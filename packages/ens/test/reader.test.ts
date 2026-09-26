import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionResult, encodeAbiParameters, concatHex, keccak256, namehash, stringToHex, zeroAddress, type Abi, type Address, type Hex } from 'viem';
import { EnsV2Reader, descriptionTransaction, createHttpRpc, resolverProxyPin, controllerAbi, factoryAbi, leaseRegistryAbi, registryAbi, resolverAbi, universalResolverAbi, type BindingExpectation, type NamespaceConfig, type Rpc } from '../src/index.js';

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const pin = (n: number) => ({ address: addr(n), codeHash: keccak256('0x6000') });
const config: NamespaceConfig = { chainId: 11155111, parentName: 'example.eth', locationSlug: 'demo', parentOwner: addr(20), locationOwner: addr(21), serviceOrigin: 'https://example.invalid', universalResolver: pin(1), rootRegistry: pin(2), ethRegistry: pin(3), upperRegistry: pin(4), locationRegistry: pin(5), factory: pin(6), resolverImplementation: pin(7), nameController: pin(8), leaseRegistry: pin(9), userRegistryImplementation: pin(10), proxyLogic: pin(11) };
const expected: BindingExpectation = { name: 'f00042.demo.example.eth', leaseKey: hash(10), buildingKey: hash(20), slot: 42, holderSalt: hash(30), owner: config.locationOwner, resolver: resolverProxyPin(config, hash(10)), leaseVersion: 1n, expiresAt: 1000n, entitlement: 'paid', dbActive: true };

function fixture(options: { reorg?: boolean; owner?: Address; pointer?: Address; code?: Hex; unavailable?: boolean; expiry?: bigint; wildcard?: boolean; revoked?: boolean; badRecord?: boolean; broadText?: boolean } = {}): Rpc {
  return async (method, params) => {
    if (options.unavailable) throw new Error('fixture outage');
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getBlockByNumber') return { number: '0x64', timestamp: '0x64', hash: options.reorg && params[0] !== 'finalized' ? hash(2) : hash(1) };
    if (method === 'eth_getCode') return options.code ?? (params[0] === expected.resolver.address ? concatHex(['0x363d3d373d3d3d363d73', config.proxyLogic.address, '0x5af43d82803e903d91602b57fd5bf3', keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [config.nameController.address, BigInt(expected.leaseKey)]))]) : '0x6000');
    assert.equal(method, 'eth_call');
    assert.equal(params[1], '0x64');
    const call = params[0] as { to: Address; data: Hex };
    const abi = call.to === config.universalResolver.address ? universalResolverAbi : call.to === config.leaseRegistry.address ? leaseRegistryAbi : call.to === config.nameController.address ? controllerAbi : call.to === config.factory.address ? factoryAbi : call.to === expected.resolver.address ? resolverAbi : registryAbi;
    const decoded = decodeFunctionData({ abi, data: call.data });
    let result: unknown;
    if (decoded.functionName === 'ROOT_REGISTRY') result = config.rootRegistry.address;
    else if (decoded.functionName === 'proxyLogic') result = config.proxyLogic.address;
    else if (decoded.functionName === 'verifyContract') result = decoded.args?.[0] === expected.resolver.address ? config.resolverImplementation.address : config.userRegistryImplementation.address;
    else if (decoded.functionName === 'parentLabel') result = 'example';
    else if (decoded.functionName === 'ETH_REGISTRY') result = config.ethRegistry.address;
    else if (decoded.functionName === 'UPPER_REGISTRY') result = config.upperRegistry.address;
    else if (decoded.functionName === 'RESOLVER_FACTORY') result = config.factory.address;
    else if (decoded.functionName === 'RESOLVER_IMPLEMENTATION') result = config.resolverImplementation.address;
    else if (decoded.functionName === 'LEASE_REGISTRY') result = config.leaseRegistry.address;
    else if (decoded.functionName === 'getSubregistry') result = call.to === config.rootRegistry.address ? config.ethRegistry.address : call.to === config.ethRegistry.address ? config.upperRegistry.address : call.to === config.locationRegistry.address ? zeroAddress : options.pointer ?? config.locationRegistry.address;
    else if (decoded.functionName === 'findParentRegistry') result = config.locationRegistry.address;
    else if (decoded.functionName === 'paused') result = false;
    else if (decoded.functionName === 'getState') result = { status: 2, expiry: options.expiry ?? 1000n, latestOwner: options.owner ?? (call.to === config.ethRegistry.address ? config.parentOwner : config.locationOwner), tokenId: 1n, resource: 1n };
    else if (decoded.functionName === 'hasRootRoles') result = call.to === expected.resolver.address ? options.broadText === true && decoded.args?.[0] === 16n : true;
    else if (decoded.functionName === 'hasRoles') result = call.to === expected.resolver.address;
    else if (decoded.functionName === 'roles') {
      const descriptionResource = BigInt(keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [namehash(expected.name), keccak256(stringToHex('description'))])));
      result = call.to === expected.resolver.address && decoded.args?.[0] === descriptionResource ? 16n : 0n;
    }
    else if (decoded.functionName === 'getResolver') result = expected.resolver.address;
    else if (decoded.functionName === 'getAlias') result = '0x';
    else if (decoded.functionName === 'findResolver') result = [expected.resolver.address, namehash(expected.name), options.wildcard ? 10n : 0n];
    else if (decoded.functionName === 'getNamespace') result = ['demo', config.locationRegistry.address, namehash('demo.example.eth')];
    else if (decoded.functionName === 'getBinding') result = [expected.leaseKey, expected.owner, expected.resolver.address, expected.leaseVersion, false];
    else if (decoded.functionName === 'getLease') result = [expected.buildingKey, expected.slot, keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [expected.owner, expected.holderSalt])), expected.expiresAt, expected.leaseVersion, options.revoked ?? false];
    else if (decoded.functionName === 'resolve') {
      const profile = decodeFunctionData({ abi: resolverAbi, data: decoded.args?.[1] as Hex });
      const records: Record<string, string> = { 'realaddr.schema': '1', 'realaddr.lease': `eip155:11155111:${config.leaseRegistry.address}:${expected.leaseKey}`, 'realaddr.binding': config.nameController.address, 'realaddr.api': config.serviceOrigin };
      const value = profile.functionName === 'addr' ? expected.owner : options.badRecord ? 'tampered' : records[profile.args?.[1] as string];
      result = [encodeFunctionResult({ abi: resolverAbi as Abi, functionName: profile.functionName, result: value }), expected.resolver.address];
    }
    else if (decoded.functionName === 'getParent') result = call.to === config.upperRegistry.address ? [config.ethRegistry.address, 'example'] : [config.upperRegistry.address, 'demo'];
    else throw new Error('fixture unexpected call');
    return encodeFunctionResult({ abi: abi as Abi, functionName: decoded.functionName, result });
  };
}

