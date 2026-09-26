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
const pricing: PricingConfig = {
  profile: 'testnet', network: 'eip155:84532', asset: `0x${'1'.repeat(40)}`, payTo: `0x${'2'.repeat(40)}`,
  decimals: 6, pricingVersion: 'test-v1', addressAmountAtomic: '550000', ensFloorAmountAtomic: '100000', ensCustomAmountAtomic: '300000',
};
const readiness = { paymentConfigVerified: true as const, riskProviderAvailable: true as const };

interface Fixture {
  db: Firestore;
  repo: RealAddrRepository;
  locationId: string;
  principal: AgentPrincipal;
  otherPrincipal: AgentPrincipal;
}

async function makeFixture(): Promise<Fixture> {
  const db = new Firestore({ projectId: `demo-realaddr-${randomUUID()}`, databaseId: '(default)' });
  try {
    const repo = new RealAddrRepository(db, 'realaddr_event_', pricing, { authDomain: 'localhost' });
    const operator = { verified: true as const, subject: 'operator-test' };
    const location = await repo.createLocation(operator, { slug: 'tokyo', displayName: 'Tokyo', publicArea: 'Tokyo', postalCode: '1000001', address: 'Chiyoda 1-1', status: 'paused', reason: 'Test location' }, randomUUID());
    await repo.updateLocation(operator, location.id, { expectedVersion: 1, reason: 'Publish test location', publicationConfirmed: true, changes: { status: 'available' } }, randomUUID(), readiness);
    async function register(wallet: string): Promise<AgentPrincipal> {
      const challenge = await repo.issueWalletChallenge({ address: wallet, chain: pricing.network, domain: 'localhost', termsVersion: 'test-v1' });
      const session = await repo.registerAgentFromVerifiedChallenge({ verified: true, challengeId: challenge.id, walletAddress: wallet, chain: pricing.network, domain: 'localhost', message: challenge.message }, 'Test agent');
      return session.principal;
    }
    return { db, repo, locationId: location.id, principal: await register(`0x${'a'.repeat(40)}`), otherPrincipal: await register(`0x${'b'.repeat(40)}`) };
  } catch (error) {
    await db.terminate();
    throw error;
  }
}

async function reserve(fixture: Fixture, floor: number, principal = fixture.principal): Promise<Record<string, unknown>> {
  return fixture.repo.reservePurchaseIntent({ locationId: fixture.locationId, floor, idempotencyKey: randomUUID(), principal, readiness });
}

// These are local verified-input fixtures for repository boundaries, not provider responses or live settlement evidence.
function verifiedInputs(order: Record<string, unknown>, principal: AgentPrincipal, nonce = `0x${randomUUID().replaceAll('-', '').padEnd(64, '0')}`): { authorization: VerifiedPurchaseAuthorization; risk: { payTo: VerifiedRiskAssessment; payer: VerifiedRiskAssessment }; receipt: VerifiedPurchaseReceipt } {
  const now = new Date();
  const risk = (subjectAddress: string): VerifiedRiskAssessment => ({ verified: true, decision: 'allow', subjectAddress, paymentNetwork: pricing.network, riskNetwork: 'eip155:1', checkedAt: now, expiresAt: new Date(now.getTime() + 60_000), policyVersion: 'test-policy', responseHash: sha256(`risk:${subjectAddress}:${nonce}`) });
  const authorization: VerifiedPurchaseAuthorization = {
    verified: true, network: pricing.network, asset: pricing.asset, payer: principal.walletAddress, payTo: pricing.payTo,
    amountAtomic: pricing.addressAmountAtomic, authorizationNonce: nonce, payloadHash: sha256(`payload:${nonce}`),
    encryptedPayload: { algorithm: 'aes-256-gcm', keyId: 'local-test-key', iv: Buffer.alloc(12, 1).toString('base64'), ciphertext: Buffer.from('local-test-payload').toString('base64'), tag: Buffer.alloc(16, 2).toString('base64') },
    validBefore: new Date(new Date(order.expiresAt as string).getTime() - 1_000),
  };
  const receipt: VerifiedPurchaseReceipt = {
    verified: true, finalityVerified: true, network: authorization.network, asset: authorization.asset, payer: authorization.payer, payTo: authorization.payTo,
    amountAtomic: authorization.amountAtomic, authorizationNonce: authorization.authorizationNonce,
    txHash: `0x${sha256(`tx:${nonce}`)}`, transferLogIndex: 0, confirmedAt: now, evidenceHash: sha256(`evidence:${nonce}`),
  };
  return { authorization, risk: { payTo: risk(pricing.payTo), payer: risk(principal.walletAddress) }, receipt };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof DomainError && error.code === code;
}

