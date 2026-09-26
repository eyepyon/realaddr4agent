import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Firestore } from '@google-cloud/firestore';
import { DomainError, sha256, type PricingConfig } from '@realaddr/domain';
import { EnsRepository, ensLabel, type EnsSaleConfig, OutboxRepository, RegistryRepository, OwnerReadRepository, RealAddrRepository, type AgentPrincipal, type VerifiedPurchaseAuthorization, type VerifiedPurchaseReceipt, type VerifiedRiskAssessment, } from '../src/index.js';
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
    const db = new Firestore({ projectId: `demo-realaddr-${randomUUID()}`, databaseId: 'realaddr' });
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
    }
    catch (error) {
        await db.terminate();
        throw error;
    }
}
async function reserve(fixture: Fixture, floor: number, principal = fixture.principal): Promise<Record<string, unknown>> {
    return fixture.repo.reservePurchaseIntent({ locationId: fixture.locationId, floor, idempotencyKey: randomUUID(), principal, readiness });
}
// These are local verified-input fixtures for repository boundaries, not provider responses or live settlement evidence.
function verifiedInputs(order: Record<string, unknown>, principal: AgentPrincipal, nonce = `0x${randomUUID().replaceAll('-', '').padEnd(64, '0')}`): {
    authorization: VerifiedPurchaseAuthorization;
    risk: {
        payTo: VerifiedRiskAssessment;
        payer: VerifiedRiskAssessment;
    };
    receipt: VerifiedPurchaseReceipt;
} {
    const now = new Date();
    const risk = (subjectAddress: string): VerifiedRiskAssessment => ({ verified: true, decision: 'allow', subjectAddress, paymentNetwork: pricing.network, riskNetwork: 'eip155:1', checkedAt: now, expiresAt: new Date(now.getTime() + 60000), policyVersion: 'test-policy', responseHash: sha256(`risk:${subjectAddress}:${nonce}`) });
    const authorization: VerifiedPurchaseAuthorization = {
        verified: true, network: pricing.network, asset: pricing.asset, payer: principal.walletAddress, payTo: pricing.payTo,
        amountAtomic: pricing.addressAmountAtomic, authorizationNonce: nonce, payloadHash: sha256(`payload:${nonce}`),
        encryptedPayload: { algorithm: 'aes-256-gcm', keyId: 'local-test-key', iv: Buffer.alloc(12, 1).toString('base64'), ciphertext: Buffer.from('local-test-payload').toString('base64'), tag: Buffer.alloc(16, 2).toString('base64') },
        validBefore: new Date(new Date(order.expiresAt as string).getTime() - 1000),
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
async function purchased(fixture: Fixture, floor = 42): Promise<string> {
    const order = await reserve(fixture, floor);
    const inputs = verifiedInputs(order, fixture.principal);
    await fixture.repo.preparePurchaseSettlement({ orderId: order.id as string, principal: fixture.principal, authorization: inputs.authorization, risk: inputs.risk });
    const result = await fixture.repo.confirmPurchasePayment({ orderId: order.id as string, receipt: inputs.receipt });
    assert.equal(result.status, 'fulfilled');
    assert.equal(Object.hasOwn(await data(fixture, 'mail_profiles', order.id as string), 'grantExpiresAt'), false);
    return order.id as string;
}
async function data(fixture: Fixture, collection: Parameters<RealAddrRepository['collections']['doc']>[0], id: string) {
    return (await fixture.repo.collections.doc(collection, id).get()).data()!;
}
const ensConfig: EnsSaleConfig = { verified: true, network: 'eip155:11155111', parentName: 'example.eth', upperRegistry: pricing.asset, controller: pricing.payTo, resolverFactory: pricing.asset, leaseRegistry: pricing.payTo, universalResolver: pricing.asset };
async function ensFixture(f: Fixture, leaseId: string) { const l = await data(f, 'leases', leaseId); await f.repo.collections.doc('ens_namespaces', f.locationId).set({ schemaVersion: 1, status: 'verified', network: ensConfig.network, parentName: ensConfig.parentName, locationSlug: 'tokyo', upperRegistry: ensConfig.upperRegistry, locationRegistry: pricing.payTo, namespaceName: 'tokyo.example.eth', parentExpiresAt: l.expiresAt, expiresAt: l.expiresAt, verifiedAt: new Date(), evidenceHash: sha256('local namespace evidence'), blockHash: '0x' + 'c'.repeat(64) }); return new EnsRepository(f.db, 'realaddr_event_', pricing, ensConfig); }
async function ensQuote(repo: EnsRepository, f: Fixture, id: string, label?: string, key = randomUUID()) { return repo.reserveEnsAddonIntent({ subscriptionId: id, nameType: label ? 'custom' : 'floor', ...(label ? { customLabel: label } : {}), principal: f.principal, idempotencyKey: key, readiness }); }
function ensInputs(order: Record<string, unknown>, f: Fixture) { const inputs = verifiedInputs(order, f.principal); inputs.authorization.amountAtomic = order.amountAtomic as string; inputs.receipt.amountAtomic = order.amountAtomic as string; return inputs; }
test('ENS label policy protects standard namespace and reserved words', () => {
    assert.equal(ensLabel('floor', 42), 'f00042');
    assert.equal(ensLabel('custom', 42, 'agent-42'), 'agent-42');
    for (const label of ['admin', 'api', 'www', 'f42', 'Agent', 'ab', 'a'.repeat(33), 'agent.eth', '-abc', 'abc-'])
        assert.throws(() => ensLabel('custom', 42, label), hasCode('invalid_ens_label'));
});
test('ENS addon quotes are gated, canonical, idempotent and exclude competing names', { skip: !emulator }, async () => {
    const f = await makeFixture();
    try {
        const id = await purchased(f), repo = await ensFixture(f, id);
        await assert.rejects(ensQuote(new EnsRepository(f.db, 'realaddr_event_', pricing), f, id), hasCode('ens_sale_unavailable'));
        const key = randomUUID(), q = await ensQuote(repo, f, id, 'agent-42', key);
        assert.equal(q.amountAtomic, '300000');
        assert.equal(q.fqdn, 'agent-42.tokyo.example.eth');
        assert.equal(await repo.getResolutionCandidate(q.fqdn as string), null);
        await assert.rejects(repo.reserveEnsAddonIntent({ subscriptionId: id, principal: f.otherPrincipal, idempotencyKey: randomUUID(), readiness }), hasCode('not_found'));
        assert.deepEqual(await ensQuote(repo, f, id, 'agent-42', key), q);
        await assert.rejects(ensQuote(repo, f, id, 'different', key), hasCode('idempotency_conflict'));
        await assert.rejects(ensQuote(repo, f, id), hasCode('ens_already_reserved'));
        const second = await purchased(f, 43);
        await ensFixture(f, second);
        await assert.rejects(ensQuote(repo, f, second, 'agent-42'), hasCode('ens_name_unavailable'));
        await f.repo.collections.doc('ens_namespaces', f.locationId).update({ verifiedAt: new Date(Date.now() - 61000) });
        await assert.rejects(ensQuote(repo, f, second), hasCode('ens_namespace_unverified'));
    }
    finally {
        await f.db.terminate();
    }
});
test('ENS unknown payment retains name and confirmed receipt atomically buys once despite lease suspension', { skip: !emulator }, async () => {
    const f = await makeFixture();
    try {
        const id = await purchased(f), repo = await ensFixture(f, id), q = await ensQuote(repo, f, id), v = ensInputs(q, f);
        assert.equal(q.amountAtomic, '100000');
        await assert.rejects(repo.prepareEnsAddonSettlement({ orderId: q.id as string, principal: f.principal, authorization: v.authorization, risk: { ...v.risk, payer: { ...v.risk.payer, decision: 'hold' as 'allow' } } }), hasCode('risk_payer_not_allowed'));
        await repo.prepareEnsAddonSettlement({ orderId: q.id as string, principal: f.principal, ...v });
        await repo.markEnsAddonSettlementUnknown({ orderId: q.id as string, authorizationNonce: v.authorization.authorizationNonce });
        await f.repo.collections.doc('orders', q.id as string).update({ expiresAt: new Date(Date.now() - 1) });
        await assert.rejects(repo.releaseUnpaidEnsAddonIntent({ orderId: q.id as string, determination: { kind: 'expired_without_authorization' } }), hasCode('unpaid_not_established'));
        await f.repo.collections.doc('leases', id).update({ status: 'suspended' });
        const results = await Promise.all([repo.confirmEnsAddonPayment({ orderId: q.id as string, receipt: v.receipt }), repo.confirmEnsAddonPayment({ orderId: q.id as string, receipt: v.receipt })]);
        assert.deepEqual(results[0], results[1]);
        const ent = await data(f, 'ens_entitlements', id);
        assert.equal(ent.state, 'paid');
        assert.equal(ent.normalizedName, 'f00042.tokyo.example.eth');
        assert.equal(ent.paidPaymentId, q.id);
        const candidate = await repo.getResolutionCandidate('f00042.tokyo.example.eth');
        assert.equal(candidate?.state, 'paid');
        assert.equal(candidate?.lease.id, id);
        assert.equal(candidate?.binding, null);
        await f.repo.collections.doc('payments', q.id as string).update({ evidenceHash: sha256('tampered') });
        await assert.rejects(repo.getResolutionCandidate('f00042.tokyo.example.eth'), hasCode('ens_payment_unverified'));
        await f.repo.collections.doc('payments', q.id as string).update({ evidenceHash: v.receipt.evidenceHash });
        const job = await data(f, 'outbox', sha256(JSON.stringify([id, '1', 'ens.lease_sync_requested'])));
        assert.equal(job.state, 'blocked');
        assert.equal((await data(f, 'payments', q.id as string)).encryptedPayload, null);
        await assert.rejects(ensQuote(repo, f, id, 'new-name'), hasCode('lease_not_active'));
        const second = await purchased(f, 43);
        await ensFixture(f, second);
        const secondQuote = await ensQuote(repo, f, second);
        const secondInputs = ensInputs(secondQuote, f);
        await repo.prepareEnsAddonSettlement({ orderId: secondQuote.id as string, principal: f.principal, ...secondInputs });
        await assert.rejects(repo.confirmEnsAddonPayment({ orderId: secondQuote.id as string, receipt: { ...secondInputs.receipt, txHash: v.receipt.txHash } }), hasCode('payment_receipt_reused'));
        assert.equal((await data(f, 'ens_entitlements', second)).state, 'pending_payment');
    }
    finally {
        await f.db.terminate();
    }
});
test('ENS definitive unpaid releases pending reservation without touching paid address', { skip: !emulator }, async () => {
    const f = await makeFixture();
    try {
        const id = await purchased(f), repo = await ensFixture(f, id), q = await ensQuote(repo, f, id, 'my-agent'), v = ensInputs(q, f);
        await repo.prepareEnsAddonSettlement({ orderId: q.id as string, principal: f.principal, ...v });
        await repo.markEnsAddonSettlementUnknown({ orderId: q.id as string, authorizationNonce: v.authorization.authorizationNonce });
        await repo.releaseUnpaidEnsAddonIntent({ orderId: q.id as string, determination: { kind: 'definitive_unpaid', proof: { verified: true, providerSettlementFinal: true, chainFinalityVerified: true, noTransferVerified: true, network: pricing.network, asset: pricing.asset, payer: f.principal.walletAddress, authorizationNonce: v.authorization.authorizationNonce, evidenceHash: sha256('unpaid proof'), checkedAt: new Date(), irrevocablyCancelled: true } } });
        assert.equal((await data(f, 'leases', id)).status, 'active');
        assert.equal((await f.repo.collections.doc('ens_entitlements', id).get()).exists, false);
        const next = await ensQuote(repo, f, id, 'my-agent');
        assert.notEqual(next.id, q.id);
    }
    finally {
        await f.db.terminate();
    }
});
test('ENS unsigned description persistence freezes a current paid binding and rejects replay changes', { skip: !emulator }, async () => {
    const f = await makeFixture();
    try {
        const id = await purchased(f), repo = await ensFixture(f, id), q = await ensQuote(repo, f, id), v = ensInputs(q, f);
        await repo.prepareEnsAddonSettlement({ orderId: q.id as string, principal: f.principal, ...v });
        await repo.confirmEnsAddonPayment({ orderId: q.id as string, receipt: v.receipt });
        const leaseKey = '0x' + 'e'.repeat(64);
        await f.repo.collections.doc('leases', id).update({ leaseKey });
        await f.repo.collections.doc('ens_bindings', id).set({ schemaVersion: 1, leaseId: id, normalizedName: q.fqdn, ownerWallet: f.principal.walletAddress, leaseKey, syncedLeaseVersion: 1, status: 'ready', resolverAddress: pricing.asset, controllerAddress: ensConfig.controller, registryAddress: pricing.payTo });
        const tx = { network: 'eip155:11155111' as const, chainId: 11155111 as const, from: f.principal.walletAddress, to: pricing.asset, data: '0x1234', value: '0' as const, name: q.fqdn as string, key: 'description' as const, expiresAt: new Date(Date.now() + 60000).toISOString(), maxGasAtomic: '100000' };
        const input = { principal: f.principal, leaseId: id, idempotencyKey: randomUUID(), description: 'Agent', expectedLeaseVersion: 1, verifiedAt: new Date(), transaction: tx };
        assert.deepEqual(await repo.persistDescriptionTransaction(input), tx);
        assert.deepEqual(await repo.persistDescriptionTransaction(input), tx);
        await assert.rejects(repo.persistDescriptionTransaction({ ...input, description: 'Changed' }), hasCode('idempotency_conflict'));
        await assert.rejects(repo.persistDescriptionTransaction({ ...input, idempotencyKey: randomUUID(), expectedLeaseVersion: 2 }), hasCode('lease_version_conflict'));
        await assert.rejects(repo.persistDescriptionTransaction({ ...input, idempotencyKey: randomUUID(), transaction: { ...tx, to: pricing.payTo } }), hasCode('ens_description_transaction_mismatch'));
        const guard = sha256(JSON.stringify(['agent', f.principal.agentId, 'POST', '/v1/subscriptions/' + id + '/ens-description-transaction', input.idempotencyKey]));
        await f.repo.collections.doc('idempotency_keys', guard).update({ 'responseSnapshot.expiresAt': new Date(Date.now() - 1).toISOString() });
        await assert.rejects(repo.persistDescriptionTransaction(input), hasCode('ens_description_transaction_expired'));
    }
    finally {
        await f.db.terminate();
    }
});
