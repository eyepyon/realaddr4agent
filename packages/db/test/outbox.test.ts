import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Firestore } from '@google-cloud/firestore';
import { DomainError, sha256, type PricingConfig } from '@realaddr/domain';
import {
  OutboxRepository,
  RealAddrRepository,
  type AgentPrincipal,
  type VerifiedPurchaseAuthorization,
  type VerifiedPurchaseReceipt,
  type VerifiedRiskAssessment,
} from '../src/index.js';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const prefix = 'realaddr_event_';
const pricing: PricingConfig = {
  profile: 'testnet', network: 'eip155:84532', asset: `0x${'1'.repeat(40)}`, payTo: `0x${'2'.repeat(40)}`,
  decimals: 6, pricingVersion: 'test-v1', addressAmountAtomic: '550000', ensFloorAmountAtomic: '100000', ensCustomAmountAtomic: '300000',
};

function testDb(): Firestore {
  return new Firestore({ projectId: `demo-realaddr-${randomUUID()}`, databaseId: 'realaddr' });
}

function code(expected: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof DomainError && error.code === expected;
}

async function putJob(db: Firestore, id: string, now: Date, state = 'pending'): Promise<void> {
  await db.collection(`${prefix}outbox`).doc(id).create({
    schemaVersion: 1, aggregateId: id, version: 1, eventType: 'payment.settlement_requested',
    payload: { orderId: id }, state, availableAt: now, attempts: 0,
  });
}

test('only one worker can claim a due outbox item', { skip: !emulator }, async () => {
  const db = testDb();
  try {
    const now = new Date('2026-09-26T00:00:00.000Z');
    const outbox = new OutboxRepository(db, prefix, { now: () => now });
    await putJob(db, 'one', now);
    assert.deepEqual(await outbox.listDue(), ['one']);
    const claims = await Promise.all([outbox.claim('one', 'worker-a'), outbox.claim('one', 'worker-b')]);
    assert.equal(claims.filter(Boolean).length, 1);
    const winner = claims.find(Boolean);
    assert.ok(winner);
    assert.equal(winner.claimGeneration, 1);
    assert.equal(await outbox.claim('one', 'worker-c'), null);
    assert.deepEqual(await outbox.listDue(), []);
    await outbox.complete(winner);
    assert.equal((await db.collection(`${prefix}outbox`).doc('one').get()).data()?.state, 'completed');
  } finally {
    await db.terminate();
  }
});

test('expired claims require reconciliation and fence stale completion and retry', { skip: !emulator }, async () => {
  const db = testDb();
  try {
    let clock = Date.parse('2026-09-26T00:00:00.000Z');
    const outbox = new OutboxRepository(db, prefix, { now: () => new Date(clock) });
    await putJob(db, 'reclaim', new Date(clock));
    const first = await outbox.claim('reclaim', 'worker-a');
    assert.ok(first);
    assert.equal(first.reconciliationOnly, false);
    clock += 61_000;
    const second = await outbox.claim('reclaim', 'worker-b');
    assert.ok(second);
    assert.equal(second.claimGeneration, first.claimGeneration + 1);
    assert.equal(second.reconciliationOnly, true);
    await assert.rejects(outbox.complete(first), code('outbox_claim_lost'));
    await assert.rejects(outbox.retry(first), code('outbox_claim_lost'));
    const snap = await db.collection(`${prefix}outbox`).doc('reclaim').get();
    assert.equal(snap.data()?.claimOwner, 'worker-b');
    assert.equal(snap.data()?.claimGeneration, second.claimGeneration);
    await outbox.complete(second);
  } finally {
    await db.terminate();
  }
});

