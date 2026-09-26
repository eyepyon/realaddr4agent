import { decodeFunctionResult, encodeFunctionData, encodeAbiParameters, concatHex, getCreate2Address, keccak256, namehash, stringToHex, toHex, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import { normalize, packetToBytes } from 'viem/ens';
import { AsyncLocalStorage } from 'node:async_hooks';
import { controllerAbi, factoryAbi, leaseRegistryAbi, registryAbi, resolverAbi, universalResolverAbi } from './abi.js';
export * from './abi.js';

export type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
export interface ContractPin { address: Address; codeHash: Hex }
export interface NamespaceConfig {
  chainId: 11155111;
  parentName: string;
  locationSlug: string;
  parentOwner: Address;
  locationOwner: Address;
  serviceOrigin: string;
  universalResolver: ContractPin;
  rootRegistry: ContractPin;
  ethRegistry: ContractPin;
  upperRegistry: ContractPin;
  locationRegistry: ContractPin;
  factory: ContractPin;
  resolverImplementation: ContractPin;
  userRegistryImplementation: ContractPin;
  proxyLogic: ContractPin;
  nameController: ContractPin;
  leaseRegistry: ContractPin;
}
export interface BindingExpectation {
  name: string;
  leaseKey: Hex;
  buildingKey: Hex;
  slot: number;
  holderSalt: Hex;
  owner: Address;
  resolver: ContractPin;
  leaseVersion: bigint;
  expiresAt: bigint;
  entitlement: 'paid';
  dbActive: boolean;
}
export interface ReadEvidence { blockNumber: bigint; blockHash: Hex; checkedAt: bigint; parentExpiry: bigint; locationExpiry: bigint }
export type ReadResult<T> = { status: 'verified'; evidence: T } | { status: 'pending' | 'invalid'; reason: string };
interface PinnedBlock { number: Hex; hash: Hex; timestamp: Hex }
class VerificationError extends Error { constructor(readonly reason: string) { super(reason); } }
const requireMatch = (condition: boolean, reason: string): void => { if (!condition) throw new VerificationError(reason); };
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const isHex = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v) && v.length % 2 === 0;
const isBytes32 = (v: unknown): v is Hex => isHex(v) && v.length === 66;
const validAddress = (v: unknown): v is Address => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) && !same(v, zeroAddress);
const dns = (name: string): Hex => toHex(packetToBytes(name));
const labelId = (label: string): bigint => BigInt(keccak256(stringToHex(label)));

export function validateNamespaceConfig(c: NamespaceConfig): void {
  requireMatch(c.chainId === 11155111, 'invalid_chain_configuration');
  requireMatch(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(c.locationSlug), 'invalid_location_configuration');
  requireMatch(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.eth$/.test(c.parentName) && normalize(c.parentName) === c.parentName, 'invalid_parent_configuration');
  let origin: URL; try { origin = new URL(c.serviceOrigin); } catch { throw new VerificationError('invalid_origin_configuration'); }
  requireMatch(origin.protocol === 'https:' && origin.origin === c.serviceOrigin, 'invalid_origin_configuration');
  requireMatch(validAddress(c.parentOwner) && validAddress(c.locationOwner), 'invalid_owner_configuration');
  for (const pin of [c.universalResolver, c.rootRegistry, c.ethRegistry, c.upperRegistry, c.locationRegistry, c.factory, c.resolverImplementation, c.userRegistryImplementation, c.proxyLogic, c.nameController, c.leaseRegistry]) requireMatch(!!pin && validAddress(pin.address) && isBytes32(pin.codeHash), 'invalid_contract_configuration');
}

export function resolverProxyPin(config: Pick<NamespaceConfig, 'factory' | 'proxyLogic' | 'nameController'>, leaseKey: Hex): ContractPin {
  requireMatch(isBytes32(leaseKey), 'invalid_lease_key');
  const salt = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [config.nameController.address, BigInt(leaseKey)]));
  const runtime = concatHex(['0x363d3d373d3d3d363d73', config.proxyLogic.address, '0x5af43d82803e903d91602b57fd5bf3', salt]);
  const creation = concatHex(['0x3d604d80600a3d3981f3', runtime]);
  return { address: getCreate2Address({ from: config.factory.address, salt, bytecode: creation }), codeHash: keccak256(runtime) };
}

