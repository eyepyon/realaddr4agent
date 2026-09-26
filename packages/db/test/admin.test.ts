import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Firestore } from '@google-cloud/firestore';
import { DomainError, sha256, type PricingConfig } from '@realaddr/domain';
import { AdminRepository, RealAddrRepository } from '../src/index.js';
const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const pricing: PricingConfig = { profile: 'testnet', network: 'eip155:84532', asset: `0x${'1'.repeat(40)}`, payTo: `0x${'2'.repeat(40)}`, decimals: 6, pricingVersion: 'test-v1', addressAmountAtomic: '550000', ensFloorAmountAtomic: '100000', ensCustomAmountAtomic: '300000' };
const readiness = { paymentConfigVerified: true as const, riskProviderAvailable: true as const };
const identity = { issuer: 'https://accounts.google.com', subject: 'test-operator-subject', email: 'operator@example.invalid', displayName: 'Operator', tokenHash: sha256('session-fixture'), csrfHash: sha256('csrf-fixture') };
const input = { slug: 'test-location', displayName: 'Test location', publicArea: 'Test public area', postalCode: '1000001', address: 'Test address', status: 'paused' as const, reason: 'Create test location' };
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
async function fixture() {
  const db = new Firestore({ projectId: `demo-realaddr-${randomUUID()}`, databaseId: 'realaddr' }); let now = new Date('2026-01-01T00:00:00Z');
  const repo = new AdminRepository(db, 'realaddr_event_', pricing, { now: () => now, cursorSecret: 'local-test-cursor-secret-at-least-32-characters' });
  await repo.bootstrapPrincipals([identity.email]); await repo.bindAndIssueSession(identity);
  return { db, repo, setNow: (date: Date) => { now = date; }, now: () => now };
}
test('admin login refuses an absent allowlist and cannot be claimed by another browser or reused', { skip: !emulator }, async () => {
  const f = await fixture();
  try {
    const login = { stateHash: sha256('state'), nonceHash: sha256('nonce'), cookieHash: sha256('browser'), encryptedVerifier: { algorithm: 'aes-256-gcm' as const, keyId: 'local-key', iv: Buffer.alloc(12, 1).toString('base64'), tag: Buffer.alloc(16, 2).toString('base64'), ciphertext: Buffer.from('encrypted-fixture').toString('base64') }, expiresAt: new Date(f.now().getTime() + 300000) };
    await f.repo.issueLogin(login);
    await assert.rejects(f.repo.consumeLogin(login.stateHash, sha256('other-browser')), code('admin_login_invalid'));
    assert.equal((await f.repo.consumeLogin(login.stateHash, login.cookieHash)).nonceHash, login.nonceHash);
    await assert.rejects(f.repo.consumeLogin(login.stateHash, login.cookieHash), code('admin_login_invalid'));
    await f.repo.collections.doc('admin_principals', sha256(identity.email)).delete();
    await assert.rejects(f.repo.issueLogin({ ...login, stateHash: sha256('new-state') }), code('admin_unavailable'));
  } finally { await f.db.terminate(); }
});
test('principal binding is immutable and bootstrap preserves binding and revocation', { skip: !emulator }, async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.repo.bindAndIssueSession({ ...identity, subject: 'different-subject', tokenHash: sha256('other-session') }), code('admin_identity_conflict'));
    const ref = f.repo.collections.doc('admin_principals', sha256(identity.email)), before = (await ref.get()).data()!;
    await f.repo.bootstrapPrincipals([identity.email.toUpperCase()]); assert.deepEqual((await ref.get()).data(), before);
    await ref.update({ status: 'revoked' }); await f.repo.bootstrapPrincipals([identity.email]); assert.equal((await ref.get()).data()!.status, 'revoked');
    await assert.rejects(f.repo.authenticateSession(identity.tokenHash), code('admin_session_required'));
  } finally { await f.db.terminate(); }
});
test('session checks idle and absolute expiry and logout invalidates current identity', { skip: !emulator }, async () => {
  const f = await fixture();
  try {
    f.setNow(new Date('2026-01-01T00:14:00Z')); assert.equal((await f.repo.authenticateSession(identity.tokenHash)).subject, identity.subject);
    f.setNow(new Date('2026-01-01T00:29:00Z')); await assert.rejects(f.repo.authenticateSession(identity.tokenHash), code('admin_session_required'));
    f.setNow(new Date('2026-01-01T00:00:00Z')); await f.repo.bindAndIssueSession({ ...identity, tokenHash: sha256('logout-session') }); await f.repo.revokeSession(sha256('logout-session')); await assert.rejects(f.repo.authenticateSession(sha256('logout-session')), code('admin_session_required'));
    await f.repo.bindAndIssueSession({ ...identity, tokenHash: sha256('absolute-session') });
    for (const minute of [14, 28, 42, 56]) { f.setNow(new Date(`2026-01-01T00:${minute}:00Z`)); await f.repo.authenticateSession(sha256('absolute-session')); }
    f.setNow(new Date('2026-01-01T01:00:00Z')); await assert.rejects(f.repo.authenticateSession(sha256('absolute-session')), code('admin_session_required'));
  } finally { await f.db.terminate(); }
});
test('location create is paused, idempotent, slug unique and audited without private data', { skip: !emulator }, async () => {
  const f = await fixture();
  try {
    const key = randomUUID(), first = await f.repo.createLocation(identity.tokenHash, input, key, 'test-trace');
    assert.deepEqual(await f.repo.createLocation(identity.tokenHash, input, key, 'second-trace'), first);
    await assert.rejects(f.repo.createLocation(identity.tokenHash, { ...input, displayName: 'Changed' }, key, 'test-trace'), code('idempotency_conflict'));
    await assert.rejects(f.repo.createLocation(identity.tokenHash, input, randomUUID(), 'test-trace'), code('slug_unavailable'));
    const location = (await f.repo.collections.doc('buildings', first.id).get()).data()!; assert.equal(location.status, 'paused'); assert.equal(location.addressUseEnabled, false); assert.equal(location.postalCode, '100-0001'); assert.equal(location.capacity, 65535); assert.equal(location.plan.amountAtomic, '550000');
    assert.equal((await f.repo.collections.collection('slot_shards').where('locationId', '==', first.id).get()).size, 64);
    const audit = (await f.repo.collections.collection('audit_events').get()).docs[0]!.data(); assert.equal(audit.traceId, 'test-trace'); assert.equal(audit.actorId.includes(identity.subject), false); assert.equal(Object.hasOwn(audit, 'address'), false);
    const listed = await f.repo.list('locations', identity.tokenHash, { id: first.id }); assert.equal((listed.locations as Record<string, unknown>[])[0]!.issuedSubscriptionCount, 0);
    assert.equal((await f.repo.overview(identity.tokenHash)).available, false);
  } finally { await f.db.terminate(); }
});
test('resume needs explicit publication and dependencies, mutations recheck revoked principals', { skip: !emulator }, async () => {
  const f = await fixture();
  try {
    const created = await f.repo.createLocation(identity.tokenHash, input, randomUUID(), 'test-trace');
    const resume = { expectedVersion: 1, reason: 'Resume test location', changes: { status: 'available' as const } };
    await assert.rejects(f.repo.updateLocation(identity.tokenHash, created.id, resume, randomUUID(), 'test-trace', readiness), code('publication_confirmation_required'));
    await assert.rejects(f.repo.updateLocation(identity.tokenHash, created.id, { ...resume, publicationConfirmed: true }, randomUUID(), 'test-trace'), code('payment_dependency_unavailable'));
    const updated = await f.repo.updateLocation(identity.tokenHash, created.id, { ...resume, publicationConfirmed: true }, randomUUID(), 'test-trace', readiness); assert.equal(updated.version, 2);
    await assert.rejects(f.repo.updateLocation(identity.tokenHash, created.id, { expectedVersion: 1, reason: 'Pause test location', changes: { status: 'paused' } }, randomUUID(), 'test-trace'), error => code('version_conflict')(error) && (error as DomainError & { currentVersion: number }).currentVersion === 2);
    await f.repo.collections.doc('admin_principals', sha256(identity.email)).update({ status: 'revoked' });
    await assert.rejects(f.repo.updateLocation(identity.tokenHash, created.id, { expectedVersion: 2, reason: 'Pause test location', changes: { status: 'paused' } }, randomUUID(), 'test-trace'), code('admin_session_required'));
  } finally { await f.db.terminate(); }
});
test('provided address is immutable with a hold, uncertain order, or any historical lease', { skip: !emulator }, async () => {
  const f = await fixture();
  try {
    const created = await f.repo.createLocation(identity.tokenHash, input, randomUUID(), 'test-trace'), update = { expectedVersion: 1, reason: 'Edit provided address', changes: { address: 'Changed test address' } };
    const shard = f.repo.collections.doc('slot_shards', `${created.id}_0`);
    await shard.update({ held: `${'0'.repeat(255)}1`, freeCount: 1023 });
    await assert.rejects(f.repo.updateLocation(identity.tokenHash, created.id, update, randomUUID(), 'test-trace'), code('location_address_locked'));
    await shard.update({ held: '0'.repeat(256), freeCount: 1024 });
    const order = f.repo.collections.doc('orders', randomUUID()); await order.create({ buildingId: created.id, status: 'reconciling' });
    await assert.rejects(f.repo.updateLocation(identity.tokenHash, created.id, update, randomUUID(), 'test-trace'), code('location_address_locked'));
    await order.delete(); await f.repo.collections.doc('leases', randomUUID()).create({ buildingId: created.id, status: 'expired' });
    await assert.rejects(f.repo.updateLocation(identity.tokenHash, created.id, update, randomUUID(), 'test-trace'), code('location_address_locked'));
  } finally { await f.db.terminate(); }
});
test('admin cursor binds principal, filters, list kind and limit and rejects forged cursor', { skip: !emulator }, async () => {
  const f = await fixture();
  try {
    for (let index = 0; index < 3; index++) await f.repo.createLocation(identity.tokenHash, { ...input, slug: `test-${index}` }, randomUUID(), 'test-trace');
    const first = await f.repo.list('locations', identity.tokenHash, { limit: 1 }); assert.equal((first.locations as unknown[]).length, 1); assert.equal(typeof first.nextCursor, 'string');
    const next = await f.repo.list('locations', identity.tokenHash, { limit: 1, cursor: first.nextCursor as string }); assert.notDeepEqual(next.locations, first.locations);
    await assert.rejects(f.repo.list('locations', identity.tokenHash, { limit: 2, cursor: first.nextCursor as string }), code('invalid_cursor'));
    await assert.rejects(f.repo.list('locations', identity.tokenHash, { limit: 1, cursor: `${first.nextCursor}x` }), code('invalid_cursor'));
    const other = { ...identity, email: 'other@example.invalid', subject: 'other-operator', tokenHash: sha256('other-cursor-session') }; await f.repo.bootstrapPrincipals([other.email]); await f.repo.bindAndIssueSession(other);
    await assert.rejects(f.repo.list('locations', other.tokenHash, { limit: 1, cursor: first.nextCursor as string }), code('invalid_cursor'));
    await assert.rejects(f.repo.list('locations', identity.tokenHash, { id: randomUUID(), status: 'paused' }), code('invalid_admin_query'));
    await assert.rejects(f.repo.list('audit', identity.tokenHash, { targetId: randomUUID() }), code('invalid_admin_query'));
  } finally { await f.db.terminate(); }
});
test('safe admin projections exclude credentials, forwarding data and raw receipts', { skip: !emulator }, async () => {
  const f = await fixture();
  try {
    const id = randomUUID(), now = f.now(), privateValue = 'private-field-must-not-appear';
    await f.repo.collections.doc('orders', id).create({ schemaVersion: 1, id, buildingId: randomUUID(), slotNumber: 42, kind: 'purchase', amountAtomic: '550000', status: 'reconciling', createdAt: now, updatedAt: now, encryptedPayload: privateValue, authorization: privateValue, receipt: privateValue });
    const payments = await f.repo.list('payments', identity.tokenHash, { id }); assert.equal(JSON.stringify(payments).includes(privateValue), false); assert.equal((payments.paymentIntents as Record<string, unknown>[])[0]!.riskVerdict, 'unknown');
    await f.repo.collections.doc('leases', id).create({ schemaVersion: 1, id, buildingId: randomUUID(), slotNumber: 42, status: 'active', expiresAt: new Date(now.getTime() + 100000), updatedAt: now, chainSyncStatus: 'pending', ownerWallet: `0x${'3'.repeat(40)}`, agentId: randomUUID(), addressSnapshot: { address: privateValue } });
    await f.repo.collections.doc('mail_profiles', id).create({ schemaVersion: 1, leaseId: id, status: 'enabled', destinationConfigured: true, version: 1, destinationVersion: 1, enabledByApprovalId: randomUUID(), encryptedDestination: privateValue });
    const subscriptions = await f.repo.list('subscriptions', identity.tokenHash, { id }), subscription = (subscriptions.subscriptions as Record<string, unknown>[])[0]!;
    assert.equal(subscription.mailEnabled, false); assert.equal(subscription.destinationConfigured, true); assert.equal(subscription.ensNameType, null); assert.equal(JSON.stringify(subscriptions).includes(privateValue), false);
    await f.repo.collections.doc('leases', id).update({ chainSyncStatus: 'synced' });
    assert.equal(((await f.repo.list('subscriptions', identity.tokenHash, { id })).subscriptions as Record<string, unknown>[])[0]!.registryStatus, 'pending');
    await assert.rejects(f.repo.createLocation(identity.tokenHash, { ...input, displayName: undefined } as unknown as typeof input, randomUUID(), 'test-trace'), code('invalid_location_input'));
  } finally { await f.db.terminate(); }
});
test('missing pricing disables creation and admin throttle has independent persisted buckets', { skip: !emulator }, async () => {
  const f = await fixture();
  try {
    const unpriced = new AdminRepository(f.db, 'realaddr_event_', null, { now: f.now }); await assert.rejects(unpriced.createLocation(identity.tokenHash, input, randomUUID(), 'test-trace'), code('pricing_unavailable'));
    const business = new RealAddrRepository(f.db, 'realaddr_event_', pricing), subject = sha256('test-throttle'); await business.consumeRateLimit(subject, 'admin_login', 1, 60000); await assert.rejects(business.consumeRateLimit(subject, 'admin_login', 1, 60000), code('rate_limit')); await business.consumeRateLimit(subject, 'admin_api', 1, 60000);
  } finally { await f.db.terminate(); }
});
