import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { FieldPath, type DocumentData, type Firestore, type Transaction } from '@google-cloud/firestore';
import { DomainError, SCHEMA_VERSION, SHARD_COUNT, SLOT_CAPACITY, assertIdempotencyKey, bitmapEmpty, normalizePostalCode, normalizeSlug, requiredText, sha256, shardCapacity, validatePricing, type PricingConfig } from '@realaddr/domain';
import { CollectionMapper } from './collections.js';
import type { EncryptedPaymentPayload, LocationInput, PurchaseReadiness } from './repository.js';
import { WorldRepository } from './world.js';

export interface AdminSessionIdentity { principalId: string; issuer: string; subject: string; displayName: string; expiresAt: string; csrfHash: string }
export interface AdminLoginInput { stateHash: string; nonceHash: string; encryptedVerifier: EncryptedPaymentPayload; cookieHash: string; expiresAt: Date }
export type AdminListKind = 'locations' | 'payments' | 'subscriptions' | 'operations' | 'audit';
export interface AdminListQuery { limit?: number; cursor?: string; id?: string; status?: string; locationId?: string; kind?: string; targetType?: string; targetId?: string }
export interface AdminLocationUpdate { expectedVersion: number; reason: string; publicationConfirmed?: boolean; changes: Partial<Pick<LocationInput, 'displayName' | 'publicArea' | 'postalCode' | 'address'>> & { status?: 'available' | 'paused' } }
function fail(code: string, status = 403): never { throw new DomainError(code, status); }
const hashPattern = /^[a-f0-9]{64}$/;
const guard = (...parts: string[]) => sha256(JSON.stringify(parts));
const validHash = (value: unknown): value is string => typeof value === 'string' && hashPattern.test(value);
function date(value: unknown): Date { const d = value instanceof Date ? value : value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function' ? value.toDate() : null; if (!(d instanceof Date) || !Number.isFinite(d.getTime())) return fail('invalid_admin_state', 503); return d; }
function text(value: unknown, max = 128): string { if (typeof value !== 'string' || !value || value.length > max) return fail('invalid_admin_state', 503); return value; }
function int(value: unknown, min = 0): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) return fail('invalid_admin_state', 503); return value; }
function email(value: string): string { if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) return fail('invalid_admin_email', 422); return value.trim().toLowerCase(); }
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])); return value; }
function constantEqual(a: string, b: string): boolean { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); }
function envelope(value: EncryptedPaymentPayload): void { if (value?.algorithm !== 'aes-256-gcm' || typeof value.keyId !== 'string' || !value.keyId || value.keyId.length > 128 || !/^[A-Za-z0-9+/]{16}$/.test(value.iv) || !/^[A-Za-z0-9+/]{22}==$/.test(value.tag) || !value.ciphertext || value.ciphertext.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.ciphertext)) fail('invalid_admin_login', 422); }

export class AdminRepository {
  readonly collections: CollectionMapper;
  private readonly now: () => Date;
  private readonly pricing: Readonly<PricingConfig> | null;
  private readonly cursorSecret: string | undefined;
  constructor(private readonly db: Firestore, prefix: string | undefined, pricing: PricingConfig | null, options: { now?: () => Date; cursorSecret?: string } = {}) {
    this.collections = new CollectionMapper(db, prefix); this.pricing = pricing === null ? null : validatePricing(pricing); this.now = options.now ?? (() => new Date()); this.cursorSecret = options.cursorSecret;
    if (options.cursorSecret !== undefined && options.cursorSecret.length < 32) fail('invalid_admin_cursor_configuration', 503);
  }