export function createHttpRpc(url: string, fetcher: typeof fetch = fetch): Rpc {
  let endpoint: URL;
  try { endpoint = new URL(url); } catch { throw new Error('invalid_rpc_configuration'); }
  if (endpoint.username || endpoint.password || endpoint.hash || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname)))) throw new Error('invalid_rpc_configuration');
  let id = 0;
  return async (method, params) => {
    const requestId = ++id;
    try {
      const response = await fetcher(endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }), signal: AbortSignal.timeout(8_000) });
      if (!response.ok || !response.body || Number(response.headers.get('content-length') ?? 0) > 262144) throw new Error();
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > 262144) { await reader.cancel(); throw new Error(); }
        chunks.push(next.value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown };
      if (body.jsonrpc !== '2.0' || body.id !== requestId || body.error || body.result === undefined) throw new Error();
      return body.result;
    } catch { throw new Error('rpc_unavailable'); }
  };
}

export class EnsV2Reader {
  private readonly deadline = new AsyncLocalStorage<number>();
  constructor(private readonly config: NamespaceConfig, private readonly rpc: Rpc, private readonly now: () => bigint = () => BigInt(Math.floor(Date.now() / 1000))) {}

  private async request(method: string, params: readonly unknown[]): Promise<unknown> {
    const remaining = (this.deadline.getStore() ?? 0) - Date.now();
    if (remaining <= 0) throw new Error('ens_read_deadline');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.rpc(method, params), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('ens_read_deadline')), remaining); })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private validateConfig(): void {
    validateNamespaceConfig(this.config);
  }

  private pins(): ContractPin[] {
    const c = this.config;
    return [c.universalResolver, c.rootRegistry, c.ethRegistry, c.upperRegistry, c.locationRegistry, c.factory, c.resolverImplementation, c.userRegistryImplementation, c.proxyLogic, c.nameController, c.leaseRegistry];
  }

  private async block(): Promise<PinnedBlock> {
    requireMatch(await this.request('eth_chainId', []) === '0xaa36a7', 'wrong_chain');
    const block = await this.request('eth_getBlockByNumber', ['finalized', false]) as Partial<PinnedBlock> | null;
    requireMatch(!!block && isBytes32(block.hash) && typeof block.number === 'string' && /^0x[0-9a-f]+$/i.test(block.number) && typeof block.timestamp === 'string' && /^0x[0-9a-f]+$/i.test(block.timestamp), 'finalized_block_unavailable');
    return block as PinnedBlock;
  }

  private async recheck(block: PinnedBlock): Promise<void> {
    const current = await this.request('eth_getBlockByNumber', [block.number, false]) as Partial<PinnedBlock> | null;
    requireMatch(!!current && current.hash === block.hash, 'canonical_block_changed');
  }

  private async code(pin: ContractPin, block: PinnedBlock): Promise<void> {
    const code = await this.request('eth_getCode', [pin.address, block.number]);
    requireMatch(isHex(code) && code !== '0x' && same(keccak256(code), pin.codeHash), 'contract_code_mismatch');
  }

  private async call(address: Address, abi: Abi, functionName: string, args: readonly unknown[], block: PinnedBlock): Promise<unknown> {
    const data = encodeFunctionData({ abi, functionName, args });
    const result = await this.request('eth_call', [{ to: address, data }, block.number]);
    requireMatch(isHex(result), 'invalid_rpc_result');
    return decodeFunctionResult({ abi, functionName, data: result as Hex });
  }

  private async registration(registry: Address, label: string, owner: Address, block: PinnedBlock): Promise<bigint> {
    const state = await this.call(registry, registryAbi, 'getState', [labelId(label)], block) as { status: number; expiry: bigint; latestOwner: Address };
    requireMatch(state.status === 2 && same(state.latestOwner, owner), 'registration_owner_mismatch');
    requireMatch(state.expiry > BigInt(block.timestamp) && state.expiry > this.now(), 'registration_expired');
    return state.expiry;
  }

  private async namespace(block: PinnedBlock, minimumExpiry: bigint): Promise<ReadEvidence> {
    const c = this.config;
    requireMatch(minimumExpiry > this.now(), 'invalid_minimum_expiry');
    await Promise.all(this.pins().map(pin => this.code(pin, block)));
    const [upperImplementation, locationImplementation, factoryLogic] = await Promise.all([
      this.call(c.factory.address, factoryAbi, 'verifyContract', [c.upperRegistry.address], block),
      this.call(c.factory.address, factoryAbi, 'verifyContract', [c.locationRegistry.address], block),
      this.call(c.factory.address, factoryAbi, 'proxyLogic', [], block),
    ]);
    requireMatch(same(upperImplementation as string, c.userRegistryImplementation.address) && same(locationImplementation as string, c.userRegistryImplementation.address) && same(factoryLogic as string, c.proxyLogic.address), 'registry_implementation_mismatch');
    const [root, eth, upper, location, parentRegistry, leasePaused, controllerPaused, parentLabel, configuredEth, configuredUpper, configuredFactory, configuredImpl, configuredLease] = await Promise.all([
      this.call(c.universalResolver.address, universalResolverAbi, 'ROOT_REGISTRY', [], block),
      this.call(c.rootRegistry.address, registryAbi, 'getSubregistry', ['eth'], block),
      this.call(c.ethRegistry.address, registryAbi, 'getSubregistry', [c.parentName.slice(0, -4)], block),
      this.call(c.upperRegistry.address, registryAbi, 'getSubregistry', [c.locationSlug], block),
      this.call(c.universalResolver.address, universalResolverAbi, 'findParentRegistry', [dns(`probe.${c.locationSlug}.${c.parentName}`)], block),
      this.call(c.leaseRegistry.address, leaseRegistryAbi, 'paused', [], block),
      this.call(c.nameController.address, controllerAbi, 'paused', [], block),
      this.call(c.nameController.address, controllerAbi, 'parentLabel', [], block),
      this.call(c.nameController.address, controllerAbi, 'ETH_REGISTRY', [], block),
      this.call(c.nameController.address, controllerAbi, 'UPPER_REGISTRY', [], block),
      this.call(c.nameController.address, controllerAbi, 'RESOLVER_FACTORY', [], block),
      this.call(c.nameController.address, controllerAbi, 'RESOLVER_IMPLEMENTATION', [], block),
      this.call(c.nameController.address, controllerAbi, 'LEASE_REGISTRY', [], block),
    ]);
    requireMatch(same(root as string, c.rootRegistry.address) && same(eth as string, c.ethRegistry.address) && same(upper as string, c.upperRegistry.address) && same(location as string, c.locationRegistry.address) && same(parentRegistry as string, c.locationRegistry.address), 'namespace_pointer_mismatch');
    requireMatch(leasePaused === false, 'lease_registry_paused');
    requireMatch(controllerPaused === false && parentLabel === c.parentName.slice(0, -4) && same(configuredEth as string, c.ethRegistry.address) && same(configuredUpper as string, c.upperRegistry.address) && same(configuredFactory as string, c.factory.address) && same(configuredImpl as string, c.resolverImplementation.address) && same(configuredLease as string, c.leaseRegistry.address), 'controller_configuration_mismatch');
    const [parentExpiry, locationExpiry, registerRole, renewRole, unregisterRole, upperParent, locationParent] = await Promise.all([
      this.registration(c.ethRegistry.address, c.parentName.slice(0, -4), c.parentOwner, block),
      this.registration(c.upperRegistry.address, c.locationSlug, c.locationOwner, block),
      this.call(c.locationRegistry.address, registryAbi, 'hasRootRoles', [1n, c.nameController.address], block),
      this.call(c.locationRegistry.address, registryAbi, 'hasRootRoles', [1n << 16n, c.nameController.address], block),
      this.call(c.locationRegistry.address, registryAbi, 'hasRootRoles', [1n << 12n, c.nameController.address], block),
      this.call(c.upperRegistry.address, registryAbi, 'getParent', [], block),
      this.call(c.locationRegistry.address, registryAbi, 'getParent', [], block),
    ]);
    requireMatch(parentExpiry >= minimumExpiry && locationExpiry >= minimumExpiry, 'namespace_expiry_insufficient');
    requireMatch(registerRole === true && renewRole === true && unregisterRole === true, 'controller_roles_missing');
    const up = upperParent as readonly [Address, string]; const loc = locationParent as readonly [Address, string];
    requireMatch(same(up[0], c.ethRegistry.address) && up[1] === c.parentName.slice(0, -4) && same(loc[0], c.upperRegistry.address) && loc[1] === c.locationSlug, 'canonical_parent_mismatch');
    return { blockNumber: BigInt(block.number), blockHash: block.hash, checkedAt: this.now(), parentExpiry, locationExpiry };
  }

  private async guarded<T>(read: (block: PinnedBlock) => Promise<T>): Promise<ReadResult<T>> {
    return this.deadline.run(Date.now() + 25_000, async () => { try {
      this.validateConfig();
      const block = await this.block();
      const evidence = await read(block);
      await this.recheck(block);
      return { status: 'verified', evidence };
    } catch (error) {
      return error instanceof VerificationError ? { status: 'invalid', reason: error.reason } : { status: 'pending', reason: 'ens_read_unavailable' };
    } });
  }

  readNamespaceReadiness(minimumExpiry: bigint): Promise<ReadResult<ReadEvidence>> {
    return this.guarded(block => this.namespace(block, minimumExpiry));
  }

  verifyBinding(expected: BindingExpectation): Promise<ReadResult<ReadEvidence & { name: string; resolver: Address; leaseVersion: bigint }>> {
    return this.guarded(async block => {
      const c = this.config;
      requireMatch(expected.entitlement === 'paid' && expected.dbActive && expected.leaseVersion > 0n && expected.expiresAt > this.now(), 'db_entitlement_inactive');
      requireMatch(isBytes32(expected.leaseKey) && isBytes32(expected.buildingKey) && isBytes32(expected.holderSalt) && validAddress(expected.owner) && validAddress(expected.resolver.address) && isBytes32(expected.resolver.codeHash) && Number.isInteger(expected.slot) && expected.slot >= 1 && expected.slot <= 65535, 'invalid_binding_expectation');
      const derivedResolver = resolverProxyPin(c, expected.leaseKey);
      requireMatch(same(expected.resolver.codeHash, derivedResolver.codeHash) && same(expected.resolver.address, derivedResolver.address), 'untrusted_resolver_runtime');
      const canonical = normalize(expected.name);
      const suffix = `.${c.locationSlug}.${c.parentName}`;
      requireMatch(canonical === expected.name && canonical.endsWith(suffix) && canonical.slice(0, -suffix.length).indexOf('.') === -1 && canonical.length > suffix.length, 'binding_name_mismatch');
      const label = canonical.slice(0, -suffix.length);
      const node = namehash(canonical); const dnsName = dns(canonical);
      const evidence = await this.namespace(block, expected.expiresAt);
      const namespace = await this.call(c.nameController.address, controllerAbi, 'getNamespace', [expected.buildingKey], block) as readonly [string, Address, Hex];
      requireMatch(namespace[0] === c.locationSlug && same(namespace[1], c.locationRegistry.address) && same(namespace[2], namehash(`${c.locationSlug}.${c.parentName}`)), 'building_namespace_mismatch');
      await this.code(expected.resolver, block);
      const leafExpiry = await this.registration(c.locationRegistry.address, label, expected.owner, block);
      requireMatch(leafExpiry === expected.expiresAt, 'binding_expiry_mismatch');
      const descriptionResource = BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [node, keccak256(stringToHex('description'))])));
      const [leafResolver, leafSubregistry, urResolver, binding, lease, implementation, alias, canTransfer, descriptionGrant, broadText, broadAddress, broadAlias, broadUpgrade, textAdmin] = await Promise.all([
        this.call(c.locationRegistry.address, registryAbi, 'getResolver', [label], block),
        this.call(c.locationRegistry.address, registryAbi, 'getSubregistry', [label], block),
        this.call(c.universalResolver.address, universalResolverAbi, 'findResolver', [dnsName], block),
        this.call(c.nameController.address, controllerAbi, 'getBinding', [node], block),
        this.call(c.leaseRegistry.address, leaseRegistryAbi, 'getLease', [expected.leaseKey], block),
        this.call(c.factory.address, factoryAbi, 'verifyContract', [expected.resolver.address], block),
        this.call(expected.resolver.address, resolverAbi, 'getAlias', [dnsName], block),
        this.call(c.locationRegistry.address, registryAbi, 'hasRoles', [labelId(label), 1n << 156n, expected.owner], block),
        this.call(expected.resolver.address, resolverAbi, 'hasRoles', [descriptionResource, 1n << 4n, expected.owner], block),
        this.call(expected.resolver.address, resolverAbi, 'hasRootRoles', [1n << 4n, expected.owner], block),
        this.call(expected.resolver.address, resolverAbi, 'hasRootRoles', [1n, expected.owner], block),
        this.call(expected.resolver.address, resolverAbi, 'hasRootRoles', [1n << 28n, expected.owner], block),
        this.call(expected.resolver.address, resolverAbi, 'hasRootRoles', [1n << 124n, expected.owner], block),
        this.call(expected.resolver.address, resolverAbi, 'hasRootRoles', [1n << 132n, expected.owner], block),
      ]);
      const found = urResolver as readonly [Address, Hex, bigint];
      requireMatch(same(leafResolver as string, expected.resolver.address) && same(leafSubregistry as string, zeroAddress) && same(found[0], expected.resolver.address) && same(found[1], node) && found[2] === 0n, 'exact_resolver_mismatch');
      requireMatch(same(implementation as string, c.resolverImplementation.address) && alias === '0x' && canTransfer === false, 'resolver_or_transfer_policy_mismatch');
      requireMatch(descriptionGrant === true && broadText === false && broadAddress === false && broadAlias === false && broadUpgrade === false && textAdmin === false, 'description_permission_mismatch');
      const nodeResource = BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [node, `0x${'0'.repeat(64)}`])));
      const [registryRootRoles, registryNameRoles, resolverRootRoles, resolverNameRoles, resolverDescriptionRoles] = await Promise.all([
        this.call(c.locationRegistry.address, registryAbi, 'roles', [0n, expected.owner], block),
        this.call(c.locationRegistry.address, registryAbi, 'roles', [labelId(label), expected.owner], block),
        this.call(expected.resolver.address, resolverAbi, 'roles', [0n, expected.owner], block),
        this.call(expected.resolver.address, resolverAbi, 'roles', [nodeResource, expected.owner], block),
        this.call(expected.resolver.address, resolverAbi, 'roles', [descriptionResource, expected.owner], block),
      ]);
      requireMatch(registryRootRoles === 0n && registryNameRoles === 0n && resolverRootRoles === 0n && resolverNameRoles === 0n && resolverDescriptionRoles === 16n, 'owner_roles_not_minimal');
      const b = binding as readonly [Hex, Address, Address, bigint, boolean];
      requireMatch(same(b[0], expected.leaseKey) && same(b[1], expected.owner) && same(b[2], expected.resolver.address) && b[3] === expected.leaseVersion && b[4] === false, 'controller_binding_mismatch');
      const l = lease as readonly [Hex, number, Hex, bigint, bigint, boolean];
      const holder = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [expected.owner, expected.holderSalt]));
      requireMatch(same(l[0], expected.buildingKey) && l[1] === expected.slot && same(l[2], holder) && l[3] === expected.expiresAt && l[4] === expected.leaseVersion && l[5] === false && l[3] > BigInt(block.timestamp), 'lease_attestation_mismatch');
      const fixedTexts: Record<string, string> = { 'realaddr.schema': '1', 'realaddr.lease': `eip155:11155111:${c.leaseRegistry.address.toLowerCase()}:${expected.leaseKey.toLowerCase()}`, 'realaddr.binding': c.nameController.address.toLowerCase(), 'realaddr.api': c.serviceOrigin };
      const protectedParts = [...Object.keys(fixedTexts).map(key => keccak256(stringToHex(key))), keccak256(encodeAbiParameters([{ type: 'uint256' }], [60n]))];
      for (const part of protectedParts) {
        for (const scopeNode of [node, `0x${'0'.repeat(64)}` as Hex]) {
          const resource = BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [scopeNode, part])));
          requireMatch(await this.call(expected.resolver.address, resolverAbi, 'roles', [resource, expected.owner], block) === 0n, 'protected_record_delegation');
        }
      }
      for (const [key, value] of Object.entries(fixedTexts)) {
        const profile = encodeFunctionData({ abi: resolverAbi, functionName: 'text', args: [node, key] });
        const result = await this.call(c.universalResolver.address, universalResolverAbi, 'resolve', [dnsName, profile], block) as readonly [Hex, Address];
        const text = decodeFunctionResult({ abi: resolverAbi, functionName: 'text', data: result[0] });
        requireMatch(same(result[1], expected.resolver.address) && text === value, 'fixed_record_mismatch');
      }
      const addrProfile = encodeFunctionData({ abi: resolverAbi, functionName: 'addr', args: [node] });
      const addressResult = await this.call(c.universalResolver.address, universalResolverAbi, 'resolve', [dnsName, addrProfile], block) as readonly [Hex, Address];
      requireMatch(same(addressResult[1], expected.resolver.address) && same(decodeFunctionResult({ abi: resolverAbi, functionName: 'addr', data: addressResult[0] }), expected.owner), 'address_record_mismatch');
      return { ...evidence, name: canonical, resolver: expected.resolver.address, leaseVersion: expected.leaseVersion };
    });
  }
}

export function descriptionTransaction(name: string, resolver: Address, text: string): { chainId: 11155111; to: Address; data: Hex } {
  requireMatch(normalize(name) === name && validAddress(resolver) && Array.from(text).length <= 280 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text), 'invalid_description');
  return { chainId: 11155111, to: resolver, data: encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [namehash(name), 'description', text] }) };
}
