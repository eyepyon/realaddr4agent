import { randomUUID } from 'node:crypto';
import type { Firestore, Transaction, DocumentData } from '@google-cloud/firestore';
import { normalize } from 'viem/ens';
import { DomainError, HOLD_MS, SCHEMA_VERSION, amountFor, assertIdempotencyKey, normalizeSlug, normalizeWallet, sha256, validateFloor, validatePricing, type PricingConfig } from '@realaddr/domain';
import { CollectionMapper } from './collections.js';
import type { AgentPrincipal, PurchaseReadiness, VerifiedPurchaseAuthorization, VerifiedPurchaseReceipt, VerifiedRiskAssessment, DefinitiveUnpaidProof, EncryptedPaymentPayload } from './repository.js';
export interface EnsSaleConfig {
    verified: true;
    network: 'eip155:11155111';
    parentName: string;
    upperRegistry: string;
    controller: string;
    resolverFactory: string;
    leaseRegistry: string;
    universalResolver: string;
}
export interface EnsUnsignedDescriptionTransaction {
    network: 'eip155:11155111';
    chainId: 11155111;
    from: string;
    to: string;
    data: string;
    value: '0';
    name: string;
    key: 'description';
    expiresAt: string;
    maxGasAtomic: string;
}
export function ensLabel(nameType: 'floor' | 'custom', floor: number, customLabel?: string): string {
    validateFloor(floor);
    if (nameType === 'floor') {
        if (customLabel !== undefined)
            throw new DomainError('invalid_ens_label', 422);
        return 'f' + String(floor).padStart(5, '0');
    }
    if (nameType !== 'custom' || typeof customLabel !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/.test(customLabel) || /^f[0-9]+$/.test(customLabel) || ['admin', 'api', 'www'].includes(customLabel))
        throw new DomainError('invalid_ens_label', 422);
    try {
        if (normalize(customLabel) !== customLabel)
            throw new Error();
    }
    catch {
        throw new DomainError('invalid_ens_label', 422);
    }
    return customLabel;
}
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HASH = /^[0-9a-fA-F]{64}$/;
function validDate(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()); }
function assertHash(value: string): void {
    if (!HASH.test(value))
        throw new DomainError('invalid_payment_evidence', 422);
}
function decodedBase64(value: unknown, maxBytes: number): Buffer | null {
    if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
        return null;
    const bytes = Buffer.from(value, 'base64');
    return bytes.length <= maxBytes && bytes.toString('base64') === value ? bytes : null;
}
function assertPayload(value: EncryptedPaymentPayload): void {
    if (value?.algorithm !== 'aes-256-gcm' || typeof value.keyId !== 'string' || value.keyId.length < 1 || value.keyId.length > 128 || decodedBase64(value.iv, 12)?.length !== 12 || !decodedBase64(value.ciphertext, 16384)?.length || decodedBase64(value.tag, 16)?.length !== 16)
        throw new DomainError('invalid_encrypted_payment_payload', 422);
}
function guardId(...parts: string[]): string { return sha256(JSON.stringify(parts)); }
function asDate(value: unknown): Date {
    if (value instanceof Date)
        return value;
    if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function')
        return value.toDate() as Date;
    throw new DomainError('invalid_stored_timestamp', 503);
}
export class EnsRepository {
    readonly collections: CollectionMapper;
    private readonly pricing: Readonly<PricingConfig> | null;
    private readonly config: Readonly<EnsSaleConfig> | null;
    constructor(private readonly db: Firestore, prefix: string | undefined, pricing: PricingConfig | null, config: EnsSaleConfig | null = null) { this.collections = new CollectionMapper(db, prefix); this.pricing = pricing ? validatePricing(pricing) : null; this.config = config ? Object.freeze({ ...config }) : null; }
    async prepareEnsAddonSettlement(input: {
        orderId: string;
        principal: AgentPrincipal;
        authorization: VerifiedPurchaseAuthorization;
        risk: {
            payTo: VerifiedRiskAssessment;
            payer: VerifiedRiskAssessment;
        };
    }): Promise<{
        orderId: string;
        status: 'settling' | 'reconciling' | 'manual_review' | 'fulfilled';
        leaseId?: string;
    }> {
        const { authorization, risk } = input;
        if (authorization?.verified !== true || !HEX32.test(authorization.authorizationNonce) || !validDate(authorization.validBefore) || (authorization.validAfter !== undefined && !validDate(authorization.validAfter)))
            throw new DomainError('invalid_payment_authorization', 422);
        assertHash(authorization.payloadHash);
        assertPayload(authorization.encryptedPayload);
        const payer = normalizeWallet(authorization.payer);
        const payTo = normalizeWallet(authorization.payTo);
        const asset = normalizeWallet(authorization.asset);
        const orderRef = this.collections.doc('orders', input.orderId);
        const paymentRef = this.collections.doc('payments', input.orderId);
        const authGuardRef = this.collections.doc('uniques', guardId('payment_authorization', authorization.network, asset, payer, authorization.authorizationNonce.toLowerCase()));
        const agentRef = this.collections.doc('agents', input.principal.agentId);
        const tenantRef = this.collections.doc('tenants', input.principal.tenantId);
        return this.db.runTransaction(async (tx) => {
            const [orderSnap, paymentSnap, guardSnap, agentSnap, tenantSnap] = await Promise.all([tx.get(orderRef), tx.get(paymentRef), tx.get(authGuardRef), tx.get(agentRef), tx.get(tenantRef)]);
            const order = orderSnap.data();
            const payment = paymentSnap.data();
            if (!order || order.kind !== 'ens_addon' || order.tenantId !== input.principal.tenantId || order.agentId !== input.principal.agentId)
                throw new DomainError('not_found', 404);
            if (agentSnap.data()?.status !== 'active' || agentSnap.data()?.tenantId !== order.tenantId || agentSnap.data()?.walletAddress !== order.ownerWallet || agentSnap.data()?.walletChain !== order.network || tenantSnap.data()?.status !== 'active')
                throw new DomainError('unauthorized', 401);
            if (payer !== order.ownerWallet || payer !== normalizeWallet(input.principal.walletAddress) || input.principal.walletChain !== order.network || authorization.network !== order.network || asset !== order.asset.toLowerCase() || payTo !== order.payTo.toLowerCase() || authorization.amountAtomic !== order.amountAtomic || authorization.validBefore > asDate(order.expiresAt))
                throw new DomainError('payment_authorization_mismatch', 409);
            if (guardSnap.exists && guardSnap.data()?.orderId !== input.orderId)
                throw new DomainError('payment_authorization_reused', 409);
            if (guardSnap.exists && !paymentSnap.exists)
                throw new DomainError('payment_guard_inconsistent', 503);
            if (paymentSnap.exists) {
                if (payment?.authorizationNonce !== authorization.authorizationNonce.toLowerCase() || payment?.payloadHash !== authorization.payloadHash.toLowerCase() || payment?.payer !== payer || !guardSnap.exists)
                    throw new DomainError('payment_authorization_conflict', 409);
                if (order.status === 'fulfilled' && payment.status === 'confirmed')
                    return { orderId: input.orderId, status: 'fulfilled' as const, leaseId: order.leaseId as string };
                if (order.status === 'manual_review' && payment.status === 'confirmed')
                    return { orderId: input.orderId, status: 'manual_review' as const };
                if (order.status === 'settling' || order.status === 'reconciling')
                    return { orderId: input.orderId, status: order.status as 'settling' | 'reconciling' };
                throw new DomainError('payment_order_closed', 409);
            }
            const now = new Date();
            if (order.status !== 'awaiting_payment' || asDate(order.expiresAt) <= now)
                throw new DomainError('payment_order_closed', 409);
            if (authorization.validBefore <= now || (authorization.validAfter && authorization.validAfter > now))
                throw new DomainError('payment_authorization_expired', 409);
            for (const [side, assessment, address] of [['payTo', risk?.payTo, payTo], ['payer', risk?.payer, payer]] as const) {
                if (assessment?.verified !== true || assessment.decision !== 'allow' || normalizeWallet(assessment.subjectAddress) !== address || assessment.paymentNetwork !== authorization.network || !assessment.riskNetwork || !assessment.policyVersion || !validDate(assessment.checkedAt) || !validDate(assessment.expiresAt) || assessment.checkedAt.getTime() > now.getTime() + 30000 || now.getTime() - assessment.checkedAt.getTime() > 60000 || assessment.expiresAt <= now)
                    throw new DomainError(`risk_${side}_not_allowed`, 409);
                assertHash(assessment.responseHash);
            }
            await this.assertReservedLease(tx, order, true);
            const fenceNow = new Date();
            if (asDate(order.expiresAt) <= fenceNow || authorization.validBefore <= fenceNow || risk.payTo.expiresAt <= fenceNow || risk.payer.expiresAt <= fenceNow || fenceNow.getTime() - risk.payTo.checkedAt.getTime() > 60000 || fenceNow.getTime() - risk.payer.checkedAt.getTime() > 60000)
                throw new DomainError('payment_authorization_expired', 409);
            const nextVersion = order.version + 1;
            const outboxId = guardId(input.orderId, String(nextVersion), 'payment.settlement_requested');
            tx.create(authGuardRef, { schemaVersion: SCHEMA_VERSION, kind: 'payment_authorization', network: order.network, asset, payer, authorizationNonce: authorization.authorizationNonce.toLowerCase(), orderId: input.orderId });
            tx.create(paymentRef, { schemaVersion: SCHEMA_VERSION, id: input.orderId, orderId: input.orderId, status: 'settling', payer, network: order.network, asset, payTo, amountAtomic: order.amountAtomic, authorizationNonce: authorization.authorizationNonce.toLowerCase(), payloadHash: authorization.payloadHash.toLowerCase(), encryptedPayload: authorization.encryptedPayload, validAfter: authorization.validAfter ?? null, validBefore: authorization.validBefore, version: 1, createdAt: now, updatedAt: now });
            for (const [side, assessment] of [['payTo', risk.payTo], ['payer', risk.payer]] as const)
                tx.create(this.collections.doc('risk_assessments', guardId(input.orderId, side, 'settlement')), { schemaVersion: SCHEMA_VERSION, orderId: input.orderId, side, subjectAddress: normalizeWallet(assessment.subjectAddress), paymentNetwork: assessment.paymentNetwork, riskNetwork: assessment.riskNetwork, decision: 'allow', checkedAt: assessment.checkedAt, expiresAt: assessment.expiresAt, policyVersion: assessment.policyVersion, responseHash: assessment.responseHash.toLowerCase() });
            tx.update(orderRef, { status: 'settling', version: nextVersion, settlementOutboxId: outboxId, updatedAt: now });
            tx.create(this.collections.doc('outbox', outboxId), { schemaVersion: SCHEMA_VERSION, aggregateId: input.orderId, version: nextVersion, eventType: 'payment.settlement_requested', payload: { orderId: input.orderId }, state: 'pending', availableAt: now, attempts: 0 });
            tx.set(this.collections.doc('admin_operations', guardId('payment', input.orderId)), { schemaVersion: SCHEMA_VERSION, operationId: guardId('payment', input.orderId), kind: 'payment', targetId: input.orderId, status: 'unknown', version: nextVersion, updatedAt: now });
            return { orderId: input.orderId, status: 'settling' as const };
        });
    }
    async markEnsAddonSettlementUnknown(input: {
        orderId: string;
        authorizationNonce: string;
    }): Promise<{
        orderId: string;
        status: 'reconciling' | 'manual_review' | 'fulfilled';
    }> {
        const now = new Date();
        const orderRef = this.collections.doc('orders', input.orderId);
        const paymentRef = this.collections.doc('payments', input.orderId);
        return this.db.runTransaction(async (tx) => {
            const [orderSnap, paymentSnap] = await Promise.all([tx.get(orderRef), tx.get(paymentRef)]);
            const order = orderSnap.data();
            const payment = paymentSnap.data();
            if (!order || order.kind !== 'ens_addon' || !payment || payment.authorizationNonce !== input.authorizationNonce.toLowerCase())
                throw new DomainError('payment_not_found', 404);
            if (order.status === 'fulfilled' && payment.status === 'confirmed')
                return { orderId: input.orderId, status: 'fulfilled' as const };
            if (order.status === 'manual_review' && payment.status === 'confirmed')
                return { orderId: input.orderId, status: 'manual_review' as const };
            if (order.status === 'reconciling' && payment.status === 'unknown')
                return { orderId: input.orderId, status: 'reconciling' as const };
            if (order.status !== 'settling' || payment.status !== 'settling')
                throw new DomainError('payment_order_closed', 409);
            const settlementOutboxRef = this.collections.doc('outbox', order.settlementOutboxId);
            const settlementOutboxSnap = await tx.get(settlementOutboxRef);
            if (!settlementOutboxSnap.exists)
                throw new DomainError('settlement_outbox_missing', 503);
            const nextVersion = order.version + 1;
            const reconcileId = guardId(input.orderId, String(nextVersion), 'payment.reconcile_requested');
            tx.update(orderRef, { status: 'reconciling', version: nextVersion, reconciliationOutboxId: reconcileId, updatedAt: now });
            tx.update(paymentRef, { status: 'unknown', version: payment.version + 1, updatedAt: now });
            tx.update(settlementOutboxRef, { state: 'superseded', updatedAt: now });
            tx.create(this.collections.doc('outbox', reconcileId), { schemaVersion: SCHEMA_VERSION, aggregateId: input.orderId, version: nextVersion, eventType: 'payment.reconcile_requested', payload: { orderId: input.orderId }, state: 'pending', availableAt: now, attempts: 0 });
            tx.set(this.collections.doc('admin_operations', guardId('payment', input.orderId)), { schemaVersion: SCHEMA_VERSION, operationId: guardId('payment', input.orderId), kind: 'payment', targetId: input.orderId, status: 'reconciling', version: nextVersion, updatedAt: now });
            return { orderId: input.orderId, status: 'reconciling' as const };
        });
    }
    private namespace(record: DocumentData | undefined, lease: DocumentData, now: Date): DocumentData {
        const c = this.config;
        if (!this.pricing || c?.verified !== true || c.network !== 'eip155:11155111' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.eth$/.test(c.parentName))
            throw new DomainError('ens_sale_unavailable', 503);
        for (const address of [c.upperRegistry, c.controller, c.resolverFactory, c.leaseRegistry, c.universalResolver])
            if (/^0x0+$/.test(normalizeWallet(address)))
                throw new DomainError('ens_sale_unavailable', 503);
        if (!record || record.schemaVersion !== SCHEMA_VERSION || record.status !== 'verified' || record.network !== c.network || record.parentName !== c.parentName || record.upperRegistry !== c.upperRegistry || normalizeSlug(record.locationSlug) !== record.locationSlug || record.namespaceName !== record.locationSlug + '.' + c.parentName || !HASH.test(record.evidenceHash) || !HEX32.test(record.blockHash) || asDate(record.verifiedAt) > now || now.getTime() - asDate(record.verifiedAt).getTime() > 60000 || asDate(record.parentExpiresAt) < asDate(lease.expiresAt) || asDate(record.expiresAt) < asDate(lease.expiresAt))
            throw new DomainError('ens_namespace_unverified', 503);
        if (/^0x0+$/.test(normalizeWallet(record.locationRegistry)))
            throw new DomainError('ens_namespace_unverified', 503);
        return { network: c.network, parentName: c.parentName, locationSlug: record.locationSlug, namespaceName: record.namespaceName, upperRegistry: c.upperRegistry, locationRegistry: record.locationRegistry, controller: c.controller, resolverFactory: c.resolverFactory, leaseRegistry: c.leaseRegistry, universalResolver: c.universalResolver, evidenceHash: record.evidenceHash, blockHash: record.blockHash };
    }
    private activeLease(lease: DocumentData | undefined, p: Pick<AgentPrincipal, 'tenantId' | 'agentId' | 'walletAddress'>, now: Date): asserts lease is DocumentData {
        if (!lease || lease.tenantId !== p.tenantId || lease.agentId !== p.agentId || lease.ownerWallet !== normalizeWallet(p.walletAddress))
            throw new DomainError('not_found', 404);
        if (lease.status !== 'active' || asDate(lease.expiresAt) <= now || !Number.isSafeInteger(lease.version) || lease.version < 1)
            throw new DomainError('lease_not_active', 409);
    }
    private async assertReservedLease(tx: Transaction, order: DocumentData, fresh: boolean): Promise<void> {
        const [ls, gs, es, ns, slot] = await Promise.all([tx.get(this.collections.doc('leases', order.leaseId)), tx.get(this.collections.doc('uniques', guardId('ens_name', order.ensNameSnapshot.normalizedName))), tx.get(this.collections.doc('ens_entitlements', order.leaseId)), tx.get(this.collections.doc('ens_namespaces', order.buildingId)), tx.get(this.collections.doc('slots', order.buildingId + '_' + order.slotNumber))]);
        const l = ls.data();
        this.activeLease(l, { tenantId: order.tenantId, agentId: order.agentId, walletAddress: order.ownerWallet }, new Date());
        if (l.version !== order.leaseVersion || l.buildingId !== order.buildingId || l.slotNumber !== order.slotNumber || slot.data()?.state !== 'leased' || slot.data()?.leaseId !== order.leaseId || gs.data()?.orderId !== order.id || gs.data()?.leaseId !== order.leaseId || es.data()?.state !== 'pending_payment' || es.data()?.intentId !== order.id)
            throw new DomainError('ens_reservation_conflict', 409);
        if (fresh) {
            const current = this.namespace(ns.data(), l, new Date());
            for (const field of ['network', 'parentName', 'locationSlug', 'namespaceName', 'upperRegistry', 'locationRegistry', 'controller', 'resolverFactory', 'leaseRegistry', 'universalResolver'])
                if (current[field] !== order.ensNamespaceSnapshot[field])
                    throw new DomainError('ens_namespace_changed', 409);
        }
        await this.assertPaidLease(tx, l, order.leaseId);
    }
    async reserveEnsAddonIntent(input: {
        subscriptionId: string;
        nameType?: 'floor' | 'custom';
        customLabel?: string;
        idempotencyKey: string;
        principal: AgentPrincipal;
        readiness: PurchaseReadiness;
    }): Promise<Record<string, unknown>> {
        if (input.readiness?.paymentConfigVerified !== true || input.readiness.riskProviderAvailable !== true || !this.pricing || !this.config)
            throw new DomainError('ens_sale_unavailable', 503);
        const key = assertIdempotencyKey(input.idempotencyKey), p = input.principal, wallet = normalizeWallet(p.walletAddress), type = input.nameType ?? 'floor';
        if (p.walletChain !== this.pricing.network)
            throw new DomainError('unauthorized', 401);
        const hash = sha256(JSON.stringify({ kind: 'ens_addon', subscriptionId: input.subscriptionId, nameType: type, customLabel: input.customLabel ?? null })), id = randomUUID();
        const idem = this.collections.doc('idempotency_keys', guardId('agent', p.agentId, 'POST', '/v1/payment-intents', key)), er = this.collections.doc('ens_entitlements', input.subscriptionId);
        return this.db.runTransaction(async (tx) => {
            const [is, ls, es, ag, tn] = await Promise.all([tx.get(idem), tx.get(this.collections.doc('leases', input.subscriptionId)), tx.get(er), tx.get(this.collections.doc('agents', p.agentId)), tx.get(this.collections.doc('tenants', p.tenantId))]);
            if (ag.data()?.status !== 'active' || ag.data()?.tenantId !== p.tenantId || ag.data()?.walletAddress !== wallet || ag.data()?.walletChain !== p.walletChain || tn.data()?.status !== 'active')
                throw new DomainError('unauthorized', 401);
            if (is.exists) {
                if (is.data()?.bodyHash !== hash)
                    throw new DomainError('idempotency_conflict', 409);
                const current = await tx.get(this.collections.doc('orders', is.data()!.resourceId));
                return { ...is.data()!.responseSnapshot, status: current.data()?.status };
            }
            const l = ls.data(), now = new Date();
            this.activeLease(l, p, now);
            if (es.exists)
                throw new DomainError('ens_already_reserved', 409);
            const [ns, building] = await Promise.all([tx.get(this.collections.doc('ens_namespaces', l.buildingId)), tx.get(this.collections.doc('buildings', l.buildingId))]);
            const namespace = this.namespace(ns.data(), l, now);
            if (building.data()?.slug !== namespace.locationSlug)
                throw new DomainError('ens_namespace_unverified', 503);
            const label = ensLabel(type, l.slotNumber, input.customLabel), name = normalize(label + '.' + namespace.namespaceName), gr = this.collections.doc('uniques', guardId('ens_name', name));
            if ((await tx.get(gr)).exists)
                throw new DomainError('ens_name_unavailable', 409);
            const snapshot = { nameType: type, label, normalizedName: name, namePolicyVersion: 1 }, expiresAt = new Date(Math.min(now.getTime() + HOLD_MS, asDate(l.expiresAt).getTime()));
            const order = { schemaVersion: SCHEMA_VERSION, id, kind: 'ens_addon', leaseId: input.subscriptionId, subscriptionId: input.subscriptionId, leaseVersion: l.version, tenantId: p.tenantId, agentId: p.agentId, ownerWallet: wallet, buildingId: l.buildingId, locationId: l.buildingId, slotNumber: l.slotNumber, floor: l.slotNumber, amountAtomic: amountFor(this.pricing!, type === 'floor' ? 'ens_floor' : 'ens_custom'), network: this.pricing!.network, asset: this.pricing!.asset, payTo: this.pricing!.payTo, pricingVersion: this.pricing!.pricingVersion, ensNameSnapshot: snapshot, ensNamespaceSnapshot: namespace, expiresAt, createdAt: now, updatedAt: now, status: 'awaiting_payment', version: 1 };
            await this.assertPaidLease(tx, l, input.subscriptionId);
            const response = { id, kind: 'ens_addon', subscriptionId: input.subscriptionId, locationId: l.buildingId, floor: l.slotNumber, status: order.status, amountAtomic: order.amountAtomic, network: order.network, asset: order.asset, payTo: order.payTo, pricingVersion: order.pricingVersion, nameType: type, label, fqdn: name, expiresAt: expiresAt.toISOString(), payPath: '/v1/payment-intents/' + id + '/pay' };
            tx.create(this.collections.doc('orders', id), order);
            tx.create(gr, { schemaVersion: SCHEMA_VERSION, kind: 'ens_name', leaseId: input.subscriptionId, orderId: id, intentId: id, normalizedName: name, state: 'reserved', expiresAt });
            tx.create(er, { schemaVersion: SCHEMA_VERSION, leaseId: input.subscriptionId, intentId: id, state: 'pending_payment', version: 1, pricingVersion: order.pricingVersion, ...snapshot });
            tx.create(idem, { schemaVersion: SCHEMA_VERSION, bodyHash: hash, resourceId: id, responseSnapshot: response });
            return response;
        });
    }
    private async assertPaidLease(tx: Transaction, l: DocumentData, id: string): Promise<void> {
        if (typeof l.registryPaymentOrderId !== 'string')
            throw new DomainError('lease_payment_unverified', 409);
        const [os, ps, ss] = await Promise.all([tx.get(this.collections.doc('orders', l.registryPaymentOrderId)), tx.get(this.collections.doc('payments', l.registryPaymentOrderId)), tx.get(this.collections.doc('slots', l.buildingId + '_' + l.slotNumber))]);
        const o = os.data(), p = ps.data();
        if (!o || !p || o.status !== 'fulfilled' || o.leaseId !== id || o.buildingId !== l.buildingId || o.slotNumber !== l.slotNumber || o.ownerWallet !== l.ownerWallet || o.tenantId !== l.tenantId || o.agentId !== l.agentId || p.status !== 'confirmed' || p.orderId !== l.registryPaymentOrderId || p.payer !== l.ownerWallet || p.settlementEvidence?.finalityVerified !== true || p.settlementEvidence?.evidenceHash !== p.evidenceHash || !HASH.test(p.evidenceHash) || !HEX32.test(p.txHash) || !Number.isSafeInteger(p.transferLogIndex) || p.transferLogIndex < 0 || o.network !== p.network || normalizeWallet(o.asset) !== p.asset || normalizeWallet(o.payTo) !== p.payTo || o.amountAtomic !== p.amountAtomic || p.network !== 'eip155:84532' || p.amountAtomic !== '550000' || (l.version === 1 ? o.kind !== 'purchase' : o.kind !== 'renew' || o.leaseVersion !== l.version - 1) || ss.data()?.state !== 'leased' || ss.data()?.leaseId !== id)
            throw new DomainError('lease_payment_unverified', 409);
        const guard = await tx.get(this.collections.doc('uniques', guardId('payment_transfer', p.network, p.txHash, String(p.transferLogIndex))));
        const expectedExpiry = (o.kind === 'purchase' ? asDate(p.confirmedAt).getTime() : Math.max(asDate(o.previousExpiresAt).getTime(), asDate(p.confirmedAt).getTime())) + 30 * 86400000;
        if (guard.data()?.orderId !== l.registryPaymentOrderId || guard.data()?.paymentId !== l.registryPaymentOrderId || asDate(l.expiresAt).getTime() !== expectedExpiry)
            throw new DomainError('lease_payment_unverified', 409);
    }
    async confirmEnsAddonPayment(input: {
        orderId: string;
        receipt: VerifiedPurchaseReceipt;
    }): Promise<{
        orderId: string;
        status: 'fulfilled';
        leaseId: string;
    }> {
        const r = input.receipt, now = new Date();
        if (r?.verified !== true || r.finalityVerified !== true || !HEX32.test(r.authorizationNonce) || !HEX32.test(r.txHash) || !Number.isSafeInteger(r.transferLogIndex) || r.transferLogIndex < 0 || !validDate(r.confirmedAt) || r.confirmedAt.getTime() > now.getTime() + 30000)
            throw new DomainError('invalid_payment_receipt', 422);
        assertHash(r.evidenceHash);
        const payer = normalizeWallet(r.payer), asset = normalizeWallet(r.asset), payTo = normalizeWallet(r.payTo), or = this.collections.doc('orders', input.orderId), pr = this.collections.doc('payments', input.orderId), rr = this.collections.doc('uniques', guardId('payment_transfer', r.network, r.txHash.toLowerCase(), String(r.transferLogIndex)));
        return this.db.runTransaction(async (tx) => {
            const [os, ps, rs] = await Promise.all([tx.get(or), tx.get(pr), tx.get(rr)]), o = os.data(), p = ps.data();
            if (!o || o.kind !== 'ens_addon' || !p)
                throw new DomainError('payment_not_found', 404);
            if (rs.exists && rs.data()?.orderId !== input.orderId)
                throw new DomainError('payment_receipt_reused', 409);
            if (r.network !== o.network || asset !== o.asset.toLowerCase() || payer !== o.ownerWallet || payTo !== o.payTo.toLowerCase() || r.amountAtomic !== o.amountAtomic || r.authorizationNonce.toLowerCase() !== p.authorizationNonce || p.network !== r.network || p.asset !== asset || p.payer !== payer || p.payTo !== payTo || p.amountAtomic !== r.amountAtomic)
                throw new DomainError('payment_receipt_mismatch', 409);
            if (o.status === 'fulfilled' && p.status === 'confirmed') {
                if (!rs.exists || p.txHash !== r.txHash.toLowerCase() || p.transferLogIndex !== r.transferLogIndex || p.evidenceHash !== r.evidenceHash.toLowerCase() || asDate(p.confirmedAt).getTime() !== r.confirmedAt.getTime())
                    throw new DomainError('payment_receipt_conflict', 409);
                return { orderId: input.orderId, status: 'fulfilled', leaseId: o.leaseId };
            }
            if (rs.exists || !((o.status === 'settling' && p.status === 'settling') || (o.status === 'reconciling' && p.status === 'unknown')))
                throw new DomainError('payment_state_conflict', 409);
            const er = this.collections.doc('ens_entitlements', o.leaseId), gr = this.collections.doc('uniques', guardId('ens_name', o.ensNameSnapshot.normalizedName)), sr = this.collections.doc('outbox', o.settlementOutboxId), cr = o.reconciliationOutboxId ? this.collections.doc('outbox', o.reconciliationOutboxId) : null;
            const [es, gs, ls, ss, cs, ags] = await Promise.all([tx.get(er), tx.get(gr), tx.get(this.collections.doc('leases', o.leaseId)), tx.get(sr), cr ? tx.get(cr) : Promise.resolve(null), tx.get(this.collections.doc('uniques', guardId('payment_authorization', o.network, asset, payer, p.authorizationNonce)))]);
            if (es.data()?.state !== 'pending_payment' || es.data()?.intentId !== o.id || gs.data()?.orderId !== o.id || gs.data()?.leaseId !== o.leaseId || !ss.exists || (cr && !cs?.exists) || ags.data()?.orderId !== o.id)
                throw new DomainError('ens_payment_state_inconsistent', 503);
            const l = ls.data();
            if (!l || l.tenantId !== o.tenantId || l.agentId !== o.agentId || l.ownerWallet !== o.ownerWallet || l.buildingId !== o.buildingId || l.slotNumber !== o.slotNumber)
                throw new DomainError('ens_lease_state_inconsistent', 503);
            const job = guardId(o.leaseId, String(l.version), 'ens.lease_sync_requested'), jobRef = this.collections.doc('outbox', job);
            if ((await tx.get(jobRef)).exists)
                throw new DomainError('ens_outbox_conflict', 503);
            const time = new Date(), active = l.status === 'active' && asDate(l.expiresAt) > time;
            tx.create(rr, { schemaVersion: SCHEMA_VERSION, kind: 'payment_transfer', network: r.network, txHash: r.txHash.toLowerCase(), transferLogIndex: r.transferLogIndex, orderId: o.id, paymentId: o.id });
            tx.update(pr, { status: 'confirmed', txHash: r.txHash.toLowerCase(), transferLogIndex: r.transferLogIndex, evidenceHash: r.evidenceHash.toLowerCase(), confirmedAt: r.confirmedAt, settlementEvidence: { evidenceHash: r.evidenceHash.toLowerCase(), finalityVerified: true }, encryptedPayload: null, version: p.version + 1, updatedAt: time });
            tx.update(er, { state: 'paid', paidPaymentId: o.id, paidAt: r.confirmedAt, version: es.data()!.version + 1, namespaceSnapshot: o.ensNamespaceSnapshot, updatedAt: time });
            tx.update(gr, { state: 'paid', paidAt: r.confirmedAt });
            tx.update(or, { status: 'fulfilled', version: o.version + 1, fulfilledAt: time, updatedAt: time });
            tx.update(sr, { state: 'completed', updatedAt: time });
            if (cr)
                tx.update(cr, { state: 'completed', updatedAt: time });
            tx.create(jobRef, { schemaVersion: SCHEMA_VERSION, aggregateId: o.leaseId, version: l.version, eventType: 'ens.lease_sync_requested', payload: { leaseId: o.leaseId, leaseVersion: l.version }, state: active ? 'pending' : 'blocked', availableAt: time, attempts: 0, ...(!active ? { lastErrorCode: 'lease_not_active' } : {}) });
            tx.delete(this.collections.doc('admin_operations', guardId('payment', o.id)));
            return { orderId: input.orderId, status: 'fulfilled', leaseId: o.leaseId };
        });
    }
    async releaseUnpaidEnsAddonIntent(input: {
        orderId: string;
        determination: {
            kind: 'expired_without_authorization';
        } | {
            kind: 'definitive_unpaid';
            proof: DefinitiveUnpaidProof;
        };
    }): Promise<{
        orderId: string;
        status: 'expired' | 'failed_unpaid';
    }> {
        let now = new Date();
        const orderRef = this.collections.doc('orders', input.orderId);
        const paymentRef = this.collections.doc('payments', input.orderId);
        return this.db.runTransaction(async (tx) => {
            const [orderSnap, paymentSnap] = await Promise.all([tx.get(orderRef), tx.get(paymentRef)]);
            const order = orderSnap.data();
            const payment = paymentSnap.data();
            if (!order || order.kind !== 'ens_addon')
                throw new DomainError('not_found', 404);
            if (order.status === 'expired' || order.status === 'failed_unpaid')
                return { orderId: input.orderId, status: order.status as 'expired' | 'failed_unpaid' };
            if (input.determination.kind === 'expired_without_authorization') {
                if (order.status !== 'awaiting_payment' || paymentSnap.exists || asDate(order.expiresAt) > now)
                    throw new DomainError('unpaid_not_established', 409);
            }
            else {
                const proof = input.determination.proof;
                if ((order.status !== 'settling' && order.status !== 'reconciling') || !payment || (payment.status !== 'settling' && payment.status !== 'unknown') || proof?.verified !== true || proof.providerSettlementFinal !== true || proof.chainFinalityVerified !== true || proof.noTransferVerified !== true || !validDate(proof.checkedAt) || proof.checkedAt > now || (proof.checkedAt < asDate(payment.validBefore) && proof.irrevocablyCancelled !== true) || proof.network !== order.network || normalizeWallet(proof.asset) !== order.asset.toLowerCase() || normalizeWallet(proof.payer) !== order.ownerWallet || proof.authorizationNonce.toLowerCase() !== payment.authorizationNonce)
                    throw new DomainError('unpaid_not_established', 409);
                assertHash(proof.evidenceHash);
            }
            const renewalGuardRef = this.collections.doc('uniques', guardId('ens_name', order.ensNameSnapshot.normalizedName));
            const entitlementRef = this.collections.doc('ens_entitlements', order.leaseId);
            const entitlement = await tx.get(entitlementRef);
            if (entitlement.data()?.state !== 'pending_payment' || entitlement.data()?.intentId !== order.id)
                throw new DomainError('ens_reservation_conflict', 409);
            const settlementOutboxRef = order.settlementOutboxId ? this.collections.doc('outbox', order.settlementOutboxId) : null;
            const reconciliationOutboxRef = order.reconciliationOutboxId ? this.collections.doc('outbox', order.reconciliationOutboxId) : null;
            const [guardSnap, settlementOutboxSnap, reconciliationOutboxSnap] = await Promise.all([tx.get(renewalGuardRef), settlementOutboxRef ? tx.get(settlementOutboxRef) : Promise.resolve(null), reconciliationOutboxRef ? tx.get(reconciliationOutboxRef) : Promise.resolve(null)]);
            now = new Date();
            if (guardSnap.data()?.orderId !== input.orderId || guardSnap.data()?.leaseId !== order.leaseId || (settlementOutboxRef && !settlementOutboxSnap?.exists) || (reconciliationOutboxRef && !reconciliationOutboxSnap?.exists))
                throw new DomainError('ens_reservation_conflict', 503);
            const status = input.determination.kind === 'expired_without_authorization' ? 'expired' as const : 'failed_unpaid' as const;
            tx.delete(renewalGuardRef);
            tx.delete(entitlementRef);
            tx.update(orderRef, { status, version: order.version + 1, releasedAt: now, updatedAt: now });
            if (payment)
                tx.update(paymentRef, { status: 'failed', encryptedPayload: null, definitiveUnpaidEvidenceHash: input.determination.kind === 'definitive_unpaid' ? input.determination.proof.evidenceHash.toLowerCase() : null, version: payment.version + 1, updatedAt: now });
            if (settlementOutboxRef)
                tx.update(settlementOutboxRef, { state: 'completed', updatedAt: now });
            if (reconciliationOutboxRef)
                tx.update(reconciliationOutboxRef, { state: 'completed', updatedAt: now });
            if (payment)
                tx.delete(this.collections.doc('admin_operations', guardId('payment', input.orderId)));
            return { orderId: input.orderId, status };
        });
    }
    // Server-only inspection. Stored state is a candidate for external exact-registration verification.
    async getResolutionCandidate(canonicalName: string): Promise<{
        state: 'paid' | 'refund_pending' | 'refunded';
        lease: DocumentData;
        entitlement: DocumentData;
        binding: DocumentData | null;
        namespace: DocumentData | null;
        building: DocumentData;
    } | null> {
        try {
            if (normalize(canonicalName) !== canonicalName)
                throw new Error();
        }
        catch {
            throw new DomainError('invalid_ens_name', 422);
        }
        return this.db.runTransaction(async (tx) => {
            const guard = (await tx.get(this.collections.doc('uniques', guardId('ens_name', canonicalName)))).data();
            if (!guard || guard.state !== 'paid')
                return null;
            const [entitlementSnap, leaseSnap, bindingSnap] = await Promise.all([tx.get(this.collections.doc('ens_entitlements', guard.leaseId)), tx.get(this.collections.doc('leases', guard.leaseId)), tx.get(this.collections.doc('ens_bindings', guard.leaseId))]);
            const e = entitlementSnap.data(), l = leaseSnap.data();
            if (!e || e.state === 'pending_payment')
                return null;
            if (!l || !['paid', 'refund_pending', 'refunded'].includes(e.state) || e.schemaVersion !== SCHEMA_VERSION || e.leaseId !== guard.leaseId || e.intentId !== guard.orderId || e.normalizedName !== canonicalName || e.paidPaymentId !== guard.orderId)
                throw new DomainError('ens_state_inconsistent', 503);
            const [oSnap, pSnap, namespaceSnap, buildingSnap] = await Promise.all([tx.get(this.collections.doc('orders', guard.orderId)), tx.get(this.collections.doc('payments', guard.orderId)), tx.get(this.collections.doc('ens_namespaces', l.buildingId)), tx.get(this.collections.doc('buildings', l.buildingId))]);
            const o = oSnap.data(), p = pSnap.data(), building = buildingSnap.data();
            if (!o || !p || !building || o.kind !== 'ens_addon' || o.leaseId !== l.id || o.tenantId !== l.tenantId || o.agentId !== l.agentId || o.ownerWallet !== l.ownerWallet || o.buildingId !== l.buildingId || o.slotNumber !== l.slotNumber || o.ensNameSnapshot?.normalizedName !== canonicalName || o.ensNameSnapshot?.label !== e.label || o.ensNameSnapshot?.nameType !== e.nameType || o.ensNameSnapshot?.namePolicyVersion !== e.namePolicyVersion || p.status !== 'confirmed' || p.orderId !== o.id || p.payer !== l.ownerWallet || p.amountAtomic !== o.amountAtomic || p.network !== o.network || p.asset !== normalizeWallet(o.asset) || p.payTo !== normalizeWallet(o.payTo) || p.settlementEvidence?.finalityVerified !== true || p.settlementEvidence?.evidenceHash !== p.evidenceHash || !HASH.test(p.evidenceHash) || !HEX32.test(p.txHash) || !Number.isSafeInteger(p.transferLogIndex) || p.transferLogIndex < 0)
                throw new DomainError('ens_payment_unverified', 503);
            const receiptGuard = await tx.get(this.collections.doc('uniques', guardId('payment_transfer', p.network, p.txHash, String(p.transferLogIndex))));
            if (receiptGuard.data()?.orderId !== o.id || receiptGuard.data()?.paymentId !== o.id)
                throw new DomainError('ens_payment_unverified', 503);
            const binding = bindingSnap.data();
            if (binding && (binding.leaseId !== l.id || binding.schemaVersion !== SCHEMA_VERSION || binding.normalizedName !== canonicalName || binding.ownerWallet !== l.ownerWallet || binding.leaseKey !== l.leaseKey || binding.controllerAddress !== o.ensNamespaceSnapshot?.controller || binding.registryAddress !== o.ensNamespaceSnapshot?.locationRegistry))
                throw new DomainError('ens_binding_inconsistent', 503);
            return { state: e.state, lease: l, entitlement: e, binding: binding ?? null, namespace: namespaceSnap.data() ?? null, building };
        }, { readOnly: true });
    }
    async persistDescriptionTransaction(input: {
        principal: AgentPrincipal;
        leaseId: string;
        idempotencyKey: string;
        description: string;
        expectedLeaseVersion: number;
        verifiedAt: Date;
        transaction: EnsUnsignedDescriptionTransaction;
    }): Promise<EnsUnsignedDescriptionTransaction> {
        const p = input.principal, key = assertIdempotencyKey(input.idempotencyKey), value = Object.freeze({ ...input.transaction }), now = new Date();
        if (typeof input.description !== 'string' || Array.from(input.description).length > 280 || !Number.isSafeInteger(input.expectedLeaseVersion) || input.expectedLeaseVersion < 1)
            throw new DomainError('invalid_ens_description', 422);
        if (!validDate(input.verifiedAt) || input.verifiedAt > now || now.getTime() - input.verifiedAt.getTime() > 30000 || value.network !== 'eip155:11155111' || value.chainId !== 11155111 || value.value !== '0' || value.key !== 'description' || !/^0x(?:[a-fA-F0-9]{2})+$/.test(value.data) || !Number.isFinite(Date.parse(value.expiresAt)) || !/^[1-9][0-9]*$/.test(value.maxGasAtomic))
            throw new DomainError('ens_description_transaction_unverified', 503);
        const path = '/v1/subscriptions/' + input.leaseId + '/ens-description-transaction', hash = sha256(JSON.stringify({ description: input.description, expectedLeaseVersion: input.expectedLeaseVersion })), ir = this.collections.doc('idempotency_keys', guardId('agent', p.agentId, 'POST', path, key));
        return this.db.runTransaction(async (tx) => {
            const [ls, es, bs, is, ag, tn] = await Promise.all([tx.get(this.collections.doc('leases', input.leaseId)), tx.get(this.collections.doc('ens_entitlements', input.leaseId)), tx.get(this.collections.doc('ens_bindings', input.leaseId)), tx.get(ir), tx.get(this.collections.doc('agents', p.agentId)), tx.get(this.collections.doc('tenants', p.tenantId))]);
            const l = ls.data(), e = es.data(), b = bs.data(), time = new Date();
            this.activeLease(l, p, time);
            if (ag.data()?.status !== 'active' || ag.data()?.tenantId !== p.tenantId || ag.data()?.walletAddress !== normalizeWallet(p.walletAddress) || ag.data()?.walletChain !== p.walletChain || tn.data()?.status !== 'active' || p.walletChain !== 'eip155:84532')
                throw new DomainError('unauthorized', 401);
            if (l.version !== input.expectedLeaseVersion)
                throw new DomainError('lease_version_conflict', 409);
            if (e?.state !== 'paid' || e.leaseId !== input.leaseId || b?.leaseId !== input.leaseId || b.schemaVersion !== SCHEMA_VERSION || b.normalizedName !== e.normalizedName || b.ownerWallet !== l.ownerWallet || b.leaseKey !== l.leaseKey || b.syncedLeaseVersion !== l.version || b.status !== 'ready')
                throw new DomainError('ens_binding_not_verified', 409);
            await this.assertPaidLease(tx, l, input.leaseId);
            const expiry = Date.parse(value.expiresAt);
            if (normalizeWallet(value.from) !== l.ownerWallet || normalizeWallet(value.to) !== normalizeWallet(b.resolverAddress) || value.name !== e.normalizedName || expiry <= time.getTime() || expiry > time.getTime() + 5 * 60000 || expiry > asDate(l.expiresAt).getTime() || time.getTime() - input.verifiedAt.getTime() > 30000)
                throw new DomainError('ens_description_transaction_mismatch', 409);
            const o = (await tx.get(this.collections.doc('orders', e.paidPaymentId))).data();
            const paid = (await tx.get(this.collections.doc('payments', e.paidPaymentId))).data();
            if (!o || o.kind !== 'ens_addon' || o.leaseId !== l.id || o.ensNameSnapshot?.normalizedName !== e.normalizedName || o.ensNamespaceSnapshot?.controller !== b.controllerAddress || o.ensNamespaceSnapshot?.locationRegistry !== b.registryAddress || o.tenantId !== l.tenantId || o.agentId !== l.agentId || o.ownerWallet !== l.ownerWallet || paid?.status !== 'confirmed' || paid.orderId !== e.paidPaymentId || paid.payer !== l.ownerWallet || paid.network !== o.network || paid.asset !== normalizeWallet(o.asset) || paid.payTo !== normalizeWallet(o.payTo) || paid.amountAtomic !== o.amountAtomic || paid.settlementEvidence?.finalityVerified !== true || paid.settlementEvidence.evidenceHash !== paid.evidenceHash || !HASH.test(paid.evidenceHash) || !HEX32.test(paid.txHash) || !Number.isSafeInteger(paid.transferLogIndex) || paid.transferLogIndex < 0)
                throw new DomainError('ens_payment_unverified', 503);
            const receiptGuard = await tx.get(this.collections.doc('uniques', guardId('payment_transfer', paid.network, paid.txHash, String(paid.transferLogIndex))));
            if (receiptGuard.data()?.orderId !== e.paidPaymentId || receiptGuard.data()?.paymentId !== e.paidPaymentId)
                throw new DomainError('ens_payment_unverified', 503);
            if (is.exists) {
                if (is.data()?.bodyHash !== hash)
                    throw new DomainError('idempotency_conflict', 409);
                const saved = is.data()!.responseSnapshot as EnsUnsignedDescriptionTransaction;
                if (normalizeWallet(saved.from) !== l.ownerWallet || normalizeWallet(saved.to) !== normalizeWallet(b.resolverAddress) || saved.name !== e.normalizedName || Date.parse(saved.expiresAt) > asDate(l.expiresAt).getTime() || Date.parse(saved.expiresAt) <= time.getTime())
                    throw new DomainError('ens_description_transaction_expired', 409);
                return saved;
            }
            tx.create(ir, { schemaVersion: SCHEMA_VERSION, bodyHash: hash, resourceId: input.leaseId, responseSnapshot: value, createdAt: time });
            return value;
        });
    }
}
