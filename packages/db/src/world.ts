import { randomUUID } from 'node:crypto';
import type { DocumentData, Firestore, Transaction } from '@google-cloud/firestore';
import { DomainError, SCHEMA_VERSION, assertIdempotencyKey, newOpaqueToken, normalizeWallet, sha256 } from '@realaddr/domain';
import { CollectionMapper } from './collections.js';
import type { AgentPrincipal, EncryptedPaymentPayload, VerifiedWalletProof } from './repository.js';
export type WorldEnvelope = EncryptedPaymentPayload;
export interface VerifiedWorldIdentity {
  verified: true;
  issuer: string;
  subject: string;
  keyedSubjectHash: string;
  encryptedIssuer: WorldEnvelope;
  encryptedSubject: WorldEnvelope;
  authTime: Date;
}
export interface ApprovalView {
  id: string;
  subscriptionId: string;
  agentId: string;
  action: 'mail.enable';
  actionHash: string;
  status: string;
  expiresAt: string;
  targetProfileVersion: number;
  targetDestinationVersion: number;
}
export interface MailView {
  status: 'enabled' | 'disabled' | 'suspended';
  destinationConfigured: boolean;
  version: number;
  destinationVersion: number;
  physicalForwardingAvailable: false;
}
const fail = (code: string, status = 403): never => {
  throw new DomainError(code, status);
};
const hash = (...parts: string[]) => sha256(JSON.stringify(parts));
function time(v: unknown): Date {
  const d = v instanceof Date ? v : v && typeof v === 'object' && 'toDate' in v && typeof v.toDate === 'function' ? v.toDate() as Date : null;
  if (!d || !Number.isFinite(d.getTime()))
    return fail('invalid_world_state', 503);
  return d;
}
function envelope(v: WorldEnvelope): void {
  if (!v || v.algorithm !== 'aes-256-gcm' || !v.keyId || v.keyId.length > 128
    || !/^[A-Za-z0-9+/]{16}$/.test(v.iv) || !/^[A-Za-z0-9+/]{22}==$/.test(v.tag)
    || !v.ciphertext || v.ciphertext.length > 32768 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.ciphertext)) {
    fail('invalid_encrypted_payload', 422);
  }
}
function view(a: DocumentData): ApprovalView {
  return { id: a.id, subscriptionId: a.leaseId, agentId: a.agentId, action: 'mail.enable', actionHash: a.actionHash, status: a.status, expiresAt: time(a.expiresAt).toISOString(), targetProfileVersion: a.targetProfileVersion, targetDestinationVersion: a.targetDestinationVersion };
}
function profileVersion(m: DocumentData): number {
  if (!Number.isSafeInteger(m.version) || m.version < 1)
    return fail('invalid_mail_profile', 503);
  return m.version as number;
}
function destinationVersion(m: DocumentData): number {
  const v = m.destinationVersion ?? (m.destinationConfigured ? 1 : 0);
  if (!Number.isSafeInteger(v) || v < 0)
    return fail('invalid_mail_profile', 503);
  return v as number;
}
// Only server adapters may supply verified wallet/World evidence or encrypted payloads.
export class WorldRepository {
  readonly collections: CollectionMapper;
  private readonly now: () => Date;
  constructor(private readonly db: Firestore, prefix: string | undefined, options: {
    now?: () => Date;
  } = {}) {
    this.collections = new CollectionMapper(db, prefix);
    this.now = options.now ?? (() => new Date());
  }
  async getOwnerMailStatus(principal: AgentPrincipal, leaseId: string): Promise<MailView> {
    return this.db.runTransaction(async (tx) => {
      const lease = await this.lease(tx, leaseId, principal);
      const mail = (await tx.get(this.collections.doc('mail_profiles', leaseId))).data();
      if (!mail)
        return fail('invalid_mail_profile', 503);
      return this.getMailStatus(tx, lease, mail);
    }, { readOnly: true });
  }
  async rotateSession(token: string): Promise<{
    token: string;
    csrfToken: string;
    expiresAt: string;
  }> {
    const nextToken = newOpaqueToken(), csrfToken = newOpaqueToken();
    return this.db.runTransaction(async (tx) => {
      const current = await this.session(tx, token);
      tx.create(this.collections.doc('browser_sessions', sha256(nextToken)), {
        ...current, idHash: sha256(nextToken), csrfHash: sha256(csrfToken), rotatedAt: this.now(),
      });
      tx.delete(this.collections.doc('browser_sessions', current.idHash));
      return { token: nextToken, csrfToken, expiresAt: time(current.expiresAt).toISOString() };
    });
  }
  private async lease(tx: Transaction, id: string, p?: AgentPrincipal): Promise<DocumentData> {
    const l = (await tx.get(this.collections.doc('leases', id))).data();
    if (!l || (p && (l.tenantId !== p.tenantId || l.agentId !== p.agentId || l.ownerWallet !== normalizeWallet(p.walletAddress))))
      return fail('not_found', 404);
    if (l.schemaVersion !== SCHEMA_VERSION || l.id !== id || !Number.isSafeInteger(l.version))
      return fail('invalid_world_state', 503);
    return l;
  }
  private async paid(tx: Transaction, l: DocumentData): Promise<void> {
    if (l.status !== 'active' || time(l.expiresAt) <= this.now())
      fail('lease_inactive', 409);
    if (typeof l.registryPaymentOrderId !== 'string')
      fail('paid_lease_required', 503);
    const id = l.registryPaymentOrderId as string;
    const [os, ps] = await Promise.all([tx.get(this.collections.doc('orders', id)), tx.get(this.collections.doc('payments', id))]);
    const o = os.data(), p = ps.data();
    if (!o || !p || o.schemaVersion !== SCHEMA_VERSION || p.schemaVersion !== SCHEMA_VERSION || o.status !== 'fulfilled' || o.leaseId !== l.id || o.tenantId !== l.tenantId || o.agentId !== l.agentId || o.ownerWallet !== l.ownerWallet || !['purchase', 'renew'].includes(o.kind) || p.status !== 'confirmed' || p.orderId !== id || p.id !== id || p.payer !== l.ownerWallet || p.network !== o.network || p.asset !== o.asset || p.payTo !== o.payTo || p.amountAtomic !== o.amountAtomic || p.settlementEvidence?.finalityVerified !== true || !/^[a-f0-9]{64}$/.test(p.evidenceHash) || p.settlementEvidence.evidenceHash !== p.evidenceHash || !/^0x[a-f0-9]{64}$/.test(p.txHash) || !Number.isSafeInteger(p.transferLogIndex) || p.transferLogIndex < 0)
      fail('paid_lease_required', 503);
    const g = (await tx.get(this.collections.doc('uniques', hash('payment_transfer', p!.network, p!.txHash, String(p!.transferLogIndex))))).data();
    if (!g || g.orderId !== id || g.paymentId !== id || g.kind !== 'payment_transfer')
      fail('paid_lease_required', 503);
  }
  private async session(tx: Transaction, token: string, csrf?: string): Promise<DocumentData> {
    if (typeof token !== 'string' || token.length < 32 || token.length > 256)
      return fail('human_session_required', 401);
    const s = (await tx.get(this.collections.doc('browser_sessions', sha256(token)))).data();
    if (!s || s.schemaVersion !== SCHEMA_VERSION || time(s.expiresAt) <= this.now())
      return fail('human_session_required', 401);
    if (csrf !== undefined && (typeof csrf !== 'string' || sha256(csrf) !== s.csrfHash))
      fail('csrf_invalid');
    return s;
  }
  private async approval(tx: Transaction, id: string, s?: DocumentData, current = true): Promise<{
    a: DocumentData;
    l: DocumentData;
    m: DocumentData;
    head: DocumentData | undefined;
  }> {
    const a = (await tx.get(this.collections.doc('approvals', id))).data();
    if (!a || a.schemaVersion !== SCHEMA_VERSION || (s && s.approvalId !== id))
      return fail('not_found', 404);
    const l = await this.lease(tx, a.leaseId);
    const [ms, hs] = await Promise.all([tx.get(this.collections.doc('mail_profiles', a.leaseId)), tx.get(this.collections.doc('approval_heads', a.leaseId))]);
    const m = ms.data(), head = hs.data();
    if (!m || m.schemaVersion !== SCHEMA_VERSION || m.leaseId !== l.id)
      return fail('invalid_mail_profile', 503);
    if (a.ownerWallet !== l.ownerWallet || a.agentId !== l.agentId || a.tenantId !== l.tenantId)
      fail('approval_stale', 409);
    if (current && a.status !== 'applied' && (time(a.expiresAt) <= this.now() || a.leaseVersion !== l.version || head?.approvalId !== id || a.targetProfileVersion !== profileVersion(m)))
      fail('approval_stale', 409);
    return { a, l, m, head };
  }
  private owner(s: DocumentData, a: DocumentData): void {
    if (s.ownerWallet !== a.ownerWallet || !s.walletProvedAt)
      fail('owner_proof_required');
  }
  private async authenticationApproval(tx: Transaction, id: string, session: DocumentData) {
    const result = await this.approval(tx, id, session);
    if (result.a.status === 'applied') {
      if (result.m.status !== 'enabled')
        fail('approval_stale', 409);
      await this.getMailStatus(tx, result.l, result.m);
      if (result.m.enabledByApprovalId !== id) {
        const a = result.a;
        if (!a.destinationWriteAuthorized || a.destinationWriteConsumedAt
          || a.leaseVersion !== result.l.version
          || a.targetProfileVersion !== profileVersion(result.m)
          || a.targetDestinationVersion !== destinationVersion(result.m) + 1) {
          fail('approval_stale', 409);
        }
        await this.paid(tx, result.l);
      }
    }
    else {
      if (!['pending', 'authenticated'].includes(result.a.status))
        fail('approval_stale', 409);
      await this.paid(tx, result.l);
    }
    this.owner(session, result.a);
    return result;
  }
  private async human(tx: Transaction, s: DocumentData, l: DocumentData): Promise<DocumentData> {
    if (s.ownerWallet !== l.ownerWallet || !s.walletProvedAt || !s.keyedSubjectHash || !s.worldAuthTime || time(s.worldAuthTime).getTime() < this.now().getTime() - 300000 || time(s.worldAuthTime).getTime() > this.now().getTime() + 30000)
      return fail('world_authentication_required');
    const b = (await tx.get(this.collections.doc('human_bindings', l.id))).data();
    if (!b || b.ownerWallet !== l.ownerWallet || b.keyedSubjectHash !== s.keyedSubjectHash)
      return fail('human_binding_mismatch');
    return b;
  }
  async createApproval(p: AgentPrincipal, leaseId: string, input: {
    idempotencyKey: string;
    policyVersion: string;
    forceReauth?: boolean;
  }): Promise<ApprovalView> {
    assertIdempotencyKey(input.idempotencyKey);
    if (!input.policyVersion || input.policyVersion.length > 128)
      fail('invalid_policy', 422);
    const id = randomUUID(), nonce = newOpaqueToken(), now = this.now(), expiresAt = new Date(now.getTime() + 600000);
    const ir = this.collections.doc('idempotency_keys', hash(p.tenantId, p.agentId, 'POST', `/v1/subscriptions/${leaseId}/mail-approval`, input.idempotencyKey));
    const bodyHash = hash(input.policyVersion, String(input.forceReauth ?? false));
    return this.db.runTransaction(async (tx) => {
      const l = await this.lease(tx, leaseId, p);
      await this.paid(tx, l);
      const [ms, hs, is] = await Promise.all([tx.get(this.collections.doc('mail_profiles', leaseId)), tx.get(this.collections.doc('approval_heads', leaseId)), tx.get(ir)]);
      const m = ms.data(), h = hs.data(), i = is.data();
      if (!m)
        return fail('invalid_mail_profile', 503);
      if (i) {
        if (i.bodyHash !== bodyHash)
          fail('idempotency_conflict', 409);
        const old = (await tx.get(this.collections.doc('approvals', i.resourceId))).data();
        if (!old)
          return fail('invalid_world_state', 503);
        return view(old);
      }
      if (m.status === 'enabled' && m.enabledByApprovalId) {
        const existing = (await tx.get(this.collections.doc('approvals', m.enabledByApprovalId))).data();
        if (existing && existing.status === 'applied' && existing.policyVersion === input.policyVersion && (!m.initialDestinationPending || existing.leaseVersion === l.version)) {
          await this.getMailStatus(tx, l, m);
          tx.create(ir, { schemaVersion: SCHEMA_VERSION, bodyHash, resourceId: existing.id });
          return view(existing);
        }
      }
      if (h?.approvalId) {
        const old = (await tx.get(this.collections.doc('approvals', h.approvalId))).data();
        if (old && ['pending', 'authenticated'].includes(old.status) && time(old.expiresAt) > now && old.leaseVersion === l.version && old.targetProfileVersion === profileVersion(m)) {
          if (old.policyVersion !== input.policyVersion)
            fail('approval_in_progress', 409);
          tx.create(ir, { schemaVersion: SCHEMA_VERSION, bodyHash, resourceId: old.id });
          return view(old);
        }
      }
      const payload = { schemaVersion: SCHEMA_VERSION, action: 'mail.enable', leaseId, leaseVersion: l.version, agentId: l.agentId, ownerWallet: l.ownerWallet, policyVersion: input.policyVersion, targetProfileVersion: profileVersion(m), targetDestinationVersion: destinationVersion(m) + (m.destinationConfigured ? 0 : 1), nonce, expiresAt: expiresAt.toISOString() };
      const canonical = Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
      const a = { ...payload, expiresAt, id, tenantId: l.tenantId, status: 'pending', actionHash: sha256(JSON.stringify(canonical)), createdAt: now };
      tx.create(this.collections.doc('approvals', id), a);
      tx.set(this.collections.doc('approval_heads', leaseId), { schemaVersion: SCHEMA_VERSION, leaseId, approvalId: id, currentApprovalId: id, leaseVersion: l.version, updatedAt: now });
      tx.create(ir, { schemaVersion: SCHEMA_VERSION, bodyHash, resourceId: id });
      return view(a);
    });
  }
  async createBrowserSession(approvalId: string): Promise<{
    token: string;
    csrfToken: string;
    expiresAt: string;
  }> {
    const token = newOpaqueToken(), csrfToken = newOpaqueToken(), now = this.now(), expiresAt = new Date(now.getTime() + 600000);
    await this.db.runTransaction(async (tx) => {
      await this.approval(tx, approvalId, undefined, false);
      tx.create(this.collections.doc('browser_sessions', sha256(token)), { schemaVersion: SCHEMA_VERSION, idHash: sha256(token), approvalId, csrfHash: sha256(csrfToken), createdAt: now, expiresAt });
    });
    return { token, csrfToken, expiresAt: expiresAt.toISOString() };
  }
  async validateBrowserSession(approvalId: string, token: string): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      const s = await this.session(tx, token);
      if (s.approvalId !== approvalId)
        fail('human_session_required', 401);
    }, { readOnly: true });
  }
  async createDestinationApproval(leaseId: string, token: string, csrf: string, input: {
    expectedVersion: number;
    policyVersion: string;
  }): Promise<ApprovalView> {
    const id = randomUUID(), nonce = newOpaqueToken(), now = this.now(), expiresAt = new Date(now.getTime() + 600000);
    if (!input.policyVersion || input.policyVersion.length > 128)
      fail('invalid_policy', 422);
    return this.db.runTransaction(async (tx) => {
      const s = await this.session(tx, token, csrf), l = await this.lease(tx, leaseId);
      await this.human(tx, s, l);
      await this.paid(tx, l);
      const [ms, hs] = await Promise.all([tx.get(this.collections.doc('mail_profiles', leaseId)), tx.get(this.collections.doc('approval_heads', leaseId))]);
      const m = ms.data(), h = hs.data();
      if (!m || !m.destinationConfigured)
        return fail('destination_not_configured', 409);
      if (m.status !== 'enabled')
        fail('mail_disabled', 409);
      if (input.expectedVersion !== profileVersion(m))
        fail('profile_version_conflict', 409);
      if (h?.approvalId) {
        const old = (await tx.get(this.collections.doc('approvals', h.approvalId))).data();
        if (old && ['pending', 'authenticated'].includes(old.status) && time(old.expiresAt) > now && old.leaseVersion === l.version && old.targetProfileVersion === profileVersion(m) && old.targetDestinationVersion === destinationVersion(m) + 1 && old.policyVersion === input.policyVersion)
          return view(old);
      }
      const payload = { schemaVersion: SCHEMA_VERSION, action: 'mail.enable', leaseId, leaseVersion: l.version, agentId: l.agentId, ownerWallet: l.ownerWallet, policyVersion: input.policyVersion, targetProfileVersion: profileVersion(m), targetDestinationVersion: destinationVersion(m) + 1, nonce, expiresAt: expiresAt.toISOString() };
      const canonical = Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
      const a = { ...payload, expiresAt, id, tenantId: l.tenantId, status: 'pending', actionHash: sha256(JSON.stringify(canonical)), createdAt: now };
      tx.create(this.collections.doc('approvals', id), a);
      tx.set(this.collections.doc('approval_heads', leaseId), { schemaVersion: SCHEMA_VERSION, leaseId, approvalId: id, currentApprovalId: id, leaseVersion: l.version, updatedAt: now });
      return view(a);
    });
  }
  async getApproval(id: string, token: string): Promise<ApprovalView & {
    ownerWallet: string;
    worldAuthenticated: boolean;
  }> {
    return this.db.runTransaction(async (tx) => {
      const s = await this.session(tx, token);
      const { a } = await this.approval(tx, id, s, false);
      this.owner(s, a);
      return { ...view(a), ownerWallet: a.ownerWallet, worldAuthenticated: !!s.keyedSubjectHash && !!s.worldAuthTime && time(s.worldAuthTime).getTime() >= this.now().getTime() - 300000 };
    }, { readOnly: true });
  }
  async issueOwnerChallenge(id: string, token: string, csrf: string, input: {
    domain: string;
    chain: string;
  }): Promise<{
    id: string;
    message: string;
    expiresAt: string;
  }> {
    if (!['address.chain.tokyo', 'localhost', '127.0.0.1'].includes(input.domain) || input.chain !== 'eip155:84532')
      fail('invalid_challenge', 422);
    const challengeId = randomUUID(), nonce = newOpaqueToken(), now = this.now(), expiresAt = new Date(now.getTime() + 300000);
    return this.db.runTransaction(async (tx) => {
      const s = await this.session(tx, token, csrf);
      const { a } = await this.approval(tx, id, s, false);
      const message = `${input.domain} wants you to authorize RealAddr mail owner proof\nPurpose: mail.owner\nApproval: ${id}\nSession: ${s.idHash}\nWallet: ${a.ownerWallet}\nChain: ${input.chain}\nNonce: ${nonce}\nExpires: ${expiresAt.toISOString()}`;
      tx.create(this.collections.doc('wallet_challenges', challengeId), { schemaVersion: SCHEMA_VERSION, id: challengeId, purpose: 'mail.owner', approvalId: id, sessionId: s.idHash, address: a.ownerWallet, chain: input.chain, domain: input.domain, message, expiresAt, consumedAt: null });
      return { id: challengeId, message, expiresAt: expiresAt.toISOString() };
    });
  }
  async getOwnerChallenge(id: string, token: string): Promise<{
    message: string;
    address: string;
    chain: string;
    domain: string;
  } | null> {
    return this.db.runTransaction(async (tx) => {
      const s = await this.session(tx, token);
      const c = (await tx.get(this.collections.doc('wallet_challenges', id))).data();
      if (!c || c.purpose !== 'mail.owner' || c.sessionId !== s.idHash || c.consumedAt || time(c.expiresAt) <= this.now())
        return null;
      return { message: c.message, address: c.address, chain: c.chain, domain: c.domain };
    }, { readOnly: true });
  }
  async consumeOwnerProof(id: string, token: string, csrf: string, p: VerifiedWalletProof): Promise<void> {
    if (p?.verified !== true)
      fail('owner_proof_required');
    await this.db.runTransaction(async (tx) => {
      const s = await this.session(tx, token, csrf);
      const { a } = await this.approval(tx, id, s, false);
      const c = (await tx.get(this.collections.doc('wallet_challenges', p.challengeId))).data();
      if (!c || c.purpose !== 'mail.owner' || c.sessionId !== s.idHash || c.approvalId !== id || c.consumedAt || time(c.expiresAt) <= this.now() || normalizeWallet(p.walletAddress) !== a.ownerWallet || c.address !== a.ownerWallet || c.message !== p.message || c.chain !== p.chain || c.domain !== p.domain)
        fail('owner_proof_invalid');
      tx.update(this.collections.doc('wallet_challenges', p.challengeId), { consumedAt: this.now() });
      tx.update(this.collections.doc('browser_sessions', s.idHash), { ownerWallet: a.ownerWallet, walletProvedAt: this.now() });
    });
  }
  async beginOidc(id: string, token: string, csrf: string, input: {
    state: string;
    nonce: string;
    encryptedPkceVerifier: WorldEnvelope;
  }): Promise<{
    id: string;
    expiresAt: string;
  }> {
    envelope(input.encryptedPkceVerifier);
    if (input.state.length < 32 || input.nonce.length < 32)
      fail('invalid_oidc_input', 422);
    const oidcId = sha256(input.state), now = this.now();
    return this.db.runTransaction(async (tx) => {
      const s = await this.session(tx, token, csrf);
      const { a } = await this.authenticationApproval(tx, id, s);
      const expiresAt = new Date(Math.min(time(s.expiresAt).getTime(), now.getTime() + 300000));
      tx.create(this.collections.doc('oidc_sessions', oidcId), { schemaVersion: SCHEMA_VERSION, id: oidcId, approvalId: id, stateHash: oidcId, nonce: input.nonce, nonceHash: sha256(input.nonce), encryptedPkceVerifier: input.encryptedPkceVerifier, browserSessionId: s.idHash, startedAt: now, expiresAt, consumedAt: null });
      return { id: oidcId, expiresAt: expiresAt.toISOString() };
    });
  }
  async claimOidc(state: string, token: string): Promise<{
    id: string;
    approvalId: string;
    nonce: string;
    encryptedPkceVerifier: WorldEnvelope;
    startedAt: Date;
  }> {
    const id = sha256(state);
    return this.db.runTransaction(async (tx) => {
      const s = await this.session(tx, token);
      const o = (await tx.get(this.collections.doc('oidc_sessions', id))).data();
      if (!o || o.browserSessionId !== s.idHash || o.consumedAt || time(o.expiresAt) <= this.now())
        return fail('oidc_state_invalid');
      await this.authenticationApproval(tx, o.approvalId, s);
      tx.update(this.collections.doc('oidc_sessions', id), { consumedAt: this.now(), exchangeStatus: 'claimed' });
      return { id, approvalId: o.approvalId, nonce: o.nonce, encryptedPkceVerifier: o.encryptedPkceVerifier, startedAt: time(o.startedAt) };
    });
  }
  async finishOidc(id: string, token: string, e: VerifiedWorldIdentity): Promise<void> {
    if (e?.verified !== true || !e.issuer || !e.subject || !/^[a-f0-9]{64}$/.test(e.keyedSubjectHash))
      fail('world_identity_invalid');
    envelope(e.encryptedIssuer);
    envelope(e.encryptedSubject);
    await this.db.runTransaction(async (tx) => {
      const s = await this.session(tx, token);
      const o = (await tx.get(this.collections.doc('oidc_sessions', id))).data();
      if (!o || o.browserSessionId !== s.idHash || o.exchangeStatus !== 'claimed' || time(o.expiresAt) <= this.now())
        fail('oidc_state_invalid');
      const { a, l } = await this.authenticationApproval(tx, o!.approvalId, s);
      const b = (await tx.get(this.collections.doc('human_bindings', l.id))).data();
      const auth = time(e.authTime);
      if (auth.getTime() < time(o!.startedAt).getTime() - 30000 || auth.getTime() > this.now().getTime() + 30000 || auth.getTime() < this.now().getTime() - 300000)
        fail('world_authentication_stale');
      if (b && (b.ownerWallet !== l.ownerWallet || b.keyedSubjectHash !== e.keyedSubjectHash))
        fail('human_binding_mismatch');
      tx.update(this.collections.doc('oidc_sessions', id), { exchangeStatus: 'verified', verifiedAt: this.now() });
      tx.update(this.collections.doc('browser_sessions', s.idHash), { keyedSubjectHash: e.keyedSubjectHash, encryptedIssuer: e.encryptedIssuer, encryptedSubject: e.encryptedSubject, worldAuthTime: auth });
      if (a.status === 'pending' && a.leaseVersion === l.version && time(a.expiresAt) > this.now())
        tx.update(this.collections.doc('approvals', a.id), { status: 'authenticated', authTime: auth });
    });
  }
  async decide(id: string, token: string, csrf: string, input: {
    decision: 'approve' | 'deny';
    actionHash: string;
  }): Promise<MailView> {
    return this.db.runTransaction(async (tx) => {
      const s = await this.session(tx, token, csrf);
      const { a, l, m } = await this.approval(tx, id, s);
      this.owner(s, a);
      if (input.actionHash !== a.actionHash)
        fail('action_hash_mismatch');
      if (!['approve', 'deny'].includes(input.decision))
        fail('invalid_decision', 422);
      if (!s.keyedSubjectHash || !s.worldAuthTime || time(s.worldAuthTime).getTime() < this.now().getTime() - 300000)
        fail('world_authentication_required');
      const b = (await tx.get(this.collections.doc('human_bindings', l.id))).data();
      if (b && (b.ownerWallet !== l.ownerWallet || b.keyedSubjectHash !== s.keyedSubjectHash))
        fail('human_binding_mismatch');
      if (a.status === 'applied') {
        if (a.keyedSubjectHash !== s.keyedSubjectHash)
          fail('human_binding_mismatch');
        return this.getMailStatus(tx, l, m);
      }
      await this.paid(tx, l);
      if (a.status !== 'authenticated')
        fail('world_authentication_required');
      if (m.status === 'suspended')
        fail('mail_security_suspended');
      if (input.decision === 'deny') {
        tx.update(this.collections.doc('approvals', id), { status: 'denied', decidedAt: this.now() });
        tx.update(this.collections.doc('approval_heads', l.id), { approvalId: null, currentApprovalId: null });
        return { status: m.status === 'enabled' ? 'enabled' : 'disabled', destinationConfigured: !!m.destinationConfigured, version: profileVersion(m), destinationVersion: destinationVersion(m), physicalForwardingAvailable: false };
      }
      const now = this.now();
      if (!b)
        tx.create(this.collections.doc('human_bindings', l.id), { schemaVersion: SCHEMA_VERSION, id: l.id, leaseId: l.id, ownerWallet: l.ownerWallet, keyedSubjectHash: s.keyedSubjectHash, encryptedIssuer: s.encryptedIssuer, encryptedSubject: s.encryptedSubject, createdAt: now });
      tx.update(this.collections.doc('approvals', id), { status: 'applied', keyedSubjectHash: s.keyedSubjectHash, consentAt: now, appliedAt: now, destinationWriteAuthorized: !m.destinationConfigured || a.targetDestinationVersion !== destinationVersion(m), destinationWriteConsumedAt: null });
      tx.update(this.collections.doc('approval_heads', l.id), { approvalId: null, currentApprovalId: null });
      if (!m.destinationConfigured || a.targetDestinationVersion === destinationVersion(m))
        tx.update(this.collections.doc('mail_profiles', l.id), { status: 'enabled', enabledByApprovalId: id, approvedDestinationVersion: a.targetDestinationVersion, initialDestinationPending: !m.destinationConfigured, destinationVersion: destinationVersion(m), policyVersion: a.policyVersion, ownerWallet: l.ownerWallet, updatedAt: now });
      return { status: 'enabled', destinationConfigured: !!m.destinationConfigured, version: profileVersion(m), destinationVersion: destinationVersion(m), physicalForwardingAvailable: false };
    });
  }
  async getMailStatus(tx: Transaction, l: DocumentData, m: DocumentData): Promise<MailView> {
    const base = { destinationConfigured: !!m.destinationConfigured, version: profileVersion(m), destinationVersion: destinationVersion(m), physicalForwardingAvailable: false as const };
    if (m.status !== 'enabled')
      return { ...base, status: m.status === 'suspended' ? 'suspended' : 'disabled' };
    const a = (await tx.get(this.collections.doc('approvals', m.enabledByApprovalId))).data();
    const b = (await tx.get(this.collections.doc('human_bindings', l.id))).data();
    if (!a || !b || a.status !== 'applied' || a.leaseId !== l.id || a.ownerWallet !== l.ownerWallet || a.agentId !== l.agentId || a.keyedSubjectHash !== b.keyedSubjectHash || m.ownerWallet !== l.ownerWallet || m.policyVersion !== a.policyVersion || m.approvedDestinationVersion !== a.targetDestinationVersion || (m.initialDestinationPending ? (a.targetProfileVersion !== base.version || a.targetDestinationVersion !== base.destinationVersion + 1) : m.approvedDestinationVersion !== base.destinationVersion))
      return fail('invalid_mail_consent', 503);
    if (l.status !== 'active' || time(l.expiresAt) <= this.now())
      return { ...base, status: 'suspended' };
    await this.paid(tx, l);
    return { ...base, status: 'enabled' };
  }
  async getMailProfile(leaseId: string, token: string): Promise<MailView & {
    encryptedDestination: WorldEnvelope | null;
  }> {
    return this.db.runTransaction(async (tx) => {
      const s = await this.session(tx, token), l = await this.lease(tx, leaseId);
      await this.human(tx, s, l);
      const m = (await tx.get(this.collections.doc('mail_profiles', leaseId))).data();
      if (!m)
        return fail('invalid_mail_profile', 503);
      const status = await this.getMailStatus(tx, l, m);
      return { ...status, encryptedDestination: status.status === 'enabled' ? (m.encryptedDestination ?? null) : null };
    }, { readOnly: true });
  }
  async saveDestination(leaseId: string, token: string, csrf: string, input: {
    approvalId?: string;
    expectedVersion: number;
    encryptedDestination: WorldEnvelope;
  }): Promise<MailView> {
    envelope(input.encryptedDestination);
    return this.db.runTransaction(async (tx) => {
      const s = await this.session(tx, token, csrf), { a, l, m } = await this.approval(tx, input.approvalId ?? s.approvalId, undefined, false);
      if (l.id !== leaseId)
        fail('not_found', 404);
      await this.human(tx, s, l);
      await this.paid(tx, l);
      if (a.status !== 'applied' || a.keyedSubjectHash !== s.keyedSubjectHash || !a.destinationWriteAuthorized || a.destinationWriteConsumedAt || a.leaseVersion !== l.version || a.targetProfileVersion !== profileVersion(m) || input.expectedVersion !== profileVersion(m) || a.targetDestinationVersion !== destinationVersion(m) + 1)
        fail('destination_approval_required', 409);
      if (m.status === 'suspended' || (m.status === 'disabled' && m.enabledByApprovalId))
        fail('mail_disabled', 409);
      const now = this.now(), version = profileVersion(m) + 1, dv = a.targetDestinationVersion as number;
      tx.update(this.collections.doc('mail_profiles', leaseId), { status: 'enabled', version, destinationVersion: dv, encryptedDestination: input.encryptedDestination, destinationConfigured: true, enabledByApprovalId: a.id, approvedDestinationVersion: dv, initialDestinationPending: false, policyVersion: a.policyVersion, ownerWallet: l.ownerWallet, updatedAt: now });
      tx.update(this.collections.doc('approvals', a.id), { destinationWriteConsumedAt: now });
      return { status: 'enabled', version, destinationVersion: dv, destinationConfigured: true, physicalForwardingAvailable: false };
    });
  }
  async disableMail(leaseId: string, token: string, csrf: string, input: {
    expectedVersion: number;
  }): Promise<MailView> {
    return this.db.runTransaction(async (tx) => {
      const s = await this.session(tx, token, csrf), l = await this.lease(tx, leaseId);
      await this.human(tx, s, l);
      const m = (await tx.get(this.collections.doc('mail_profiles', leaseId))).data();
      if (!m)
        return fail('invalid_mail_profile', 503);
      if (input.expectedVersion !== profileVersion(m))
        fail('profile_version_conflict', 409);
      const version = profileVersion(m) + 1;
      tx.update(this.collections.doc('mail_profiles', leaseId), { status: 'disabled', version, initialDestinationPending: false, updatedAt: this.now() });
      tx.set(this.collections.doc('approval_heads', leaseId), { schemaVersion: SCHEMA_VERSION, leaseId, approvalId: null, currentApprovalId: null, leaseVersion: l.version, updatedAt: this.now() });
      return { status: 'disabled', version, destinationVersion: destinationVersion(m), destinationConfigured: !!m.destinationConfigured, physicalForwardingAvailable: false };
    });
  }
}