test('confirmed purchase retries create one lease, payment, and registry job with mail disabled and no ENS add-on', { skip: !emulator }, async () => {
  const fixture = await makeFixture();
  try {
    const order = await reserve(fixture, 42);
    const inputs = verifiedInputs(order, fixture.principal);
    await fixture.repo.preparePurchaseSettlement({ orderId: order.id as string, principal: fixture.principal, authorization: inputs.authorization, risk: inputs.risk });
    const results = await Promise.all([
      fixture.repo.confirmPurchasePayment({ orderId: order.id as string, receipt: inputs.receipt }),
      fixture.repo.confirmPurchasePayment({ orderId: order.id as string, receipt: inputs.receipt }),
    ]);
    assert.deepEqual(results[0], results[1]);
    const [orders, payments, leases, mail, ens, outbox, slot] = await Promise.all([
      fixture.repo.collections.doc('orders', order.id as string).get(), fixture.repo.collections.collection('payments').get(),
      fixture.repo.collections.collection('leases').get(), fixture.repo.collections.collection('mail_profiles').get(),
      fixture.repo.collections.collection('ens_entitlements').get(), fixture.repo.collections.collection('outbox').get(),
      fixture.repo.collections.doc('slots', `${fixture.locationId}_42`).get(),
    ]);
    assert.equal(orders.data()?.status, 'fulfilled');
    assert.equal(payments.size, 1);
    assert.equal(payments.docs[0]?.data().status, 'confirmed');
    assert.equal(leases.size, 1);
    assert.equal(leases.docs[0]?.data().status, 'active');
    assert.equal(slot.data()?.state, 'leased');
    assert.equal(mail.size, 1);
    assert.equal(mail.docs[0]?.data().status, 'disabled');
    assert.equal(ens.size, 0);
    assert.equal(outbox.docs.filter(s => String(s.data().eventType).includes('registry')).length, 1);
    assert.equal(outbox.docs.filter(s => String(s.data().eventType).includes('ens')).length, 0);
  } finally {
    await fixture.db.terminate();
  }
});

test('purchase settlement rejects quote, payer, risk, tenant, and payment replay mismatches', { skip: !emulator }, async () => {
  const fixture = await makeFixture();
  try {
    const first = await reserve(fixture, 43);
    const second = await reserve(fixture, 44);
    const one = verifiedInputs(first, fixture.principal);
    await assert.rejects(fixture.repo.preparePurchaseSettlement({ orderId: first.id as string, principal: fixture.otherPrincipal, authorization: one.authorization, risk: one.risk }), hasCode('not_found'));
    await assert.rejects(fixture.repo.preparePurchaseSettlement({ orderId: first.id as string, principal: fixture.principal, authorization: { ...one.authorization, amountAtomic: '1' }, risk: one.risk }), hasCode('payment_authorization_mismatch'));
    await assert.rejects(fixture.repo.preparePurchaseSettlement({ orderId: first.id as string, principal: fixture.principal, authorization: { ...one.authorization, payer: fixture.otherPrincipal.walletAddress }, risk: one.risk }), hasCode('payment_authorization_mismatch'));
    await assert.rejects(fixture.repo.preparePurchaseSettlement({ orderId: first.id as string, principal: fixture.principal, authorization: { ...one.authorization, validBefore: new Date(0) }, risk: one.risk }), hasCode('payment_authorization_expired'));
    await assert.rejects(fixture.repo.preparePurchaseSettlement({ orderId: first.id as string, principal: fixture.principal, authorization: one.authorization, risk: { ...one.risk, payer: { ...one.risk.payer, expiresAt: new Date(0) } } }), hasCode('risk_payer_not_allowed'));
    const unknownVerdict = { ...one.risk.payer, decision: 'unknown_verdict' } as unknown as VerifiedRiskAssessment;
    await assert.rejects(fixture.repo.preparePurchaseSettlement({ orderId: first.id as string, principal: fixture.principal, authorization: one.authorization, risk: { ...one.risk, payer: unknownVerdict } }), hasCode('risk_payer_not_allowed'));
    await fixture.repo.preparePurchaseSettlement({ orderId: first.id as string, principal: fixture.principal, authorization: one.authorization, risk: one.risk });
    assert.equal((await fixture.repo.preparePurchaseSettlement({ orderId: first.id as string, principal: fixture.principal, authorization: one.authorization, risk: { ...one.risk, payer: { ...one.risk.payer, expiresAt: new Date(0) } } })).status, 'settling');
    await assert.rejects(fixture.repo.preparePurchaseSettlement({ orderId: second.id as string, principal: fixture.principal, authorization: one.authorization, risk: one.risk }), hasCode('payment_authorization_reused'));
    await fixture.repo.confirmPurchasePayment({ orderId: first.id as string, receipt: one.receipt });
    const two = verifiedInputs(second, fixture.principal);
    await fixture.repo.preparePurchaseSettlement({ orderId: second.id as string, principal: fixture.principal, authorization: two.authorization, risk: two.risk });
    await assert.rejects(fixture.repo.confirmPurchasePayment({ orderId: second.id as string, receipt: { ...two.receipt, txHash: one.receipt.txHash, transferLogIndex: one.receipt.transferLogIndex } }), hasCode('payment_receipt_reused'));
  } finally {
    await fixture.db.terminate();
  }
});