  async bootstrapPrincipals(emails: string[]): Promise<void> {
    if (!Array.isArray(emails) || emails.length > 100) fail('invalid_admin_allowlist', 422);
    const normalized = [...new Set(emails.map(email))];
    await this.db.runTransaction(async tx => {
      const entries = await Promise.all(normalized.map(async value => ({ value, ref: this.collections.doc('admin_principals', sha256(value)), snap: await tx.get(this.collections.doc('admin_principals', sha256(value))) })));
      for (const entry of entries) if (!entry.snap.exists) tx.create(entry.ref, { schemaVersion: SCHEMA_VERSION, emailLower: entry.value, issuer: null, subject: null, role: 'operator', status: 'active', boundAt: null, version: 1 });
    });
  }
  async issueLogin(input: AdminLoginInput): Promise<void> {
    if (![input.stateHash, input.nonceHash, input.cookieHash].every(validHash)) fail('invalid_admin_login', 422); envelope(input.encryptedVerifier);
    const now = date(this.now()), expiresAt = date(input.expiresAt);
    if (expiresAt <= now || expiresAt.getTime() > now.getTime() + 10 * 60_000) fail('invalid_admin_login', 422);
    const allowed = await this.collections.collection('admin_principals').where('status', '==', 'active').where('role', '==', 'operator').limit(1).get();
    const principal = allowed.docs[0];
    if (!principal || principal.data().schemaVersion !== SCHEMA_VERSION || typeof principal.data().emailLower !== 'string' || sha256(principal.data().emailLower) !== principal.id) fail('admin_unavailable', 503);
    await this.collections.doc('admin_oidc_sessions', input.stateHash).create({ schemaVersion: SCHEMA_VERSION, ...input, createdAt: now, consumedAt: null });
  }
  async consumeLogin(stateHash: string, cookieHash: string): Promise<{ encryptedVerifier: EncryptedPaymentPayload; nonceHash: string }> {
    if (!validHash(stateHash) || !validHash(cookieHash)) fail('admin_login_invalid');
    return this.db.runTransaction(async tx => {
      const ref = this.collections.doc('admin_oidc_sessions', stateHash), d = (await tx.get(ref)).data();
      if (!d || d.schemaVersion !== SCHEMA_VERSION || d.stateHash !== stateHash || d.consumedAt || date(d.expiresAt) <= this.now() || !validHash(d.cookieHash) || !constantEqual(d.cookieHash, cookieHash) || !validHash(d.nonceHash)) fail('admin_login_invalid');
      envelope(d.encryptedVerifier); tx.update(ref, { consumedAt: this.now() });
      return { encryptedVerifier: d.encryptedVerifier, nonceHash: d.nonceHash };
    });
  }
  async bindAndIssueSession(input: { issuer: string; subject: string; email: string; displayName: string; tokenHash: string; csrfHash: string }): Promise<{ displayName: string; expiresAt: string; principalId: string }> {
    if (!['https://accounts.google.com', 'accounts.google.com'].includes(input.issuer) || typeof input.subject !== 'string' || !input.subject || input.subject.length > 255 || !validHash(input.tokenHash) || !validHash(input.csrfHash)) fail('admin_identity_invalid');
    const issuer = 'https://accounts.google.com', normalizedEmail = email(input.email), displayName = requiredText(input.displayName, 100), principalId = sha256(normalizedEmail), now = date(this.now()), expiresAt = new Date(now.getTime() + 60 * 60_000);
    return this.db.runTransaction(async tx => {
      const ref = this.collections.doc('admin_principals', principalId), d = (await tx.get(ref)).data();
      if (!d || d.schemaVersion !== SCHEMA_VERSION || d.emailLower !== normalizedEmail || d.status !== 'active' || d.role !== 'operator') fail('admin_forbidden');
      if (d.issuer === null && d.subject === null && d.boundAt === null) tx.update(ref, { issuer, subject: input.subject, boundAt: now, version: int(d.version, 1) + 1 });
      else if (d.issuer !== issuer || d.subject !== input.subject || !d.boundAt) fail('admin_identity_conflict');
      tx.create(this.collections.doc('admin_sessions', input.tokenHash), { schemaVersion: SCHEMA_VERSION, principalId, issuer, subject: input.subject, displayName, csrfHash: input.csrfHash, createdAt: now, lastUsedAt: now, expiresAt, revokedAt: null });
      return { displayName, expiresAt: expiresAt.toISOString(), principalId };
    });
  }
  private async session(tx: Transaction, tokenHash: string): Promise<AdminSessionIdentity> {
    if (!validHash(tokenHash)) return fail('admin_session_required', 401);
    const d = (await tx.get(this.collections.doc('admin_sessions', tokenHash))).data(), now = date(this.now());
    if (!d || d.schemaVersion !== SCHEMA_VERSION || d.issuer !== 'https://accounts.google.com' || d.revokedAt || date(d.expiresAt) <= now || date(d.lastUsedAt).getTime() + 15 * 60_000 <= now.getTime() || date(d.createdAt) > now || date(d.lastUsedAt) > now || date(d.expiresAt).getTime() !== date(d.createdAt).getTime() + 60 * 60_000 || !validHash(d.csrfHash) || !validHash(d.principalId)) return fail('admin_session_required', 401);
    const p = (await tx.get(this.collections.doc('admin_principals', d.principalId))).data();
    if (!p || p.schemaVersion !== SCHEMA_VERSION || p.status !== 'active' || p.role !== 'operator' || p.issuer !== d.issuer || p.subject !== d.subject || !p.boundAt || sha256(text(p.emailLower, 254)) !== d.principalId) return fail('admin_session_required', 401);
    return { principalId: d.principalId, issuer: d.issuer, subject: text(d.subject, 255), displayName: text(d.displayName, 100), expiresAt: date(d.expiresAt).toISOString(), csrfHash: d.csrfHash };
  }
  private touch(tx: Transaction, tokenHash: string): void { tx.update(this.collections.doc('admin_sessions', tokenHash), { lastUsedAt: this.now() }); }
  async authenticateSession(tokenHash: string): Promise<AdminSessionIdentity> { return this.db.runTransaction(async tx => { const identity = await this.session(tx, tokenHash); this.touch(tx, tokenHash); return identity; }); }
  async revokeSession(tokenHash: string): Promise<void> { await this.db.runTransaction(async tx => { await this.session(tx, tokenHash); tx.update(this.collections.doc('admin_sessions', tokenHash), { revokedAt: this.now() }); }); }

