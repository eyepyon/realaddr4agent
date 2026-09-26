import { createHmac } from 'node:crypto';
import type { Firestore } from '@google-cloud/firestore';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { EnsRepository, OwnerReadRepository, type AgentPrincipal, type RealAddrRepository } from '@realaddr/db';
import { DomainError, assertIdempotencyKey } from '@realaddr/domain';
import { EnsV2Reader, createHttpRpc, descriptionTransaction, resolverProxyPin, type BindingExpectation, type NamespaceConfig } from '@realaddr/ens';
import { normalize } from 'viem/ens';
import type { Address, Hex } from 'viem';
import type { ApiConfig } from './config.js';

type Candidate = NonNullable<Awaited<ReturnType<EnsRepository['getResolutionCandidate']>>>;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function date(value: unknown): Date {
  const result = value instanceof Date ? value : value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function' ? value.toDate() : null;
  if (!(result instanceof Date) || !Number.isFinite(result.getTime())) throw new DomainError('ens_state_inconsistent', 503);
  return result;
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 255) throw new DomainError('invalid_ens_name', 422);
  try { return normalize(value); } catch { throw new DomainError('invalid_ens_name', 422); }
}
function owned(candidate: Candidate | null, principal: AgentPrincipal): asserts candidate is Candidate {
  if (!candidate || candidate.lease.tenantId !== principal.tenantId || candidate.lease.agentId !== principal.agentId || candidate.lease.ownerWallet !== principal.walletAddress.toLowerCase()) throw new DomainError('not_found', 404);
}
function assertQuery(request: FastifyRequest): string {
  const query = request.query as Record<string, unknown>;
  if (Object.keys(query).some(key => key !== 'name')) throw new DomainError('invalid_request', 422);
  return name(query.name);
}
export function registerEnsRoutes(app: FastifyInstance, config: ApiConfig, repository: RealAddrRepository | null,
  db: Firestore | null, principal: (request: FastifyRequest) => Promise<AgentPrincipal>) {
  const ens = db ? new EnsRepository(db, config.collectionPrefix, config.pricing) : null;
  const reads = db ? new OwnerReadRepository(db, config.collectionPrefix) : null;
  const rpc = config.ens ? createHttpRpc(config.ens.rpcUrl) : null;
  const available = () => { if (!repository || !ens || !reads || !rpc || !config.ens) throw new DomainError('ens_dependency_unavailable', 503, 'ENS verification is unavailable', true); };
  function stateFingerprint(candidate: Candidate): string {
    const {lease:l,entitlement:e,binding:b,building:g,namespace:n}=candidate;
    return JSON.stringify([candidate.state,l.id,l.tenantId,l.agentId,l.ownerWallet,l.buildingId,l.slotNumber,l.status,l.version,date(l.expiresAt).toISOString(),l.leaseKey,l.holderSalt,l.holderCommitment,g.buildingKey,e.version,e.state,e.intentId,e.paidPaymentId,e.normalizedName,e.label,e.nameType,e.namePolicyVersion,b?.status,b?.targetLeaseVersion,b?.syncedLeaseVersion,b?.leaseKey,b?.ownerWallet,b?.normalizedName,b?.resolverAddress,b?.controllerAddress,b?.registryAddress,n?.status,n?.parentName,n?.locationSlug,n?.upperRegistry,n?.locationRegistry]);
  }
  async function inspect(canonical: string, candidate: Candidate | null) {
    available();
    const base = { normalizedName: canonical, checkedAt: new Date().toISOString() };
    if (!candidate) return { wire: { ...base, status: 'invalid', reasonCode: 'ens_not_registered' } as Record<string, unknown> };
    const { lease, binding, entitlement, building } = candidate;
    if (candidate.state !== 'paid' || lease.status !== 'active' || date(lease.expiresAt).getTime() <= Date.now()) return { wire: { ...base, status: 'invalid', reasonCode: 'ens_entitlement_inactive' } as Record<string, unknown> };
    const settings: NamespaceConfig | undefined = config.ens!.namespaces[lease.buildingId];
    if (!settings || !binding) return { wire: { ...base, status: 'pending', reasonCode: 'ens_registration_pending' } as Record<string, unknown> };
    if (binding.controllerAddress?.toLowerCase() !== settings.nameController.address.toLowerCase() || binding.registryAddress?.toLowerCase() !== settings.locationRegistry.address.toLowerCase()) throw new DomainError('ens_configuration_mismatch', 503);
    const resolverPin=resolverProxyPin(settings,lease.leaseKey as Hex);
    if(resolverPin.address.toLowerCase()!==binding.resolverAddress?.toLowerCase()) throw new DomainError('ens_configuration_mismatch',503);
    const expectation: BindingExpectation = { name: entitlement.normalizedName, leaseKey: lease.leaseKey as Hex, buildingKey: building.buildingKey as Hex,
      slot: lease.slotNumber, holderSalt: lease.holderSalt as Hex, owner: lease.ownerWallet as Address,
      resolver: resolverPin,
      leaseVersion: BigInt(lease.version), expiresAt: BigInt(Math.floor(date(lease.expiresAt).getTime() / 1000)), entitlement: 'paid', dbActive: true };
    const verified = await new EnsV2Reader(settings, rpc!).verifyBinding(expectation);
    if (verified.status !== 'verified') return { wire: { ...base, status: verified.status, reasonCode: verified.reason } as Record<string, unknown> };
    const current=await ens!.getResolutionCandidate(canonical);
    if (!current || current.state!=='paid' || current.lease.status!=='active' || date(current.lease.expiresAt).getTime()<=Date.now() || stateFingerprint(current)!==stateFingerprint(candidate)) return {wire:{...base,status:'pending',reasonCode:'ens_state_changed'} as Record<string,unknown>};
    // Only public, independently verified fields leave this boundary.
    const wire: Record<string, unknown> = { normalizedName: canonical, status: 'verified', reasonCode: 'ens_binding_verified',
      checkedAt: new Date(Number(verified.evidence.checkedAt) * 1000).toISOString(), expiresAt: date(lease.expiresAt).toISOString(), verifiedBlock: verified.evidence.blockNumber.toString(),
      reference: { network: 'eip155:11155111', leaseRegistry: settings.leaseRegistry.address, leaseKey: expectation.leaseKey, controller: settings.nameController.address, resolver: expectation.resolver.address, ownerWallet: expectation.owner } };
    return { wire, verified, settings, expectation };
  }
  app.get('/v1/ens/resolve', async request => {
    const canonical = assertQuery(request); available();
    await repository!.consumeRateLimit(createHmac('sha256', config.rateLimitKey).update(request.ip).digest('hex'), 'ens_resolve', 10, 60_000);
    return (await inspect(canonical, await ens!.getResolutionCandidate(canonical))).wire;
  });
  app.get('/v1/subscriptions/by-ens', async request => {
    const identity = await principal(request), canonical = assertQuery(request); available();
    const candidate = await ens!.getResolutionCandidate(canonical); owned(candidate, identity);
    const result = await inspect(canonical, candidate);
    if (result.wire.status !== 'verified') throw new DomainError(result.wire.status === 'pending' ? 'ens_pending' : 'ens_invalid', result.wire.status === 'pending' ? 409 : 410);
    const subscription = await reads!.getSubscription(identity, candidate.lease.id);
    if (subscription.version !== candidate.lease.version || subscription.status !== 'active') throw new DomainError('ens_state_changed', 409);
    return { ...subscription, ens: readyStatus(candidate, result.settings!) };
  });
  function readyStatus(candidate: Candidate, settings: NamespaceConfig) {
    return { status: 'ready', network: 'eip155:11155111', name: candidate.entitlement.normalizedName, resolverAddress: candidate.binding!.resolverAddress,
      registryAddress: settings.locationRegistry.address, controllerAddress: settings.nameController.address,
      expiresAt: date(candidate.lease.expiresAt).toISOString(), targetLeaseVersion: candidate.lease.version, syncedLeaseVersion: candidate.lease.version };
  }
  async function getOwnerCandidate(identity: AgentPrincipal, id: string) {
    if (!uuid.test(id)) throw new DomainError('invalid_request', 422);
    const subscription = await reads!.getSubscription(identity, id);
    const entitlement = (await ens!.collections.doc('ens_entitlements', id).get()).data();
    if (!entitlement?.normalizedName || entitlement.state === 'pending_payment') return { subscription, candidate: null };
    const candidate = await ens!.getResolutionCandidate(name(entitlement.normalizedName));
    if (!candidate) return {subscription,candidate:null};
    owned(candidate, identity);
    if (candidate.lease.id!==id) throw new DomainError('ens_state_inconsistent',503);
    return { subscription, candidate };
  }
  app.post('/v1/subscriptions/:subscriptionId/ens-description-transaction', async request => {
    const identity = await principal(request); available();
    if (!config.ens?.maxGasAtomic) throw new DomainError('ens_signer_configuration_unavailable', 503);
    const id = (request.params as { subscriptionId: string }).subscriptionId;
    const body = request.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['description', 'expectedLeaseVersion'].includes(key)) || typeof body.description !== 'string' || Array.from(body.description).length>280 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.description) || !Number.isSafeInteger(body.expectedLeaseVersion) || Number(body.expectedLeaseVersion)<1) throw new DomainError('invalid_request', 422);
    const key = assertIdempotencyKey(request.headers['idempotency-key']);
    const { candidate } = await getOwnerCandidate(identity, id);
    if (!candidate || candidate.lease.version !== body.expectedLeaseVersion) throw new DomainError('ens_state_changed', 409);
    const result = await inspect(candidate.entitlement.normalizedName, candidate);
    if (!result.expectation || !result.verified) throw new DomainError('ens_not_ready', 409);
    const transaction = { ...descriptionTransaction(result.expectation.name, result.expectation.resolver.address, body.description), network: 'eip155:11155111' as const,
      from: identity.walletAddress, value: '0' as const, name: result.expectation.name, key: 'description' as const,
      expiresAt: new Date(Math.min(Date.now() + 300_000, date(candidate.lease.expiresAt).getTime())).toISOString(), maxGasAtomic: config.ens.maxGasAtomic };
    return ens!.persistDescriptionTransaction({ principal: identity, leaseId: id, idempotencyKey: key, description: body.description, expectedLeaseVersion: Number(body.expectedLeaseVersion), verifiedAt: new Date(Number(result.verified.evidence.checkedAt) * 1000), transaction });
  });
  return async (identity: AgentPrincipal, id: string) => {
    if (!reads || !ens) throw new DomainError('configuration_incomplete', 503);
    if (!config.ens) return reads.getEns(identity,id);
    const { subscription, candidate } = await getOwnerCandidate(identity, id);
    if (!candidate || subscription.ens.status !== 'pending') return subscription.ens;
    const result = await inspect(candidate.entitlement.normalizedName, candidate);
    return result.settings && result.wire.status === 'verified' ? readyStatus(candidate, result.settings) : { ...subscription.ens, lastErrorCode: result.wire.reasonCode };
  };
}
