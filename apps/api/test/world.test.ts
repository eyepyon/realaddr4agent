import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seal, open, subjectHash, secretKey } from '../src/world-crypto.js';

test('World and mail envelopes bind purpose, resource and key', () => {
  const key = Buffer.alloc(32, 1), envelope = seal(key, 'destination', 'lease-fixture', 'private-fixture');
  assert.equal(open(key, 'destination', 'lease-fixture', envelope), 'private-fixture');
  assert.throws(() => open(key, 'subject', 'lease-fixture', envelope));
  assert.throws(() => open(key, 'destination', 'other-fixture', envelope));
  assert.throws(() => open(Buffer.alloc(32, 2), 'destination', 'lease-fixture', envelope));
  assert.throws(() => open(key, 'destination', 'lease-fixture', { ...envelope, tag: Buffer.alloc(16).toString('base64') }));
  assert.equal(secretKey(key.toString('base64')).length, 32);
  assert.throws(() => secretKey('invalid'));
  assert.notEqual(subjectHash(key, 'issuer-one', 'subject'), subjectHash(key, 'issuer-two', 'subject'));
});

test('human HTTP routes reject agent bearer and require exact Origin before dependency work', async () => {
  const { createApp } = await import('../src/server.js');
  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig({ APP_ENV: 'local', FIRESTORE_DATABASE_ID: 'realaddr', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8085' });
  const app = createApp(config, null, null);
  try {
    const base = '/v1/approvals/00000000-0000-4000-8000-000000000001';
    const bearer = await app.inject({ method: 'GET', url: base, headers: { authorization: 'Bearer fixture' } });
    assert.equal(bearer.statusCode, 401);
    assert.equal(bearer.json().error, 'human_session_required');
    const missingOrigin = await app.inject({ method: 'POST', url: base + '/decision', headers: { cookie: '__Host-realaddr_session=' + 'x'.repeat(43), 'x-csrf-token': 'fixture' }, payload: { decision: 'approve', actionHash: 'a'.repeat(64) } });
    assert.equal(missingOrigin.statusCode, 403);
    assert.equal(missingOrigin.json().error, 'invalid_origin');
    const disabled = await app.inject({ method: 'GET', url: base, headers: { cookie: '__Host-realaddr_session=' + 'x'.repeat(43) } });
    assert.equal(disabled.statusCode, 503);
    assert.equal(disabled.json().error, 'world_unavailable');
  } finally { await app.close(); }
});

test('browser bootstrap uses host cookies and applied reauth has no request expiry', async () => {
  const Fastify = (await import('fastify')).default;
  const { registerWorldRoutes } = await import('../src/world.js');
  const { loadConfig } = await import('../src/config.js');
  const { DomainError } = await import('@realaddr/domain');
  const config = loadConfig({ APP_ENV: 'event', GCP_PROJECT_ID: 'realaddr-fixture', RESOURCE_PREFIX: 'realaddr-event', FIRESTORE_COLLECTION_PREFIX: 'realaddr_event_', FIRESTORE_DATABASE_ID: 'realaddr', PUBLIC_ORIGIN: 'https://address.chain.tokyo', TERMS_VERSION: 'realaddr-v1', RATE_LIMIT_HMAC_KEY: 'a'.repeat(64), WORLD_ENABLED: 'true', WORLD_CLIENT_ID: 'fixture-client', WORLD_CLIENT_SECRET: 'fixture-secret', WORLD_REDIRECT_URI: 'https://address.chain.tokyo/auth/world/callback', WORLD_SESSION_KEY: Buffer.alloc(32, 1).toString('base64'), MAIL_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64') });
  const approvalId = '00000000-0000-4000-8000-000000000001';
  const view = { id: approvalId, subscriptionId: approvalId, agentId: approvalId, action: 'mail.enable', actionHash: 'a'.repeat(64), status: 'applied', expiresAt: '2020-01-01T00:00:00.000Z', targetProfileVersion: 1, targetDestinationVersion: 1, ownerWallet: '0x' + 'a'.repeat(40), worldAuthenticated: false };
  let created = 0;
  const world = { decide: async () => ({ status: 'enabled', destinationConfigured: false, physicalForwardingAvailable: false }), rotateSession: async () => ({ token: 'r'.repeat(43), csrfToken: 's'.repeat(43), expiresAt: '2030-01-01T00:00:00.000Z' }), createApproval: async () => view, getApproval: async () => view, validateBrowserSession: async (_id: string, token: string) => { if (token !== 'v'.repeat(43)) throw new DomainError('human_session_required', 401); }, createBrowserSession: async () => { created++; return { token: 'v'.repeat(43), csrfToken: 'c'.repeat(43), expiresAt: '2030-01-01T00:00:00.000Z' }; } };
  const repository = { consumeRateLimit: async () => undefined };
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 503).send({ error: error instanceof DomainError ? error.code : 'dependency_unavailable' }));
  const bootstrap = registerWorldRoutes(app, config, repository as never, world as never, async () => ({ tenantId: approvalId, agentId: approvalId, walletAddress: view.ownerWallet, walletChain: 'eip155:84532', credentialId: approvalId }));
  app.get('/approve/:approvalId', async (request, reply) => { await bootstrap(request, reply); return 'fixture'; });
  try {
    const first = await app.inject({ method: 'GET', url: '/approve/' + approvalId });
    assert.equal(first.statusCode, 200);
    const cookies = first.headers['set-cookie'] as unknown as string[];
    assert.equal(cookies.length, 2);
    assert.match(cookies[0]!, /^__Host-realaddr_session=/);
    assert.match(cookies[0]!, /; Path=\/; HttpOnly; SameSite=Lax; Secure$/);
    assert.match(cookies[1]!, /^__Host-realaddr_csrf=/);
    assert.ok(cookies.every(c => !c.includes('Domain=')));
    await app.inject({ method: 'GET', url: '/approve/' + approvalId, headers: { cookie: '__Host-realaddr_session=' + 'v'.repeat(43) } });
    assert.equal(created, 1);
    const link = await app.inject({ method: 'POST', url: '/v1/subscriptions/' + approvalId + '/mail-approval', headers: { 'idempotency-key': 'fixture-key' }, payload: { forceReauth: true } });
    assert.equal(link.statusCode, 201);
    assert.deepEqual(link.json(), { approvalId, status: 'applied', expiresAt: null, approvalUrl: config.origin + '/approve/' + approvalId });
    const current = await app.inject({ method: 'GET', url: '/v1/approvals/' + approvalId, headers: { cookie: '__Host-realaddr_session=' + 'v'.repeat(43) } });
    assert.equal(current.json().expiresAt, null);
    assert.equal(current.json().targetDestinationVersion, undefined);
    const decision = await app.inject({ method: 'POST', url: '/v1/approvals/' + approvalId + '/decision', headers: { origin: config.origin, cookie: '__Host-realaddr_session=' + 'v'.repeat(43), 'x-csrf-token': 'c'.repeat(43) }, payload: { decision: 'approve', actionHash: view.actionHash } });
    assert.equal(decision.statusCode, 200);
    const rotatedCookies = decision.headers['set-cookie'] as unknown as string[];
    assert.match(rotatedCookies[0]!, new RegExp('^__Host-realaddr_session=' + 'r'.repeat(43)));
    assert.match(rotatedCookies[1]!, new RegExp('^__Host-realaddr_csrf=' + 's'.repeat(43)));
    assert.deepEqual(decision.json().mail, { status: 'enabled', destinationConfigured: false, physicalForwardingAvailable: false });
    const duplicate = await app.inject({ method: 'GET', url: '/v1/approvals/' + approvalId, headers: { cookie: '__Host-realaddr_session=' + 'v'.repeat(43) + '; __Host-realaddr_session=' + 'x'.repeat(43) } });
    assert.equal(duplicate.statusCode, 401);
  } finally { await app.close(); }
});
