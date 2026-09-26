import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { DispatchRepository } from '@realaddr/db';
import type { DispatchClaim } from '@realaddr/db';
import { createDispatcher, createTaskAdapter, createRuntimeTransport, type RestRequest } from '../src/dispatcher.js';
import { loadWorkerConfig, type WorkerConfig } from '../src/config.js';

const config: WorkerConfig = { appEnv: 'local', port: 8081, projectId: 'demo-realaddr-local', databaseId: 'realaddr', collectionPrefix: 'realaddr_event_', audience: 'http://127.0.0.1:8081', tasksAccount: 'realaddr-event-tasks@demo-realaddr-local.iam.gserviceaccount.com', schedulerAccount: 'realaddr-event-sched@demo-realaddr-local.iam.gserviceaccount.com', region: 'us-central1', queue: 'realaddr-event-jobs' };
const claim: DispatchClaim = { id: 'a'.repeat(64), taskId: 'b'.repeat(64), owner: 'owner', generation: 1, taskGeneration: 0, taskConfirmed: false };
test('REST task freezes minimal payload and OIDC identity; 409 tombstone is missing', async () => {
  const calls: RestRequest[] = [];
  const adapter = createTaskAdapter(config, async request => { calls.push(request); return { status: calls.length === 1 ? 409 : 404 }; });
  assert.equal(await adapter.dispatch(claim), 'missing');
  assert.equal(calls[0]?.method, 'POST');
  assert.equal(calls[1]?.method, 'GET');
  const body = calls[0]!.body as { task: { name: string; dispatchDeadline: string; httpRequest: { body: string; url: string; oidcToken: unknown } } };
  assert.equal(body.task.name, `projects/${config.projectId}/locations/us-central1/queues/realaddr-event-jobs/tasks/${claim.taskId}`);
  assert.equal(body.task.dispatchDeadline, '30s');
  assert.deepEqual(JSON.parse(Buffer.from(body.task.httpRequest.body, 'base64').toString()), { outboxId: claim.id });
  assert.deepEqual(body.task.httpRequest.oidcToken, { serviceAccountEmail: config.tasksAccount, audience: config.audience });
  assert.equal(body.task.httpRequest.url, `${config.audience}/tasks/run`);
});
test('confirmed tasks use GET; unknown errors retain same name and hide provider details', async () => {
  const calls: RestRequest[] = [];
  const adapter = createTaskAdapter(config, async request => { calls.push(request); throw new Error('raw private response'); });
  assert.equal(await adapter.dispatch(claim), 'unknown');
  assert.equal(await adapter.dispatch(claim), 'unknown');
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(await adapter.dispatch({ ...claim, taskConfirmed: true }), 'unknown');
  assert.equal(calls[2]?.method, 'GET');
  assert.equal(await adapter.dispatch({ ...claim, taskId: '../other' }), 'unknown');
  assert.equal(calls.length, 3);
  assert.throws(() => createTaskAdapter({ ...config, appEnv: 'event' }, async () => ({ status: 200 })), /disallowed/);
});
test('runtime transport refuses disabled dispatch and metadata identity mismatch', async () => {
  await assert.rejects(createRuntimeTransport(config)({ method: 'GET', url: 'https://cloudtasks.googleapis.com/v2/task' }), /disabled/);
  const original = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async (_input, init) => { count++; assert.equal(init?.redirect, 'error'); assert.ok(init?.signal); return new Response('other@example.invalid', { headers: { 'Metadata-Flavor': 'Google' } }); };
  try { await assert.rejects(createRuntimeTransport({ ...config, appEnv: 'event', dispatchEnabled: true })({ method: 'GET', url: 'https://cloudtasks.googleapis.com/v2/task' }), /identity_mismatch/); assert.equal(count, 1); }
  finally { globalThis.fetch = original; }
});
test('dispatch config requires event dedicated queue region and no key fallback', () => {
  const env = { APP_ENV: 'event', RESOURCE_PREFIX: 'realaddr-event', FIRESTORE_COLLECTION_PREFIX: 'realaddr_event_', FIRESTORE_DATABASE_ID: 'realaddr', GCP_PROJECT_ID: 'sample-project', WORKER_URL: 'https://worker.example', TASK_INVOKER_SA: 'realaddr-event-tasks@sample-project.iam.gserviceaccount.com', SCHEDULER_INVOKER_SA: 'realaddr-event-sched@sample-project.iam.gserviceaccount.com', CLOUD_TASKS_DISPATCH_ENABLED: 'true', GCP_REGION: 'us-central1', TASKS_QUEUE: 'realaddr-event-jobs' };
  assert.equal(loadWorkerConfig(env).dispatchEnabled, true);
  assert.throws(() => loadWorkerConfig({ ...env, TASKS_QUEUE: 'other' }), /queue/);
  assert.throws(() => loadWorkerConfig({ ...env, GCP_REGION: '../region' }), /region/);
  assert.throws(() => loadWorkerConfig({ ...env, GOOGLE_APPLICATION_CREDENTIALS: 'key.json' }), /disallowed/);
});

test('emulator sweep persists unknown task ID then confirms collision and rotates missing task', { skip: !process.env.FIRESTORE_EMULATOR_HOST }, async () => {
  const db = new Firestore({ projectId: `demo-realaddr-${randomUUID()}`, databaseId: 'realaddr' });
  let now = new Date('2026-09-26T00:00:00Z');
  const repository = new DispatchRepository(db, config.collectionPrefix, { now: () => now });
  const ref = db.collection(`${config.collectionPrefix}outbox`).doc(claim.id);
  const requests: RestRequest[] = [];
  let phase = 0;
  const adapter = createTaskAdapter(config, async request => {
    requests.push(request);
    if (phase === 0) throw new Error('uncertain create timeout');
    if (phase === 1 && request.method === 'POST') return { status: 409 };
    if (phase === 1) return { status: 200, data: { name: request.url.slice('https://cloudtasks.googleapis.com/v2/'.length) } };
    return { status: 404 };
  });
  const dispatcher = createDispatcher({ ...config, dispatchEnabled: true }, repository, adapter, 'worker-test');
  try {
    await ref.create({ schemaVersion: 1, aggregateId: claim.id, version: 1, eventType: 'payment.settlement_requested', payload: { orderId: claim.id }, state: 'pending', availableAt: now, attempts: 0 });
    assert.deepEqual(await dispatcher.sweep(), { status: 'finished', queued: 0, unknown: 1, skipped: 0 });
    const first = (await ref.get()).data()!;
    assert.equal(first.taskConfirmed, false);
    now = new Date(now.getTime() + 5_000); phase = 1;
    assert.deepEqual(await dispatcher.sweep(), { status: 'finished', queued: 1, unknown: 0, skipped: 0 });
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(requests[2]?.method, 'GET');
    assert.equal((await ref.get()).data()?.taskConfirmed, true);
    now = new Date(now.getTime() + 10_000); phase = 2;
    assert.deepEqual(await dispatcher.sweep(), { status: 'finished', queued: 0, unknown: 0, skipped: 1 });
    const rotated = (await ref.get()).data()!;
    assert.equal(rotated.state, 'pending');
    assert.equal(rotated.taskGeneration, 1);
    assert.notEqual(rotated.taskId, first.taskId);
    assert.equal(rotated.taskConfirmed, false);
  } finally { await db.terminate(); }
});
