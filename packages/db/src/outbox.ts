import type { Firestore, Transaction } from '@google-cloud/firestore';
import { DomainError, sha256 } from '@realaddr/domain';
import { CollectionMapper } from './collections.js';

export const OUTBOX_MAX_ATTEMPTS = 5;
export const OUTBOX_CLAIM_MS = 60_000;
const MAX_DUE = 20;
const MIN_RETRY_MS = 5_000;
const MAX_RETRY_MS = 300_000;

export interface OutboxClaim {
  id: string;
  eventType: string;
  aggregateId: string;
  version: number;
  payload: { orderId?: string; leaseId?: string; leaseVersion?: number };
  claimOwner: string;
  claimGeneration: number;
  claimUntil: Date;
  reconciliationOnly: boolean;
}

function storedDate(value: unknown): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    const date = value.toDate();
    if (date instanceof Date && Number.isFinite(date.getTime())) return date;
  }
  throw new DomainError('invalid_outbox_timestamp', 503);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('/');
}

function metadata(id: string, data: Record<string, unknown>): Pick<OutboxClaim, 'id' | 'eventType' | 'aggregateId' | 'version' | 'payload'> {
  if (!validId(data.aggregateId) || typeof data.eventType !== 'string' || !/^[a-z][a-z0-9_.]{0,127}$/.test(data.eventType) || !Number.isSafeInteger(data.version) || (data.version as number) < 1 || !data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload)) throw new DomainError('invalid_outbox_record', 503);
  const raw = data.payload as Record<string, unknown>;
  const payload: OutboxClaim['payload'] = {};
  if (raw.orderId !== undefined) {
    if (!validId(raw.orderId)) throw new DomainError('invalid_outbox_record', 503);
    payload.orderId = raw.orderId;
  }
  if (raw.leaseId !== undefined) {
    if (!validId(raw.leaseId)) throw new DomainError('invalid_outbox_record', 503);
    payload.leaseId = raw.leaseId;
  }
  if (raw.leaseVersion !== undefined) {
    if (!Number.isSafeInteger(raw.leaseVersion) || (raw.leaseVersion as number) < 1) throw new DomainError('invalid_outbox_record', 503);
    payload.leaseVersion = raw.leaseVersion as number;
  }
  return { id, eventType: data.eventType, aggregateId: data.aggregateId, version: data.version as number, payload };
}

export function assertCurrentOutboxClaim(data: Record<string, unknown> | undefined, claim: OutboxClaim, now: Date): void {
  if (!data || data.state !== 'processing' || data.claimOwner !== claim.claimOwner || data.claimGeneration !== claim.claimGeneration || storedDate(data.claimUntil).getTime() <= now.getTime() || data.eventType !== claim.eventType || data.aggregateId !== claim.aggregateId || data.version !== claim.version || data.reconciliationOnly !== claim.reconciliationOnly || JSON.stringify(metadata(claim.id, data).payload) !== JSON.stringify(claim.payload)) throw new DomainError('outbox_claim_lost', 409);
}

export class OutboxRepository {
  readonly collections: CollectionMapper;
  private readonly now: () => Date;

  constructor(private readonly db: Firestore, prefix: string | undefined, options: { now?: () => Date } = {}) {
    this.collections = new CollectionMapper(db, prefix);
    this.now = options.now ?? (() => new Date());
  }

  private async updateOperation(tx: Transaction, job: Pick<OutboxClaim, 'eventType' | 'aggregateId' | 'version'>, fields: Record<string, unknown>): Promise<void> {
    const kind = job.eventType.startsWith('payment.') ? 'payment' : job.eventType.startsWith('lease.registry_') ? 'registry' : job.eventType.startsWith('ens.') ? 'ens' : null;
    if (!kind) return;
    const operationId = sha256(JSON.stringify([kind, job.aggregateId]));
    const ref = this.collections.doc('admin_operations', operationId);
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const data = snap.data()!;
    if (data.kind !== kind || data.targetId !== job.aggregateId || data.operationId !== operationId) throw new DomainError('invalid_outbox_projection', 503);
    if (data.version !== job.version) return;
    tx.update(ref, fields);
  }

