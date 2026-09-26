import { randomUUID } from 'node:crypto';
import type { DispatchRepository, DispatchClaim } from '@realaddr/db';
import type { WorkerConfig } from './config.js';

export type DispatchOutcome = 'confirmed' | 'unknown' | 'missing';
export interface RestRequest { method: 'POST' | 'GET'; url: string; body?: unknown }
export interface RestResponse { status: number; data?: unknown }
export type TasksTransport = (request: RestRequest) => Promise<RestResponse>;
export interface SweepResult { status: 'finished' | 'busy' | 'disabled'; queued: number; unknown: number; skipped: number }
export interface Dispatcher { sweep(): Promise<SweepResult> }

async function metadata(path: string): Promise<Response> {
  const response = await fetch(`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/${path}`, {
    headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error', signal: AbortSignal.timeout(1500),
  });
  if (!response.ok || response.headers.get('Metadata-Flavor') !== 'Google') { await response.body?.cancel(); throw new Error('runtime_credentials_unavailable'); }
  return response;
}

export function createRuntimeTransport(config: WorkerConfig): TasksTransport {
  return async (request) => {
    if (config.appEnv !== 'event' || !config.dispatchEnabled) throw new Error('dispatch_disabled');
    const email = (await (await metadata('email')).text()).trim();
    if (email !== `realaddr-event-worker@${config.projectId}.iam.gserviceaccount.com`) throw new Error('runtime_identity_mismatch');
    const value: unknown = await (await metadata('token')).json();
    if (!value || typeof value !== 'object' || !('access_token' in value) || typeof value.access_token !== 'string' || !value.access_token || !('token_type' in value) || value.token_type !== 'Bearer' || !('expires_in' in value) || typeof value.expires_in !== 'number' || value.expires_in < 10) throw new Error('runtime_credentials_unavailable');
    const response = await fetch(request.url, {
      method: request.method, redirect: 'error', signal: AbortSignal.timeout(1500),
      headers: { Authorization: `Bearer ${value.access_token}`, 'Content-Type': 'application/json' },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
    // Parse only successful task resources; provider errors never escape this adapter.
    if (!response.ok) { await response.body?.cancel(); return { status: response.status }; }
    return { status: response.status, data: await response.json() as unknown };
  };
}

export function createTaskAdapter(config: WorkerConfig, testTransport?: TasksTransport) {
  if (testTransport && config.appEnv !== 'local') throw new Error('test_transport_disallowed');
  const transport = testTransport ?? createRuntimeTransport(config);
  const queue = `projects/${config.projectId}/locations/${config.region}/queues/${config.queue}`;
  const validResource = (data: unknown, name: string) => !!data && typeof data === 'object' && 'name' in data && data.name === name;
  return {
    async dispatch(claim: DispatchClaim): Promise<DispatchOutcome> {
      if (!/^[a-f0-9]{64}$/.test(claim.id) || !/^[a-f0-9]{64}$/.test(claim.taskId)) return 'unknown';
      const name = `${queue}/tasks/${claim.taskId}`;
      const lookup = async (): Promise<DispatchOutcome> => {
        const response = await transport({ method: 'GET', url: `https://cloudtasks.googleapis.com/v2/${name}` });
        return response.status === 404 ? 'missing' : response.status === 200 && validResource(response.data, name) ? 'confirmed' : 'unknown';
      };
      try {
        if (claim.taskConfirmed) return await lookup();
        const response = await transport({ method: 'POST', url: `https://cloudtasks.googleapis.com/v2/${queue}/tasks`, body: { task: {
          name, httpRequest: { httpMethod: 'POST', url: `${config.audience}/tasks/run`, headers: { 'Content-Type': 'application/json' },
            body: Buffer.from(JSON.stringify({ outboxId: claim.id })).toString('base64'), oidcToken: { serviceAccountEmail: config.tasksAccount, audience: config.audience } }, dispatchDeadline: '30s',
        } } });
        if (response.status === 409) return await lookup();
        return response.status >= 200 && response.status < 300 && validResource(response.data, name) ? 'confirmed' : 'unknown';
      } catch { return 'unknown'; }
    },
  };
}

export function createDispatcher(config: WorkerConfig, repository: Pick<DispatchRepository, 'acquireSweep' | 'listSweepPage' | 'finishSweep' | 'claimDispatch' | 'finishDispatch'>, adapter = createTaskAdapter(config), owner: string = randomUUID()): Dispatcher {
  return { async sweep() {
    const result: SweepResult = { status: 'disabled', queued: 0, unknown: 0, skipped: 0 };
    if (!config.dispatchEnabled) return result;
    const sweep = await repository.acquireSweep(owner);
    if (!sweep) return { ...result, status: 'busy' };
    const page = await repository.listSweepPage(sweep);
    result.status = 'finished';
    let next = 0;
    const deadline = Date.now() + 25_000;
    const processPage = async () => {
      while (next < page.ids.length) {
        const id = page.ids[next++]!;
        if (Date.now() >= deadline) { result.skipped += 1; continue; }
        try {
          const claim = await repository.claimDispatch(id, owner);
          if (!claim) { result.skipped += 1; continue; }
          const outcome = await adapter.dispatch(claim);
          await repository.finishDispatch(claim, outcome);
          if (outcome === 'confirmed') result.queued += 1;
          else if (outcome === 'unknown') result.unknown += 1;
          else result.skipped += 1;
        } catch { result.unknown += 1; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, page.ids.length) }, processPage));
    await repository.finishSweep(sweep, page.cursor);
    return result;
  } };
}
