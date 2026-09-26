import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { DomainError } from '@realaddr/domain';
import { WorldRepository, type RealAddrRepository, type AgentPrincipal } from '@realaddr/db';
import { WorldClient, createPkce } from '@realaddr/world';
import { recoverMessageAddress } from 'viem';
import type { ApiConfig } from './config.js';
import { open, seal, subjectHash } from './world-crypto.js';

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new DomainError('invalid_request', 422);
  return value as Record<string, unknown>;
}
function str(value: unknown): string { if (typeof value !== 'string' || !value || value.length > 4096) throw new DomainError('invalid_request', 422); return value; }
function id(value: unknown): string { const result = str(value); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result)) throw new DomainError('invalid_request', 422); return result; }
function cookie(request: FastifyRequest): string {
  if (request.headers.authorization) throw new DomainError('human_session_required', 401);
  const matches = (request.headers.cookie ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith('__Host-realaddr_session='));
  if (matches.length !== 1 || !/^[A-Za-z0-9_-]{32,128}$/.test(matches[0]!.slice(24))) throw new DomainError('human_session_required', 401);
  return matches[0]!.slice(24);
}
export function registerWorldRoutes(app: FastifyInstance, config: ApiConfig, repository: RealAddrRepository | null, world: WorldRepository | null, principal: (request: FastifyRequest) => Promise<AgentPrincipal>) {
  const client = config.world ? new WorldClient(config.world) : null;
  function setSession(reply: FastifyReply, session: { token: string; csrfToken: string }): void {
    reply.header('Set-Cookie', [`__Host-realaddr_session=${session.token}; Path=/; HttpOnly; SameSite=Lax; Secure`, `__Host-realaddr_csrf=${session.csrfToken}; Path=/; SameSite=Lax; Secure`]);
  }
  function enabled(): void { if (!config.world || !world || !client || !repository) throw new DomainError('world_unavailable', 503, 'World sandbox is not configured', true); }
  async function human(request: FastifyRequest, mutation = false): Promise<{ token: string; csrf: string }> {
    const token = cookie(request);
    if (mutation && request.headers.origin !== config.origin) throw new DomainError('invalid_origin', 403);
    const csrf = mutation ? str(request.headers['x-csrf-token']) : '';
    enabled();
    await repository!.consumeRateLimit(createHmac('sha256', config.rateLimitKey).update(request.ip).digest('hex'), 'human_api', 30, 60_000);
    return { token, csrf };
  }
  const params = (request: FastifyRequest) => request.params as Record<string, string>;
  app.post('/v1/subscriptions/:subscriptionId/mail-approval', async (request, reply) => {
    const identity = await principal(request); enabled();
    const body = object(request.body, ['forceReauth']);
    if (body.forceReauth !== undefined && typeof body.forceReauth !== 'boolean') throw new DomainError('invalid_request', 422);
    const result = await world!.createApproval(identity, id(params(request).subscriptionId), { idempotencyKey: str(request.headers['idempotency-key']), policyVersion: 'mail-v1', ...(body.forceReauth === undefined ? {} : { forceReauth: body.forceReauth }) });
    if (result.status === 'applied' && body.forceReauth !== true) {
      const status = await world!.getOwnerMailStatus(identity, id(params(request).subscriptionId));
      return { status: status.status, destinationConfigured: status.destinationConfigured, physicalForwardingAvailable: false };
    }
    return reply.code(201).send({ approvalId: result.id, status: result.status, expiresAt: result.status === 'applied' ? null : result.expiresAt, approvalUrl: `${config.origin}/approve/${result.id}` });
  });
  app.post('/v1/approvals/:approvalId/owner-challenge', async (request, reply) => {
    const { token, csrf } = await human(request, true); object(request.body, []);
    const result = await world!.issueOwnerChallenge(id(params(request).approvalId), token, csrf, { domain: new URL(config.origin).hostname, chain: 'eip155:84532' });
    return reply.code(201).send({ challengeId: result.id, message: result.message, expiresAt: result.expiresAt });
  });
  app.post('/v1/approvals/:approvalId/owner-proof', async request => {
    const { token, csrf } = await human(request, true); const body = object(request.body, ['challengeId', 'signature']);
    const challenge = await world!.getOwnerChallenge(id(body.challengeId), token);
    if (!challenge) throw new DomainError('invalid_challenge', 403);
    const signature = str(body.signature);
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new DomainError('invalid_signature', 422);
    let recovered: string;
    try { recovered = await recoverMessageAddress({ message: challenge.message, signature: signature as `0x${string}` }); } catch { throw new DomainError('invalid_signature', 403); }
    if (recovered.toLowerCase() !== challenge.address.toLowerCase()) throw new DomainError('invalid_signature', 403);
    await world!.consumeOwnerProof(id(params(request).approvalId), token, csrf, { verified: true, challengeId: id(body.challengeId), walletAddress: recovered, chain: challenge.chain, domain: challenge.domain, message: challenge.message });
    return { walletVerified: true };
  });
  app.get('/v1/approvals/:approvalId', async request => { const { token } = await human(request); const { targetProfileVersion: _profile, targetDestinationVersion: _destination, ...value } = await world!.getApproval(id(params(request).approvalId), token); return { ...value, expiresAt: value.status === 'applied' ? null : value.expiresAt }; });
  app.post('/v1/approvals/:approvalId/authenticate', async request => {
    const { token, csrf } = await human(request, true); object(request.body, []);
    const approvalId = id(params(request).approvalId), state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), pkce = createPkce();
    const attempt = await world!.beginOidc(approvalId, token, csrf, { state, nonce, encryptedPkceVerifier: seal(config.world!.sessionKey, 'pkce', approvalId, pkce.verifier) });
    return { authorizationUrl: client!.authorizationUrl({ state, nonce, codeChallenge: pkce.codeChallenge }), expiresAt: attempt.expiresAt };
  });
  app.get('/auth/world/callback', async (request, reply) => {
    const { token } = await human(request); const query = object(request.query, ['state', 'code', 'error', 'error_description']);
    const attempt = await world!.claimOidc(str(query.state), token);
    let failed = false;
    try {
      if (query.error || !query.code) throw new DomainError('world_authentication_failed', 403);
      const evidence = await client!.exchangeAndVerify({ code: str(query.code), verifier: open(config.world!.sessionKey, 'pkce', attempt.approvalId, attempt.encryptedPkceVerifier), nonce: attempt.nonce, startedAt: attempt.startedAt });
      await world!.finishOidc(attempt.id, token, { verified: true, ...evidence, keyedSubjectHash: subjectHash(config.world!.sessionKey, evidence.issuer, evidence.subject), encryptedIssuer: seal(config.world!.sessionKey, 'issuer', attempt.approvalId, evidence.issuer), encryptedSubject: seal(config.world!.sessionKey, 'subject', attempt.approvalId, evidence.subject) });
      setSession(reply, await world!.rotateSession(token));
    } catch { failed = true; }
    return reply.code(303).header('Location', `/approve/${id(attempt.approvalId)}${failed ? '?world=failed' : ''}`).send();
  });
  app.post('/v1/approvals/:approvalId/decision', async (request, reply) => {
    const { token, csrf } = await human(request, true), body = object(request.body, ['decision', 'actionHash']);
    if (body.decision !== 'approve' && body.decision !== 'deny') throw new DomainError('invalid_request', 422);
    const approvalId = id(params(request).approvalId);
    const result = await world!.decide(approvalId, token, csrf, { decision: body.decision, actionHash: str(body.actionHash) });
    const current = await world!.getApproval(approvalId, token);
    if (body.decision === 'approve') setSession(reply, await world!.rotateSession(token));
    return { approvalId, status: current.status, mail: { status: result.status, destinationConfigured: result.destinationConfigured, physicalForwardingAvailable: false } };
  });
  const profile = async (leaseId: string, token: string) => {
    const value = await world!.getMailProfile(leaseId, token);
    const { encryptedDestination } = value;
    const mail = { status: value.status, destinationConfigured: value.destinationConfigured, physicalForwardingAvailable: false };
    return { subscriptionId: leaseId, version: value.version, mail, destination: value.status === 'enabled' && encryptedDestination ? JSON.parse(open(config.world!.mailKey, 'destination', leaseId, encryptedDestination)) as unknown : null };
  };
  app.get('/v1/subscriptions/:subscriptionId/mail-profile', async request => { const { token } = await human(request); return profile(id(params(request).subscriptionId), token); });
  app.post('/v1/subscriptions/:subscriptionId/mail-destination-approval', async (request, reply) => {
    const { token, csrf } = await human(request, true), leaseId = id(params(request).subscriptionId), body = object(request.body, ['expectedVersion']);
    if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) throw new DomainError('invalid_request', 422);
    const result = await world!.createDestinationApproval(leaseId, token, csrf, { expectedVersion: Number(body.expectedVersion), policyVersion: 'mail-v1' });
    return reply.code(201).send({ approvalId: result.id, status: result.status, expiresAt: result.expiresAt, approvalUrl: `${config.origin}/approve/${result.id}` });
  });
  app.put('/v1/subscriptions/:subscriptionId/mail-destination', async request => {
    const { token, csrf } = await human(request, true), leaseId = id(params(request).subscriptionId), body = object(request.body, ['expectedVersion', 'destination']);
    if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) throw new DomainError('invalid_request', 422);
    const destination = object(body.destination, ['country', 'recipient', 'postalCode', 'prefecture', 'city', 'addressLine1', 'addressLine2']);
    const prefectures = '北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県'.split(' ');
    if (destination.country !== 'JP' || !/^[0-9]{7}$/.test(str(destination.postalCode)) || !prefectures.includes(str(destination.prefecture))) throw new DomainError('invalid_destination', 422);
    for (const [field, max] of [['recipient', 100], ['city', 100], ['addressLine1', 200], ['addressLine2', 200]] as const) {
      if (field === 'addressLine2' && destination[field] === undefined) continue;
      if (typeof destination[field] !== 'string' || destination[field].length > max || (field !== 'addressLine2' && !destination[field].trim()) || /[\u0000-\u001f\u007f]/.test(destination[field])) throw new DomainError('invalid_destination', 422);
    }
    await world!.saveDestination(leaseId, token, csrf, { expectedVersion: Number(body.expectedVersion), encryptedDestination: seal(config.world!.mailKey, 'destination', leaseId, JSON.stringify(destination)) });
    return profile(leaseId, token);
  });
  app.post('/v1/subscriptions/:subscriptionId/mail-disable', async request => {
    const { token, csrf } = await human(request, true), leaseId = id(params(request).subscriptionId), body = object(request.body, ['expectedVersion']);
    if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) throw new DomainError('invalid_request', 422);
    await world!.disableMail(leaseId, token, csrf, { expectedVersion: Number(body.expectedVersion) });
    return profile(leaseId, token);
  });
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.world || !world) return;
    if (request.headers.authorization) throw new DomainError('human_session_required', 401);
    if (!repository) throw new DomainError('world_unavailable', 503);
    await repository.consumeRateLimit(createHmac('sha256', config.rateLimitKey).update(request.ip).digest('hex'), 'human_bootstrap', 10, 60_000);
    const approvalId = id(params(request).approvalId);
    try { await world.validateBrowserSession(approvalId, cookie(request)); return; } catch { /* Renew unavailable browser session. */ }
    const session = await world.createBrowserSession(approvalId);
    setSession(reply, session);
  };
}
