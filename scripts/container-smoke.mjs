import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { CURRENT_TERMS_VERSION } from '../packages/domain/src/terms.ts';

const execute = promisify(execFile);
const runId = randomUUID();
const image = `realaddr-local-check:${runId}`;
const containers = [];
let imageBuilt = false;
let failure;

async function docker(args, timeout = 30_000) {
  return execute('docker', args, { timeout, maxBuffer: 2 * 1024 * 1024 });
}

async function create(role) {
  const result = await docker([
    'create', '--name', `realaddr-local-${role}-${runId}`, '--network', 'none',
    '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-e', 'APP_ENV=local', '-e', 'GCP_PROJECT_ID=demo-realaddr-container',
    '-e', 'RESOURCE_PREFIX=realaddr-event', '-e', 'FIRESTORE_COLLECTION_PREFIX=realaddr_event_',
    '-e', 'FIRESTORE_DATABASE_ID=realaddr', '-e', 'FIRESTORE_EMULATOR_HOST=127.0.0.1:8085',
    '-e', 'PUBLIC_ORIGIN=http://localhost:8080', '-e', 'TERMS_VERSION=event-demo-1',
    '-e', 'WORKER_URL=http://localhost:8080', '-e', 'CLOUD_TASKS_DISPATCH_ENABLED=false',
    '-e', 'TASK_INVOKER_SA=realaddr-event-tasks@demo-realaddr-container.iam.gserviceaccount.com',
    '-e', 'SCHEDULER_INVOKER_SA=realaddr-event-sched@demo-realaddr-container.iam.gserviceaccount.com',
    image, role,
  ]);
  const id = result.stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid_created_container_id');
  containers.push(id);
  return id;
}

async function health(id, role) {
  const probe = `
    const response = await fetch('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(2000) });
    const body = await response.json();
    if (response.headers.get('cache-control') !== 'no-store') throw new Error('health_cache_policy');
    if (${JSON.stringify(role)} === 'web') {
      if (response.status !== 200 || body.status !== 'ok') throw new Error('web_health_failed');
      const terms = await fetch('http://127.0.0.1:8080/terms', { signal: AbortSignal.timeout(2000) });
      const html = await terms.text();
      if (terms.status !== 200 || !html.includes(${JSON.stringify(CURRENT_TERMS_VERSION)}) || !html.includes('第15条')) throw new Error('approved_terms_not_served');
      if (terms.headers.get('x-robots-tag')?.includes('noindex') || !/<meta[^>]+name="robots"[^>]+content="index,follow"/.test(html)) throw new Error('approved_terms_must_be_indexable');
    } else {
      if (response.status !== 401 || body.error !== 'unauthorized') throw new Error('worker_auth_not_closed');
    }
  `;
  let lastError;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await docker(['exec', id, 'node', '--input-type=module', '-e', probe], 5_000);
      console.log(`${role}: localhost health ${role === 'web' ? '200' : '401 (authentication required)'}`);
      return;
    } catch (error) {
      lastError = error;
      const state = await docker(['inspect', '--format', '{{.State.Running}}', id]);
      if (state.stdout.trim() !== 'true') {
        const logs = await docker(['logs', id]);
        throw new Error(`${role}_exited_before_health: ${logs.stdout}${logs.stderr}`);
      }
      await delay(1_000);
    }
  }
  throw new Error(`${role}_health_timeout`, { cause: lastError });
}

try {
  await docker(['info', '--format', '{{.ServerVersion}}']);
  const build = await docker([
    'build', '--build-arg', 'VITE_APP_ENV=local', '--build-arg', 'VITE_TERMS_VERSION=event-demo-1',
    '--tag', image, '.',
  ], 10 * 60_000);
  process.stdout.write(build.stdout);
  process.stderr.write(build.stderr);
  imageBuilt = true;
  for (const role of ['web', 'worker']) {
    const id = await create(role);
    await docker(['start', id]);
    await health(id, role);
  }
  const invalid = await create('invalid');
  await docker(['start', invalid]);
  const exit = await docker(['wait', invalid], 10_000);
  const logs = await docker(['logs', invalid]);
  if (exit.stdout.trim() === '0' || !`${logs.stdout}${logs.stderr}`.includes('container_role_must_be_web_or_worker')) {
    throw new Error('unknown_container_role_was_not_rejected');
  }
  console.log('Unknown role rejected; no database or queue requests performed.');
} catch (error) {
  failure = error;
} finally {
  for (const id of containers) {
    try { await docker(['rm', '--force', id]); }
    catch (error) { failure ??= error; }
  }
  if (imageBuilt) {
    try { await docker(['image', 'rm', image]); }
    catch (error) { failure ??= error; }
  }
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