test('unknown settlement keeps the original slot, wallet quota, and budget after hold expiry and restart', { skip: !emulator }, async () => {
  const fixture = await makeFixture();
  try {
    const order = await reserve(fixture, 45);
    const inputs = verifiedInputs(order, fixture.principal);
    await fixture.repo.preparePurchaseSettlement({ orderId: order.id as string, principal: fixture.principal, authorization: inputs.authorization, risk: inputs.risk });
    await fixture.repo.markPurchaseSettlementUnknown({ orderId: order.id as string, authorizationNonce: inputs.authorization.authorizationNonce });
    const persisted = await fixture.repo.collections.doc('orders', order.id as string).get();
    await fixture.repo.collections.doc('orders', order.id as string).update({ expiresAt: new Date(0) });
    await fixture.repo.collections.doc('slots', `${fixture.locationId}_45`).update({ holdExpiresAt: new Date(0) });
    const restarted = new RealAddrRepository(fixture.db, 'realaddr_event_', pricing, { authDomain: 'localhost' });
    await assert.rejects(restarted.releaseUnpaidPurchaseHold({ orderId: order.id as string, determination: { kind: 'expired_without_authorization' } }), hasCode('unpaid_not_established'));
    assert.equal((await restarted.getOwnedOrder(fixture.principal, order.id as string)).status, 'reconciling');
    assert.equal(await restarted.isFloorAvailable(fixture.locationId, 45), false);
    const quota = await restarted.collections.collection('wallet_hold_quotas').get();
    const budget = await restarted.collections.doc('daily_purchase_budgets', persisted.data()?.budgetDay as string).get();
    assert.equal(quota.docs[0]?.data().heldCount, 1);
    assert.equal(budget.data()?.reserved, 1);
  } finally {
    await fixture.db.terminate();
  }
});

