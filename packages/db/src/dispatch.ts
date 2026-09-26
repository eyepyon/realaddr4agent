import { FieldPath, type Firestore } from '@google-cloud/firestore';
import { DomainError, sha256 } from '@realaddr/domain';
import { CollectionMapper } from './collections.js';

export const DISPATCH_MAX_ATTEMPTS = 10;
const LEASE_MS = 60_000;
export interface SweepCursor { availableAt: Date; id: string }
export interface SweepClaim { owner: string; generation: number; until: Date; through: Date; cursor: SweepCursor | null }
export interface DispatchClaim { id: string; owner: string; generation: number; taskGeneration: number; taskId: string; taskConfirmed: boolean }
function date(value: unknown): Date {
  const result = value instanceof Date ? value : value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function' ? value.toDate() : null;
  if (!(result instanceof Date) || !Number.isFinite(result.getTime())) throw new DomainError('invalid_dispatch_record', 503);
  return result;
}
function integer(value: unknown, fallback = 0): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || (result as number) < 0 || (result as number) >= Number.MAX_SAFE_INTEGER) throw new DomainError('invalid_dispatch_record', 503);
  return result as number;
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 256 || value.includes('/')) throw new DomainError('invalid_dispatch_id', 422);
}
function owner(value: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new DomainError('invalid_dispatch_owner', 422);
}
function cursor(value: unknown): SweepCursor | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || !('id' in value) || !('availableAt' in value)) throw new DomainError('invalid_dispatch_record', 503);
  id(value.id);
  return { id: value.id, availableAt: date(value.availableAt) };
}
export class DispatchRepository {
  readonly collections: CollectionMapper;
  private readonly now: () => Date;
  constructor(private readonly db: Firestore, prefix: string | undefined, options: { now?: () => Date } = {}) {
    this.collections = new CollectionMapper(db, prefix);
    this.now = options.now ?? (() => new Date());
  }
  async acquireSweep(claimOwner: string): Promise<SweepClaim | null> {
    owner(claimOwner);
    const ref = this.collections.doc('ops_metrics', 'outbox_dispatch_sweep');
    return this.db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const data = snap.data();
      const now = this.now();
      if (data?.until && date(data.until) > now) return null;
      const generation = integer(data?.generation) + 1;
      const savedCursor = cursor(data?.cursor);
      const through = savedCursor ? date(data?.through) : now;
      const until = new Date(now.getTime() + LEASE_MS);
      tx.set(ref, { schemaVersion: 1, owner: claimOwner, generation, until, through, cursor: savedCursor, updatedAt: now });
      return { owner: claimOwner, generation, until, through, cursor: savedCursor };
    });
  }
  private checkSweep(data: Record<string, unknown> | undefined, claim: SweepClaim): void {
    if (!data || data.owner !== claim.owner || data.generation !== claim.generation || date(data.until) <= this.now() || date(data.through).getTime() !== claim.through.getTime()) throw new DomainError('sweep_claim_lost', 409);
  }
  async listSweepPage(claim: SweepClaim): Promise<{ ids: string[]; cursor: SweepCursor | null }> {
    this.checkSweep((await this.collections.doc('ops_metrics', 'outbox_dispatch_sweep').get()).data(), claim);
    let query = this.collections.collection('outbox').where('state', 'in', ['pending', 'processing']).where('availableAt', '<=', claim.through).orderBy('availableAt').orderBy(FieldPath.documentId());
    if (claim.cursor) query = query.startAfter(claim.cursor.availableAt, claim.cursor.id);
    const page = await query.limit(20).get();
    const last = page.docs.at(-1);
    return { ids: page.docs.map(doc => doc.id), cursor: page.size === 20 && last ? { availableAt: date(last.data().availableAt), id: last.id } : null };
  }
  async finishSweep(claim: SweepClaim, nextCursor: SweepCursor | null): Promise<void> {
    const savedCursor = cursor(nextCursor);
    const ref = this.collections.doc('ops_metrics', 'outbox_dispatch_sweep');
    await this.db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      this.checkSweep(snap.data(), claim);
      tx.update(ref, { cursor: savedCursor, owner: null, until: null, updatedAt: this.now() });
    });
  }
  async claimDispatch(jobId: string, claimOwner: string): Promise<DispatchClaim | null> {
    id(jobId); owner(claimOwner);
    const ref = this.collections.doc('outbox', jobId);
    return this.db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const data = snap.data()!;
      if (['completed', 'superseded', 'manual_review'].includes(data.state)) return null;
      if (data.state !== 'pending' && data.state !== 'processing') throw new DomainError('invalid_outbox_state', 503);
      const now = this.now();
      if (date(data.availableAt) > now || (data.state === 'processing' && date(data.claimUntil) > now) || (data.dispatchUntil && date(data.dispatchUntil) > now) || (data.dispatchAvailableAt && date(data.dispatchAvailableAt) > now)) return null;
      const attempts = integer(data.dispatchAttempts);
      const generation = integer(data.dispatchGeneration) + 1;
      const taskGeneration = integer(data.taskGeneration);
      const taskId = sha256(JSON.stringify([jobId, taskGeneration]));
      if (taskGeneration > attempts || attempts > DISPATCH_MAX_ATTEMPTS || (data.taskId !== undefined && data.taskId !== taskId) || (data.taskConfirmed !== undefined && typeof data.taskConfirmed !== 'boolean') || (data.reconciliationOnly !== undefined && typeof data.reconciliationOnly !== 'boolean')) throw new DomainError('invalid_dispatch_record', 503);
      if (attempts >= DISPATCH_MAX_ATTEMPTS) {
        id(data.aggregateId);
        if (!Number.isSafeInteger(data.version) || data.version < 1 || typeof data.eventType !== 'string') throw new DomainError('invalid_dispatch_record', 503);
        const kind = data.eventType.startsWith('payment.') ? 'payment' : data.eventType.startsWith('lease.registry_') ? 'registry' : data.eventType.startsWith('ens.') ? 'ens' : null;
        if (kind) {
          const operationId = sha256(JSON.stringify([kind, data.aggregateId]));
          const projection = this.collections.doc('admin_operations', operationId);
          const operation = (await tx.get(projection)).data();
          if (operation && (operation.kind !== kind || operation.targetId !== data.aggregateId || operation.operationId !== operationId)) throw new DomainError('invalid_outbox_projection', 503);
          if (operation?.version === data.version) tx.update(projection, { status: 'manual_review', lastErrorCode: 'dispatch_attempts_exhausted', nextAttemptAt: null, updatedAt: now });
        }
        tx.update(ref, { state: 'manual_review', claimOwner: null, claimUntil: null, reconciliationOnly: data.reconciliationOnly === true || data.state === 'processing', dispatchOwner: null, dispatchUntil: null, lastErrorCode: 'dispatch_attempts_exhausted', updatedAt: now });
        return null;
      }
      tx.update(ref, { dispatchAttempts: attempts + 1, dispatchOwner: claimOwner, dispatchGeneration: generation, dispatchUntil: new Date(now.getTime() + LEASE_MS), taskGeneration, taskId, taskConfirmed: data.taskConfirmed === true, updatedAt: now });
      return { id: jobId, owner: claimOwner, generation, taskGeneration, taskId, taskConfirmed: data.taskConfirmed === true };
    });
  }
  async finishDispatch(claim: DispatchClaim, result: 'confirmed' | 'unknown' | 'missing'): Promise<void> {
    if (!['confirmed', 'unknown', 'missing'].includes(result)) throw new DomainError('invalid_dispatch_result', 422);
    const ref = this.collections.doc('outbox', claim.id);
    await this.db.runTransaction(async tx => {
      const data = (await tx.get(ref)).data();
      const now = this.now();
      if (!data || data.dispatchOwner !== claim.owner || data.dispatchGeneration !== claim.generation || date(data.dispatchUntil) <= now || data.taskId !== claim.taskId || data.taskGeneration !== claim.taskGeneration) throw new DomainError('dispatch_claim_lost', 409);
      const attempts = integer(data.dispatchAttempts);
      if (attempts < 1 || attempts > DISPATCH_MAX_ATTEMPTS) throw new DomainError('invalid_dispatch_record', 503);
      tx.update(ref, { dispatchOwner: null, dispatchUntil: null, dispatchAvailableAt: new Date(now.getTime() + Math.min(300_000, 5_000 * 2 ** (attempts - 1))), taskConfirmed: result === 'confirmed' || (result === 'unknown' && data.taskConfirmed === true), ...(result === 'missing' ? { taskGeneration: claim.taskGeneration + 1, taskId: sha256(JSON.stringify([claim.id, claim.taskGeneration + 1])) } : {}), updatedAt: now });
    });
  }
}
