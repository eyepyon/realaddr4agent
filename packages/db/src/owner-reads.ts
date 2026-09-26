import { FieldPath, type Firestore, type Transaction, type DocumentData } from '@google-cloud/firestore';
import { DomainError, SCHEMA_VERSION, sha256 } from '@realaddr/domain';
import { CollectionMapper } from './collections.js';
import type { AgentPrincipal } from './repository.js';
import { WorldRepository } from './world.js';

export interface OwnerReadCursor { at: Date; id: string }
export interface PublicRisk { decision: 'allow' | 'deny' | 'hold'; reasonCodes: string[]; checkedAt: string; paymentNetwork: string; riskNetwork: string; subjectAddress: string; side: 'buyer' | 'seller' }
export interface PublicReceipt { paymentId: string; network: string; asset: string; amountAtomic: string; payer: string; payTo: string; txHash: string; confirmedAt: string }
export interface PublicOrder { id: string; kind: 'purchase' | 'renew' | 'ens_addon'; status: string; locationId: string; floor: number; amountAtomic: string; network: string; asset: string; payTo: string; expiresAt: string; createdAt: string; riskAssessments: PublicRisk[]; payPath: string; subscriptionId?: string; receipt?: PublicReceipt; nameType?: 'floor' | 'custom'; label?: string; fqdn?: string; pricingVersion?: string }
export interface PublicEnsStatus { status: 'not_purchased' | 'pending' | 'expired' | 'disabled'; network: 'eip155:11155111'; name?: string; expiresAt?: string; targetLeaseVersion?: number; lastErrorCode?: string }
export interface PublicLease { id: string; locationId: string; floor: number; displayAddress: string; status: 'active' | 'expired' | 'suspended' | 'revoked'; startsAt: string; expiresAt: string; version: number; chain: {status: 'pending' | 'synced'; network: string}; mail: {status: 'enabled' | 'disabled' | 'suspended'; destinationConfigured: boolean; physicalForwardingAvailable: false}; ens: PublicEnsStatus }
const corrupt = (): never => { throw new DomainError('invalid_stored_owner_resource', 503); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const wallet = /^0x[0-9a-f]{40}$/i;
function text(v: unknown, pattern?: RegExp): string { if (typeof v !== 'string' || !v.length || v.length > 2048 || (pattern && !pattern.test(v))) return corrupt(); return v; }
function date(v: unknown): Date { const d = v instanceof Date ? v : v && typeof v === 'object' && 'toDate' in v && typeof v.toDate === 'function' ? v.toDate() : null; if (!(d instanceof Date) || !Number.isFinite(d.getTime())) return corrupt(); return d; }
function integer(v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) return corrupt(); return v; }
function choice<T extends string>(v: unknown, values: readonly T[]): T { if (!values.includes(v as T)) return corrupt(); return v as T; }
function owned(d: DocumentData | undefined, p: AgentPrincipal): asserts d is DocumentData { if (!d || d.tenantId !== p.tenantId || d.agentId !== p.agentId || typeof d.ownerWallet !== 'string' || d.ownerWallet.toLowerCase() !== p.walletAddress.toLowerCase()) throw new DomainError('not_found', 404); if (d.schemaVersion !== SCHEMA_VERSION) corrupt(); }

