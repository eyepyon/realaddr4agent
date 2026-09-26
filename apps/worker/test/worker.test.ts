import assert from 'node:assert/strict';
import test from 'node:test';
import type { OutboxRepository, RealAddrRepository } from '@realaddr/db';
import { loadWorkerConfig, type WorkerConfig } from '../src/config.js';
import { createWorkerApp } from '../src/worker-app.js';
import { createWorkerRunner } from '../src/runner.js';

const project = 'demo-realaddr-local';
const tasks = `realaddr-event-tasks@${project}.iam.gserviceaccount.com`;
const sched = `realaddr-event-sched@${project}.iam.gserviceaccount.com`;
const audience = 'http://127.0.0.1:8081';
const config: WorkerConfig = { appEnv: 'local', port: 8081, projectId: project, databaseId: '(default)', collectionPrefix: 'realaddr_event_', audience, tasksAccount: tasks, schedulerAccount: sched };
const id = 'a'.repeat(64);

test('configuration requires emulator, prefix, database and dedicated invokers', () => {
  const env = { APP_ENV: 'local', PORT: '8081', RESOURCE_PREFIX: 'realaddr-event', FIRESTORE_COLLECTION_PREFIX: 'realaddr_event_', FIRESTORE_DATABASE_ID: '(default)', GCP_PROJECT_ID: project, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8085', WORKER_URL: audience, TASK_INVOKER_SA: tasks, SCHEDULER_INVOKER_SA: sched };
  assert.deepEqual(loadWorkerConfig(env), config);
  assert.throws(() => loadWorkerConfig({ ...env, FIRESTORE_EMULATOR_HOST: undefined }), /emulator/);
  assert.throws(() => loadWorkerConfig({ ...env, FIRESTORE_COLLECTION_PREFIX: undefined }), /prefix/);
  assert.throws(() => loadWorkerConfig({ ...env, SCHEDULER_INVOKER_SA: tasks }), /invoker/);
  assert.throws(() => loadWorkerConfig({ ...env, APP_ENV: 'production' }), /disabled/);
  assert.throws(() => loadWorkerConfig({ ...env, PRICE_PROFILE: 'mainnet' }), /mainnet/);
});

test('task and scheduler roles are exact and task body contains only outbox ID', async () => {
  let runs = 0;
  let identity = tasks;
  const app = createWorkerApp(config, { run: async () => { runs += 1; return { status: 'retry', retryable: true }; } }, async (_token, aud) => ({ iss: 'https://accounts.google.com', aud, email: identity, email_verified: true }));
  try {
    const send = (url: string, body: Record<string, unknown>, authorization = 'Bearer token') => app.inject({ method: 'POST', url, headers: { authorization }, payload: body });
    assert.equal((await send('/tasks/run', { outboxId: id }, '')).statusCode, 401);
    assert.equal((await send('/tasks/run', { outboxId: id, verified: true })).statusCode, 400);
    assert.equal((await send('/tasks/run', { outboxId: id, receipt: { finalityVerified: true } })).statusCode, 400);
    assert.equal((await send('/tasks/run', { outboxId: 'bad' })).statusCode, 400);
    assert.equal(runs, 0);
    assert.equal((await send('/tasks/run', { outboxId: id })).statusCode, 503);
    assert.equal(runs, 1);
    assert.equal((await send('/scheduler/sweep', {})).statusCode, 401);
    identity = sched;
    assert.equal((await send('/tasks/run', { outboxId: id })).statusCode, 401);
    assert.equal((await send('/scheduler/sweep', {})).statusCode, 503);
    assert.equal(runs, 1);
  } finally { await app.close(); }
});

test('OIDC claims and test verifier fail closed', async () => {
  assert.throws(() => createWorkerApp({ ...config, appEnv: 'event' }, { run: async () => ({ status: 'retry', retryable: true }) }, async () => undefined), /disallowed/);
  for (const claims of [
    { iss: 'accounts.google.com', aud: audience, email: tasks, email_verified: true },
    { iss: 'https://accounts.google.com', aud: 'https://different.example', email: tasks, email_verified: true },
    { iss: 'https://accounts.google.com', aud: audience, email: tasks, email_verified: false },
  ]) {
    const app = createWorkerApp(config, { run: async () => ({ status: 'fulfilled', retryable: false }) }, async () => claims);
    try { assert.equal((await app.inject({ method: 'POST', url: '/tasks/run', headers: { authorization: 'Bearer token' }, payload: { outboxId: id } })).statusCode, 401); }
    finally { await app.close(); }
  }
});

test('runner recovers only the supported persisted event and never completes unavailable handlers', async () => {
  const claim = { id, eventType: 'payment.issuance_recovery_requested', aggregateId: 'order', version: 3, payload: { orderId: 'order' }, claimOwner: 'owner', claimGeneration: 1, claimUntil: new Date(Date.now() + 60_000), reconciliationOnly: false };
  let recoveries = 0;
  const reasons: string[] = [];
  const outbox = { claim: async () => claim, retry: async (_claim: unknown, reason: string) => { reasons.push(reason); return 'pending' as const; } } as unknown as Pick<OutboxRepository, 'claim' | 'retry' | 'getDeliveryState'>;
  const recovery = { recoverConfirmedPurchaseFromOutbox: async () => { recoveries += 1; return { orderId: 'order', status: 'fulfilled' as const, leaseId: 'order' }; } } as unknown as Pick<RealAddrRepository, 'recoverConfirmedPurchaseFromOutbox'>;
  const runner = createWorkerRunner(outbox, recovery, 'owner');
  assert.deepEqual(await runner.run(id), { status: 'fulfilled', retryable: false });
  assert.equal(recoveries, 1);
  assert.deepEqual(reasons, []);
  claim.eventType = 'payment.settlement_requested';
  assert.deepEqual(await runner.run(id), { status: 'retry', retryable: true });
  assert.equal(recoveries, 1);
  assert.deepEqual(reasons, ['handler_unavailable']);
});

test('duplicate claims and inconsistent issuance do not report fulfillment', async () => {
  const claim = { id, eventType: 'payment.issuance_recovery_requested', aggregateId: 'order', version: 3, payload: { orderId: 'order' }, claimOwner: 'owner', claimGeneration: 2, claimUntil: new Date(Date.now() + 60_000), reconciliationOnly: false };
  let occupied = true;
  const reasons: string[] = [];
  const outbox = { getDeliveryState: async () => 'pending' as const, claim: async () => occupied ? null : claim, retry: async (_claim: unknown, reason: string) => { reasons.push(reason); return 'manual_review' as const; } } as unknown as Pick<OutboxRepository, 'claim' | 'retry' | 'getDeliveryState'>;
  const recovery = { recoverConfirmedPurchaseFromOutbox: async (input: typeof claim) => { assert.equal(input.claimGeneration, 2); return { orderId: 'order', status: 'manual_review' as const }; } } as unknown as Pick<RealAddrRepository, 'recoverConfirmedPurchaseFromOutbox'>;
  const runner = createWorkerRunner(outbox, recovery, 'owner');
  assert.deepEqual(await runner.run(id), { status: 'not_claimed', retryable: true });
  occupied = false;
  assert.deepEqual(await runner.run(id), { status: 'manual_review', retryable: false });
  assert.deepEqual(reasons, ['issuance_inconsistent']);
});

test('terminal duplicate delivery acknowledges business state without claiming fulfillment', async () => {
  for (const state of ['completed', 'superseded', 'manual_review', 'missing'] as const) {
    const outbox = { claim: async () => null, getDeliveryState: async () => state, retry: async () => 'pending' as const };
    const runner = createWorkerRunner(outbox as unknown as Pick<OutboxRepository, 'claim' | 'retry' | 'getDeliveryState'>, {} as Pick<RealAddrRepository, 'recoverConfirmedPurchaseFromOutbox'>);
    assert.deepEqual(await runner.run(id), { status: state, retryable: false });
    const app = createWorkerApp(config, runner, async () => ({ iss: 'https://accounts.google.com', aud: audience, email: tasks, email_verified: true }));
    try {
      const response = await app.inject({ method: 'POST', url: '/tasks/run', headers: { authorization: 'Bearer token' }, payload: { outboxId: id } });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { status: state });
    } finally { await app.close(); }
  }
});

test('scheduler accepts only empty object and reports partial failures truthfully', async () => {
  const app = createWorkerApp({ ...config, dispatchEnabled: true }, { run: async () => ({ status: 'fulfilled', retryable: false }) }, async () => ({ iss: 'https://accounts.google.com', aud: audience, email: sched, email_verified: true }), { sweep: async () => ({ status: 'finished', queued: 2, unknown: 1, skipped: 0 }) });
  try {
    const send = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/scheduler/sweep', headers: { authorization: 'Bearer token' }, payload });
    assert.equal((await send({ cursor: 'invalid' })).statusCode, 400);
    const result = await send({});
    assert.equal(result.statusCode, 503);
    assert.deepEqual(result.json(), { status: 'finished', queued: 2, unknown: 1, skipped: 0 });
  } finally { await app.close(); }
});
