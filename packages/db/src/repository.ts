import { randomUUID } from 'node:crypto';
import type { Firestore, Transaction } from '@google-cloud/firestore';
import {
  BITS_PER_SHARD, DomainError, HOLD_MS, SCHEMA_VERSION, SHARD_COUNT, SLOT_CAPACITY,
  amountFor, assertIdempotencyKey, bitmapClear, bitmapEmpty, bitmapHas, bitmapSet, newOpaqueToken,
  normalizePostalCode, normalizeSlug, normalizeWallet, requiredText, sha256,
  shardCapacity, shardForFloor, utcDay, validateFloor, validatePricing,
  type PricingConfig,
} from '@realaddr/domain';
import { CollectionMapper } from './collections.js';
import { assertCurrentOutboxClaim, type OutboxClaim } from './outbox.js';

type DbTime = Date;
export interface AgentPrincipal { tenantId: string; agentId: string; walletAddress: string; walletChain: string; credentialId: string }
export interface VerifiedWalletProof { verified: true; challengeId: string; walletAddress: string; chain: string; domain: string; message: string }
export interface LocationInput { slug: string; displayName: string; publicArea: string; postalCode: string; address: string; status: 'paused'; reason: string }
export interface OperatorIdentity { verified: true; subject: string }
export interface PublicLocation { id: string; slug: string; displayName: string; publicArea: string; status: 'available' | 'paused'; capacity: number; availableSlots: number; plan: { periodDays: 30; amountAtomic: string; asset: string; network: string; pricingVersion: string } }
export interface PurchaseReadiness { paymentConfigVerified: true; riskProviderAvailable: true }
export interface ReservePurchaseInput { locationId: string; floor?: number; idempotencyKey: string; principal: AgentPrincipal; readiness: PurchaseReadiness }
// These evidence types are server-only inputs from verified adapters, never HTTP request bodies.
export interface VerifiedRiskAssessment { verified: true; decision: 'allow'; subjectAddress: string; paymentNetwork: string; riskNetwork: string; checkedAt: Date; expiresAt: Date; policyVersion: string; responseHash: string }
export interface EncryptedPaymentPayload { algorithm: 'aes-256-gcm'; keyId: string; iv: string; ciphertext: string; tag: string }
export interface VerifiedPurchaseAuthorization { verified: true; network: string; asset: string; payer: string; payTo: string; amountAtomic: string; authorizationNonce: string; payloadHash: string; encryptedPayload: EncryptedPaymentPayload; validAfter?: Date; validBefore: Date }
export interface VerifiedPurchaseReceipt { verified: true; finalityVerified: true; network: string; asset: string; payer: string; payTo: string; amountAtomic: string; authorizationNonce: string; txHash: string; transferLogIndex: number; confirmedAt: Date; evidenceHash: string }
export interface DefinitiveUnpaidProof { verified: true; providerSettlementFinal: true; chainFinalityVerified: true; noTransferVerified: true; network: string; asset: string; payer: string; authorizationNonce: string; evidenceHash: string; checkedAt: Date; irrevocablyCancelled?: true }

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HASH = /^[0-9a-fA-F]{64}$/;
function validDate(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()); }
function assertHash(value: string): void { if (!HASH.test(value)) throw new DomainError('invalid_payment_evidence', 422); }
function decodedBase64(value: unknown, maxBytes: number): Buffer | null {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length <= maxBytes && bytes.toString('base64') === value ? bytes : null;
}
function assertPayload(value: EncryptedPaymentPayload): void {
  if (value?.algorithm !== 'aes-256-gcm' || typeof value.keyId !== 'string' || value.keyId.length < 1 || value.keyId.length > 128 || decodedBase64(value.iv, 12)?.length !== 12 || !decodedBase64(value.ciphertext, 16_384)?.length || decodedBase64(value.tag, 16)?.length !== 16) throw new DomainError('invalid_encrypted_payment_payload', 422);
}