  async listDue(limit = MAX_DUE): Promise<string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DUE) throw new DomainError('invalid_outbox_limit', 422);
    const now = this.now();
    const result = await this.collections.collection('outbox')
      .where('state', 'in', ['pending', 'processing'])
      .where('availableAt', '<=', now)
      .orderBy('availableAt')
      .limit(limit)
      .get();
    return result.docs.map(doc => doc.id);
  }

  async getDeliveryState(id: string): Promise<'completed' | 'superseded' | 'manual_review' | 'missing' | 'pending'> {
    if (!validId(id)) throw new DomainError('invalid_outbox_claim', 422);
    const snap = await this.collections.doc('outbox', id).get();
    if (!snap.exists) return 'missing';
    const state = snap.data()!.state;
    if (state === 'pending' || state === 'processing') return 'pending';
    if (state === 'completed' || state === 'superseded' || state === 'manual_review') return state;
    throw new DomainError('invalid_outbox_state', 503);
  }

  async claim(id: string, owner: string): Promise<OutboxClaim | null> {
    if (typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(owner) || !validId(id)) throw new DomainError('invalid_outbox_claim', 422);
    const ref = this.collections.doc('outbox', id);
    return this.db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const now = this.now();
      if (!snap.exists) return null;
      const data = snap.data()!;
      if (data.state === 'completed' || data.state === 'superseded' || data.state === 'manual_review') return null;
      if (data.state !== 'pending' && data.state !== 'processing') throw new DomainError('invalid_outbox_state', 503);
      const base = metadata(id, data);
      if (!Number.isSafeInteger(data.attempts) || data.attempts < 0 || !Number.isSafeInteger(data.claimGeneration ?? 0) || (data.claimGeneration ?? 0) < 0 || (data.claimGeneration ?? 0) >= Number.MAX_SAFE_INTEGER || (data.reconciliationOnly !== undefined && typeof data.reconciliationOnly !== 'boolean')) throw new DomainError('invalid_outbox_record', 503);
      const availableAt = storedDate(data.availableAt);
      if (availableAt > now) return null;
      const expiredProcessing = data.state === 'processing';
      if (expiredProcessing && storedDate(data.claimUntil) > now) return null;
      if (data.attempts >= OUTBOX_MAX_ATTEMPTS) {
        await this.updateOperation(tx, base, { status: 'manual_review', lastErrorCode: 'attempts_exhausted', nextAttemptAt: null, updatedAt: now });
        tx.update(ref, { state: 'manual_review', claimOwner: null, claimUntil: null, reconciliationOnly: data.reconciliationOnly === true || expiredProcessing, lastErrorCode: 'attempts_exhausted', updatedAt: now });
        return null;
      }
      const generation = (data.claimGeneration ?? 0) + 1;
      const claimUntil = new Date(now.getTime() + OUTBOX_CLAIM_MS);
      const reconciliationOnly = data.reconciliationOnly === true || expiredProcessing;
      tx.update(ref, { state: 'processing', attempts: data.attempts + 1, claimOwner: owner, claimUntil, claimGeneration: generation, reconciliationOnly, availableAt: claimUntil, updatedAt: now });
      return { ...base, claimOwner: owner, claimGeneration: generation, claimUntil, reconciliationOnly };
    });
  }

  async complete(claim: OutboxClaim): Promise<void> {
    const ref = this.collections.doc('outbox', claim.id);
    await this.db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const now = this.now();
      assertCurrentOutboxClaim(snap.data(), claim, now);
      tx.update(ref, { state: 'completed', claimOwner: null, claimUntil: null, updatedAt: now });
    });
  }

  async retry(claim: OutboxClaim, reason: 'handler_unavailable' | 'issuance_inconsistent' | 'processing_failed' | 'registry_readback_unconfirmed' | 'registry_readback_failed' = 'processing_failed'): Promise<'pending' | 'manual_review'> {
    if (reason !== 'handler_unavailable' && reason !== 'issuance_inconsistent' && reason !== 'processing_failed' && reason !== 'registry_readback_unconfirmed' && reason !== 'registry_readback_failed') throw new DomainError('invalid_outbox_retry_reason', 422);
    const ref = this.collections.doc('outbox', claim.id);
    return this.db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const now = this.now();
      const data = snap.data();
      assertCurrentOutboxClaim(data, claim, now);
      if (!Number.isSafeInteger(data!.attempts) || data!.attempts < 1 || data!.attempts > OUTBOX_MAX_ATTEMPTS) throw new DomainError('invalid_outbox_record', 503);
      if (data!.attempts >= OUTBOX_MAX_ATTEMPTS) {
        await this.updateOperation(tx, claim, { status: 'manual_review', lastErrorCode: reason, nextAttemptAt: null, updatedAt: now });
        tx.update(ref, { state: 'manual_review', claimOwner: null, claimUntil: null, lastErrorCode: reason, updatedAt: now });
        return 'manual_review' as const;
      }
      const delayMs = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** (data!.attempts - 1));
      const availableAt = new Date(now.getTime() + delayMs);
      await this.updateOperation(tx, claim, { lastErrorCode: reason, nextAttemptAt: availableAt, updatedAt: now });
      tx.update(ref, { state: 'pending', availableAt, claimOwner: null, claimUntil: null, lastErrorCode: reason, updatedAt: now });
      return 'pending' as const;
    });
  }
}