test('retries back off and park at the attempt limit; terminal jobs cannot be reclaimed', { skip: !emulator }, async () => {
  const db = testDb();
  try {
    let clock = Date.parse('2026-09-26T00:00:00.000Z');
    const outbox = new OutboxRepository(db, prefix, { now: () => new Date(clock) });
    await putJob(db, 'bounded', new Date(clock));
    let previousDelay = 0;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claim = await outbox.claim('bounded', `worker-${attempt}`);
      assert.ok(claim);
      const state = await outbox.retry(claim);
      const saved = (await db.collection(`${prefix}outbox`).doc('bounded').get()).data();
      assert.equal(saved?.attempts, attempt);
      if (attempt < 5) {
        assert.equal(state, 'pending');
        assert.equal(saved?.state, 'pending');
        const due = saved?.availableAt.toDate().getTime() as number;
        const delay = due - clock;
        assert.ok(delay >= 5_000 && delay <= 300_000);
        assert.ok(delay >= previousDelay);
        previousDelay = delay;
        assert.equal(await outbox.claim('bounded', 'too-early'), null);
        clock = due;
      } else {
        assert.equal(state, 'manual_review');
        assert.equal(saved?.state, 'manual_review');
      }
    }
    await putJob(db, 'superseded', new Date(clock), 'superseded');
    assert.equal(await outbox.claim('bounded', 'later'), null);
    assert.equal(await outbox.claim('superseded', 'later'), null);
    assert.equal((await db.collection(`${prefix}outbox`).doc('bounded').get()).data()?.state, 'manual_review');
  } finally {
    await db.terminate();
  }
});

async function purchaseFixture(db: Firestore): Promise<{ repo: RealAddrRepository; order: Record<string, unknown>; principal: AgentPrincipal; locationId: string }> {
  const repo = new RealAddrRepository(db, prefix, pricing, { authDomain: 'localhost' });
  const operator = { verified: true as const, subject: 'operator-test' };
  const location = await repo.createLocation(operator, {
    slug: 'tokyo', displayName: 'Tokyo', publicArea: 'Tokyo', postalCode: '1000001',
    address: 'Chiyoda 1-1', status: 'paused', reason: 'Test location',
  }, randomUUID());
  const readiness = { paymentConfigVerified: true as const, riskProviderAvailable: true as const };
  await repo.updateLocation(operator, location.id, {
    expectedVersion: 1, reason: 'Publish test location', publicationConfirmed: true, changes: { status: 'available' },
  }, randomUUID(), readiness);
  const walletAddress = `0x${'a'.repeat(40)}`;
  const challenge = await repo.issueWalletChallenge({ address: walletAddress, chain: pricing.network, domain: 'localhost', termsVersion: 'test-v1' });
  const session = await repo.registerAgentFromVerifiedChallenge({
    verified: true, challengeId: challenge.id, walletAddress, chain: pricing.network,
    domain: 'localhost', message: challenge.message,
  }, 'Test agent');
  const order = await repo.reservePurchaseIntent({ locationId: location.id, floor: 42, idempotencyKey: randomUUID(), principal: session.principal, readiness });
  return { repo, order, principal: session.principal, locationId: location.id };
}

function purchaseEvidence(order: Record<string, unknown>, principal: AgentPrincipal): {
  authorization: VerifiedPurchaseAuthorization;
  risk: { payTo: VerifiedRiskAssessment; payer: VerifiedRiskAssessment };
  receipt: VerifiedPurchaseReceipt;
} {
  const now = new Date();
  const nonce = `0x${randomUUID().replaceAll('-', '').padEnd(64, '0')}`;
  const risk = (subjectAddress: string): VerifiedRiskAssessment => ({
    verified: true, decision: 'allow', subjectAddress, paymentNetwork: pricing.network, riskNetwork: 'eip155:1',
    checkedAt: now, expiresAt: new Date(now.getTime() + 60_000), policyVersion: 'test-policy', responseHash: sha256(`risk:${subjectAddress}:${nonce}`),
  });
  const authorization: VerifiedPurchaseAuthorization = {
    verified: true, network: pricing.network, asset: pricing.asset, payer: principal.walletAddress, payTo: pricing.payTo,
    amountAtomic: pricing.addressAmountAtomic, authorizationNonce: nonce, payloadHash: sha256(`payload:${nonce}`),
    encryptedPayload: { algorithm: 'aes-256-gcm', keyId: 'local-test-key', iv: Buffer.alloc(12, 1).toString('base64'), ciphertext: Buffer.from('local-test-payload').toString('base64'), tag: Buffer.alloc(16, 2).toString('base64') },
    validBefore: new Date(new Date(order.expiresAt as string).getTime() - 1_000),
  };
  const receipt: VerifiedPurchaseReceipt = {
    verified: true, finalityVerified: true, network: authorization.network, asset: authorization.asset,
    payer: authorization.payer, payTo: authorization.payTo, amountAtomic: authorization.amountAtomic,
    authorizationNonce: nonce, txHash: `0x${sha256(`tx:${nonce}`)}`, transferLogIndex: 0,
    confirmedAt: now, evidenceHash: sha256(`evidence:${nonce}`),
  };
  return { authorization, risk: { payTo: risk(pricing.payTo), payer: risk(principal.walletAddress) }, receipt };
}