export class OwnerReadRepository {
  readonly collections: CollectionMapper;
  private readonly now: () => Date;
  constructor(private readonly db: Firestore, prefix: string | undefined, options: {now?: () => Date} = {}) { this.collections = new CollectionMapper(db, prefix); this.now = options.now ?? (() => new Date()); }
  async getOrder(p: AgentPrincipal, id: string): Promise<PublicOrder> { return this.db.runTransaction(async tx => { const d = (await tx.get(this.collections.doc('orders', id))).data(); owned(d, p); return this.order(tx, d, id); }, {readOnly: true}); }
  async getSubscription(p: AgentPrincipal, id: string): Promise<PublicLease> { return this.db.runTransaction(async tx => { const d = (await tx.get(this.collections.doc('leases', id))).data(); owned(d, p); return this.lease(tx, d, id); }, {readOnly: true}); }
  async getEns(p: AgentPrincipal, id: string): Promise<PublicEnsStatus> { return (await this.getSubscription(p, id)).ens; }
  async listOrders(p: AgentPrincipal, options: {limit: number; cursor?: OwnerReadCursor}): Promise<{items: PublicOrder[]; nextCursor: OwnerReadCursor | null}> { return this.list(p, 'orders', 'createdAt', options, (tx, d, id) => this.order(tx, d, id)); }
  async listSubscriptions(p: AgentPrincipal, options: {limit: number; cursor?: OwnerReadCursor}): Promise<{items: PublicLease[]; nextCursor: OwnerReadCursor | null}> { return this.list(p, 'leases', 'updatedAt', options, (tx, d, id) => this.lease(tx, d, id)); }
  private async list<T>(p: AgentPrincipal, collection: 'orders' | 'leases', sort: 'createdAt' | 'updatedAt', options: {limit: number; cursor?: OwnerReadCursor}, convert: (tx: Transaction, d: DocumentData, id: string) => Promise<T>): Promise<{items: T[]; nextCursor: OwnerReadCursor | null}> {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new DomainError('invalid_limit', 422);
    if (options.cursor && (!(options.cursor.at instanceof Date) || !Number.isFinite(options.cursor.at.getTime()) || !uuid.test(options.cursor.id))) throw new DomainError('invalid_cursor', 422);
    let q = this.collections.collection(collection).where('tenantId', '==', p.tenantId).where('agentId', '==', p.agentId).orderBy(sort, 'desc').orderBy(FieldPath.documentId(), 'desc').limit(options.limit + 1);
    if (options.cursor) q = q.startAfter(options.cursor.at, this.collections.doc(collection, options.cursor.id));
    return this.db.runTransaction(async tx => { const result = await tx.get(q); for (const s of result.docs) { owned(s.data(), p); date(s.data()[sort]); }
      const selected = result.docs.slice(0, options.limit); const items = await Promise.all(selected.map(s => convert(tx, s.data(), s.id))); const last = selected.at(-1);
      return {items, nextCursor: result.size > options.limit && last ? {at: date(last.data()[sort]), id: last.id} : null};
    }, {readOnly: true});
  }
  private async order(tx: Transaction, d: DocumentData, id: string): Promise<PublicOrder> {
    if (text(d.id, uuid) !== id) corrupt();
    const out: PublicOrder = {id, kind: choice(d.kind, ['purchase', 'renew', 'ens_addon']), status: choice(d.status, ['awaiting_payment','settling','reconciling','fulfilled','failed_unpaid','manual_review','refund_pending','refunded','expired','cancelled','blocked']), locationId: text(d.locationId ?? d.buildingId, uuid), floor: integer(d.floor ?? d.slotNumber, 1, 65535), amountAtomic: text(d.amountAtomic, /^(0|[1-9][0-9]*)$/), network: text(d.network), asset: text(d.asset, wallet), payTo: text(d.payTo, wallet), expiresAt: date(d.expiresAt).toISOString(), createdAt: date(d.createdAt).toISOString(), riskAssessments: [], payPath: `/v1/payment-intents/${id}/pay`};
    if (d.subscriptionId !== undefined || d.leaseId !== undefined) out.subscriptionId = text(d.subscriptionId ?? d.leaseId, uuid);
    if (out.kind !== 'purchase' && !out.subscriptionId) corrupt();
    if (out.kind === 'ens_addon') { const name = d.ensNameSnapshot; if (!name || typeof name !== 'object') return corrupt(); out.nameType = choice(name.nameType, ['floor','custom']); out.label = text(name.label); out.fqdn = text(name.normalizedName); out.pricingVersion = text(d.pricingVersion); }
    const payment = (await tx.get(this.collections.doc('payments', id))).data();
    if (payment && (payment.schemaVersion !== SCHEMA_VERSION || payment.id !== id || payment.orderId !== id)) corrupt();
    if (out.status === 'fulfilled' && (payment?.status !== 'confirmed' || !out.subscriptionId)) corrupt();
    if (out.status === 'awaiting_payment' && date(d.expiresAt) <= date(this.now()) && !payment) out.status = 'expired';
    if (payment?.status === 'confirmed') {
      if (payment.settlementEvidence?.finalityVerified !== true || typeof payment.evidenceHash !== 'string' || !/^[a-f0-9]{64}$/i.test(payment.evidenceHash) || payment.settlementEvidence.evidenceHash !== payment.evidenceHash || payment.network !== out.network || typeof payment.asset !== 'string' || payment.asset.toLowerCase() !== out.asset.toLowerCase() || typeof payment.payTo !== 'string' || payment.payTo.toLowerCase() !== out.payTo.toLowerCase() || typeof payment.payer !== 'string' || payment.payer.toLowerCase() !== d.ownerWallet.toLowerCase() || payment.amountAtomic !== out.amountAtomic) corrupt();
      integer(payment.transferLogIndex, 0);
      out.receipt = {paymentId: id, network: out.network, asset: out.asset, amountAtomic: out.amountAtomic, payer: text(payment.payer, wallet), payTo: out.payTo, txHash: text(payment.txHash, /^0x[0-9a-f]{64}$/i), confirmedAt: date(payment.confirmedAt).toISOString()};
    }
    for (const side of ['payer','payTo'] as const) { const risk = (await tx.get(this.collections.doc('risk_assessments', sha256(JSON.stringify([id, side, 'settlement']))))).data();
      if (!risk) continue;
      if (risk.schemaVersion !== SCHEMA_VERSION || risk.orderId !== id || risk.side !== side) corrupt();
      if (risk.paymentNetwork !== out.network || typeof risk.subjectAddress !== 'string' || risk.subjectAddress.toLowerCase() !== (side === 'payTo' ? out.payTo : d.ownerWallet).toLowerCase()) corrupt();
      if (risk.reasonCodes !== undefined && !Array.isArray(risk.reasonCodes)) corrupt();
      out.riskAssessments.push({decision: choice(risk.decision, ['allow','deny','hold']), reasonCodes: (risk.reasonCodes ?? []).map((v: unknown) => text(v)), checkedAt: date(risk.checkedAt).toISOString(), paymentNetwork: text(risk.paymentNetwork), riskNetwork: text(risk.riskNetwork), subjectAddress: text(risk.subjectAddress, wallet), side: side === 'payTo' ? 'buyer' : 'seller'});
    }
    return out;
  }
  private async lease(tx: Transaction, d: DocumentData, id: string): Promise<PublicLease> {
    if (text(d.id, uuid) !== id || !['pending', 'synced'].includes(d.chainSyncStatus)) corrupt();
    if (d.chainSyncStatus === 'synced' && (d.registryEvidence?.finalityVerified !== true || d.registryEvidence?.chainId !== 11155111 || d.registryEvidence?.change?.version !== d.version || d.registryEvidence?.change?.leaseKey !== d.leaseKey || d.registryEvidence?.change?.holderCommitment !== d.holderCommitment || d.registryEvidence?.change?.slot !== d.slotNumber || d.registryEvidence?.change?.expiresAt !== String(Math.floor(date(d.expiresAt).getTime() / 1000)))) corrupt();
    const expires = date(d.expiresAt); let status = choice(d.status, ['active','expired','suspended','revoked']); if (status === 'active' && expires <= date(this.now())) status = 'expired';
    const floor = integer(d.slotNumber ?? d.floor, 1, 65535); const snapshot = d.addressSnapshot; if (!snapshot || typeof snapshot !== 'object') corrupt();
    const [mailSnap, entitlementSnap] = await Promise.all([tx.get(this.collections.doc('mail_profiles', id)), tx.get(this.collections.doc('ens_entitlements', id))]); const mail = mailSnap.data(); const entitlement = entitlementSnap.data();
    if (!mail) return corrupt();
    if (mail.leaseId !== id || mail.schemaVersion !== SCHEMA_VERSION || typeof mail.destinationConfigured !== 'boolean' || !['enabled','disabled','suspended'].includes(mail.status)) corrupt();
    const mailStatus = mail.status === 'enabled' ? (await new WorldRepository(this.db,this.collections.prefix,{now:this.now}).getMailStatus(tx,d,mail)).status : mail.status as 'disabled' | 'suspended';
    const ens: PublicEnsStatus = {status: 'not_purchased', network: 'eip155:11155111'};
    if (entitlement) {
      if (entitlement.leaseId !== id || entitlement.schemaVersion !== SCHEMA_VERSION) corrupt();
      const state = choice(entitlement.state, ['pending_payment','paid','refund_pending','refunded']);
      ens.status = state === 'pending_payment' ? 'not_purchased' : state !== 'paid' || status === 'revoked' || status === 'suspended' ? 'disabled' : status === 'expired' ? 'expired' : 'pending';
      if (state === 'refunded') ens.lastErrorCode = 'ens_refunded';
    }
    return {id, locationId: text(d.buildingId ?? d.locationId, uuid), floor, displayAddress: `${text(snapshot.postalCode)} ${text(snapshot.address)} V${String(floor).padStart(5,'0')}`, status, startsAt: date(d.startsAt).toISOString(), expiresAt: expires.toISOString(), version: integer(d.version, 0), chain: {status: d.chainSyncStatus as 'pending' | 'synced', network: 'eip155:11155111'}, mail: {status: mailStatus, destinationConfigured: mail.destinationConfigured, physicalForwardingAvailable: false}, ens};
  }
}