test('definitive unpaid proof releases once against the original budget day; an unsigned expired hold releases separately', { skip: !emulator }, async () => {
  const fixture = await makeFixture();
  try {
    const paidAttempt = await reserve(fixture, 46);
    const inputs = verifiedInputs(paidAttempt, fixture.principal);
    const currentDay = (await fixture.repo.collections.doc('orders', paidAttempt.id as string).get()).data()?.budgetDay as string;
    const originalDay = new Date(Date.parse(`${currentDay}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
    await fixture.repo.collections.doc('orders', paidAttempt.id as string).update({ budgetDay: originalDay });
    await fixture.repo.collections.doc('daily_purchase_budgets', originalDay).set({ schemaVersion: 1, day: originalDay, reserved: 1, consumed: 0 });
    await fixture.repo.collections.doc('daily_purchase_budgets', currentDay).update({ reserved: 0 });
    await fixture.repo.preparePurchaseSettlement({ orderId: paidAttempt.id as string, principal: fixture.principal, authorization: inputs.authorization, risk: inputs.risk });
    await fixture.repo.markPurchaseSettlementUnknown({ orderId: paidAttempt.id as string, authorizationNonce: inputs.authorization.authorizationNonce });
    const proof = {
      verified: true as const, providerSettlementFinal: true as const, chainFinalityVerified: true as const, noTransferVerified: true as const,
      network: pricing.network, asset: pricing.asset, payer: fixture.principal.walletAddress,
      authorizationNonce: inputs.authorization.authorizationNonce, evidenceHash: sha256('definitive-unpaid'), checkedAt: new Date(),
      irrevocablyCancelled: true as const,
    };
    const { irrevocablyCancelled: _cancelled, ...incompleteProof } = proof;
    await assert.rejects(fixture.repo.releaseUnpaidPurchaseHold({ orderId: paidAttempt.id as string, determination: { kind: 'definitive_unpaid', proof: incompleteProof } }), hasCode('unpaid_not_established'));
    await fixture.repo.releaseUnpaidPurchaseHold({ orderId: paidAttempt.id as string, determination: { kind: 'definitive_unpaid', proof } });
    await fixture.repo.releaseUnpaidPurchaseHold({ orderId: paidAttempt.id as string, determination: { kind: 'definitive_unpaid', proof } });
    assert.equal((await fixture.repo.collections.doc('daily_purchase_budgets', originalDay).get()).data()?.reserved, 0);
    assert.equal((await fixture.repo.collections.doc('daily_purchase_budgets', currentDay).get()).data()?.reserved, 0);
    assert.equal((await fixture.repo.collections.collection('wallet_hold_quotas').get()).docs[0]?.data().heldCount, 0);
    assert.equal(await fixture.repo.isFloorAvailable(fixture.locationId, 46), true);
    const unsigned = await reserve(fixture, 47);
    await fixture.repo.collections.doc('orders', unsigned.id as string).update({ expiresAt: new Date(0) });
    await fixture.repo.releaseUnpaidPurchaseHold({ orderId: unsigned.id as string, determination: { kind: 'expired_without_authorization' } });
    assert.equal(await fixture.repo.isFloorAvailable(fixture.locationId, 47), true);
    assert.equal((await fixture.repo.collections.doc('daily_purchase_budgets', originalDay).get()).data()?.reserved, 0);
    assert.equal((await fixture.repo.collections.doc('daily_purchase_budgets', currentDay).get()).data()?.reserved, 0);
  } finally {
    await fixture.db.terminate();
  }
});

test('a confirmed receipt with a broken hold is retained for one same-payment issuance recovery', { skip: !emulator }, async () => {
  const fixture = await makeFixture();
  try {
    const order = await reserve(fixture, 48);
    const inputs = verifiedInputs(order, fixture.principal);
    await fixture.repo.preparePurchaseSettlement({ orderId: order.id as string, principal: fixture.principal, authorization: inputs.authorization, risk: inputs.risk });
    const slotRef = fixture.repo.collections.doc('slots', `${fixture.locationId}_48`);
    await slotRef.update({ state: 'available' });
    const first = await fixture.repo.confirmPurchasePayment({ orderId: order.id as string, receipt: inputs.receipt });
    assert.equal(first.status, 'manual_review');
    await assert.rejects(fixture.repo.confirmPurchasePayment({ orderId: order.id as string, receipt: inputs.receipt }), hasCode('outbox_claim_required'));
    assert.equal((await fixture.repo.preparePurchaseSettlement({ orderId: order.id as string, principal: fixture.principal, authorization: inputs.authorization, risk: inputs.risk })).status, 'manual_review');
    assert.equal((await fixture.repo.markPurchaseSettlementUnknown({ orderId: order.id as string, authorizationNonce: inputs.authorization.authorizationNonce })).status, 'manual_review');
    await assert.rejects(fixture.repo.confirmPurchasePayment({ orderId: order.id as string, receipt: { ...inputs.receipt, confirmedAt: new Date(inputs.receipt.confirmedAt.getTime() - 1_000) } }), hasCode('outbox_claim_required'));
    assert.equal((await fixture.repo.collections.doc('orders', order.id as string).get()).data()?.status, 'manual_review');
    assert.equal((await fixture.repo.collections.doc('payments', order.id as string).get()).data()?.status, 'confirmed');
    assert.equal((await fixture.repo.collections.collection('leases').get()).size, 0);
    const pendingOutbox = await fixture.repo.collections.collection('outbox').get();
    const recoveryJobs = pendingOutbox.docs.filter(s => s.data().eventType === 'payment.issuance_recovery_requested');
    assert.equal(recoveryJobs.length, 1);
    const recoveryId = recoveryJobs[0]!.id;
    await slotRef.update({ state: 'held' });
    await assert.rejects(fixture.repo.confirmPurchasePayment({ orderId: order.id as string, receipt: inputs.receipt }), hasCode('outbox_claim_required'));
    const outbox = new OutboxRepository(fixture.db, 'realaddr_event_', { now: () => new Date(Date.now() + 1_000) });
    const claim = await outbox.claim(recoveryId, 'test-worker');
    assert.ok(claim);
    const recovered = await fixture.repo.recoverConfirmedPurchaseFromOutbox(claim);
    assert.deepEqual(recovered, { orderId: order.id, status: 'fulfilled', leaseId: order.id });
    const lease = (await fixture.repo.collections.doc('leases', order.id as string).get()).data();
    assert.equal(lease?.startsAt.toDate().getTime(), inputs.receipt.confirmedAt.getTime());
    assert.equal(lease?.expiresAt.toDate().getTime(), inputs.receipt.confirmedAt.getTime() + 30 * 86_400_000);
    assert.equal((await fixture.repo.collections.collection('payments').get()).size, 1);
    assert.equal((await fixture.repo.collections.collection('leases').get()).size, 1);
    assert.equal((await fixture.repo.collections.collection('outbox').get()).docs.filter(s => s.data().eventType === 'lease.registry_sync_requested').length, 1);
  } finally {
    await fixture.db.terminate();
  }
});
