import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { DomainError } from '@realaddr/domain';
import { AdminRepository, type RealAddrRepository } from '@realaddr/db';
import type { ApiConfig } from './config.js';
import { AdminOidcClient, AdminOidcError, GOOGLE_ISSUER, createPkce } from './admin-oidc.js';
import { open, seal } from './world-crypto.js';

const sessionName = 'realaddr_admin_session';
const loginName = '__Host-realaddr_admin_login';
export const adminHash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const adminCsrf = (key: Buffer, token: string): string => createHmac('sha256', key).update(JSON.stringify(['realaddr-admin-csrf-v1', token])).digest('base64url');
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new DomainError('invalid_request', 400);
  return value as Record<string, unknown>;
}
function cookie(request: FastifyRequest, name: string): string {
  if (request.headers.authorization) throw new DomainError('operator_session_required', 401);
  const values = (request.headers.cookie ?? '').split(';').map(x => x.trim()).filter(x => x.startsWith(`${name}=`));
  const token = values[0]?.slice(name.length + 1);
  if (values.length !== 1 || !token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new DomainError('operator_session_required', 401);
  return token;
}
function setCookie(reply: FastifyReply, name: string, token: string, maxAge: number): void {
  reply.header('Set-Cookie', `${name}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
}
export function registerAdminRoutes(app: FastifyInstance, config: ApiConfig, admin: AdminRepository | null, repository: RealAddrRepository | null, injectedClient?: AdminOidcClient) {
  const client = injectedClient ?? (config.admin ? new AdminOidcClient(config.admin) : null);
  function enabled(): void {
    if (!config.admin || !admin || !client || !repository) throw new DomainError('admin_login_unavailable', 503, 'Operator login is unavailable', true);
  }
  async function throttle(request: FastifyRequest, bucket: 'admin_login' | 'admin_api'): Promise<void> {
    await repository!.consumeRateLimit(createHmac('sha256', config.rateLimitKey).update(request.ip).digest('hex'), bucket, 30, 60_000);
  }
  async function operator(request: FastifyRequest, mutation = false): Promise<string> {
    const token = cookie(request, sessionName);
    enabled();
    await throttle(request, 'admin_api');
    const tokenHash = adminHash(token);
    const identity = await admin!.authenticateSession(tokenHash);
    if (mutation) {
      if (request.headers.origin !== config.origin) throw new DomainError('invalid_origin', 403);
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new DomainError('invalid_content_type', 415);
      const csrf = request.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrf) || !/^[a-f0-9]{64}$/.test(identity.csrfHash) || !timingSafeEqual(Buffer.from(adminHash(csrf), 'hex'), Buffer.from(identity.csrfHash, 'hex')) || csrf !== adminCsrf(config.admin!.sessionKey, token)) throw new DomainError('invalid_csrf', 403);
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || key.length < 8 || key.length > 128 || !/^[\x21-\x7e]+$/.test(key)) throw new DomainError('invalid_idempotency_key', 422);
    }
    return tokenHash;
  }
  app.get('/auth/admin/start', async (request, reply) => {
    if (request.headers.authorization) throw new DomainError('operator_session_required', 401);
    object(request.query, []); enabled(); await throttle(request, 'admin_login');
    const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), loginCookie = randomBytes(32).toString('base64url');
    const pkce = createPkce(), stateHash = adminHash(state);
    await admin!.issueLogin({ stateHash, nonceHash: adminHash(nonce), cookieHash: adminHash(loginCookie), encryptedVerifier: seal(config.admin!.sessionKey, 'admin-pkce', stateHash, pkce.verifier), expiresAt: new Date(Date.now() + 300_000) });
    setCookie(reply, loginName, loginCookie, 300);
    return reply.redirect(client!.authorizationUrl({ state, nonce, codeChallenge: pkce.codeChallenge }));
  });
  app.get('/auth/admin/callback', async (request, reply) => {
    const loginCookie = cookie(request, loginName); enabled(); await throttle(request, 'admin_login');
    const q = object(request.query, ['state', 'code', 'scope', 'authuser', 'prompt', 'hd', 'iss', 'error', 'error_description']);
    if (Object.values(q).some(value => typeof value !== 'string' || value.length > 4096) || (q.iss !== undefined && q.iss !== GOOGLE_ISSUER)) throw new DomainError('admin_authentication_failed', 403);
    if (typeof q.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(q.state)) throw new DomainError('admin_authentication_failed', 403);
    const stateHash = adminHash(q.state);
    const login = await admin!.consumeLogin(stateHash, adminHash(loginCookie));
    setCookie(reply, loginName, '', 0);
    if (q.error !== undefined || typeof q.code !== 'string' || !q.code || q.code.length > 4096) throw new DomainError('admin_authentication_failed', 403);
    let claims;
    try { claims = await client!.exchangeAndVerify({ code: q.code, verifier: open(config.admin!.sessionKey, 'admin-pkce', stateHash, login.encryptedVerifier), nonceHash: login.nonceHash }); }
    catch (error) { if (error instanceof AdminOidcError) throw new DomainError('admin_authentication_failed', 403); throw error; }
    const token = randomBytes(32).toString('base64url');
    const result = await admin!.bindAndIssueSession({ ...claims, tokenHash: adminHash(token), csrfHash: adminHash(adminCsrf(config.admin!.sessionKey, token)) });
    reply.header('Set-Cookie', [`${loginName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`, `${sessionName}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`]);
    return reply.redirect('/admin');
  });
  app.get('/v1/admin/session', async request => {
    object(request.query, []); const tokenHash = await operator(request);
    const identity = await admin!.authenticateSession(tokenHash);
    return { displayName: identity.displayName, role: 'operator', expiresAt: identity.expiresAt, csrfToken: adminCsrf(config.admin!.sessionKey, cookie(request, sessionName)) };
  });
  app.delete('/v1/admin/session', async (request, reply) => {
    object(request.query, []); const tokenHash = await operator(request, true); await admin!.revokeSession(tokenHash);
    setCookie(reply, sessionName, '', 0); return reply.code(204).send();
  });
  app.get('/v1/admin/overview', async request => { object(request.query, []); const tokenHash = await operator(request); return admin!.overview(tokenHash); });
  for (const [path, kind] of [['locations', 'locations'], ['payment-intents', 'payments'], ['subscriptions', 'subscriptions'], ['operations', 'operations'], ['audit-events', 'audit']] as const) {
    app.get(`/v1/admin/${path}`, async request => {
      const tokenHash = await operator(request);
      const raw = object(request.query, ['limit', 'cursor', 'id', 'status', 'locationId', 'kind', 'targetType', 'targetId']);
      if (raw.limit !== undefined && (typeof raw.limit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(raw.limit))) throw new DomainError('invalid_request', 400);
      const query = { ...raw, ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }) };
      return admin!.list(kind, tokenHash, query as Parameters<AdminRepository['list']>[2]);
    });
  }
  app.post('/v1/admin/locations', async (request, reply) => {
    object(request.query, []); const tokenHash = await operator(request, true);
    const input = object(request.body, ['slug', 'displayName', 'publicArea', 'postalCode', 'address', 'status', 'reason']);
    if (input.status !== undefined && input.status !== 'paused') throw new DomainError('invalid_request', 422);
    const result = await admin!.createLocation(tokenHash, { ...input, status: 'paused' } as unknown as Parameters<AdminRepository['createLocation']>[1], request.headers['idempotency-key'] as string, request.id);
    return reply.code(201).send(result);
  });
  app.patch<{ Params: { locationId: string } }>('/v1/admin/locations/:locationId', async request => {
    object(request.query, []); const tokenHash = await operator(request, true);
    const input = object(request.body, ['expectedVersion', 'reason', 'publicationConfirmed', 'changes']);
    object(input.changes, ['displayName', 'publicArea', 'postalCode', 'address', 'status']);
    return admin!.updateLocation(tokenHash, request.params.locationId, input as unknown as Parameters<AdminRepository['updateLocation']>[2], request.headers['idempotency-key'] as string, request.id);
  });
  app.post('/v1/admin/operations/:operationId/reconcile', async request => {
    await operator(request, true); object(request.body, ['expectedVersion', 'reason']); object(request.query, []);
    throw new DomainError('read_reconciliation_unavailable', 503, 'Read reconciliation is not connected', true);
  });
}
