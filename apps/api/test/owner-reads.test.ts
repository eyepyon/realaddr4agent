import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Firestore } from '@google-cloud/firestore';
import { RealAddrRepository } from '@realaddr/db';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';

test('owner HTTP reads authenticate, isolate, paginate and preserve closed integrations', { skip: !process.env.FIRESTORE_EMULATOR_HOST }, async () => {
  const config = loadConfig({ ...process.env, APP_ENV: 'local', GCP_PROJECT_ID: `demo-realaddr-${randomUUID()}` });
  const db = new Firestore({ projectId: config.projectId });
  const repo = new RealAddrRepository(db, config.collectionPrefix, null, { authDomain: 'localhost' });
  const app = createApp(config, repo, db);
  try {
    async function register(address: string) {
      const c = await repo.issueWalletChallenge({ address, chain: 'eip155:84532', domain: 'localhost', termsVersion: config.termsVersion });
      // Verified local boundary fixture; no provider success or HTTP authentication bypass.
      return repo.registerAgentFromVerifiedChallenge({ verified: true, challengeId: c.id, walletAddress: address, chain: 'eip155:84532', domain: 'localhost', message: c.message }, 'Test');
    }
    const owner = await register(`0x${'a'.repeat(40)}`);
    const other = await register(`0x${'b'.repeat(40)}`);
    const now = new Date();
    const ids = [randomUUID(), randomUUID()].sort().reverse();
    const locationId = randomUUID();
    for (const id of ids) {
      const owned = { schemaVersion: 1, id, tenantId: owner.principal.tenantId, agentId: owner.principal.agentId, ownerWallet: owner.principal.walletAddress };
      await repo.collections.doc('orders', id!).set({ ...owned, kind: 'purchase', status: 'reconciling', buildingId: locationId, slotNumber: 42, amountAtomic: '550000', network: 'eip155:84532', asset: `0x${'1'.repeat(40)}`, payTo: `0x${'2'.repeat(40)}`, expiresAt: now, createdAt: now, encryptedPayload: 'PRIVATE_MARKER', authorizationNonce: 'PRIVATE_MARKER' });
      await repo.collections.doc('leases', id!).set({ ...owned, buildingId: locationId, slotNumber: 42, addressSnapshot: { postalCode: '1000001', address: 'Test building' }, status: 'active', startsAt: new Date(now.getTime() - 1000), expiresAt: new Date(now.getTime() - 1), version: 1, chainSyncStatus: 'pending', updatedAt: now, worldSubject: 'PRIVATE_MARKER' });
      await repo.collections.doc('mail_profiles', id!).set({ schemaVersion: 1, leaseId: id, status: 'disabled', destinationConfigured: true, encryptedDestination: 'PRIVATE_MARKER' });
    }
    const get = (url: string, token = owner.token) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
    assert.equal((await app.inject({ method: 'GET', url: '/v1/subscriptions' })).statusCode, 401);
    for (const base of ['/v1/subscriptions', '/v1/payment-intents']) {
      const key = base.endsWith('subscriptions') ? 'subscriptions' : 'paymentIntents';
      const first = await get(`${base}?limit=1`);
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.headers['cache-control'], 'no-store');
      assert.equal(first.headers['x-robots-tag'], 'noindex, nofollow');
      assert.ok(first.headers['x-trace-id']);
      const page = first.json();
      assert.equal(page[key][0].id, ids[0]);
      const next = await get(`${base}?limit=1&cursor=${page.nextCursor}`);
      assert.equal(next.statusCode, 200, next.body);
      assert.equal(next.json()[key][0].id, ids[1]);
      assert.equal(next.json().nextCursor, null);
      for (const url of [`${base}?limit=2&cursor=${page.nextCursor}`, `${base}?limit=1&cursor=${page.nextCursor}x`, `${base}?limit=1&cursor=bad`, `${base}?limit=1&cursor=${page.nextCursor}%3D`, `${base}?unknown=1`, `${base}?limit=1&limit=2`, `${base}/not-uuid`, `${base}/${ids[0]}?limit=1`]) assert.equal((await get(url)).statusCode, 422, url);
      assert.equal((await get(`${base}?limit=1&cursor=${page.nextCursor}`, other.token)).statusCode, 422);
      const otherBase = key === 'subscriptions' ? '/v1/payment-intents' : '/v1/subscriptions';
      assert.equal((await get(`${otherBase}?limit=1&cursor=${page.nextCursor}`)).statusCode, 422);
      assert.equal((await get(`${base}/${ids[0]}`, other.token)).statusCode, 404);
      assert.equal((await get(`${base}/${randomUUID()}`)).statusCode, 404);
      assert.equal(first.body.includes('PRIVATE_MARKER'), false);
    }
    const lease = await get(`/v1/subscriptions/${ids[0]}`);
    assert.equal(lease.json().status, 'expired');
    assert.equal(Object.hasOwn(lease.json().mail, 'grantExpiresAt'), false);
    assert.equal(lease.body.includes('PRIVATE_MARKER'), false);
    const ens = await get(`/v1/subscriptions/${ids[0]}/ens`);
    assert.deepEqual(ens.json(), { status: 'not_purchased', network: 'eip155:11155111' });
    assert.equal((await get(`/v1/subscriptions/${ids[0]}/ens`, other.token)).statusCode, 404);
    assert.equal((await get(`/v1/subscriptions/${ids[0]}/mail-profile`)).statusCode, 401);
    assert.equal((await get('/v1/subscriptions/by-ens?name=test.eth')).statusCode, 503);
    for (const url of ['/v1/payment-intents', `/v1/payment-intents/${ids[0]}/pay`, `/v1/subscriptions/${ids[0]}/mail-approval`, `/v1/subscriptions/${ids[0]}/ens-description-transaction`]) assert.equal((await app.inject({ method: 'POST', url, payload: {}, headers: { authorization: `Bearer ${owner.token}` } })).statusCode, 503);
    // Resolve Fastify's installed AJV dependency without adding a package dependency.
    const require = createRequire(import.meta.url);
    const fastifyRequire = createRequire(require.resolve('fastify'));
    const compilerRequire = createRequire(fastifyRequire.resolve('@fastify/ajv-compiler'));
    const Ajv = compilerRequire('ajv');
    const api = JSON.parse(await readFile(new URL('../../../docs/openapi.json', import.meta.url), 'utf8'));
    const ajv = new Ajv({ strict: false, validateFormats: false });
    ajv.addSchema({ $id: 'contract', components: api.components });
    for (const [schema, body] of [['Lease', lease.json()], ['EnsStatus', ens.json()], ['Order', (await get(`/v1/payment-intents/${ids[0]}`)).json()]]) {
      const validate = ajv.compile({ $ref: `contract#/components/schemas/${schema}` });
      assert.ok(validate(body), JSON.stringify(validate.errors));
    }
    await repo.collections.doc('mail_profiles', ids[0]!).update({ status: 'suspended' });
    assert.equal((await get(`/v1/subscriptions/${ids[0]}`)).json().mail.status, 'suspended');
    await repo.collections.doc('mail_profiles', ids[0]!).update({ status: 'enabled', enabledByApprovalId: 'test-applied-approval' });
    assert.equal((await get(`/v1/subscriptions/${ids[0]}`)).statusCode, 503);
    await repo.collections.doc('mail_profiles', ids[0]!).update({ status: 'disabled' });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    for (const [group, flag] of [['lease', '--subscription'], ['intent', '--intent']] as const) {
      const cli = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url)), fileURLToPath(new URL('../../../packages/agent-cli/src/index.ts', import.meta.url)), group, 'status', flag, ids[0]!, '--json'], { env: { ...process.env, AGENT_API_ORIGIN: origin, AGENT_API_TOKEN: owner.token }, timeout: 20_000 });
      assert.equal(JSON.parse(cli.stdout).id, ids[0]);
      assert.equal(cli.stdout.includes('PRIVATE_MARKER'), false);
    }
    await repo.revokeCredential(owner.principal);
    assert.equal((await get('/v1/subscriptions')).statusCode, 401);
  } finally { await app.close(); await db.terminate(); }
});
