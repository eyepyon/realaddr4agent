import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Firestore } from '@google-cloud/firestore';
import { DomainError, sha256, type PricingConfig } from '@realaddr/domain';
import {
  OutboxRepository,
  OwnerReadRepository,
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

const duration = 30 * 86_400_000;
async function purchased(fixture: Fixture, floor = 42): Promise<string> {
  const order = await reserve(fixture, floor);
  const inputs = verifiedInputs(order, fixture.principal);
  await fixture.repo.preparePurchaseSettlement({ orderId: order.id as string, principal: fixture.principal, authorization: inputs.authorization, risk: inputs.risk });
  const result = await fixture.repo.confirmPurchasePayment({ orderId: order.id as string, receipt: inputs.receipt });
  assert.equal(result.status, 'fulfilled');
  assert.equal(Object.hasOwn(await data(fixture, 'mail_profiles', order.id as string), 'grantExpiresAt'), false);
  return order.id as string;
}
async function renew(fixture: Fixture, leaseId: string): Promise<Record<string, unknown>> {
  return fixture.repo.reserveRenewalIntent({ subscriptionId: leaseId, idempotencyKey: randomUUID(), principal: fixture.principal, readiness });
}
async function prepare(fixture: Fixture, order: Record<string, unknown>) {
  const inputs = verifiedInputs(order, fixture.principal);
  await fixture.repo.prepareRenewalSettlement({ orderId: order.id as string, principal: fixture.principal, authorization: inputs.authorization, risk: inputs.risk });
  return inputs;
}
async function data(fixture: Fixture, collection: Parameters<RealAddrRepository['collections']['doc']>[0], id: string) {
  return (await fixture.repo.collections.doc(collection, id).get()).data()!;
}

test('active and expired renewals apply once to the same lease and slot without new quota or budget', { skip: !emulator }, async () => {
  const f = await makeFixture();
  try {
    const leaseId = await purchased(f);
    const slotBefore = await data(f, 'slots', `${f.locationId}_42`);
    const budgetBefore = (await f.repo.collections.collection('daily_purchase_budgets').get()).docs.map(d => d.data());
    const quotaBefore = (await f.repo.collections.collection('wallet_hold_quotas').get()).docs.map(d => d.data());
    for (const expired of [false, true]) {
      if (expired) await f.repo.collections.doc('leases', leaseId).update({ status: 'expired', expiresAt: new Date(Date.now() - 1_000) });
      const old = await data(f, 'leases', leaseId);
      const order = await renew(f, leaseId);
      const inputs = await prepare(f, order);
      const results = await Promise.all([f.repo.confirmRenewalPayment({ orderId: order.id as string, receipt: inputs.receipt }), f.repo.confirmRenewalPayment({ orderId: order.id as string, receipt: inputs.receipt })]);
      assert.deepEqual(results[0], results[1]);
      assert.equal(results[0]?.status, 'fulfilled');
      const lease = await data(f, 'leases', leaseId);
      assert.equal(lease.version, old.version + 1);
      assert.equal(lease.expiresAt.toMillis(), Math.max(old.expiresAt.toMillis(), inputs.receipt.confirmedAt.getTime()) + duration);
      assert.equal(lease.status, 'active');
      const reads = new OwnerReadRepository(f.db, 'realaddr_event_');
      const publicOrder = await reads.getOrder(f.principal, order.id as string);
      assert.equal(publicOrder.kind, 'renew');
      assert.equal(publicOrder.status, 'fulfilled');
      assert.equal(publicOrder.subscriptionId, leaseId);
      const publicLease = await reads.getSubscription(f.principal, leaseId);
      assert.equal(publicLease.expiresAt, lease.expiresAt.toDate().toISOString());
      assert.equal(publicLease.mail.status, 'disabled');
    }
    assert.equal((await f.repo.collections.collection('leases').get()).size, 1);
    assert.deepEqual(await data(f, 'slots', `${f.locationId}_42`), slotBefore);
    assert.deepEqual((await f.repo.collections.collection('daily_purchase_budgets').get()).docs.map(d => d.data()), budgetBefore);
    assert.deepEqual((await f.repo.collections.collection('wallet_hold_quotas').get()).docs.map(d => d.data()), quotaBefore);
  } finally { await f.db.terminate(); }
});

test('renewal owner, concurrent quote, screening, price and global payment reuse checks fail closed', { skip: !emulator }, async () => {
  const f = await makeFixture();
  try {
    const leaseId = await purchased(f);
    await assert.rejects(f.repo.reserveRenewalIntent({ subscriptionId: leaseId, idempotencyKey: randomUUID(), principal: f.otherPrincipal, readiness }), hasCode('not_found'));
    const quotes = await Promise.allSettled([renew(f, leaseId), renew(f, leaseId)]);
    assert.equal(quotes.filter(q => q.status === 'fulfilled').length, 1);
    assert.equal(quotes.filter(q => q.status === 'rejected' && hasCode('renewal_pending')(q.reason)).length, 1);
    const order = (quotes.find(q => q.status === 'fulfilled') as PromiseFulfilledResult<Record<string, unknown>>).value;
    const inputs = verifiedInputs(order, f.principal);
    await assert.rejects(f.repo.prepareRenewalSettlement({ orderId: order.id as string, principal: f.principal, authorization: { ...inputs.authorization, amountAtomic: '1' }, risk: inputs.risk }), hasCode('payment_authorization_mismatch'));
    await assert.rejects(f.repo.prepareRenewalSettlement({ orderId: order.id as string, principal: f.principal, authorization: inputs.authorization, risk: { ...inputs.risk, payer: { ...inputs.risk.payer, decision: 'hold' } as unknown as VerifiedRiskAssessment } }), hasCode('risk_payer_not_allowed'));
    const other = await reserve(f, 43);
    await f.repo.preparePurchaseSettlement({ orderId: other.id as string, principal: f.principal, authorization: inputs.authorization, risk: inputs.risk });
    await assert.rejects(f.repo.prepareRenewalSettlement({ orderId: order.id as string, principal: f.principal, authorization: inputs.authorization, risk: inputs.risk }), hasCode('payment_authorization_reused'));
    await f.repo.confirmPurchasePayment({ orderId: other.id as string, receipt: inputs.receipt });
    const fresh = await prepare(f, order);
    await assert.rejects(f.repo.confirmRenewalPayment({ orderId: order.id as string, receipt: { ...fresh.receipt, txHash: inputs.receipt.txHash } }), hasCode('payment_receipt_reused'));
  } finally { await f.db.terminate(); }
});

test('unknown renewal retains the guard after expiry until verified unpaid, preserving the previous lease', { skip: !emulator }, async () => {
  const f = await makeFixture();
  try {
    const leaseId = await purchased(f);
    await f.repo.collections.doc('mail_profiles', leaseId).update({ status: 'enabled', enabledByApprovalId: 'test-approval', encryptedDestination: 'test-destination', destinationConfigured: true });
    const mailBefore = await data(f, 'mail_profiles', leaseId);
    const old = await data(f, 'leases', leaseId);
    const order = await renew(f, leaseId);
    const inputs = await prepare(f, order);
    await f.repo.markRenewalSettlementUnknown({ orderId: order.id as string, authorizationNonce: inputs.authorization.authorizationNonce });
    await f.repo.collections.doc('orders', order.id as string).update({ expiresAt: new Date(0) });
    await assert.rejects(f.repo.releaseUnpaidRenewalIntent({ orderId: order.id as string, determination: { kind: 'expired_without_authorization' } }), hasCode('unpaid_not_established'));
    await assert.rejects(renew(f, leaseId), hasCode('renewal_pending'));
    assert.deepEqual(await data(f, 'leases', leaseId), old);
    assert.deepEqual(await data(f, 'mail_profiles', leaseId), mailBefore);
    const proof = { verified: true as const, providerSettlementFinal: true as const, chainFinalityVerified: true as const, noTransferVerified: true as const, network: pricing.network, asset: pricing.asset, payer: f.principal.walletAddress, authorizationNonce: inputs.authorization.authorizationNonce, evidenceHash: sha256('renew-unpaid'), checkedAt: new Date(), irrevocablyCancelled: true as const };
    await f.repo.releaseUnpaidRenewalIntent({ orderId: order.id as string, determination: { kind: 'definitive_unpaid', proof } });
    assert.deepEqual(await data(f, 'leases', leaseId), old);
    assert.deepEqual(await data(f, 'mail_profiles', leaseId), mailBefore);
    const unsigned = await renew(f, leaseId);
    await f.repo.collections.doc('orders', unsigned.id as string).update({ expiresAt: new Date(0) });
    await f.repo.releaseUnpaidRenewalIntent({ orderId: unsigned.id as string, determination: { kind: 'expired_without_authorization' } });
    assert.deepEqual(await data(f, 'leases', leaseId), old);
    assert.deepEqual(await data(f, 'mail_profiles', leaseId), mailBefore);
    await renew(f, leaseId);
  } finally { await f.db.terminate(); }
});

test('paid renewal with changed lease state requires a fenced recovery and uses the stored confirmation time', { skip: !emulator }, async () => {
  const f = await makeFixture();
  try {
    const leaseId = await purchased(f);
    const old = await data(f, 'leases', leaseId);
    const order = await renew(f, leaseId);
    const inputs = await prepare(f, order);
    await f.repo.collections.doc('leases', leaseId).update({ status: 'suspended', version: old.version + 1 });
    assert.equal((await f.repo.confirmRenewalPayment({ orderId: order.id as string, receipt: inputs.receipt })).status, 'manual_review');
    assert.equal((await data(f, 'leases', leaseId)).expiresAt.toMillis(), old.expiresAt.toMillis());
    await assert.rejects(f.repo.confirmRenewalPayment({ orderId: order.id as string, receipt: inputs.receipt }), hasCode('outbox_claim_required'));
    const jobs = (await f.repo.collections.collection('outbox').get()).docs.filter(d => d.data().eventType === 'payment.renewal_recovery_requested');
    assert.equal(jobs.length, 1);
    await f.repo.collections.doc('leases', leaseId).update({ status: old.status, version: old.version });
    const outbox = new OutboxRepository(f.db, 'realaddr_event_');
    const claim = await outbox.claim(jobs[0]!.id, 'renewal-worker');
    assert.ok(claim);
    await assert.rejects(f.repo.recoverConfirmedRenewalFromOutbox({ ...claim, claimGeneration: claim.claimGeneration + 1 }), hasCode('outbox_claim_lost'));
    const result = await f.repo.recoverConfirmedRenewalFromOutbox(claim);
    assert.deepEqual(result, { orderId: order.id, status: 'fulfilled', leaseId });
    assert.equal((await data(f, 'leases', leaseId)).expiresAt.toMillis(), Math.max(old.expiresAt.toMillis(), inputs.receipt.confirmedAt.getTime()) + duration);
    assert.equal((await f.repo.collections.collection('leases').get()).size, 1);
  } finally { await f.db.terminate(); }
});

test('renewal preserves consent and destination across expiry, retains disabled or suspended states and maintains only paid ENS names', { skip: !emulator }, async () => {
  const f = await makeFixture();
  try {
    const leaseId = await purchased(f);
    const encryptedDestination = { algorithm: 'aes-256-gcm', keyId: 'test-key', ciphertext: 'test-ciphertext' };
    await f.repo.collections.doc('mail_profiles', leaseId).update({ status: 'enabled', enabledByApprovalId: 'test-approval', ownerWallet: f.principal.walletAddress, worldHumanId: 'test-human', policyVersion: 'test-policy', encryptedDestination, destinationConfigured: true });
    const consentProfile = await data(f, 'mail_profiles', leaseId);
    await f.repo.collections.doc('approvals', 'test-approval').set({ status: 'applied', leaseId, agentId: f.principal.agentId });
    const appliedConsent = await data(f, 'approvals', 'test-approval');
    await f.repo.collections.doc('approval_heads', leaseId).set({ currentApprovalId: 'test-approval', approvalId: 'test-approval' });
    for (const state of ['pending_payment', 'refund_pending', 'refunded', 'paid']) {
      await f.repo.collections.doc('ens_entitlements', leaseId).set({ schemaVersion: 1, leaseId, state, name: 'f00042.tokyo.test.eth' });
      const order = await renew(f, leaseId);
      assert.equal(order.amountAtomic, pricing.addressAmountAtomic);
      const inputs = await prepare(f, order);
      await f.repo.confirmRenewalPayment({ orderId: order.id as string, receipt: inputs.receipt });
      const jobs = (await f.repo.collections.collection('outbox').get()).docs.filter(d => d.data().eventType === 'ens.lease_sync_requested');
      assert.equal(jobs.length, state === 'paid' ? 1 : 0);
      if (state === 'paid') assert.equal(jobs[0]!.data().version, (await data(f, 'leases', leaseId)).version);
      assert.equal((await data(f, 'ens_entitlements', leaseId)).name, 'f00042.tokyo.test.eth');
      assert.deepEqual(await data(f, 'mail_profiles', leaseId), consentProfile);
      assert.deepEqual(await data(f, 'approvals', 'test-approval'), appliedConsent);
    }
    await f.repo.collections.doc('leases', leaseId).update({ status: 'expired', expiresAt: new Date(Date.now() - 1_000) });
    const revival = await renew(f, leaseId);
    const revivalInputs = await prepare(f, revival);
    await f.repo.confirmRenewalPayment({ orderId: revival.id as string, receipt: revivalInputs.receipt });
    assert.deepEqual(await data(f, 'mail_profiles', leaseId), consentProfile);
    assert.deepEqual(await data(f, 'approvals', 'test-approval'), appliedConsent);
    const head = await data(f, 'approval_heads', leaseId);
    assert.equal(head.currentApprovalId, null);
    assert.equal(head.approvalId, null);
    assert.equal(head.leaseVersion, (await data(f, 'leases', leaseId)).version);
    await assert.rejects(new OwnerReadRepository(f.db, 'realaddr_event_').getSubscription(f.principal, leaseId), e => e instanceof DomainError && e.status === 503);
    for (const status of ['disabled', 'suspended']) {
      await f.repo.collections.doc('mail_profiles', leaseId).update({ status });
      const before = await data(f, 'mail_profiles', leaseId);
      const order = await renew(f, leaseId);
      const inputs = await prepare(f, order);
      await f.repo.confirmRenewalPayment({ orderId: order.id as string, receipt: inputs.receipt });
      assert.deepEqual(await data(f, 'mail_profiles', leaseId), before);
    }
    assert.equal(JSON.stringify((await f.repo.collections.collection('outbox').get()).docs.map(d => d.data())).includes('test-ciphertext'), false);
  } finally { await f.db.terminate(); }
});