test('namespace readiness uses one finalized snapshot with exact hierarchy, owners and roles', async () => {
  const result = await new EnsV2Reader(config, fixture(), () => 101n).readNamespaceReadiness(900n);
  assert.equal(result.status, 'verified');
  if (result.status === 'verified') assert.equal(result.evidence.blockNumber, 100n);
});
test('a wrong intermediate pointer, owner, expired name or code fails closed', async () => {
  for (const options of [{ pointer: zeroAddress }, { owner: addr(22) }, { expiry: 100n }, { code: '0x6001' as Hex }]) {
    assert.equal((await new EnsV2Reader(config, fixture(options), () => 101n).readNamespaceReadiness(900n)).status, 'invalid');
  }
});
test('canonical block change invalidates otherwise matching reads', async () => {
  assert.deepEqual(await new EnsV2Reader(config, fixture({ reorg: true }), () => 101n).readNamespaceReadiness(900n), { status: 'invalid', reason: 'canonical_block_changed' });
});
test('an unreachable sponsor RPC remains pending', async () => {
  assert.deepEqual(await new EnsV2Reader(config, fixture({ unavailable: true }), () => 101n).readNamespaceReadiness(900n), { status: 'pending', reason: 'ens_read_unavailable' });
});
test('description transaction encodes only pinned resolver text profile and key', () => {
  const transaction = descriptionTransaction('f00042.demo.example.eth', addr(30), 'Hello');
  const decoded = decodeFunctionData({ abi: resolverAbi, data: transaction.data });
  assert.equal(transaction.chainId, 11155111);
  assert.equal(decoded.functionName, 'setText');
  assert.equal(decoded.args?.[1], 'description');
  assert.throws(() => descriptionTransaction('f00042.demo.example.eth', addr(30), 'x'.repeat(281)));
});
test('paid binding verifies exact owner, pointer, attestation and Universal Resolver records', async () => {
  assert.equal((await new EnsV2Reader(config, fixture(), () => 101n).verifyBinding(expected)).status, 'verified');
});
test('wildcard resolution, revoked lease, fixed record tampering and broad delegate roles fail closed', async () => {
  for (const options of [{ wildcard: true }, { revoked: true }, { badRecord: true }, { broadText: true }]) {
    assert.equal((await new EnsV2Reader(config, fixture(options), () => 101n).verifyBinding(expected)).status, 'invalid');
  }
});
test('unpaid DB state and untrusted resolver proxy runtime never verify', async () => {
  const reader = new EnsV2Reader(config, fixture(), () => 101n);
  assert.equal((await reader.verifyBinding({ ...expected, dbActive: false })).status, 'invalid');
  assert.equal((await reader.verifyBinding({ ...expected, resolver: { ...expected.resolver, codeHash: hash(100) } })).status, 'invalid');
});
test('HTTP RPC rejects redirects, oversized responses and mismatched response IDs without leaking errors', async () => {
  assert.throws(() => createHttpRpc('https://username:password@example.invalid'));
  let options: RequestInit | undefined;
  const fetcher = (async (_input: unknown, init?: RequestInit) => {
    options = init;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 999, result: '0xaa36a7' }));
  }) as typeof fetch;
  await assert.rejects(createHttpRpc('https://example.invalid', fetcher)('eth_chainId', []), /rpc_unavailable/);
  assert.equal(options?.redirect, 'error');
  const oversized = (async () => new Response('x'.repeat(262145))) as typeof fetch;
  await assert.rejects(createHttpRpc('https://example.invalid', oversized)('eth_chainId', []), /rpc_unavailable/);
});
