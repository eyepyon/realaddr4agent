import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Firestore } from '@google-cloud/firestore';
import { DomainError, sha256, validateFloor, type PricingConfig } from '@realaddr/domain';
import { CollectionMapper, RealAddrRepository } from '../src/index.js';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const pricing: PricingConfig = {
  profile: 'testnet', network: 'eip155:84532', asset: `0x${'1'.repeat(40)}`, payTo: `0x${'2'.repeat(40)}`,
  decimals: 6, pricingVersion: 'test-v1', addressAmountAtomic: '550000', ensFloorAmountAtomic: '100000', ensCustomAmountAtomic: '300000',
};

test('floor boundaries and collection prefix fail closed', () => {
  for (const invalid of [0, -1, 1.5, 65536, '1', null]) assert.throws(() => validateFloor(invalid));
  assert.equal(validateFloor(65535), 65535);
  const db = new Firestore({ projectId: `demo-realaddr-${randomUUID()}`, databaseId: 'realaddr' });
  assert.equal(db.databaseId, 'realaddr');
  for (const databaseId of ['(default)', 'other']) {
    const wrongDb = new Firestore({ projectId: 'demo-realaddr-local', databaseId });
    assert.throws(() => new CollectionMapper(wrongDb, 'realaddr_event_'), (error: unknown) => error instanceof DomainError && error.code === 'invalid_firestore_database');
  }
  const implicitDefault = new Firestore({ projectId: 'demo-realaddr-local' });
  assert.throws(() => new CollectionMapper(implicitDefault, 'realaddr_event_'), (error: unknown) => error instanceof DomainError && error.code === 'invalid_firestore_database');
  assert.throws(() => new CollectionMapper(db, ''));
  assert.throws(() => new CollectionMapper(db, 'orders'));
  assert.equal(new CollectionMapper(db, 'realaddr_event_').name('admin_sessions'), 'realaddr_event_admin_sessions');
});

test('Firestore challenge replay, tenant authorization, and concurrent slot hold', { skip: !emulator }, async () => {
  const db = new Firestore({ projectId: `demo-realaddr-${randomUUID()}`, databaseId: 'realaddr' });
  const repo = new RealAddrRepository(db, 'realaddr_event_', pricing, { authDomain: 'localhost' });
  const authOnly = new RealAddrRepository(db, 'realaddr_event_', null, { authDomain: 'localhost' });
  assert.throws(() => authOnly.pricing, (error: unknown) => error instanceof DomainError && error.code === 'pricing_unavailable');
  const operator = { verified: true as const, subject: 'operator-test' };
  await repo.consumeRateLimit(sha256('test-subject'), 'wallet_challenge', 1, 60_000);
  await assert.rejects(repo.consumeRateLimit(sha256('test-subject'), 'wallet_challenge', 1, 60_000), (error: unknown) => error instanceof DomainError && error.code === 'rate_limit');
  const location = await repo.createLocation(operator, { slug: 'tokyo', displayName: 'Tokyo', publicArea: 'Tokyo', postalCode: '1000001', address: 'Chiyoda 1-1', status: 'paused', reason: 'Test location' }, randomUUID());
  await repo.updateLocation(operator, location.id, { expectedVersion: 1, reason: 'Publish test location', publicationConfirmed: true, changes: { status: 'available' } }, randomUUID(), { paymentConfigVerified: true, riskProviderAvailable: true });
  const wallet = `0x${'a'.repeat(40)}`;
  const challenge = await repo.issueWalletChallenge({ address: wallet, chain: 'eip155:84532', domain: 'localhost', termsVersion: 'test-v1' });
  assert.equal((await repo.getWalletChallenge(challenge.id))?.message, challenge.message);
  const session = await repo.registerAgentFromVerifiedChallenge({ verified: true, challengeId: challenge.id, walletAddress: wallet, chain: 'eip155:84532', domain: 'localhost', message: challenge.message }, 'Test agent');
  await assert.rejects(repo.registerAgentFromVerifiedChallenge({ verified: true, challengeId: challenge.id, walletAddress: wallet, chain: 'eip155:84532', domain: 'localhost', message: challenge.message }, 'Test agent'), (error: unknown) => error instanceof DomainError && error.code === 'invalid_challenge');
  assert.equal((await repo.authenticateBearer(session.token)).agentId, session.principal.agentId);

  const readiness = { paymentConfigVerified: true as const, riskProviderAvailable: true as const };
  const results = await Promise.allSettled([repo.reservePurchaseIntent({ locationId: location.id, floor: 42, idempotencyKey: randomUUID(), principal: session.principal, readiness }), repo.reservePurchaseIntent({ locationId: location.id, floor: 42, idempotencyKey: randomUUID(), principal: session.principal, readiness })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason instanceof DomainError && r.reason.code === 'slot_unavailable').length, 1);
  const winner = results.find(r => r.status === 'fulfilled');
  assert.ok(winner && winner.status === 'fulfilled');
  const orderId = winner.value.id as string;
  assert.equal((await repo.getOwnedOrder(session.principal, orderId)).id, orderId);
  await assert.rejects(repo.getOwnedOrder({ ...session.principal, tenantId: randomUUID() }, orderId), (error: unknown) => error instanceof DomainError && error.code === 'not_found');
  assert.equal(await repo.isFloorAvailable(location.id, 42), false);
  assert.equal((await repo.getPublicLocation(location.id))?.availableSlots, 65534);
  await db.terminate();
});