function guardId(...parts: string[]): string { return sha256(JSON.stringify(parts)); }
function asDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') return value.toDate() as Date;
  throw new DomainError('invalid_stored_timestamp', 503);
}
function requireOperator(operator: OperatorIdentity): string {
  if (operator?.verified !== true || !operator.subject) throw new DomainError('operator_required', 403);
  return operator.subject;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
function bodyHash(value: unknown): string { return sha256(JSON.stringify(canonical(value))); }

export class RealAddrRepository {
  readonly collections: CollectionMapper;
  private readonly configuredPricing: Readonly<PricingConfig> | null;
  private readonly authDomain: string;
  constructor(private readonly db: Firestore, prefix: string | undefined, pricing: PricingConfig | null, options: { authDomain?: string } = {}) {
    this.collections = new CollectionMapper(db, prefix);
    this.configuredPricing = pricing === null ? null : validatePricing(pricing);
    this.authDomain = options.authDomain ?? 'address.chain.tokyo';
    if (this.authDomain !== 'address.chain.tokyo' && this.authDomain !== 'localhost' && this.authDomain !== '127.0.0.1') throw new DomainError('invalid_auth_domain', 503);
  }
  get pricing(): Readonly<PricingConfig> {
    if (!this.configuredPricing) throw new DomainError('pricing_unavailable', 503);
    return this.configuredPricing;
  }

  async issueWalletChallenge(input: { address: string; chain: string; domain: string; termsVersion: string }): Promise<{ id: string; message: string; expiresAt: string }> {
    const address = normalizeWallet(input.address);
    if (input.chain !== 'eip155:84532' || input.domain !== this.authDomain || !input.termsVersion) throw new DomainError('invalid_challenge', 422);
    const id = randomUUID();
    const nonce = newOpaqueToken();
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const message = `${input.domain} wants you to sign in to RealAddr for Agents\nWallet: ${address}\nChain: ${input.chain}\nNonce: ${nonce}\nExpires: ${expiresAt.toISOString()}\nTerms: ${input.termsVersion}`;
    await this.collections.doc('wallet_challenges', id).create({ schemaVersion: SCHEMA_VERSION, id, purpose: 'agent.register', address, chain: input.chain, domain: input.domain, termsVersion: input.termsVersion, message, messageHash: sha256(message), expiresAt, consumedAt: null });
    return { id, message, expiresAt: expiresAt.toISOString() };
  }

  async getWalletChallenge(id: string): Promise<{ message: string; address: string; chain: string; domain: string } | null> {
    const snap = await this.collections.doc('wallet_challenges', id).get();
    const data = snap.data();
    if (!data || data.purpose !== 'agent.register' || data.consumedAt || asDate(data.expiresAt) <= new Date()) return null;
    return { message: data.message, address: data.address, chain: data.chain, domain: data.domain };
  }

  async consumeRateLimit(subjectHash: string, action: 'wallet_challenge' | 'agent_api', limit: number, windowMs: number): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(subjectHash) || !Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1_000 || windowMs > 86_400_000) throw new DomainError('invalid_rate_limit', 503);
    const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
    const ref = this.collections.doc('rate_limits', guardId(action, subjectHash, String(windowMs), String(windowStart)));
    await this.db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const count = snap.data()?.count ?? 0;
      if (count >= limit) throw new DomainError('rate_limit', 429);
      tx.set(ref, { schemaVersion: SCHEMA_VERSION, action, subjectHash, windowStart: new Date(windowStart), expiresAt: new Date(windowStart + windowMs), count: count + 1 });
    });
  }

  async registerAgentFromVerifiedChallenge(proof: VerifiedWalletProof, name: string): Promise<{ principal: AgentPrincipal; token: string; expiresAt: string }> {
    if (proof?.verified !== true) throw new DomainError('wallet_proof_required', 403);
    const address = normalizeWallet(proof.walletAddress);
    const displayName = requiredText(name, 100);
    const now = new Date();
    const tenantId = randomUUID();
    const agentId = randomUUID();
    const credentialId = randomUUID();
    const token = newOpaqueToken();
    const expiresAt = new Date(now.getTime() + 30 * 86_400_000);
    const challengeRef = this.collections.doc('wallet_challenges', proof.challengeId);
    const walletGuardRef = this.collections.doc('uniques', guardId('wallet', proof.chain, address));
    const tenantRef = this.collections.doc('tenants', tenantId);
    const agentRef = this.collections.doc('agents', agentId);
    const credentialRef = this.collections.doc('api_credentials', credentialId);
    const principal = await this.db.runTransaction(async tx => {
      const [challengeSnap, walletGuardSnap] = await Promise.all([tx.get(challengeRef), tx.get(walletGuardRef)]);
      const challenge = challengeSnap.data();
      if (!challenge || challenge.purpose !== 'agent.register' || challenge.consumedAt || asDate(challenge.expiresAt) <= now || challenge.address !== address || challenge.chain !== proof.chain || challenge.domain !== proof.domain || challenge.messageHash !== sha256(proof.message)) throw new DomainError('invalid_challenge', 403);
      let effectiveTenantId = tenantId;
      let effectiveAgentId = agentId;
      if (walletGuardSnap.exists) {
        const guard = walletGuardSnap.data();
        effectiveTenantId = guard?.tenantId;
        effectiveAgentId = guard?.agentId;
        if (typeof effectiveTenantId !== 'string' || typeof effectiveAgentId !== 'string') throw new DomainError('invalid_wallet_guard', 503);
        const [existingTenant, existingAgent] = await Promise.all([tx.get(this.collections.doc('tenants', effectiveTenantId)), tx.get(this.collections.doc('agents', effectiveAgentId))]);
        if (existingTenant.data()?.status !== 'active' || existingAgent.data()?.status !== 'active' || existingAgent.data()?.walletAddress !== address || existingAgent.data()?.walletChain !== proof.chain || existingAgent.data()?.tenantId !== effectiveTenantId) throw new DomainError('agent_revoked', 403);
      }
      tx.update(challengeRef, { consumedAt: now });
      if (!walletGuardSnap.exists) {
        tx.create(walletGuardRef, { schemaVersion: SCHEMA_VERSION, tenantId, agentId, walletChain: proof.chain, walletAddress: address });
        tx.create(tenantRef, { schemaVersion: SCHEMA_VERSION, id: tenantId, status: 'active', termsVersion: challenge.termsVersion, termsAcceptedAt: now });
        tx.create(agentRef, { schemaVersion: SCHEMA_VERSION, id: agentId, tenantId, walletChain: proof.chain, walletAddress: address, name: displayName, status: 'active' });
      }
      tx.create(credentialRef, { schemaVersion: SCHEMA_VERSION, id: credentialId, tenantId: effectiveTenantId, agentId: effectiveAgentId, secretHash: sha256(token), scopes: ['agent'], expiresAt, revokedAt: null, createdAt: now });
      return { tenantId: effectiveTenantId, agentId: effectiveAgentId, walletAddress: address, walletChain: proof.chain, credentialId };
    });
    return { principal, token, expiresAt: expiresAt.toISOString() };
  }

  async authenticateBearer(token: string): Promise<AgentPrincipal> {
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw new DomainError('unauthorized', 401);
    const query = await this.collections.collection('api_credentials').where('secretHash', '==', sha256(token)).limit(1).get();
    const credential = query.docs[0]?.data();
    if (!credential || credential.revokedAt || asDate(credential.expiresAt) <= new Date()) throw new DomainError('unauthorized', 401);
    const [agentSnap, tenantSnap] = await Promise.all([this.collections.doc('agents', credential.agentId).get(), this.collections.doc('tenants', credential.tenantId).get()]);
    const agent = agentSnap.data();
    if (agent?.status !== 'active' || tenantSnap.data()?.status !== 'active' || agent.tenantId !== credential.tenantId) throw new DomainError('unauthorized', 401);
    return { tenantId: credential.tenantId, agentId: credential.agentId, walletAddress: agent.walletAddress, walletChain: agent.walletChain, credentialId: query.docs[0]!.id };
  }

  async revokeCredential(principal: AgentPrincipal): Promise<void> {
    const ref = this.collections.doc('api_credentials', principal.credentialId);
    await this.db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (snap.data()?.tenantId !== principal.tenantId || snap.data()?.agentId !== principal.agentId) throw new DomainError('not_found', 404);
      tx.update(ref, { revokedAt: new Date() });
    });
  }

  private publicLocation(data: Record<string, unknown>): PublicLocation {
    return { id: data.id as string, slug: data.slug as string, displayName: data.displayName as string, publicArea: data.publicArea as string, status: data.status as 'available' | 'paused', capacity: SLOT_CAPACITY, availableSlots: data.availableSlots as number, plan: { periodDays: 30, amountAtomic: amountFor(this.pricing, 'address'), asset: this.pricing.asset, network: this.pricing.network, pricingVersion: this.pricing.pricingVersion } };
  }
  async getPublicLocation(id: string): Promise<PublicLocation | null> {
    const snap = await this.collections.doc('buildings', id).get();
    return snap.exists ? this.publicLocation(snap.data()!) : null;
  }
  async listPublicLocations(limit = 20, afterId?: string): Promise<PublicLocation[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError('invalid_limit', 422);
    let query = this.collections.collection('buildings').orderBy('__name__').limit(limit);
    if (afterId) query = query.startAfter(this.collections.doc('buildings', afterId));
    const result = await query.get();
    return result.docs.map(s => this.publicLocation(s.data()));
  }

  async createLocation(operator: OperatorIdentity, input: LocationInput, idempotencyKey: string): Promise<{ id: string; version: number; status: 'paused' }> {
    const actorId = requireOperator(operator);
    const key = assertIdempotencyKey(idempotencyKey);
    const normalized = normalizeLocation(input);
    const hash = bodyHash(normalized);
    const id = randomUUID();
    const now = new Date();
    const auditId = randomUUID();
    const idemRef = this.collections.doc('idempotency_keys', guardId('admin', actorId, 'create_location', key));
    const slugRef = this.collections.doc('uniques', guardId('location_slug', normalized.slug));
    const locationRef = this.collections.doc('buildings', id);
    const result = await this.db.runTransaction(async tx => {
      const [idem, slug] = await Promise.all([tx.get(idemRef), tx.get(slugRef)]);
      if (idem.exists) return sameIdempotency<{ id: string; version: number; status: 'paused' }>(idem.data(), hash);
      if (slug.exists) throw new DomainError('slug_unavailable', 409);
      const response = { id, version: 1, status: 'paused' as const };
      tx.create(locationRef, { schemaVersion: SCHEMA_VERSION, slug: normalized.slug, displayName: normalized.displayName, publicArea: normalized.publicArea, postalCode: normalized.postalCode, address: normalized.address, id, capacity: SLOT_CAPACITY, availableSlots: SLOT_CAPACITY, status: 'paused', addressUseEnabled: false, plan: this.publicLocation({ ...normalized, id, status: 'paused', availableSlots: SLOT_CAPACITY }).plan, policyVersion: 1, version: 1, createdAt: now, updatedAt: now });
      tx.create(slugRef, { schemaVersion: SCHEMA_VERSION, locationId: id, slug: normalized.slug });
      for (let shard = 0; shard < SHARD_COUNT; shard++) tx.create(this.collections.doc('slot_shards', `${id}_${shard}`), { schemaVersion: SCHEMA_VERSION, locationId: id, shard, held: bitmapEmpty(), issued: bitmapEmpty(), freeCount: shardCapacity(shard) });
      tx.create(idemRef, { schemaVersion: SCHEMA_VERSION, bodyHash: hash, responseSnapshot: response, resourceId: id });
      this.auditLocation(tx, auditId, actorId, 'location.create', id, normalized.reason, undefined, 1, now, key);
      return response;
    });
    return result;
  }

  async updateLocation(operator: OperatorIdentity, id: string, input: { expectedVersion: number; reason: string; publicationConfirmed?: boolean; changes: Partial<Pick<LocationInput, 'displayName' | 'publicArea' | 'postalCode' | 'address'>> & { status?: 'available' | 'paused' } }, idempotencyKey: string, readiness?: PurchaseReadiness): Promise<{ id: string; version: number; status: 'available' | 'paused' }> {
    const actorId = requireOperator(operator);
    const key = assertIdempotencyKey(idempotencyKey);
    const reason = requiredText(input.reason, 500);
    if (reason.length < 3 || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 1 || !input.changes || Object.keys(input.changes).length < 1) throw new DomainError('invalid_location_update', 422);
    const hash = bodyHash(input);
    const now = new Date();
    const auditId = randomUUID();
    const idemRef = this.collections.doc('idempotency_keys', guardId('admin', actorId, 'update_location', id, key));
    const locationRef = this.collections.doc('buildings', id);
    return this.db.runTransaction(async tx => {
      const [idem, snap] = await Promise.all([tx.get(idemRef), tx.get(locationRef)]);
      if (idem.exists) return sameIdempotency<{ id: string; version: number; status: 'available' | 'paused' }>(idem.data(), hash);
      if (!snap.exists) throw new DomainError('not_found', 404);
      const old = snap.data()!;
      if (old.version !== input.expectedVersion) throw new DomainError('version_conflict', 409);
      const status = input.changes.status ?? old.status;
      if (status !== 'available' && status !== 'paused') throw new DomainError('invalid_location_update', 422);
      if (status === 'available' && old.status !== 'available' && input.publicationConfirmed !== true) throw new DomainError('publication_confirmation_required', 422);
      if (status === 'available' && old.status !== 'available' && (readiness?.paymentConfigVerified !== true || readiness.riskProviderAvailable !== true)) throw new DomainError('payment_dependency_unavailable', 503);
      const postalCode = input.changes.postalCode === undefined ? old.postalCode : normalizePostalCode(input.changes.postalCode);
      const address = input.changes.address === undefined ? old.address : requiredText(input.changes.address, 500);
      const addressChanged = postalCode !== old.postalCode || address !== old.address;
      if (addressChanged) {
        const shardRefs = Array.from({ length: SHARD_COUNT }, (_, shard) => this.collections.doc('slot_shards', `${id}_${shard}`));
        const shards = await Promise.all(shardRefs.map(ref => tx.get(ref)));
        if (shards.some((s, i) => s.data()?.freeCount !== shardCapacity(i))) throw new DomainError('location_address_locked', 409);
      }
      const nextVersion = old.version + 1;
      const response = { id, version: nextVersion, status };
      tx.update(locationRef, { displayName: input.changes.displayName === undefined ? old.displayName : requiredText(input.changes.displayName, 100), publicArea: input.changes.publicArea === undefined ? old.publicArea : requiredText(input.changes.publicArea, 100), postalCode, address, status, addressUseEnabled: status === 'available', version: nextVersion, updatedAt: now });
      tx.create(idemRef, { schemaVersion: SCHEMA_VERSION, bodyHash: hash, responseSnapshot: response, resourceId: id });
      this.auditLocation(tx, auditId, actorId, 'location.update', id, reason, old.version, nextVersion, now, key);
      return response;
    });
  }

  private auditLocation(tx: Transaction, eventId: string, actorId: string, action: string, id: string, reason: string, beforeVersion: number | undefined, afterVersion: number, now: Date, key: string): void {
    tx.create(this.collections.doc('audit_events', eventId), { schemaVersion: SCHEMA_VERSION, eventId, actorId, action, targetType: 'location', targetId: id, reason, beforeVersion: beforeVersion ?? null, afterVersion, idempotencyKeyHash: sha256(key), result: 'applied', occurredAt: now });
    tx.create(this.collections.doc('outbox', guardId(id, String(afterVersion), 'location.changed')), { schemaVersion: SCHEMA_VERSION, aggregateId: id, version: afterVersion, eventType: 'location.changed', payload: { locationId: id }, state: 'pending', availableAt: now, attempts: 0 });
  }

  async isFloorAvailable(locationId: string, floor: number): Promise<boolean> {
    const { shard, bit } = shardForFloor(validateFloor(floor));
    const [location, shardSnap] = await Promise.all([this.collections.doc('buildings', locationId).get(), this.collections.doc('slot_shards', `${locationId}_${shard}`).get()]);
    if (!location.exists) throw new DomainError('not_found', 404);
    const data = shardSnap.data();
    if (!data) throw new DomainError('slot_inventory_unavailable', 503);
    return !bitmapHas(data.held, bit) && !bitmapHas(data.issued, bit);
  }

  async getOwnedOrder(principal: AgentPrincipal, orderId: string): Promise<Record<string, unknown>> {
    const snap = await this.collections.doc('orders', orderId).get();
    const data = snap.data();
    if (!data || data.tenantId !== principal.tenantId || data.agentId !== principal.agentId) throw new DomainError('not_found', 404);
    return data;
  }

  async reservePurchaseIntent(input: ReservePurchaseInput): Promise<Record<string, unknown>> {
    if (input.readiness?.paymentConfigVerified !== true || input.readiness?.riskProviderAvailable !== true) throw new DomainError('payment_dependency_unavailable', 503, 'Payment dependencies are not verified', true);
    const key = assertIdempotencyKey(input.idempotencyKey);
    const floor = input.floor === undefined ? undefined : validateFloor(input.floor);
    const principal = input.principal;
    if (!principal?.tenantId || !principal.agentId || !principal.walletAddress || principal.walletChain !== 'eip155:84532') throw new DomainError('unauthorized', 401);
    const requestHash = bodyHash({ locationId: input.locationId, floor });
    const orderId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + HOLD_MS);
    const day = utcDay(now.getTime());
    const idemRef = this.collections.doc('idempotency_keys', guardId('agent', principal.agentId, 'POST', '/v1/payment-intents', key));
    const locationRef = this.collections.doc('buildings', input.locationId);
    const agentRef = this.collections.doc('agents', principal.agentId);
    const tenantRef = this.collections.doc('tenants', principal.tenantId);
    const quotaRef = this.collections.doc('wallet_hold_quotas', guardId(principal.walletChain, normalizeWallet(principal.walletAddress)));
    const dailyRef = this.collections.doc('daily_purchase_budgets', day);
    const orderRef = this.collections.doc('orders', orderId);
    const startShard = parseInt(sha256(orderId).slice(0, 8), 16) % SHARD_COUNT;
    const candidates = floor === undefined ? Array.from({ length: SHARD_COUNT }, (_, i) => (startShard + i) % SHARD_COUNT) : [shardForFloor(floor).shard];
    for (const shard of candidates) {
      const shardRef = this.collections.doc('slot_shards', `${input.locationId}_${shard}`);
      const result = await this.db.runTransaction(async tx => {
        const [idem, location, agent, tenant, quota, daily, shardSnap] = await Promise.all([tx.get(idemRef), tx.get(locationRef), tx.get(agentRef), tx.get(tenantRef), tx.get(quotaRef), tx.get(dailyRef), tx.get(shardRef)]);
        if (idem.exists) return sameIdempotency<Record<string, unknown>>(idem.data(), requestHash);
        const place = location.data();
        if (!place) throw new DomainError('not_found', 404);
        if (place.status !== 'available' || place.addressUseEnabled !== true || !place.postalCode || !place.address) throw new DomainError('location_paused', 409);
        if (agent.data()?.tenantId !== principal.tenantId || agent.data()?.walletAddress !== normalizeWallet(principal.walletAddress) || agent.data()?.status !== 'active' || tenant.data()?.status !== 'active') throw new DomainError('unauthorized', 401);
        const heldCount = quota.data()?.heldCount ?? 0;
        if (heldCount >= 3) throw new DomainError('wallet_hold_limit', 429);
        const reserved = daily.data()?.reserved ?? 0;
        const consumed = daily.data()?.consumed ?? 0;
        if (reserved + consumed >= 100) throw new DomainError('daily_purchase_limit', 429);
        const bits = shardSnap.data();
        if (!bits) throw new DomainError('slot_inventory_unavailable', 503);
        let selected = floor;
        if (selected !== undefined) {
          const bit = shardForFloor(selected).bit;
          if (bitmapHas(bits.held, bit) || bitmapHas(bits.issued, bit)) throw new DomainError('slot_unavailable', 409);
        } else {
          selected = undefined;
          for (let bit = 0; bit < shardCapacity(shard); bit++) {
            if (!bitmapHas(bits.held, bit) && !bitmapHas(bits.issued, bit)) { selected = shard * BITS_PER_SHARD + bit + 1; break; }
          }
          if (selected === undefined) return null;
        }
        const slotRef = this.collections.doc('slots', `${input.locationId}_${selected}`);
        const slotSnap = await tx.get(slotRef);
        if (slotSnap.exists && slotSnap.data()?.state !== 'available') throw new DomainError('slot_unavailable', 409);
        const bit = shardForFloor(selected).bit;
        const order = { schemaVersion: SCHEMA_VERSION, id: orderId, tenantId: principal.tenantId, agentId: principal.agentId, ownerWallet: normalizeWallet(principal.walletAddress), kind: 'purchase', buildingId: input.locationId, locationId: input.locationId, slotNumber: selected, floor: selected, addressSnapshot: { postalCode: place.postalCode, address: place.address }, locationVersion: place.version, bodyHash: requestHash, pricingVersion: this.pricing.pricingVersion, amountAtomic: amountFor(this.pricing, 'address'), network: this.pricing.network, asset: this.pricing.asset, payTo: this.pricing.payTo, createdAt: now, expiresAt, status: 'awaiting_payment', budgetDay: day, version: 1 };
        const response = { id: orderId, locationId: input.locationId, floor: selected, kind: 'purchase', status: 'awaiting_payment', amountAtomic: order.amountAtomic, network: order.network, asset: order.asset, payTo: order.payTo, pricingVersion: order.pricingVersion, expiresAt: expiresAt.toISOString(), payPath: `/v1/payment-intents/${orderId}/pay` };
        tx.update(shardRef, { held: bitmapSet(bits.held, bit), freeCount: bits.freeCount - 1 });
        tx.update(locationRef, { availableSlots: place.availableSlots - 1 });
        if (slotSnap.exists) tx.update(slotRef, { state: 'held', heldByOrderId: orderId, holdExpiresAt: expiresAt });
        else tx.create(slotRef, { schemaVersion: SCHEMA_VERSION, buildingId: input.locationId, slotNumber: selected, state: 'held', heldByOrderId: orderId, holdExpiresAt: expiresAt });
        tx.set(quotaRef, { schemaVersion: SCHEMA_VERSION, walletAddress: principal.walletAddress, heldCount: heldCount + 1 }, { merge: true });
        tx.set(dailyRef, { schemaVersion: SCHEMA_VERSION, day, reserved: reserved + 1, consumed }, { merge: true });
        tx.create(orderRef, order);
        tx.create(idemRef, { schemaVersion: SCHEMA_VERSION, principalId: principal.agentId, method: 'POST', path: '/v1/payment-intents', keyHash: sha256(key), bodyHash: requestHash, resourceId: orderId, responseSnapshot: response });
        return response;
      });
      if (result) return result;
    }
    if (floor !== undefined) throw new DomainError('slot_unavailable', 409);
    const shardRefs = Array.from({ length: SHARD_COUNT }, (_, shard) => this.collections.doc('slot_shards', `${input.locationId}_${shard}`));
    const snapshot = await this.db.getAll(...shardRefs);
    if (snapshot.some((s, i) => s.data()?.freeCount !== 0 || s.data()?.shard !== i)) throw new DomainError('reservation_retry', 503, 'Reservation inventory changed; retry with the same key', true);
    throw new DomainError('sold_out', 409);
  }

  async preparePurchaseSettlement(input: { orderId: string; principal: AgentPrincipal; authorization: VerifiedPurchaseAuthorization; risk: { payTo: VerifiedRiskAssessment; payer: VerifiedRiskAssessment } }): Promise<{ orderId: string; status: 'settling' | 'reconciling' | 'manual_review' | 'fulfilled'; leaseId?: string }> {
    const { authorization, risk } = input;
    if (authorization?.verified !== true || !HEX32.test(authorization.authorizationNonce) || !validDate(authorization.validBefore) || (authorization.validAfter !== undefined && !validDate(authorization.validAfter))) throw new DomainError('invalid_payment_authorization', 422);
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
    return this.db.runTransaction(async tx => {
      const [orderSnap, paymentSnap, guardSnap, agentSnap, tenantSnap] = await Promise.all([tx.get(orderRef), tx.get(paymentRef), tx.get(authGuardRef), tx.get(agentRef), tx.get(tenantRef)]);
      const order = orderSnap.data();
      const payment = paymentSnap.data();
      if (!order || order.kind !== 'purchase' || order.tenantId !== input.principal.tenantId || order.agentId !== input.principal.agentId) throw new DomainError('not_found', 404);
      if (agentSnap.data()?.status !== 'active' || agentSnap.data()?.tenantId !== order.tenantId || agentSnap.data()?.walletAddress !== order.ownerWallet || tenantSnap.data()?.status !== 'active') throw new DomainError('unauthorized', 401);
      if (payer !== order.ownerWallet || payer !== normalizeWallet(input.principal.walletAddress) || input.principal.walletChain !== order.network || authorization.network !== order.network || asset !== order.asset.toLowerCase() || payTo !== order.payTo.toLowerCase() || authorization.amountAtomic !== order.amountAtomic || authorization.validBefore > asDate(order.expiresAt)) throw new DomainError('payment_authorization_mismatch', 409);
      if (guardSnap.exists && guardSnap.data()?.orderId !== input.orderId) throw new DomainError('payment_authorization_reused', 409);
      if (guardSnap.exists && !paymentSnap.exists) throw new DomainError('payment_guard_inconsistent', 503);
      if (paymentSnap.exists) {
        if (payment?.authorizationNonce !== authorization.authorizationNonce.toLowerCase() || payment?.payloadHash !== authorization.payloadHash.toLowerCase() || payment?.payer !== payer || !guardSnap.exists) throw new DomainError('payment_authorization_conflict', 409);
        if (order.status === 'fulfilled' && payment.status === 'confirmed') return { orderId: input.orderId, status: 'fulfilled' as const, leaseId: order.leaseId as string };
        if (order.status === 'manual_review' && payment.status === 'confirmed') return { orderId: input.orderId, status: 'manual_review' as const };
        if (order.status === 'settling' || order.status === 'reconciling') return { orderId: input.orderId, status: order.status as 'settling' | 'reconciling' };
        throw new DomainError('payment_order_closed', 409);
      }
      const now = new Date();
      if (order.status !== 'awaiting_payment' || asDate(order.expiresAt) <= now) throw new DomainError('payment_order_closed', 409);
      if (authorization.validBefore <= now || (authorization.validAfter && authorization.validAfter > now)) throw new DomainError('payment_authorization_expired', 409);
      for (const [side, assessment, address] of [['payTo', risk?.payTo, payTo], ['payer', risk?.payer, payer]] as const) {
        if (assessment?.verified !== true || assessment.decision !== 'allow' || normalizeWallet(assessment.subjectAddress) !== address || assessment.paymentNetwork !== authorization.network || !assessment.riskNetwork || !assessment.policyVersion || !validDate(assessment.checkedAt) || !validDate(assessment.expiresAt) || assessment.checkedAt.getTime() > now.getTime() + 30_000 || now.getTime() - assessment.checkedAt.getTime() > 60_000 || assessment.expiresAt <= now) throw new DomainError(`risk_${side}_not_allowed`, 409);
        assertHash(assessment.responseHash);
      }
      const slotRef = this.collections.doc('slots', `${order.buildingId}_${order.slotNumber}`);
      const shardRef = this.collections.doc('slot_shards', `${order.buildingId}_${shardForFloor(order.slotNumber).shard}`);
      const [slotSnap, shardSnap] = await Promise.all([tx.get(slotRef), tx.get(shardRef)]);
      const bit = shardForFloor(order.slotNumber).bit;
      if (slotSnap.data()?.state !== 'held' || slotSnap.data()?.heldByOrderId !== input.orderId || !shardSnap.exists || !bitmapHas(shardSnap.data()!.held, bit) || bitmapHas(shardSnap.data()!.issued, bit)) throw new DomainError('slot_hold_lost', 409);
      const nextVersion = order.version + 1;
      const outboxId = guardId(input.orderId, String(nextVersion), 'payment.settlement_requested');
      tx.create(authGuardRef, { schemaVersion: SCHEMA_VERSION, kind: 'payment_authorization', network: order.network, asset, payer, authorizationNonce: authorization.authorizationNonce.toLowerCase(), orderId: input.orderId });
      tx.create(paymentRef, { schemaVersion: SCHEMA_VERSION, id: input.orderId, orderId: input.orderId, status: 'settling', payer, network: order.network, asset, payTo, amountAtomic: order.amountAtomic, authorizationNonce: authorization.authorizationNonce.toLowerCase(), payloadHash: authorization.payloadHash.toLowerCase(), encryptedPayload: authorization.encryptedPayload, validAfter: authorization.validAfter ?? null, validBefore: authorization.validBefore, version: 1, createdAt: now, updatedAt: now });
      for (const [side, assessment] of [['payTo', risk.payTo], ['payer', risk.payer]] as const) tx.create(this.collections.doc('risk_assessments', guardId(input.orderId, side, 'settlement')), { schemaVersion: SCHEMA_VERSION, orderId: input.orderId, side, subjectAddress: normalizeWallet(assessment.subjectAddress), paymentNetwork: assessment.paymentNetwork, riskNetwork: assessment.riskNetwork, decision: 'allow', checkedAt: assessment.checkedAt, expiresAt: assessment.expiresAt, policyVersion: assessment.policyVersion, responseHash: assessment.responseHash.toLowerCase() });
      tx.update(orderRef, { status: 'settling', version: nextVersion, settlementOutboxId: outboxId, updatedAt: now });
      tx.create(this.collections.doc('outbox', outboxId), { schemaVersion: SCHEMA_VERSION, aggregateId: input.orderId, version: nextVersion, eventType: 'payment.settlement_requested', payload: { orderId: input.orderId }, state: 'pending', availableAt: now, attempts: 0 });
      tx.set(this.collections.doc('admin_operations', guardId('payment', input.orderId)), { schemaVersion: SCHEMA_VERSION, operationId: guardId('payment', input.orderId), kind: 'payment', targetId: input.orderId, status: 'unknown', version: nextVersion, updatedAt: now });
      return { orderId: input.orderId, status: 'settling' as const };
    });
  }

  async markPurchaseSettlementUnknown(input: { orderId: string; authorizationNonce: string }): Promise<{ orderId: string; status: 'reconciling' | 'manual_review' | 'fulfilled' }> {
    const now = new Date();
    const orderRef = this.collections.doc('orders', input.orderId);
    const paymentRef = this.collections.doc('payments', input.orderId);
    return this.db.runTransaction(async tx => {
      const [orderSnap, paymentSnap] = await Promise.all([tx.get(orderRef), tx.get(paymentRef)]);
      const order = orderSnap.data();
      const payment = paymentSnap.data();
      if (!order || order.kind !== 'purchase' || !payment || payment.authorizationNonce !== input.authorizationNonce.toLowerCase()) throw new DomainError('payment_not_found', 404);
      if (order.status === 'fulfilled' && payment.status === 'confirmed') return { orderId: input.orderId, status: 'fulfilled' as const };
      if (order.status === 'manual_review' && payment.status === 'confirmed') return { orderId: input.orderId, status: 'manual_review' as const };
      if (order.status === 'reconciling' && payment.status === 'unknown') return { orderId: input.orderId, status: 'reconciling' as const };
      if (order.status !== 'settling' || payment.status !== 'settling') throw new DomainError('payment_order_closed', 409);
      const settlementOutboxRef = this.collections.doc('outbox', order.settlementOutboxId);
      const settlementOutboxSnap = await tx.get(settlementOutboxRef);
      if (!settlementOutboxSnap.exists) throw new DomainError('settlement_outbox_missing', 503);
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

  async confirmPurchasePayment(input: { orderId: string; receipt: VerifiedPurchaseReceipt }): Promise<{ orderId: string; status: 'fulfilled'; leaseId: string } | { orderId: string; status: 'manual_review' }> {
    return this.applyPurchasePayment(input);
  }

  async recoverConfirmedPurchaseFromOutbox(claim: OutboxClaim): Promise<{ orderId: string; status: 'fulfilled'; leaseId: string } | { orderId: string; status: 'manual_review' }> {
    if (claim.eventType !== 'payment.issuance_recovery_requested' || claim.payload.orderId !== claim.aggregateId) throw new DomainError('unsupported_outbox_event', 409);
    return this.applyPurchasePayment({ orderId: claim.aggregateId, claim });
  }

  private async applyPurchasePayment(input: { orderId: string; receipt?: VerifiedPurchaseReceipt; claim?: OutboxClaim }): Promise<{ orderId: string; status: 'fulfilled'; leaseId: string } | { orderId: string; status: 'manual_review' }> {
    const orderRef = this.collections.doc('orders', input.orderId);
    const paymentRef = this.collections.doc('payments', input.orderId);
    const claimedOutboxRef = input.claim ? this.collections.doc('outbox', input.claim.id) : null;
    return this.db.runTransaction(async tx => {
      const [orderSnap, paymentSnap, claimedOutboxSnap] = await Promise.all([tx.get(orderRef), tx.get(paymentRef), claimedOutboxRef ? tx.get(claimedOutboxRef) : Promise.resolve(null)]);
      let now = new Date();
      const order = orderSnap.data();
      const payment = paymentSnap.data();
      if (!order || order.kind !== 'purchase' || !payment) throw new DomainError('payment_not_found', 404);
      if (input.claim) {
        assertCurrentOutboxClaim(claimedOutboxSnap?.data(), input.claim, now);
        if (input.claim.eventType !== 'payment.issuance_recovery_requested' || input.claim.aggregateId !== input.orderId || input.claim.payload.orderId !== input.orderId || input.claim.version !== order.version || order.recoveryOutboxId !== input.claim.id || order.status !== 'manual_review') throw new DomainError('outbox_claim_lost', 409);
      }
      let receipt = input.receipt;
      if (!receipt && input.claim) {
        if (payment.status !== 'confirmed' || payment.settlementEvidence?.finalityVerified !== true || payment.settlementEvidence?.evidenceHash !== payment.evidenceHash) throw new DomainError('stored_payment_unverified', 503);
        receipt = { verified: true, finalityVerified: true, network: payment.network, asset: payment.asset, payer: payment.payer, payTo: payment.payTo, amountAtomic: payment.amountAtomic, authorizationNonce: payment.authorizationNonce, txHash: payment.txHash, transferLogIndex: payment.transferLogIndex, confirmedAt: asDate(payment.confirmedAt), evidenceHash: payment.evidenceHash };
      }
      if (receipt?.verified !== true || receipt.finalityVerified !== true || !HEX32.test(receipt.authorizationNonce) || !HEX32.test(receipt.txHash) || !Number.isSafeInteger(receipt.transferLogIndex) || receipt.transferLogIndex < 0 || !validDate(receipt.confirmedAt) || receipt.confirmedAt.getTime() > now.getTime() + 30_000) throw new DomainError('invalid_payment_receipt', 422);
      assertHash(receipt.evidenceHash);
      const payer = normalizeWallet(receipt.payer);
      const asset = normalizeWallet(receipt.asset);
      const payTo = normalizeWallet(receipt.payTo);
      const receiptGuardRef = this.collections.doc('uniques', guardId('payment_transfer', receipt.network, receipt.txHash.toLowerCase(), String(receipt.transferLogIndex)));
      const receiptGuardSnap = await tx.get(receiptGuardRef);
      if (receiptGuardSnap.exists && receiptGuardSnap.data()?.orderId !== input.orderId) throw new DomainError('payment_receipt_reused', 409);
      if (receipt.network !== order.network || asset !== order.asset.toLowerCase() || payer !== order.ownerWallet || payTo !== order.payTo.toLowerCase() || receipt.amountAtomic !== order.amountAtomic || receipt.authorizationNonce.toLowerCase() !== payment.authorizationNonce || payment.network !== receipt.network || payment.asset !== asset || payment.payer !== payer || payment.payTo !== payTo) throw new DomainError('payment_receipt_mismatch', 409);
      if (order.status === 'fulfilled' && payment.status === 'confirmed') {
        if (!receiptGuardSnap.exists || payment.txHash !== receipt.txHash.toLowerCase() || payment.transferLogIndex !== receipt.transferLogIndex || payment.evidenceHash !== receipt.evidenceHash.toLowerCase()) throw new DomainError('payment_receipt_conflict', 409);
        return { orderId: input.orderId, status: 'fulfilled' as const, leaseId: order.leaseId as string };
      }
      if (order.status !== 'settling' && order.status !== 'reconciling' && order.status !== 'manual_review') throw new DomainError('payment_order_closed', 409);
      const recovering = order.status === 'manual_review';
      if (recovering && !input.claim) throw new DomainError('outbox_claim_required', 409);
      if ((order.status === 'settling' && payment.status !== 'settling') || (order.status === 'reconciling' && payment.status !== 'unknown') || (recovering && payment.status !== 'confirmed') || (recovering !== receiptGuardSnap.exists)) throw new DomainError('payment_state_conflict', 409);
      if (recovering && (payment.txHash !== receipt.txHash.toLowerCase() || payment.transferLogIndex !== receipt.transferLogIndex || payment.evidenceHash !== receipt.evidenceHash.toLowerCase() || asDate(payment.confirmedAt).getTime() !== receipt.confirmedAt.getTime())) throw new DomainError('payment_receipt_conflict', 409);
      const slotRef = this.collections.doc('slots', `${order.buildingId}_${order.slotNumber}`);
      const { shard, bit } = shardForFloor(order.slotNumber);
      const shardRef = this.collections.doc('slot_shards', `${order.buildingId}_${shard}`);
      const quotaRef = this.collections.doc('wallet_hold_quotas', guardId(order.network, order.ownerWallet));
      const dailyRef = this.collections.doc('daily_purchase_budgets', order.budgetDay);
      const leaseId = input.orderId;
      const leaseRef = this.collections.doc('leases', leaseId);
      const mailRef = this.collections.doc('mail_profiles', leaseId);
      const settlementOutboxRef = this.collections.doc('outbox', order.settlementOutboxId);
      const reconciliationOutboxRef = order.reconciliationOutboxId ? this.collections.doc('outbox', order.reconciliationOutboxId) : null;
      const recoveryOutboxRef = order.recoveryOutboxId ? this.collections.doc('outbox', order.recoveryOutboxId) : null;
      const [slotSnap, shardSnap, quotaSnap, dailySnap, leaseSnap, mailSnap, settlementOutboxSnap, reconciliationOutboxSnap, recoveryOutboxSnap] = await Promise.all([tx.get(slotRef), tx.get(shardRef), tx.get(quotaRef), tx.get(dailyRef), tx.get(leaseRef), tx.get(mailRef), tx.get(settlementOutboxRef), reconciliationOutboxRef ? tx.get(reconciliationOutboxRef) : Promise.resolve(null), recoveryOutboxRef ? tx.get(recoveryOutboxRef) : Promise.resolve(null)]);
      now = new Date();
      if (input.claim) assertCurrentOutboxClaim(claimedOutboxSnap?.data(), input.claim, now);
      const bits = shardSnap.data();
      const quota = quotaSnap.data();
      const daily = dailySnap.data();
      if (!settlementOutboxSnap.exists || (reconciliationOutboxRef && !reconciliationOutboxSnap?.exists) || (recoveryOutboxRef && !recoveryOutboxSnap?.exists)) throw new DomainError('purchase_outbox_inconsistent', 503);
      const issuanceReady = slotSnap.data()?.state === 'held' && slotSnap.data()?.heldByOrderId === input.orderId && !!bits && bitmapHas(bits.held, bit) && !bitmapHas(bits.issued, bit) && Number.isSafeInteger(bits.freeCount) && !!quota && Number.isSafeInteger(quota.heldCount) && quota.heldCount > 0 && !!daily && Number.isSafeInteger(daily.reserved) && daily.reserved > 0 && !leaseSnap.exists && !mailSnap.exists;
      const nextVersion = order.version + 1;
      if (!issuanceReady) {
        if (recovering) return { orderId: input.orderId, status: 'manual_review' as const };
        const recoveryId = guardId(input.orderId, String(nextVersion), 'payment.issuance_recovery_requested');
        tx.create(receiptGuardRef, { schemaVersion: SCHEMA_VERSION, kind: 'payment_transfer', network: receipt.network, txHash: receipt.txHash.toLowerCase(), transferLogIndex: receipt.transferLogIndex, orderId: input.orderId, paymentId: input.orderId });
        tx.update(paymentRef, { status: 'confirmed', txHash: receipt.txHash.toLowerCase(), transferLogIndex: receipt.transferLogIndex, evidenceHash: receipt.evidenceHash.toLowerCase(), confirmedAt: receipt.confirmedAt, settlementEvidence: { evidenceHash: receipt.evidenceHash.toLowerCase(), finalityVerified: true }, encryptedPayload: null, version: payment.version + 1, updatedAt: now });
        tx.update(orderRef, { status: 'manual_review', version: nextVersion, recoveryOutboxId: recoveryId, updatedAt: now });
        tx.update(settlementOutboxRef, { state: 'completed', updatedAt: now });
        if (reconciliationOutboxRef) tx.update(reconciliationOutboxRef, { state: 'completed', updatedAt: now });
        tx.create(this.collections.doc('outbox', recoveryId), { schemaVersion: SCHEMA_VERSION, aggregateId: input.orderId, version: nextVersion, eventType: 'payment.issuance_recovery_requested', payload: { orderId: input.orderId }, state: 'pending', availableAt: now, attempts: 0 });
        tx.set(this.collections.doc('admin_operations', guardId('payment', input.orderId)), { schemaVersion: SCHEMA_VERSION, operationId: guardId('payment', input.orderId), kind: 'payment', targetId: input.orderId, status: 'manual_review', version: nextVersion, updatedAt: now });
        return { orderId: input.orderId, status: 'manual_review' as const };
      }
      const confirmedAt = recovering ? asDate(payment.confirmedAt) : receipt.confirmedAt;
      const leaseExpiresAt = new Date(confirmedAt.getTime() + 30 * 86_400_000);
      const registryOutboxId = guardId(leaseId, '1', 'lease.registry_sync_requested');
      if (!recovering) tx.create(receiptGuardRef, { schemaVersion: SCHEMA_VERSION, kind: 'payment_transfer', network: receipt.network, txHash: receipt.txHash.toLowerCase(), transferLogIndex: receipt.transferLogIndex, orderId: input.orderId, paymentId: input.orderId });
      tx.create(leaseRef, { schemaVersion: SCHEMA_VERSION, id: leaseId, tenantId: order.tenantId, agentId: order.agentId, ownerWallet: order.ownerWallet, buildingId: order.buildingId, slotNumber: order.slotNumber, addressSnapshot: order.addressSnapshot, status: 'active', startsAt: confirmedAt, expiresAt: leaseExpiresAt, version: 1, chainSyncStatus: 'pending', createdAt: now, updatedAt: now });
      tx.create(mailRef, { schemaVersion: SCHEMA_VERSION, leaseId, status: 'disabled', enabledByApprovalId: null, grantExpiresAt: null, version: 1, encryptedDestination: null, destinationConfigured: false, updatedAt: now });
      tx.update(slotRef, { state: 'leased', leaseId, heldByOrderId: null, holdExpiresAt: null });
      tx.update(shardRef, { held: bitmapClear(bits.held, bit), issued: bitmapSet(bits.issued, bit) });
      tx.update(quotaRef, { heldCount: quota.heldCount - 1 });
      tx.update(dailyRef, { reserved: daily.reserved - 1, consumed: daily.consumed + 1 });
      if (!recovering) tx.update(paymentRef, { status: 'confirmed', txHash: receipt.txHash.toLowerCase(), transferLogIndex: receipt.transferLogIndex, evidenceHash: receipt.evidenceHash.toLowerCase(), confirmedAt: receipt.confirmedAt, settlementEvidence: { evidenceHash: receipt.evidenceHash.toLowerCase(), finalityVerified: true }, encryptedPayload: null, version: payment.version + 1, updatedAt: now });
      tx.update(orderRef, { status: 'fulfilled', leaseId, version: nextVersion, fulfilledAt: now, updatedAt: now });
      tx.update(settlementOutboxRef, { state: 'completed', updatedAt: now });
      if (reconciliationOutboxRef) tx.update(reconciliationOutboxRef, { state: 'completed', updatedAt: now });
      if (recoveryOutboxRef) tx.update(recoveryOutboxRef, { state: 'completed', claimOwner: null, claimUntil: null, updatedAt: now });
      tx.create(this.collections.doc('outbox', registryOutboxId), { schemaVersion: SCHEMA_VERSION, aggregateId: leaseId, version: 1, eventType: 'lease.registry_sync_requested', payload: { leaseId, leaseVersion: 1 }, state: 'pending', availableAt: now, attempts: 0 });
      tx.delete(this.collections.doc('admin_operations', guardId('payment', input.orderId)));
      tx.create(this.collections.doc('admin_operations', guardId('registry', leaseId)), { schemaVersion: SCHEMA_VERSION, operationId: guardId('registry', leaseId), kind: 'registry', targetId: leaseId, status: 'pending_readback', version: 1, updatedAt: now });
      return { orderId: input.orderId, status: 'fulfilled' as const, leaseId };
    });
  }

  async releaseUnpaidPurchaseHold(input: { orderId: string; determination: { kind: 'expired_without_authorization' } | { kind: 'definitive_unpaid'; proof: DefinitiveUnpaidProof } }): Promise<{ orderId: string; status: 'expired' | 'failed_unpaid' }> {
    const now = new Date();
    const orderRef = this.collections.doc('orders', input.orderId);
    const paymentRef = this.collections.doc('payments', input.orderId);
    return this.db.runTransaction(async tx => {
      const [orderSnap, paymentSnap] = await Promise.all([tx.get(orderRef), tx.get(paymentRef)]);
      const order = orderSnap.data();
      const payment = paymentSnap.data();
      if (!order || order.kind !== 'purchase') throw new DomainError('not_found', 404);
      if (order.status === 'expired' || order.status === 'failed_unpaid') return { orderId: input.orderId, status: order.status as 'expired' | 'failed_unpaid' };
      if (input.determination.kind === 'expired_without_authorization') {
        if (order.status !== 'awaiting_payment' || paymentSnap.exists || asDate(order.expiresAt) > now) throw new DomainError('unpaid_not_established', 409);
      } else {
        const proof = input.determination.proof;
        if ((order.status !== 'settling' && order.status !== 'reconciling') || !payment || (payment.status !== 'settling' && payment.status !== 'unknown') || proof?.verified !== true || proof.providerSettlementFinal !== true || proof.chainFinalityVerified !== true || proof.noTransferVerified !== true || !validDate(proof.checkedAt) || proof.checkedAt > now || (proof.checkedAt < asDate(payment.validBefore) && proof.irrevocablyCancelled !== true) || proof.network !== order.network || normalizeWallet(proof.asset) !== order.asset.toLowerCase() || normalizeWallet(proof.payer) !== order.ownerWallet || proof.authorizationNonce.toLowerCase() !== payment.authorizationNonce) throw new DomainError('unpaid_not_established', 409);
        assertHash(proof.evidenceHash);
      }
      const slotRef = this.collections.doc('slots', `${order.buildingId}_${order.slotNumber}`);
      const { shard, bit } = shardForFloor(order.slotNumber);
      const shardRef = this.collections.doc('slot_shards', `${order.buildingId}_${shard}`);
      const locationRef = this.collections.doc('buildings', order.buildingId);
      const quotaRef = this.collections.doc('wallet_hold_quotas', guardId(order.network, order.ownerWallet));
      const dailyRef = this.collections.doc('daily_purchase_budgets', order.budgetDay);
      const settlementOutboxRef = order.settlementOutboxId ? this.collections.doc('outbox', order.settlementOutboxId) : null;
      const reconciliationOutboxRef = order.reconciliationOutboxId ? this.collections.doc('outbox', order.reconciliationOutboxId) : null;
      const [slotSnap, shardSnap, locationSnap, quotaSnap, dailySnap, settlementOutboxSnap, reconciliationOutboxSnap] = await Promise.all([tx.get(slotRef), tx.get(shardRef), tx.get(locationRef), tx.get(quotaRef), tx.get(dailyRef), settlementOutboxRef ? tx.get(settlementOutboxRef) : Promise.resolve(null), reconciliationOutboxRef ? tx.get(reconciliationOutboxRef) : Promise.resolve(null)]);
      const bits = shardSnap.data();
      const quota = quotaSnap.data();
      const daily = dailySnap.data();
      const location = locationSnap.data();
      if (slotSnap.data()?.state !== 'held' || slotSnap.data()?.heldByOrderId !== input.orderId || !bits || !bitmapHas(bits.held, bit) || bitmapHas(bits.issued, bit) || !Number.isSafeInteger(bits.freeCount) || !location || !Number.isSafeInteger(location.availableSlots) || !quota || quota.heldCount < 1 || !daily || daily.reserved < 1 || (settlementOutboxRef && !settlementOutboxSnap?.exists) || (reconciliationOutboxRef && !reconciliationOutboxSnap?.exists)) throw new DomainError('purchase_state_inconsistent', 503);
      const status = input.determination.kind === 'expired_without_authorization' ? 'expired' as const : 'failed_unpaid' as const;
      tx.update(slotRef, { state: 'available', heldByOrderId: null, holdExpiresAt: null });
      tx.update(shardRef, { held: bitmapClear(bits.held, bit), freeCount: bits.freeCount + 1 });
      tx.update(locationRef, { availableSlots: location.availableSlots + 1 });
      tx.update(quotaRef, { heldCount: quota.heldCount - 1 });
      tx.update(dailyRef, { reserved: daily.reserved - 1 });
      tx.update(orderRef, { status, version: order.version + 1, releasedAt: now, updatedAt: now });
      if (payment) tx.update(paymentRef, { status: 'failed', encryptedPayload: null, definitiveUnpaidEvidenceHash: input.determination.kind === 'definitive_unpaid' ? input.determination.proof.evidenceHash.toLowerCase() : null, version: payment.version + 1, updatedAt: now });
      if (settlementOutboxRef) tx.update(settlementOutboxRef, { state: 'completed', updatedAt: now });
      if (reconciliationOutboxRef) tx.update(reconciliationOutboxRef, { state: 'completed', updatedAt: now });
      if (payment) tx.delete(this.collections.doc('admin_operations', guardId('payment', input.orderId)));
      return { orderId: input.orderId, status };
    });
  }
}

function normalizeLocation(input: LocationInput): LocationInput {
  const reason = requiredText(input.reason, 500);
  if (reason.length < 3) throw new DomainError('invalid_reason', 422);
  if (input.status !== 'paused') throw new DomainError('invalid_location_status', 422);
  return { slug: normalizeSlug(input.slug), displayName: requiredText(input.displayName, 100), publicArea: requiredText(input.publicArea, 100), postalCode: normalizePostalCode(input.postalCode), address: requiredText(input.address, 500), status: 'paused', reason };
}

function sameIdempotency<T>(record: Record<string, unknown> | undefined, expectedHash: string): T {
  if (record?.bodyHash !== expectedHash) throw new DomainError('idempotency_conflict', 409);
  return record.responseSnapshot as T;
}
