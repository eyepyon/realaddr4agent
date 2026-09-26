import { randomBytes } from 'node:crypto';
import type { Firestore, Transaction } from '@google-cloud/firestore';
import { encodeAbiParameters, keccak256, type Hex } from 'viem';
import { DomainError, normalizeWallet, sha256, validateFloor } from '@realaddr/domain';
import { CollectionMapper } from './collections.js';
import { assertCurrentOutboxClaim, type OutboxClaim } from './outbox.js';

export interface RegistryChange {
  kind: 'record' | 'revoke';
  leaseKey: Hex;
  buildingKey: Hex;
  slot: number;
  holderCommitment: Hex;
  expiresAt: string;
  version: number;
}
export interface RegistryReadbackEvidence {
  change: RegistryChange;
  chainId: 11155111;
  registryAddress: Hex;
  blockNumber: string;
  blockHash: Hex;
  finalityVerified: true;
}
const hex32 = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v) && !/^0x0+$/.test(v);
const key = (): Hex => `0x${randomBytes(32).toString('hex')}`;
function date(value: unknown): Date {
  const result = value instanceof Date ? value : value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function' ? value.toDate() : undefined;
  if (!(result instanceof Date) || !Number.isFinite(result.getTime())) throw new DomainError('registry_state_inconsistent', 503);
  return result;
}
function same(a: RegistryChange, b: RegistryChange): boolean {
  return a.kind === b.kind && a.leaseKey === b.leaseKey && a.buildingKey === b.buildingKey && a.slot === b.slot && a.holderCommitment === b.holderCommitment && a.expiresAt === b.expiresAt && a.version === b.version;
}

export class RegistryRepository {
  readonly collections: CollectionMapper;
  private readonly now: () => Date;
  private readonly registryAddress: string;
  constructor(private readonly db: Firestore, prefix: string | undefined, options: { registryAddress: string; now?: () => Date }) {
    this.collections = new CollectionMapper(db, prefix);
    this.now = options.now ?? (() => new Date());
    this.registryAddress = normalizeWallet(options.registryAddress);
    if (/^0x0+$/.test(this.registryAddress)) throw new DomainError('registry_unavailable', 503);
  }

  private async inspect(tx: Transaction, claim: OutboxClaim) {
    if (claim.eventType !== 'lease.registry_sync_requested' || claim.payload.leaseId !== claim.aggregateId || claim.payload.leaseVersion !== claim.version) throw new DomainError('invalid_registry_job', 503);
    const jobRef = this.collections.doc('outbox', claim.id);
    const leaseRef = this.collections.doc('leases', claim.aggregateId);
    const operationRef = this.collections.doc('admin_operations', sha256(JSON.stringify(['registry', claim.aggregateId])));
    const [job, leaseSnap, operation] = await Promise.all([tx.get(jobRef), tx.get(leaseRef), tx.get(operationRef)]);
    assertCurrentOutboxClaim(job.data(), claim, this.now());
    const lease = leaseSnap.data();
    if (!lease || lease.id !== claim.aggregateId || !Number.isSafeInteger(lease.version)) throw new DomainError('registry_state_inconsistent', 503);
    if (lease.version > claim.version) {
      tx.update(jobRef, { state: 'superseded', claimOwner: null, claimUntil: null, updatedAt: this.now() });
      return null;
    }
    if (lease.version !== claim.version || lease.version < 1 || !['active', 'expired', 'revoked'].includes(lease.status)) throw new DomainError('registry_state_inconsistent', 503);
    const orderId = lease.registryPaymentOrderId ?? (lease.version === 1 ? lease.id : undefined);
    if (typeof orderId !== 'string') throw new DomainError('registry_paid_provenance_missing', 503);
    const buildingRef = this.collections.doc('buildings', lease.buildingId);
    const [building, slot, orderSnap, paymentSnap] = await Promise.all([
      tx.get(buildingRef), tx.get(this.collections.doc('slots', `${lease.buildingId}_${lease.slotNumber}`)),
      tx.get(this.collections.doc('orders', orderId)), tx.get(this.collections.doc('payments', orderId)),
    ]);
    const order = orderSnap.data(); const payment = paymentSnap.data();
    if (!order || !payment || order.status !== 'fulfilled' || order.leaseId !== lease.id || order.buildingId !== lease.buildingId || order.slotNumber !== lease.slotNumber || order.ownerWallet !== lease.ownerWallet || payment.status !== 'confirmed' || payment.orderId !== orderId || payment.payer !== lease.ownerWallet || payment.settlementEvidence?.finalityVerified !== true || payment.settlementEvidence?.evidenceHash !== payment.evidenceHash || !hex32(payment.txHash) || !Number.isSafeInteger(payment.transferLogIndex) || payment.transferLogIndex < 0 || order.network !== payment.network || order.asset !== payment.asset || order.payTo !== payment.payTo || order.amountAtomic !== payment.amountAtomic || (lease.version === 1 ? order.kind !== 'purchase' : order.kind !== 'renew' || order.leaseVersion !== lease.version - 1)) throw new DomainError('registry_paid_provenance_invalid', 503);
    if (payment.network !== 'eip155:84532' || payment.amountAtomic !== '550000' || typeof payment.evidenceHash !== 'string' || !/^[a-f0-9]{64}$/.test(payment.evidenceHash) || normalizeWallet(payment.asset) !== payment.asset || normalizeWallet(payment.payTo) !== payment.payTo) throw new DomainError('registry_paid_provenance_invalid', 503);
    if (typeof lease.tenantId !== 'string' || typeof lease.agentId !== 'string' || order.tenantId !== lease.tenantId || order.agentId !== lease.agentId) throw new DomainError('registry_paid_provenance_invalid', 503);
    const guard = await tx.get(this.collections.doc('uniques', sha256(JSON.stringify(['payment_transfer', payment.network, payment.txHash, String(payment.transferLogIndex)]))));
    if (guard.data()?.orderId !== orderId || guard.data()?.paymentId !== orderId || !building.exists || slot.data()?.leaseId !== lease.id || slot.data()?.state !== 'leased') throw new DomainError('registry_state_inconsistent', 503);
    const op = operation.data();
    if (!op || op.kind !== 'registry' || op.targetId !== lease.id || op.version !== lease.version) throw new DomainError('registry_state_inconsistent', 503);
    const confirmedAt = date(payment.confirmedAt).getTime();
    const expectedExpiry = (order.kind === 'purchase' ? confirmedAt : Math.max(date(order.previousExpiresAt).getTime(), confirmedAt)) + 30 * 86_400_000;
    if (date(lease.expiresAt).getTime() !== expectedExpiry) throw new DomainError('registry_paid_provenance_invalid', 503);
    assertCurrentOutboxClaim(job.data(), claim, this.now());
    return { jobRef, leaseRef, operationRef, job: job.data()!, lease, buildingRef, building: building.data()! };
  }

