import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PublicOrder, VerifiedPurchaseAuthorization } from '@realaddr/db';
import { InterceptaClient, type RiskAssessment } from '@realaddr/intercepta';
import { prepareScreenedAddressSettlement, type ScreeningDependencies } from '../src/payment-screening.js';

const payer = `0x${'a'.repeat(40)}`;
const payTo = `0x${'b'.repeat(40)}`;
const asset = `0x${'c'.repeat(40)}`;
const initial = new Date('2026-01-01T00:00:00Z');
function fixture(kind: 'purchase' | 'renew' = 'purchase') {
  let clock = initial;
  let prepareCalls = 0;
  const scans: string[] = [];
  const order: PublicOrder = { id: 'order', kind, status: 'awaiting_payment', locationId: 'location', floor: 42, amountAtomic: '550000', network: 'eip155:84532', asset, payTo, expiresAt: new Date(initial.getTime() + 600_000).toISOString(), createdAt: initial.toISOString(), riskAssessments: [], payPath: '/unused' };
  const authorization: VerifiedPurchaseAuthorization = { verified: true, payer, payTo, asset, network: 'eip155:84532', amountAtomic: '550000', authorizationNonce: `0x${'1'.repeat(64)}`, payloadHash: '2'.repeat(64), validBefore: new Date(initial.getTime() + 300_000), encryptedPayload: { algorithm: 'aes-256-gcm', keyId: 'test', iv: '', ciphertext: '', tag: '' } };
  const assessment = (address: string): RiskAssessment => ({ provider: 'intercepta', subjectAddress: address, paymentNetwork: 'eip155:84532', riskNetwork: 'eip155:1', decision: 'allow', reasonCodes: ['test_allow'], checkedAt: initial, expiresAt: new Date(initial.getTime() + 60_000), policyVersion: 'test-policy', responseHash: '3'.repeat(64) });
  const prepare: ScreeningDependencies['repository']['preparePurchaseSettlement'] = async input => {
    prepareCalls++;
    assert.equal(scans.length, 2);
    assert.equal(input.risk.payer.subjectAddress, payer);
    assert.equal(input.risk.payTo.subjectAddress, payTo);
    return { orderId: input.orderId, status: 'settling' };
  };
  const dependencies: ScreeningDependencies = { orders: { getOrder: async () => order }, repository: { preparePurchaseSettlement: prepare, prepareRenewalSettlement: prepare }, intercepta: { assessAddress: async address => { scans.push(address); return assessment(address); } }, now: () => clock };
  const request = { kind, orderId: 'order', principal: { tenantId: 'tenant', agentId: 'agent', walletAddress: payer, walletChain: 'eip155:84532', credentialId: 'credential' }, authorization };
  return { dependencies, request, order, assessment, scans, calls: () => prepareCalls, setClock: (now: Date) => { clock = now; } };
}

test('synthetic allow evidence binds both exact parties before purchase and renewal preparation', async () => {
  for (const kind of ['purchase', 'renew'] as const) {
    const f = fixture(kind);
    assert.equal((await prepareScreenedAddressSettlement(f.dependencies, f.request)).decision, 'allow');
    assert.deepEqual(f.scans, [payTo, payer]);
    assert.equal(f.calls(), 1);
  }
});

test('deny and unknown decisions never prepare settlement', async () => {
  for (const decision of ['deny', 'hold', 'unknown'] as const) {
    const f = fixture();
    f.dependencies.intercepta.assessAddress = async address => ({ ...f.assessment(address), decision: decision as RiskAssessment['decision'], reasonCodes: ['test_denial', 'unsafe provider text'] });
    const result = await prepareScreenedAddressSettlement(f.dependencies, f.request);
    assert.equal(result.decision, decision === 'deny' ? 'deny' : 'hold');
    assert.deepEqual(result.reasonCodes, ['test_denial']);
    assert.equal(f.calls(), 0);
  }
});

test('age is checked after the second asynchronous scan', async () => {
  const f = fixture();
  f.dependencies.intercepta.assessAddress = async address => {
    if (address === payer) f.setClock(new Date(initial.getTime() + 60_001));
    return f.assessment(address);
  };
  assert.equal((await prepareScreenedAddressSettlement(f.dependencies, f.request)).decision, 'hold');
  assert.equal(f.calls(), 0);
});

test('mismatched subject, network or unknown coverage cannot authorize preparation', async () => {
  for (const mismatch of [{ subjectAddress: asset }, { paymentNetwork: 'eip155:1' }, { riskNetwork: 'unknown' }]) {
    const f = fixture();
    f.dependencies.intercepta.assessAddress = async address => ({ ...f.assessment(address), ...mismatch } as RiskAssessment);
    assert.equal((await prepareScreenedAddressSettlement(f.dependencies, f.request)).decision, 'hold');
    assert.equal(f.calls(), 0);
  }
});

test('verified authorization must match canonical quote and authenticated payer before live scans', async () => {
  for (const mismatch of [{ payTo: payer }, { payer: payTo }, { amountAtomic: '1' }, { network: 'eip155:1' }]) {
    const f = fixture();
    Object.assign(f.request.authorization, mismatch);
    await assert.rejects(prepareScreenedAddressSettlement(f.dependencies, f.request), /payment_authorization_mismatch/);
    assert.equal(f.calls(), 0);
    assert.equal(f.scans.length, 0);
  }
});

test('provider failure holds without executing preparation', async () => {
  const f = fixture();
  f.dependencies.intercepta.assessAddress = async () => { throw new Error('sensitive upstream message'); };
  assert.deepEqual(await prepareScreenedAddressSettlement(f.dependencies, f.request), { decision: 'hold', reasonCodes: ['screening_unavailable'] });
  assert.equal(f.calls(), 0);
});

test('existing payment and closed quotes route away from screening and preparation', async () => {
  for (const status of ['settling', 'fulfilled', 'reconciling', 'manual_review']) {
    const f = fixture();
    f.order.status = status;
    assert.deepEqual(await prepareScreenedAddressSettlement(f.dependencies, f.request), { decision: 'hold', reasonCodes: ['existing_payment_requires_reconciliation'] });
    assert.equal(f.scans.length, 0);
    assert.equal(f.calls(), 0);
  }
  for (const closed of ['status', 'order_expiry', 'authorization_expiry']) {
    const f = fixture();
    if (closed === 'status') f.order.status = 'expired';
    if (closed === 'order_expiry') f.order.expiresAt = initial.toISOString();
    if (closed === 'authorization_expiry') f.request.authorization.validBefore = initial;
    assert.deepEqual(await prepareScreenedAddressSettlement(f.dependencies, f.request), { decision: 'hold', reasonCodes: ['payment_order_closed'] });
    assert.equal(f.scans.length, 0);
    assert.equal(f.calls(), 0);
  }
});

test('actual InterceptaClient transport bridge holds a low-score response pending policy review', async () => {
  const f = fixture();
  let transportCalls = 0;
  f.dependencies.intercepta = new InterceptaClient({ apiKey: 'unit-test-key', fetch: async () => {
    transportCalls++;
    return new Response(JSON.stringify({ toxicScore: 0, traits: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const result = await prepareScreenedAddressSettlement(f.dependencies, f.request);
  assert.equal(result.decision, 'hold');
  assert.equal(transportCalls, 2);
  assert.equal(f.calls(), 0);
});
