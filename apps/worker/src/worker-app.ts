import Fastify from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import type { WorkerConfig } from './config.js';
import type { WorkerRunner } from './runner.js';
import type { Dispatcher } from './dispatcher.js';

export interface VerifiedInvoker { iss?: string; aud?: string; email?: string; email_verified?: boolean }
export type VerifyInvokerToken = (token: string, audience: string) => Promise<VerifiedInvoker | undefined>;

async function withinDeadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('worker_deadline_exceeded')), milliseconds); })]);
  } finally { if (timer) clearTimeout(timer); }
}

export function createWorkerApp(config: WorkerConfig, runner: WorkerRunner, testVerifier?: VerifyInvokerToken, dispatcher?: Dispatcher) {
  if (testVerifier && config.appEnv !== 'local') throw new Error('test_verifier_disallowed');
  const google = new OAuth2Client();
  const verify: VerifyInvokerToken = testVerifier ?? (async (token, audience) => {
    const ticket = await google.verifyIdToken({ idToken: token, audience });
    return ticket.getPayload();
  });
  const app = Fastify({ logger: false, bodyLimit: 1024, requestTimeout: 25_000, ajv: { customOptions: { removeAdditional: false } } });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Trace-Id', request.id);
    const expected = request.url === '/tasks/run' ? config.tasksAccount : request.url === '/scheduler/sweep' ? config.schedulerAccount : null;
    const auth = request.headers.authorization;
    if (!expected || !auth || !/^Bearer [A-Za-z0-9._~-]+$/.test(auth)) return reply.code(401).send({ error: 'unauthorized', message: 'Unauthorized', retryable: false, traceId: request.id });
    try {
      const claims = await withinDeadline(verify(auth.slice(7), config.audience), 5_000);
      if (!claims || claims.iss !== 'https://accounts.google.com' || claims.aud !== config.audience || claims.email_verified !== true || claims.email !== expected) throw new Error('unauthorized');
    } catch {
      return reply.code(401).send({ error: 'unauthorized', message: 'Unauthorized', retryable: false, traceId: request.id });
    }
  });
  app.post<{ Body: { outboxId: string } }>('/tasks/run', {
    schema: { body: { type: 'object', required: ['outboxId'], additionalProperties: false, properties: { outboxId: { type: 'string', pattern: '^[a-f0-9]{64}$' } } } },
  }, async (request, reply) => {
    try {
      const result = await runner.run(request.body.outboxId);
      if (!result.retryable) return reply.code(200).send({ status: result.status });
      return reply.code(503).send({ error: 'dependency_unavailable', message: 'Outbox remains pending', retryable: result.retryable, traceId: request.id });
    } catch {
      return reply.code(503).send({ error: 'worker_unavailable', message: 'Worker execution unavailable', retryable: true, traceId: request.id });
    }
  });
  app.post('/scheduler/sweep', { schema: { body: { type: 'object', additionalProperties: false, properties: {} } } }, async (request, reply) => {
    if (!dispatcher || !config.dispatchEnabled) return reply.code(503).send({ error: 'dispatcher_disabled', retryable: true, traceId: request.id });
    const result = await dispatcher.sweep();
    return reply.code(result.status === 'disabled' || result.unknown > 0 ? 503 : 200).send(result);
  });
  app.setErrorHandler((error, request, reply) => {
    const status = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500 ? error.statusCode : 503;
    return reply.code(status).send({ error: status === 400 ? 'invalid_request' : 'worker_unavailable', message: status === 400 ? 'Invalid request' : 'Worker unavailable', retryable: status !== 400, traceId: request.id });
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: 'not_found', message: 'Not found', retryable: false, traceId: request.id }));
  return app;
}
