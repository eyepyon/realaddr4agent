import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Firestore } from '@google-cloud/firestore';
import { DomainError, validateFloor } from '@realaddr/domain';
import { OwnerReadRepository, RealAddrRepository, type AgentPrincipal } from '@realaddr/db';
import { ownerCursor, uuidPattern } from './owner-cursor.js';
import { recoverMessageAddress } from 'viem';
import type { ApiConfig } from './config.js';
import { repoRoot } from './paths.js';

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
  '.webp': 'image/webp', '.woff2': 'font/woff2',
};

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('invalid_request', 422);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) throw new DomainError('invalid_request', 422);
  return record;
}
function string(value: unknown, code = 'invalid_request'): string {
  if (typeof value !== 'string' || !value) throw new DomainError(code, 422);
  return value;
}
function traceId(request: FastifyRequest): string { return request.id; }
function failure(reply: FastifyReply, request: FastifyRequest, status: number, error: string, message = error, retryable = false): FastifyReply {
  return reply.code(status).send({ error, message, retryable, traceId: traceId(request) });
}
function originOK(request: FastifyRequest, origin: string): boolean {
  const header = request.headers.origin;
  return !header || header === origin;
}

export function createApp(config: ApiConfig, repository: RealAddrRepository | null, db: Firestore | null) {
  const app = Fastify({ logger: false, genReqId: () => randomUUID(), bodyLimit: 64 * 1024 });
  const root = repoRoot();
  const webDist = resolve(root, 'apps/web/dist');
  const ownerReads = db ? new OwnerReadRepository(db, config.collectionPrefix) : null;
  const cursorSign = (id: string) => createHmac('sha256', config.rateLimitKey).update(`location:${id}`).digest('hex');
  const cursorEncode = (id: string) => Buffer.from(JSON.stringify({ id, mac: cursorSign(id) })).toString('base64url');
  const cursorDecode = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > 256) throw new DomainError('invalid_cursor', 422);
    try {
      const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || !('id' in parsed) || !('mac' in parsed) ||
          typeof parsed.id !== 'string' || typeof parsed.mac !== 'string' || !/^[0-9a-f-]{36}$/.test(parsed.id) || !/^[a-f0-9]{64}$/.test(parsed.mac) ||
          !timingSafeEqual(Buffer.from(parsed.mac), Buffer.from(cursorSign(parsed.id)))) throw new Error('invalid');
      return parsed.id;
    } catch { throw new DomainError('invalid_cursor', 422); }
  };

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Trace-Id', traceId(request));
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    if (request.url.startsWith('/v1/') || request.url.startsWith('/auth/') || request.url.startsWith('/admin') || request.url.startsWith('/approve') || request.url.startsWith('/app')) {
      reply.header('Cache-Control', 'no-store');
      reply.header('X-Robots-Tag', 'noindex, nofollow');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !originOK(request, config.origin)) {
      return failure(reply, request, 403, 'invalid_origin');
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) return failure(reply, request, error.status, error.code, error.message, error.retryable);
    if (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) return failure(reply, request, error.statusCode, 'invalid_request');
    return failure(reply, request, 503, 'dependency_unavailable', 'Dependency unavailable', true);
  });

  app.get('/health', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); return { status: 'ok' }; });
  app.get('/ready', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!db || !repository) return failure(reply, request, 503, 'configuration_incomplete', 'Required configuration is incomplete', true);
    try {
      await repository.collections.collection('wallet_challenges').limit(1).get();
      reply.header('Cache-Control', 'no-store');
      return { status: 'ready', firestore: 'reachable' };
    } catch {
      return failure(reply, request, 503, 'firestore_unavailable', 'Firestore is unavailable', true);
    }
  });
  app.get('/openapi.json', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    reply.type('application/json; charset=utf-8');
    return readFile(resolve(root, 'docs/openapi.json'));
  });

  async function principal(request: FastifyRequest): Promise<AgentPrincipal> {
    if (!repository) throw new DomainError('configuration_incomplete', 503, 'Required configuration is incomplete', true);
    await repository.consumeRateLimit(createHmac('sha256', config.rateLimitKey).update(request.ip).digest('hex'), 'agent_api', 60, 60_000);
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) throw new DomainError('unauthorized', 401);
    return repository.authenticateBearer(authorization.slice(7));
  }
  async function readLocationList(request: FastifyRequest, reply: FastifyReply) {
    await principal(request);
    const q = request.query as Record<string, unknown>;
    if (Object.keys(q).some(key => !['limit', 'cursor'].includes(key))) throw new DomainError('invalid_request', 422);
    const limit = q.limit === undefined ? 20 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (q.cursor !== undefined && typeof q.cursor !== 'string')) throw new DomainError('invalid_request', 422);
    const locations = await repository!.listPublicLocations(limit, cursorDecode(q.cursor));
    return { locations: locations.map(place => ({
      id: place.id, label: place.displayName, availableSlots: place.availableSlots,
      plan: { periodDays: place.plan.periodDays, amountAtomic: place.plan.amountAtomic, network: place.plan.network, asset: place.plan.asset, decimals: 6 },
    })), nextCursor: locations.length === limit && locations.at(-1) ? cursorEncode(locations.at(-1)!.id) : null };
  }
  app.get('/v1/locations', readLocationList);
  app.get<{ Params: { locationId: string; floor: string } }>('/v1/locations/:locationId/floors/:floor', async (request) => {
    await principal(request);
    const floor = validateFloor(Number(request.params.floor));
    const location = await repository!.getPublicLocation(request.params.locationId);
    if (!location) throw new DomainError('not_found', 404);
    return { locationId: request.params.locationId, floor, available: await repository!.isFloorAvailable(request.params.locationId, floor) };
  });

  app.post('/v1/auth/challenges', async (request, reply) => {
    if (!repository) throw new DomainError('configuration_incomplete', 503, 'Required configuration is incomplete', true);
    await repository.consumeRateLimit(createHmac('sha256', config.rateLimitKey).update(request.ip).digest('hex'), 'wallet_challenge', 10, 60_000);
    const input = object(request.body, ['walletAddress', 'network', 'termsVersion']);
    if (input.termsVersion !== config.termsVersion) throw new DomainError('invalid_terms_version', 422);
    const result = await repository.issueWalletChallenge({
      address: string(input.walletAddress), chain: string(input.network),
      domain: new URL(config.origin).hostname, termsVersion: config.termsVersion,
    });
    return reply.code(201).send({ challengeId: result.id, message: result.message, expiresAt: result.expiresAt });
  });
  app.post('/v1/auth/sessions', async (request, reply) => {
    if (!repository) throw new DomainError('configuration_incomplete', 503, 'Required configuration is incomplete', true);
    await repository.consumeRateLimit(createHmac('sha256', config.rateLimitKey).update(request.ip).digest('hex'), 'wallet_challenge', 10, 60_000);
    const input = object(request.body, ['challengeId', 'signature']);
    const challengeId = string(input.challengeId);
    const signature = string(input.signature);
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new DomainError('invalid_signature', 422);
    const challenge = await repository.getWalletChallenge(challengeId);
    if (!challenge) throw new DomainError('invalid_challenge', 403);
    let recovered: string;
    try { recovered = await recoverMessageAddress({ message: challenge.message, signature: signature as `0x${string}` }); }
    catch { throw new DomainError('invalid_signature', 403); }
    if (recovered.toLowerCase() !== challenge.address.toLowerCase()) throw new DomainError('invalid_signature', 403);
    const result = await repository.registerAgentFromVerifiedChallenge({
      verified: true, challengeId, walletAddress: challenge.address,
      chain: challenge.chain, domain: challenge.domain, message: challenge.message,
    }, 'Agent');
    return reply.code(201).send({ agentId: result.principal.agentId, token: result.token, expiresAt: result.expiresAt });
  });
  app.delete('/v1/auth/session', async (request, reply) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 128) throw new DomainError('invalid_idempotency_key', 422);
    if (Object.keys(request.query as Record<string, unknown>).length) throw new DomainError('invalid_request', 422);
    const identity = await principal(request);
    await repository!.revokeCredential(identity);
    return reply.code(204).send();
  });

  const protectedUnavailable = async (request: FastifyRequest, reply: FastifyReply) => {
    await principal(request);
    return failure(reply, request, 503, 'integration_unavailable', 'Integration is not configured', true);
  };
  for (const kind of ['orders', 'subscriptions'] as const) {
    const path = kind === 'orders' ? '/v1/payment-intents' : '/v1/subscriptions';
    app.get(path, async request => {
      const identity = await principal(request);
      if (!ownerReads) throw new DomainError('configuration_incomplete', 503);
      const q = object(request.query, ['limit', 'cursor']);
      if (q.limit !== undefined && (typeof q.limit !== 'string' || !/^[1-9][0-9]*$/.test(q.limit))) throw new DomainError('invalid_request', 422);
      const limit = q.limit === undefined ? 20 : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError('invalid_request', 422);
      const codec = ownerCursor(config.rateLimitKey, kind, identity, limit);
      const cursor = codec.decode(q.cursor);
      const options = cursor ? { limit, cursor } : { limit };
      const result = kind === 'orders' ? await ownerReads.listOrders(identity, options) : await ownerReads.listSubscriptions(identity, options);
      return { [kind === 'orders' ? 'paymentIntents' : 'subscriptions']: result.items, nextCursor: result.nextCursor ? codec.encode(result.nextCursor) : null };
    });
  }
  app.get('/v1/subscriptions/by-ens', protectedUnavailable);
  for (const [path, param, kind] of [
    ['/v1/payment-intents/:intentId', 'intentId', 'order'],
    ['/v1/subscriptions/:subscriptionId', 'subscriptionId', 'subscription'],
    ['/v1/subscriptions/:subscriptionId/ens', 'subscriptionId', 'ens'],
  ] as const) app.get<{ Params: Record<string, string> }>(path, async request => {
    const identity = await principal(request);
    object(request.query, []);
    const id = request.params[param];
    if (!id || !uuidPattern.test(id)) throw new DomainError('invalid_request', 422);
    if (!ownerReads) throw new DomainError('configuration_incomplete', 503);
    return kind === 'order' ? ownerReads.getOrder(identity, id) : kind === 'ens' ? ownerReads.getEns(identity, id) : ownerReads.getSubscription(identity, id);
  });
  for (const [method, path] of [
    ['POST', '/v1/payment-intents'], ['POST', '/v1/payment-intents/:intentId/pay'],
    ['POST', '/v1/subscriptions/:subscriptionId/mail-approval'],
    ['POST', '/v1/subscriptions/:subscriptionId/ens-description-transaction'],
  ] as const) app.route({ method, url: path, handler: protectedUnavailable });
  app.get('/v1/ens/resolve', async (request, reply) => failure(reply, request, 503, 'ens_dependency_unavailable', 'ENS verification is unavailable', true));
  for (const [method, path] of [
    ['POST', '/v1/approvals/:approvalId/owner-challenge'], ['POST', '/v1/approvals/:approvalId/owner-proof'],
    ['GET', '/v1/approvals/:approvalId'], ['POST', '/v1/approvals/:approvalId/authenticate'],
    ['POST', '/v1/approvals/:approvalId/decision'], ['GET', '/v1/subscriptions/:subscriptionId/mail-profile'],
    ['PUT', '/v1/subscriptions/:subscriptionId/mail-destination'], ['POST', '/v1/subscriptions/:subscriptionId/mail-disable'],
    ['GET', '/auth/world/callback'],
  ] as const) app.route({ method, url: path, handler: async (request, reply) => failure(reply, request, 401, 'human_session_required') });
  for (const [method, path] of [
    ['GET', '/v1/admin/session'], ['DELETE', '/v1/admin/session'],
    ['GET', '/v1/admin/overview'], ['GET', '/v1/admin/locations'], ['POST', '/v1/admin/locations'],
    ['PATCH', '/v1/admin/locations/:locationId'], ['GET', '/v1/admin/payment-intents'],
    ['GET', '/v1/admin/subscriptions'], ['GET', '/v1/admin/operations'],
    ['POST', '/v1/admin/operations/:operationId/reconcile'], ['GET', '/v1/admin/audit-events'],
    ['GET', '/auth/admin/callback'],
  ] as const) app.route({ method, url: path, handler: async (request, reply) => failure(reply, request, 401, 'operator_session_required') });
  app.get('/auth/admin/start', async (request, reply) => failure(reply, request, 503, 'admin_login_unavailable', 'Operator login is unavailable', true));

  const staticRoute = async (request: FastifyRequest, reply: FastifyReply, file: string, privacy: boolean) => {
    try {
      const data = await readFile(resolve(webDist, file));
      if (privacy) { reply.header('Cache-Control', 'no-store'); reply.header('X-Robots-Tag', 'noindex, nofollow'); }
      else {
        reply.header('Cache-Control', /^assets\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(file) ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
        if (file.endsWith('.html')) reply.header('Link', '</openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"');
      }
      reply.type(mime[extname(file)] ?? 'application/octet-stream');
      return data;
    } catch {
      reply.header('Cache-Control', 'no-store');
      return failure(reply, request, file.startsWith('assets/') ? 404 : 503, file.startsWith('assets/') ? 'not_found' : 'web_assets_unavailable', file.startsWith('assets/') ? 'Not found' : 'Web assets are unavailable', !file.startsWith('assets/'));
    }
  };
  app.get('/', (request, reply) => staticRoute(request, reply, 'index.html', false));
  app.get('/developers', (request, reply) => staticRoute(request, reply, 'developers/index.html', false));
  app.get('/faq', (request, reply) => staticRoute(request, reply, 'faq/index.html', false));
  for (const path of ['/terms', '/terms/']) app.get(path, (request, reply) => {
    reply.header('X-Robots-Tag', 'noindex, follow');
    return staticRoute(request, reply, 'terms/index.html', false);
  });
  app.get('/app', (request, reply) => staticRoute(request, reply, 'app/index.html', true));
  app.get('/app/subscriptions', (request, reply) => staticRoute(request, reply, 'app/index.html', true));
  app.get('/app/payments', (request, reply) => staticRoute(request, reply, 'app/index.html', true));
  app.get('/app/subscriptions/:subscriptionId', (request, reply) => staticRoute(request, reply, 'app/index.html', true));
  app.get('/admin', (request, reply) => staticRoute(request, reply, 'admin/index.html', true));
  app.get('/approve/:approvalId', (request, reply) => staticRoute(request, reply, 'approve/index.html', true));
  for (const file of ['robots.txt', 'sitemap.xml', 'llms.txt']) app.get(`/${file}`, (request, reply) => staticRoute(request, reply, file, false));
  app.get<{ Params: { asset: string } }>('/assets/:asset', (request, reply) => {
    if (!/^[A-Za-z0-9._-]+$/.test(request.params.asset)) return failure(reply, request, 404, 'not_found');
    return staticRoute(request, reply, `assets/${request.params.asset}`, false);
  });
  app.setNotFoundHandler((request, reply) => { reply.header('Cache-Control', 'no-store'); return failure(reply, request, 404, 'not_found'); });
  return app;
}
