import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { OAuth2Client } from 'google-auth-library';

const appEnv = process.env.APP_ENV ?? 'local';
if (!['local', 'event', 'production'].includes(appEnv)) throw new Error('invalid_app_env');
const audience = process.env.WORKER_URL;
const tasksAccount = process.env.TASK_INVOKER_SA;
const schedulerAccount = process.env.SCHEDULER_INVOKER_SA;
const port = Number(process.env.PORT ?? '8080');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_port');
if (appEnv !== 'local' && process.env.FIRESTORE_EMULATOR_HOST) throw new Error('emulator_disallowed_outside_local');
const verifier = new OAuth2Client();
const app = Fastify({ logger: false, genReqId: () => randomUUID(), bodyLimit: 64 * 1024 });
app.addHook('onRequest', async (request, reply) => {
  reply.header('Cache-Control', 'no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Trace-Id', request.id);
  const auth = request.headers.authorization;
  if (!audience || !tasksAccount || !schedulerAccount || !auth?.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'unauthorized', message: 'Unauthorized', retryable: false, traceId: request.id });
  }
  try {
    const ticket = await verifier.verifyIdToken({ idToken: auth.slice(7), audience });
    const claims = ticket.getPayload();
    const allowed = request.url === '/tasks/run' ? tasksAccount : request.url === '/scheduler/sweep' ? schedulerAccount : null;
    if (!claims || claims.iss !== 'https://accounts.google.com' || claims.email_verified !== true || claims.email !== allowed) throw new Error('unauthorized');
  } catch {
    return reply.code(401).send({ error: 'unauthorized', message: 'Unauthorized', retryable: false, traceId: request.id });
  }
});
for (const route of ['/tasks/run', '/scheduler/sweep']) {
  app.post(route, async (request, reply) => reply.code(503).send({
    error: 'worker_unavailable', message: 'Worker integration is unavailable', retryable: true, traceId: request.id,
  }));
}
app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: 'not_found', message: 'Not found', retryable: false, traceId: request.id }));
const stop = async () => { await app.close(); };
process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
await app.listen({ host: '0.0.0.0', port });