  private plan(): Record<string, unknown> { if (!this.pricing) return fail('pricing_unavailable', 503); return { periodDays: 30, amountAtomic: this.pricing.addressAmountAtomic, asset: this.pricing.asset, network: this.pricing.network, pricingVersion: this.pricing.pricingVersion }; }
  private reason(value: string): string { const normalized = requiredText(value, 500); if (normalized.length < 3) return fail('invalid_reason', 422); return normalized; }
  private audit(tx: Transaction, input: { eventId: string; actor: AdminSessionIdentity; action: string; id: string; reason: string; before: number | null; after: number; key: string; traceId: string; now: Date }): void {
    tx.create(this.collections.doc('audit_events', input.eventId), { schemaVersion: SCHEMA_VERSION, eventId: input.eventId, actorId: guard('admin_actor', input.actor.issuer, input.actor.subject), action: input.action, targetType: 'location', targetId: input.id, reason: input.reason, beforeVersion: input.before, afterVersion: input.after, idempotencyKeyHash: sha256(input.key), result: 'applied', traceId: input.traceId, occurredAt: input.now });
    tx.create(this.collections.doc('outbox', guard(input.id, String(input.after), 'location.changed')), { schemaVersion: SCHEMA_VERSION, aggregateId: input.id, version: input.after, eventType: 'location.changed', payload: { locationId: input.id }, state: 'pending', availableAt: input.now, attempts: 0 });
  }
  async createLocation(tokenHash: string, input: LocationInput, idempotencyKey: string, traceId: string): Promise<{ id: string; version: number; status: 'paused' }> {
    if (!input || ['slug', 'displayName', 'publicArea', 'postalCode', 'address', 'reason'].some(k => typeof (input as unknown as Record<string, unknown>)[k] !== 'string')) fail('invalid_location_input', 422);
    const key = assertIdempotencyKey(idempotencyKey), reason = this.reason(input.reason), normalized = { slug: normalizeSlug(input.slug), displayName: requiredText(input.displayName, 100), publicArea: requiredText(input.publicArea, 100), postalCode: normalizePostalCode(input.postalCode), address: requiredText(input.address, 500), status: 'paused', reason };
    if (input.status !== 'paused' || Object.keys(input).some(k => !Object.hasOwn(normalized, k))) fail('invalid_location_input', 422);
    text(traceId); const bodyHash = sha256(JSON.stringify(canonical(normalized))), id = randomUUID(), eventId = randomUUID(), now = date(this.now()), plan = this.plan();
    return this.db.runTransaction(async tx => {
      const actor = await this.session(tx, tokenHash), idemRef = this.collections.doc('idempotency_keys', guard('admin', actor.principalId, 'create_location', key)), slugRef = this.collections.doc('uniques', guard('location_slug', normalized.slug));
      const [idem, slug] = await Promise.all([tx.get(idemRef), tx.get(slugRef)]);
      if (idem.exists) { if (idem.data()?.bodyHash !== bodyHash) fail('idempotency_conflict', 409); this.touch(tx, tokenHash); return idem.data()!.responseSnapshot as { id: string; version: number; status: 'paused' }; }
      if (slug.exists) fail('slug_unavailable', 409);
      const response = { id, version: 1, status: 'paused' as const };
      const { reason: _reason, ...location } = normalized;
      tx.create(this.collections.doc('buildings', id), { schemaVersion: SCHEMA_VERSION, id, ...location, capacity: SLOT_CAPACITY, availableSlots: SLOT_CAPACITY, status: 'paused', addressUseEnabled: false, plan, policyVersion: 1, version: 1, createdAt: now, updatedAt: now });
      tx.create(slugRef, { schemaVersion: SCHEMA_VERSION, locationId: id, slug: normalized.slug });
      for (let shard = 0; shard < SHARD_COUNT; shard++) tx.create(this.collections.doc('slot_shards', `${id}_${shard}`), { schemaVersion: SCHEMA_VERSION, locationId: id, shard, held: bitmapEmpty(), issued: bitmapEmpty(), freeCount: shardCapacity(shard) });
      tx.create(idemRef, { schemaVersion: SCHEMA_VERSION, bodyHash, responseSnapshot: response, resourceId: id });
      this.audit(tx, { eventId, actor, action: 'location.create', id, reason, before: null, after: 1, key, traceId, now }); this.touch(tx, tokenHash); return response;
    });
  }
  async updateLocation(tokenHash: string, id: string, input: AdminLocationUpdate, idempotencyKey: string, traceId: string, readiness?: PurchaseReadiness): Promise<{ id: string; version: number; status: 'available' | 'paused' }> {
    if (!input || typeof input.reason !== 'string' || (input.publicationConfirmed !== undefined && typeof input.publicationConfirmed !== 'boolean') || !input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes) || Object.values(input.changes).some(value => typeof value !== 'string')) fail('invalid_location_update', 422);
    const key = assertIdempotencyKey(idempotencyKey), reason = this.reason(input.reason); text(traceId);
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || !input.changes || !Object.keys(input.changes).length || Object.keys(input).some(k => !['expectedVersion', 'reason', 'publicationConfirmed', 'changes'].includes(k)) || Object.keys(input.changes).some(k => !['displayName', 'publicArea', 'postalCode', 'address', 'status'].includes(k))) fail('invalid_location_update', 422);
    const changes = { ...input.changes };
    for (const key of ['displayName', 'publicArea', 'address'] as const) if (changes[key] !== undefined) changes[key] = requiredText(changes[key], key === 'address' ? 500 : 100);
    if (changes.postalCode !== undefined) changes.postalCode = normalizePostalCode(changes.postalCode);
    if (changes.status !== undefined && !['paused', 'available'].includes(changes.status)) fail('invalid_location_update', 422);
    if (changes.status === 'available' && input.publicationConfirmed !== true) fail('publication_confirmation_required', 422);
    const bodyHash = sha256(JSON.stringify(canonical({ ...input, reason, changes }))), eventId = randomUUID(), now = date(this.now());
    return this.db.runTransaction(async tx => {
      const actor = await this.session(tx, tokenHash), idemRef = this.collections.doc('idempotency_keys', guard('admin', actor.principalId, 'update_location', id, key)), ref = this.collections.doc('buildings', id);
      const [idem, snap] = await Promise.all([tx.get(idemRef), tx.get(ref)]);
      if (idem.exists) { if (idem.data()?.bodyHash !== bodyHash) fail('idempotency_conflict', 409); this.touch(tx, tokenHash); return idem.data()!.responseSnapshot as { id: string; version: number; status: 'available' | 'paused' }; }
      const old = snap.data(); if (!old) fail('not_found', 404); if (old.schemaVersion !== SCHEMA_VERSION || old.id !== id) fail('invalid_admin_state', 503);
      if (old.version !== input.expectedVersion) { const error = new DomainError('version_conflict', 409) as DomainError & { currentVersion: number }; error.currentVersion = int(old.version, 1); throw error; }
      const status = changes.status ?? old.status;
      if (status === 'available' && old.status !== 'available') { if (readiness?.paymentConfigVerified !== true || readiness.riskProviderAvailable !== true) fail('payment_dependency_unavailable', 503); const plan = this.plan(); for (const k of Object.keys(plan)) if (old.plan?.[k] !== plan[k]) fail('pricing_unavailable', 503); }
      const postalCode = changes.postalCode ?? old.postalCode, address = changes.address ?? old.address;
      normalizePostalCode(postalCode); requiredText(address, 500);
      if (postalCode !== old.postalCode || address !== old.address) {
        const [shards, orders, leases] = await Promise.all([
          Promise.all(Array.from({ length: SHARD_COUNT }, (_, shard) => tx.get(this.collections.doc('slot_shards', `${id}_${shard}`)))),
          tx.get(this.collections.collection('orders').where('buildingId', '==', id).where('status', 'in', ['settling', 'reconciling', 'manual_review', 'refund_pending']).limit(1)),
          tx.get(this.collections.collection('leases').where('buildingId', '==', id).limit(1)),
        ]);
        if (!orders.empty || !leases.empty || shards.some((snap, shard) => { const d = snap.data(); return !d || d.schemaVersion !== SCHEMA_VERSION || d.locationId !== id || d.shard !== shard || d.held !== bitmapEmpty() || d.issued !== bitmapEmpty() || d.freeCount !== shardCapacity(shard); })) fail('location_address_locked', 409);
      }
      const version = int(old.version, 1) + 1, response = { id, version, status };
      tx.update(ref, { ...changes, postalCode, address, status, addressUseEnabled: status === 'available', version, updatedAt: now });
      tx.create(idemRef, { schemaVersion: SCHEMA_VERSION, bodyHash, responseSnapshot: response, resourceId: id });
      this.audit(tx, { eventId, actor, action: changes.status === 'paused' ? 'location.pause' : changes.status === 'available' ? 'location.resume' : 'location.update', id, reason, before: old.version, after: version, key, traceId, now }); this.touch(tx, tokenHash); return response;
    });
  }

  async overview(tokenHash: string): Promise<Record<string, unknown>> {
    return this.db.runTransaction(async tx => {
      await this.session(tx, tokenHash); const d = (await tx.get(this.collections.doc('ops_metrics', 'current'))).data();
      const keys = ['locationCount', 'activeSubscriptionCount', 'uncertainPaymentCount', 'syncPendingCount', 'manualReviewCount'];
      let available = !!d && d.schemaVersion === SCHEMA_VERSION && Number.isSafeInteger(d.version) && d.version >= 1 && keys.every(key => Number.isSafeInteger(d[key]) && d[key] >= 0), asOf: string | null = null;
      if (available) { try { asOf = date(d!.asOf).toISOString(); if (date(d!.asOf) > this.now()) available = false; } catch { available = false; } }
      const result: Record<string, unknown> = { environment: 'testnet', paymentNetwork: 'eip155:84532', ensNetwork: 'eip155:11155111', available, asOf: available ? asOf : null };
      for (const key of keys) result[key] = available ? d![key] : null;
      this.touch(tx, tokenHash); return result;
    });
  }
  private cursorMac(value: string): string { if (!this.cursorSecret) return fail('admin_cursor_unavailable', 503); return createHmac('sha256', this.cursorSecret).update(`realaddr-admin-cursor-v1:${value}`).digest('base64url'); }
  private cursorBinding(principalId: string, kind: AdminListKind, query: AdminListQuery): string { const { cursor: _cursor, ...filters } = query; return sha256(JSON.stringify(canonical({ principalId, kind, ...filters }))); }
  private encodeCursor(binding: string, at: Date, id: string): string { const value = Buffer.from(JSON.stringify({ binding, at: at.toISOString(), id })).toString('base64url'); return `${value}.${this.cursorMac(value)}`; }
  private decodeCursor(value: string, binding: string): { at: Date; id: string } {
    if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) return fail('invalid_cursor', 400);
    const [payload, mac] = value.split('.') as [string, string]; if (!constantEqual(this.cursorMac(payload), mac)) return fail('invalid_cursor', 400);
    try { const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>; if (decoded.binding !== binding || typeof decoded.at !== 'string' || typeof decoded.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(decoded.id)) return fail('invalid_cursor', 400); const at = new Date(decoded.at); if (!Number.isFinite(at.getTime()) || at.toISOString() !== decoded.at) return fail('invalid_cursor', 400); return { at, id: decoded.id }; } catch { return fail('invalid_cursor', 400); }
  }
  private listQuery(kind: AdminListKind, input: AdminListQuery): AdminListQuery & { limit: number } {
    const allowed: Record<AdminListKind, string[]> = { locations: ['status'], payments: ['status', 'locationId'], subscriptions: ['status', 'locationId'], operations: ['kind', 'status'], audit: ['targetType', 'targetId'] };
    if (!Object.hasOwn(allowed, kind) || !input || Object.keys(input).some(k => !['limit', 'cursor', ...(kind === 'audit' ? [] : ['id']), ...allowed[kind]].includes(k))) fail('invalid_admin_query', 400);
    const query = { ...input, limit: input.limit ?? 20 }; if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) fail('invalid_limit', 400);
    for (const [key, value] of Object.entries(query)) if (key !== 'limit' && (typeof value !== 'string' || !value || value.length > (key === 'cursor' ? 1024 : 128))) fail('invalid_admin_query', 400);
    if (query.id && Object.keys(query).some(k => !['id', 'limit'].includes(k))) fail('invalid_admin_query', 400);
    if (query.id && !/^[A-Za-z0-9_-]{1,128}$/.test(query.id)) fail('invalid_admin_query', 400);
    if ((query.targetType === undefined) !== (query.targetId === undefined)) fail('invalid_admin_query', 400);
    if (query.status && !/^[a-z][a-z0-9_]{0,63}$/.test(query.status)) fail('invalid_admin_query', 400);
    if (kind === 'locations' && query.status && !['paused', 'available'].includes(query.status)) fail('invalid_admin_query', 400);
    if (kind === 'operations' && ((query.kind && !['payment', 'registry', 'ens'].includes(query.kind)) || (query.status && !['reconciling', 'pending_readback', 'manual_review', 'unknown'].includes(query.status)))) fail('invalid_admin_query', 400);
    if (query.locationId && !/^[a-f0-9-]{36}$/i.test(query.locationId)) fail('invalid_admin_query', 400);
    return query;
  }
  async list(kind: AdminListKind, tokenHash: string, input: AdminListQuery): Promise<Record<string, unknown>> {
    const query = this.listQuery(kind, input), logical = { locations: 'buildings', payments: 'orders', subscriptions: 'leases', operations: 'admin_operations', audit: 'audit_events' }[kind] as 'buildings' | 'orders' | 'leases' | 'admin_operations' | 'audit_events';
    const sort = kind === 'payments' ? 'createdAt' : kind === 'audit' ? 'occurredAt' : 'updatedAt';
    const result = await this.db.runTransaction(async tx => {
      const actor = await this.session(tx, tokenHash), binding = this.cursorBinding(actor.principalId, kind, query), cursor = query.cursor ? this.decodeCursor(query.cursor, binding) : null;
      let docs;
      if (query.id) { const snap = await tx.get(this.collections.doc(logical, query.id)); docs = snap.exists ? [snap] : []; }
      else {
        let q = this.collections.collection(logical).orderBy(sort, 'desc').orderBy(FieldPath.documentId(), 'desc').limit(query.limit + 1);
        for (const key of ['status', 'kind', 'targetType', 'targetId'] as const) if (query[key] !== undefined) q = q.where(key, '==', query[key]);
        if (query.locationId) q = q.where('buildingId', '==', query.locationId);
        if (cursor) q = q.startAfter(cursor.at, this.collections.doc(logical, cursor.id));
        docs = (await tx.get(q)).docs;
      }
      const selected = docs.slice(0, query.limit), items = await Promise.all(selected.map(snap => this.project(tx, kind, snap.data()!, snap.id))), last = selected.at(-1);
      const nextCursor = !query.id && docs.length > query.limit && last ? this.encodeCursor(binding, date(last.data()![sort]), last.id) : null;
      this.touch(tx, tokenHash); return { items, nextCursor };
    });
    if (kind === 'locations') {
      for (const item of result.items) { const count = await this.collections.collection('leases').where('buildingId', '==', item.id).count().get(); item.issuedSubscriptionCount = int(count.data().count); }
      await this.authenticateSession(tokenHash);
    }
    const field = { locations: 'locations', payments: 'paymentIntents', subscriptions: 'subscriptions', operations: 'operations', audit: 'auditEvents' }[kind];
    return { [field]: result.items, nextCursor: result.nextCursor };
  }
  private async project(tx: Transaction, kind: AdminListKind, d: DocumentData, id: string): Promise<Record<string, unknown>> {
    if (d.schemaVersion !== SCHEMA_VERSION) fail('invalid_admin_state', 503);
    if (kind === 'locations') {
      if (d.id !== id || !['paused', 'available'].includes(d.status) || d.plan?.periodDays !== 30 || d.plan?.amountAtomic !== '550000' || d.plan?.network !== 'eip155:84532' || !/^0x[a-fA-F0-9]{40}$/.test(d.plan?.asset ?? '')) fail('invalid_admin_state', 503);
      return { id, slug: normalizeSlug(d.slug), displayName: text(d.displayName, 100), publicArea: text(d.publicArea, 100), postalCode: normalizePostalCode(d.postalCode), address: text(d.address, 500), status: d.status, version: int(d.version, 1), plan: { periodDays: 30, amountAtomic: d.plan.amountAtomic, network: d.plan.network, asset: d.plan.asset, decimals: 6 }, updatedAt: date(d.updatedAt).toISOString() };
    }
    if (kind === 'payments') {
      if (d.id !== id || !['purchase', 'renew', 'ens_addon'].includes(d.kind)) fail('invalid_admin_state', 503);
      const risks = await Promise.all(['payer', 'payTo'].map(side => tx.get(this.collections.doc('risk_assessments', guard(id, side, 'settlement'))))), decisions = risks.map((s, index) => { const risk = s.data(), subject = index === 0 ? d.ownerWallet : d.payTo; return risk && risk.schemaVersion === SCHEMA_VERSION && risk.orderId === id && risk.side === (index === 0 ? 'payer' : 'payTo') && risk.subjectAddress === subject && risk.paymentNetwork === d.network && ['allow', 'deny', 'hold'].includes(risk.decision) ? risk.decision : 'unknown'; });
      const riskVerdict = decisions.includes('deny') ? 'deny' : decisions.includes('hold') ? 'hold' : decisions.length === 2 && decisions.every(v => v === 'allow') ? 'allow' : 'unknown';
      const floor = int(d.slotNumber ?? d.floor, 1); if (floor > SLOT_CAPACITY) fail('invalid_admin_state', 503);
      if (!/^(0|[1-9][0-9]*)$/.test(d.amountAtomic)) fail('invalid_admin_state', 503);
      return { id, locationId: text(d.buildingId ?? d.locationId), floor, kind: d.kind, amountAtomic: d.amountAtomic, status: text(d.status), riskVerdict, riskReasonCode: null, createdAt: date(d.createdAt).toISOString(), updatedAt: date(d.updatedAt).toISOString(), traceId: typeof d.traceId === 'string' ? d.traceId : '' };
    }
    if (kind === 'subscriptions') {
      if (d.id !== id) fail('invalid_admin_state', 503); const floor = int(d.slotNumber ?? d.floor, 1); if (floor > SLOT_CAPACITY) fail('invalid_admin_state', 503);
      const [mailSnap, ensSnap] = await Promise.all([tx.get(this.collections.doc('mail_profiles', id)), tx.get(this.collections.doc('ens_entitlements', id))]), mail = mailSnap.data(), ens = ensSnap.data();
      if (!mail || mail.schemaVersion !== SCHEMA_VERSION || mail.leaseId !== id || typeof mail.destinationConfigured !== 'boolean' || !['enabled', 'disabled', 'suspended'].includes(mail.status)) fail('invalid_admin_state', 503);
      let mailEnabled = false;
      try { mailEnabled = (await new WorldRepository(this.db, this.collections.prefix, { now: this.now }).getMailStatus(tx, d, mail)).status === 'enabled'; }
      catch (error) { if (!(error instanceof DomainError) || !['invalid_mail_consent', 'paid_lease_required', 'lease_inactive', 'invalid_mail_profile'].includes(error.code)) throw error; }
      const paid = ens?.state === 'paid'; if (ens && (ens.schemaVersion !== SCHEMA_VERSION || ens.leaseId !== id)) fail('invalid_admin_state', 503);
      if (ens && !['pending_payment', 'paid', 'refund_pending', 'refunded'].includes(ens.state)) fail('invalid_admin_state', 503);
      const expiresAt = date(d.expiresAt), status = d.status === 'active' && expiresAt <= this.now() ? 'expired' : text(d.status);
      const nameType = paid ? ens.nameType : null; if (paid && !['floor', 'custom'].includes(nameType)) fail('invalid_admin_state', 503);
      const evidence = d.registryEvidence;
      if (!['pending', 'synced'].includes(d.chainSyncStatus)) fail('invalid_admin_state', 503);
      const registryStatus = d.chainSyncStatus === 'synced' && evidence?.finalityVerified === true && evidence.chainId === 11155111 && evidence.change?.version === d.version && evidence.change?.leaseKey === d.leaseKey && evidence.change?.holderCommitment === d.holderCommitment && evidence.change?.slot === floor && evidence.change?.expiresAt === String(Math.floor(expiresAt.getTime() / 1000)) ? 'synced' : 'pending';
      return { id, locationId: text(d.buildingId ?? d.locationId), floor, status, expiresAt: expiresAt.toISOString(), registryStatus, ensName: paid ? text(ens.normalizedName, 255) : null, ensNameType: nameType, ensStatus: paid ? status === 'expired' ? 'expired' : ['suspended', 'revoked'].includes(status) ? 'disabled' : 'pending' : ens && ens.state !== 'pending_payment' ? 'disabled' : 'not_purchased', mailEnabled, destinationConfigured: mail.destinationConfigured, updatedAt: date(d.updatedAt).toISOString() };
    }
    if (kind === 'operations') {
      if (d.operationId !== id || !['payment', 'registry', 'ens'].includes(d.kind) || !['reconciling', 'pending_readback', 'manual_review', 'unknown'].includes(d.status)) fail('invalid_admin_state', 503);
      if (d.lastErrorCode !== undefined && d.lastErrorCode !== null && (typeof d.lastErrorCode !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(d.lastErrorCode))) fail('invalid_admin_state', 503);
      return { id, kind: d.kind, targetId: text(d.targetId), status: d.status, version: int(d.version, 1), lastErrorCode: d.lastErrorCode === undefined || d.lastErrorCode === null ? null : text(d.lastErrorCode), nextAttemptAt: d.nextAttemptAt ? date(d.nextAttemptAt).toISOString() : null, updatedAt: date(d.updatedAt).toISOString() };
    }
    if (d.eventId !== id || !['requested', 'applied', 'rejected', 'failed'].includes(d.result)) fail('invalid_admin_state', 503);
    return { eventId: text(d.eventId), occurredAt: date(d.occurredAt).toISOString(), actorId: text(d.actorId), action: text(d.action), targetType: text(d.targetType), targetId: text(d.targetId), reason: text(d.reason, 500), beforeVersion: d.beforeVersion === null || d.beforeVersion === undefined ? null : int(d.beforeVersion, 1), afterVersion: d.afterVersion === null || d.afterVersion === undefined ? null : int(d.afterVersion, 1), idempotencyKeyHash: text(d.idempotencyKeyHash), result: text(d.result), traceId: typeof d.traceId === 'string' ? d.traceId : '' };
  }
}
