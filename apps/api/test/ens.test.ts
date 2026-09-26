import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { EnsV2Reader, resolverProxyPin, type NamespaceConfig } from '@realaddr/ens';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Firestore } from '@google-cloud/firestore';
import { DomainError, sha256, type PricingConfig } from '@realaddr/domain';
import { EnsRepository, ensLabel, type EnsSaleConfig, OutboxRepository, RegistryRepository, OwnerReadRepository, RealAddrRepository, type AgentPrincipal, type VerifiedPurchaseAuthorization, type VerifiedPurchaseReceipt, type VerifiedRiskAssessment, } from '@realaddr/db';
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
    token: string;
}
async function makeFixture(): Promise<Fixture> {
    const db = new Firestore({ projectId: `demo-realaddr-${randomUUID()}`, databaseId: 'realaddr' });
    try {
        const repo = new RealAddrRepository(db, 'realaddr_event_', pricing, { authDomain: 'localhost' });
        const operator = { verified: true as const, subject: 'operator-test' };
        const location = await repo.createLocation(operator, { slug: 'tokyo', displayName: 'Tokyo', publicArea: 'Tokyo', postalCode: '1000001', address: 'Chiyoda 1-1', status: 'paused', reason: 'Test location' }, randomUUID());
        await repo.updateLocation(operator, location.id, { expectedVersion: 1, reason: 'Publish test location', publicationConfirmed: true, changes: { status: 'available' } }, randomUUID(), readiness);
        let token = '';
        async function register(wallet: string): Promise<AgentPrincipal> {
            const challenge = await repo.issueWalletChallenge({ address: wallet, chain: pricing.network, domain: 'localhost', termsVersion: 'test-v1' });
            const session = await repo.registerAgentFromVerifiedChallenge({ verified: true, challengeId: challenge.id, walletAddress: wallet, chain: pricing.network, domain: 'localhost', message: challenge.message }, 'Test agent');
            if (wallet === '0x' + 'a'.repeat(40))
                token = session.token;
            return session.principal;
        }
        return { db, repo, locationId: location.id, principal: await register(`0x${'a'.repeat(40)}`), otherPrincipal: await register(`0x${'b'.repeat(40)}`), get token() { return token; } };
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
// These local adapter fixtures exercise HTTP race handling; they are not live ENS evidence.
const pin = (char: string) => ({ address: ('0x' + char.repeat(40)) as NamespaceConfig['parentOwner'], codeHash: ('0x' + 'f'.repeat(64)) as NamespaceConfig['proxyLogic']['codeHash'] });
function namespaceConfig(): NamespaceConfig { return { chainId: 11155111, parentName: 'example.eth', locationSlug: 'tokyo', parentOwner: pricing.asset as NamespaceConfig['parentOwner'], locationOwner: pricing.payTo as NamespaceConfig['parentOwner'], serviceOrigin: 'https://address.chain.tokyo', universalResolver: pin('1'), rootRegistry: pin('2'), ethRegistry: pin('3'), upperRegistry: pin('1'), locationRegistry: pin('2'), factory: pin('4'), resolverImplementation: pin('5'), userRegistryImplementation: pin('6'), proxyLogic: pin('7'), nameController: pin('2'), leaseRegistry: pin('2') }; }
test('ENS HTTP preserves unpaid owner status, keeps paid pending private, and fences a live-read race', { skip: !emulator }, async () => {
    const f = await makeFixture();
    const config = loadConfig({ ...process.env, APP_ENV: 'local', FIRESTORE_DATABASE_ID: 'realaddr', GCP_PROJECT_ID: 'demo-realaddr-local' });
    config.ens = { rpcUrl: 'https://example.invalid', namespaces: { [f.locationId]: namespaceConfig() }, maxGasAtomic: '100000' };
    const app = createApp(config, f.repo, f.db);
    const original = EnsV2Reader.prototype.verifyBinding;
    try {
        const id = await purchased(f), repo = await ensFixture(f, id), get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: 'Bearer ' + f.token } });
        let result = await get('/v1/subscriptions/' + id + '/ens');
        assert.equal(result.statusCode, 200, result.body);
        assert.equal(result.json().status, 'not_purchased');
        const q = await ensQuote(repo, f, id);
        result = await get('/v1/subscriptions/' + id + '/ens');
        assert.equal(result.statusCode, 200, result.body);
        assert.equal(result.json().status, 'not_purchased');
        const v = ensInputs(q, f);
        await repo.prepareEnsAddonSettlement({ orderId: q.id as string, principal: f.principal, ...v });
        await repo.confirmEnsAddonPayment({ orderId: q.id as string, receipt: v.receipt });
        result = await app.inject({ method: 'GET', url: '/v1/ens/resolve?name=' + q.fqdn });
        assert.equal(result.statusCode, 200, result.body);
        assert.equal(result.json().status, 'pending');
        assert.equal(result.body.includes(id), false);
        assert.equal(result.body.includes('Test building'), false);
        const leaseKey = '0x' + 'c'.repeat(64);
        await f.repo.collections.doc('leases', id).update({ leaseKey, holderSalt: '0x' + 'd'.repeat(64), holderCommitment: '0x' + 'e'.repeat(64) });
        await f.repo.collections.doc('buildings', f.locationId).update({ buildingKey: '0x' + 'b'.repeat(64) });
        await f.repo.collections.doc('ens_bindings', id).set({ schemaVersion: 1, leaseId: id, normalizedName: q.fqdn, ownerWallet: f.principal.walletAddress, leaseKey, resolverAddress: resolverProxyPin(namespaceConfig(), leaseKey as NamespaceConfig['proxyLogic']['codeHash']).address, controllerAddress: ensConfig.controller, registryAddress: pricing.payTo, status: 'ready', targetLeaseVersion: 1, syncedLeaseVersion: 1 });
        EnsV2Reader.prototype.verifyBinding = async function (expected) { return { status: 'verified', evidence: { blockNumber: 1n, blockHash: ('0x' + 'a'.repeat(64)) as NamespaceConfig['proxyLogic']['codeHash'], checkedAt: BigInt(Math.floor(Date.now() / 1000)), parentExpiry: expected.expiresAt, locationExpiry: expected.expiresAt, name: expected.name, resolver: expected.resolver.address, leaseVersion: expected.leaseVersion } }; };
        const descriptionKey = randomUUID();
        result = await app.inject({ method: 'POST', url: '/v1/subscriptions/' + id + '/ens-description-transaction', headers: { authorization: 'Bearer ' + f.token, 'idempotency-key': descriptionKey }, payload: { description: 'Agent', expectedLeaseVersion: 1 } });
        assert.equal(result.statusCode, 200, result.body);
        assert.equal(result.json().chainId, 11155111);
        assert.equal(result.json().value, '0');
        assert.equal(result.json().key, 'description');
        assert.equal(result.json().name, q.fqdn);
        assert.equal(result.json().to.toLowerCase(), resolverProxyPin(namespaceConfig(), leaseKey as NamespaceConfig['proxyLogic']['codeHash']).address.toLowerCase());
        result = await app.inject({ method: 'POST', url: '/v1/subscriptions/' + id + '/ens-description-transaction', headers: { authorization: 'Bearer ' + f.token, 'idempotency-key': descriptionKey }, payload: { description: 'Changed', expectedLeaseVersion: 1 } });
        assert.equal(result.statusCode, 409, result.body);
        assert.equal(result.json().error, 'idempotency_conflict');
        EnsV2Reader.prototype.verifyBinding = async function (expected) { await f.repo.collections.doc('leases', id).update({ status: 'suspended' }); return { status: 'verified', evidence: { blockNumber: 1n, blockHash: ('0x' + 'a'.repeat(64)) as NamespaceConfig['proxyLogic']['codeHash'], checkedAt: BigInt(Math.floor(Date.now() / 1000)), parentExpiry: expected.expiresAt, locationExpiry: expected.expiresAt, name: expected.name, resolver: expected.resolver.address, leaseVersion: expected.leaseVersion } }; };
        result = await app.inject({ method: 'GET', url: '/v1/ens/resolve?name=' + q.fqdn });
        assert.equal(result.statusCode, 200, result.body);
        assert.equal(result.json().status, 'pending');
        assert.equal(result.json().reasonCode, 'ens_state_changed');
        assert.equal(Object.hasOwn(result.json(), 'reference'), false);
    }
    finally {
        EnsV2Reader.prototype.verifyBinding = original;
        await app.close();
        await f.db.terminate();
    }
});