test('stored confirmed receipt recovers once under the current claim, while old and forged claims cannot issue', { skip: !emulator }, async () => {
  const db = testDb();
  try {
    const { repo, order, principal, locationId } = await purchaseFixture(db);
    const orderId = order.id as string;
    const evidence = purchaseEvidence(order, principal);
    await repo.preparePurchaseSettlement({ orderId, principal, authorization: evidence.authorization, risk: evidence.risk });
    const slot = repo.collections.doc('slots', `${locationId}_42`);
    await slot.update({ state: 'available' });
    assert.equal((await repo.confirmPurchasePayment({ orderId, receipt: evidence.receipt })).status, 'manual_review');
    const storedOrder = (await repo.collections.doc('orders', orderId).get()).data();
    const recoveryId = storedOrder?.recoveryOutboxId as string;
    assert.ok(recoveryId);
    assert.equal((await repo.collections.doc('payments', orderId).get()).data()?.status, 'confirmed');
    assert.equal((await repo.collections.collection('leases').get()).size, 0);

    let clock = Date.now() + 1_000;
    const outbox = new OutboxRepository(db, prefix, { now: () => new Date(clock) });
    const oldClaim = await outbox.claim(recoveryId, 'worker-a');
    assert.ok(oldClaim);
    await assert.rejects(repo.recoverConfirmedPurchaseFromOutbox({
      ...oldClaim, payload: { ...oldClaim.payload, leaseId: randomUUID() },
    }), code('outbox_claim_lost'));
    assert.equal((await repo.collections.collection('leases').get()).size, 0);
    clock += 61_000;
    const currentClaim = await outbox.claim(recoveryId, 'worker-b');
    assert.ok(currentClaim);
    assert.equal(currentClaim.reconciliationOnly, true);
    await slot.update({ state: 'held' });
    await assert.rejects(repo.recoverConfirmedPurchaseFromOutbox(oldClaim), code('outbox_claim_lost'));
    assert.equal((await repo.collections.collection('leases').get()).size, 0);
    const recovered = await repo.recoverConfirmedPurchaseFromOutbox(currentClaim);
    assert.deepEqual(recovered, { orderId, status: 'fulfilled', leaseId: orderId });
    await assert.rejects(repo.recoverConfirmedPurchaseFromOutbox(currentClaim), code('outbox_claim_lost'));
    const lease = (await repo.collections.doc('leases', orderId).get()).data();
    const payment = (await repo.collections.doc('payments', orderId).get()).data();
    assert.equal(lease?.startsAt.toDate().getTime(), evidence.receipt.confirmedAt.getTime());
    assert.equal(payment?.txHash, evidence.receipt.txHash);
    assert.equal((await repo.collections.collection('leases').get()).size, 1);
    assert.equal((await repo.collections.collection('payments').get()).size, 1);
    assert.equal((await repo.collections.collection('outbox').get()).docs.filter(s => s.data().eventType === 'lease.registry_sync_requested').length, 1);
  } finally {
    await db.terminate();
  }
});