  async prepare(claim: OutboxClaim): Promise<{ status: 'ready'; change: RegistryChange } | { status: 'superseded' }> {
    const candidates = { buildingKey: key(), leaseKey: key(), holderSalt: key() };
    return this.db.runTransaction(async tx => {
      const state = await this.inspect(tx, claim);
      if (!state) return { status: 'superseded' as const };
      const identityFields = [state.lease.leaseKey, state.lease.holderSalt, state.lease.holderCommitment];
      if (identityFields.some(value => value !== undefined) && !identityFields.every(hex32)) throw new DomainError('registry_identity_invalid', 503);
      if ((identityFields.some(value => value !== undefined) || state.lease.registryEvidence !== undefined || state.job.registryChange !== undefined) && !hex32(state.building.buildingKey)) throw new DomainError('registry_identity_invalid', 503);
      if (state.lease.registryEvidence !== undefined && !identityFields.every(hex32)) throw new DomainError('registry_identity_invalid', 503);
      const buildingKey = state.building.buildingKey ?? candidates.buildingKey;
      const leaseKey = state.lease.leaseKey ?? candidates.leaseKey;
      const holderSalt = state.lease.holderSalt ?? candidates.holderSalt;
      if (![buildingKey, leaseKey, holderSalt].every(hex32)) throw new DomainError('registry_identity_invalid', 503);
      const holderCommitment = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [normalizeWallet(state.lease.ownerWallet) as Hex, holderSalt]));
      if (state.lease.holderCommitment !== undefined && state.lease.holderCommitment !== holderCommitment) throw new DomainError('registry_identity_invalid', 503);
      const change: RegistryChange = { kind: state.lease.status === 'revoked' ? 'revoke' : 'record', buildingKey, leaseKey, holderCommitment, slot: validateFloor(state.lease.slotNumber), expiresAt: String(Math.floor(date(state.lease.expiresAt).getTime() / 1000)), version: state.lease.version };
      if (state.job.registryChange && !same(state.job.registryChange, change)) throw new DomainError('registry_change_conflict', 409);
      if (!state.building.buildingKey) tx.update(state.buildingRef, { buildingKey });
      tx.update(state.leaseRef, { leaseKey, holderSalt, holderCommitment });
      tx.update(state.jobRef, { registryChange: change });
      return { status: 'ready' as const, change };
    });
  }

  async confirm(claim: OutboxClaim, evidence: RegistryReadbackEvidence): Promise<'confirmed' | 'superseded'> {
    if (!evidence || !evidence.change || evidence.chainId !== 11155111 || typeof evidence.registryAddress !== 'string' || evidence.registryAddress.toLowerCase() !== this.registryAddress || evidence.finalityVerified !== true || !hex32(evidence.blockHash) || typeof evidence.blockNumber !== 'string' || !/^(0|[1-9][0-9]*)$/.test(evidence.blockNumber)) throw new DomainError('registry_evidence_invalid', 422);
    return this.db.runTransaction(async tx => {
      const state = await this.inspect(tx, claim);
      if (!state) return 'superseded' as const;
      const change = state.job.registryChange as RegistryChange | undefined;
      if (!change || !same(change, evidence.change) || change.leaseKey !== state.lease.leaseKey || change.buildingKey !== state.building.buildingKey || change.holderCommitment !== state.lease.holderCommitment || change.expiresAt !== String(Math.floor(date(state.lease.expiresAt).getTime() / 1000)) || change.version !== state.lease.version || change.kind !== (state.lease.status === 'revoked' ? 'revoke' : 'record') || change.slot !== state.lease.slotNumber) throw new DomainError('registry_evidence_mismatch', 409);
      const now = this.now();
      assertCurrentOutboxClaim(state.job, claim, now);
      tx.update(state.jobRef, { state: 'completed', claimOwner: null, claimUntil: null, registryEvidence: evidence, updatedAt: now });
      tx.update(state.leaseRef, { chainSyncStatus: 'synced', registryEvidence: evidence, updatedAt: now });
      tx.delete(state.operationRef);
      return 'confirmed' as const;
    });
  }
}
