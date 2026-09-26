import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeFunctionResult, keccak256, parseAbi, type Hex } from 'viem';
import { createRegistryReader, type RegistryReaderConfig } from '../src/registry-reader.js';

const key = `0x${'11'.repeat(32)}` as Hex;
const blockHash = `0x${'44'.repeat(32)}` as Hex;
const config: RegistryReaderConfig = { rpcUrl: 'https://rpc.example.test/', multibaasUrl: 'https://fixture.multibaas.com', multibaasApiKey: 'secret-fixture', chainId: 11155111,
  registryAddress: `0x${'22'.repeat(20)}`, contractLabel: 'leaseregistry', contractVersion: '1.0.0', runtimeCodeHash: keccak256('0x1234') };
const change = { kind: 'record' as const, leaseKey: key, buildingKey: key, holderCommitment: key, slot: 42, expiresAt: '2000000000', version: 1 };
const abi = parseAbi(['function getLease(bytes32 leaseKey) view returns (bytes32 buildingKey,uint16 slot,bytes32 holderCommitment,uint64 expiresAt,uint64 version,bool revoked)']);
function fixture(overrides: Record<string, unknown> = {}) {
  const requests: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
  const transport: typeof fetch = async (url, options) => {
    const body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : undefined;
    requests.push({ url: String(url), body });
    assert.equal(options?.redirect, 'error');
    let name: string;
    let result: unknown;
    if (String(url).includes('rpc.example')) {
      assert.equal((options?.headers as Record<string, string>).Authorization, undefined);
      name = String(body?.method);
      result = { eth_chainId: '0xaa36a7', eth_getBlockByNumber: { number: '0x64', hash: blockHash }, eth_getCode: '0x1234',
        eth_call: encodeFunctionResult({ abi, functionName: 'getLease', result: [key, 42, key, 2000000000n, 1n, false] }) }[name];
    } else {
      name = String(url).endsWith('/status') ? 'status' : String(url).endsWith('/getLease') ? 'getLease' : 'target';
      result = { status: { chainID: 11155111 }, target: { address: config.registryAddress, contracts: [{ label: config.contractLabel, version: config.contractVersion }] },
        getLease: { kind: 'MethodCallResponse', output: [key, '42', key, '2000000000', '1', false] } }[name];
    }
    if (Object.hasOwn(overrides, name)) result = overrides[name];
    return new Response(JSON.stringify(String(url).includes('rpc.example') ? { jsonrpc: '2.0', id: 1, result } : { status: 200, result }), { headers: { 'content-type': 'application/json' } });
  };
  return { requests, transport };
}
test('read requires finalized pinned RPC state and matching pinned MultiBaas output', async () => {
  const { transport, requests } = fixture();
  assert.deepEqual(await createRegistryReader(config, transport).read(change), { change, chainId: 11155111, registryAddress: config.registryAddress, blockNumber: '100', blockHash, finalityVerified: true });
  assert.deepEqual(requests.find(request => request.body?.method === 'eth_getBlockByNumber')?.body?.params, ['finalized', false]);
  const mb = requests.find(request => request.url.endsWith('/getLease'))?.body;
  assert.equal(mb?.blockNumber, '100'); assert.equal(mb?.signAndSubmit, false); assert.equal(mb?.contractOverride, false);
  assert.equal(requests.some(request => request.body?.method === 'eth_sendTransaction'), false);
});
test('unknown/malformed/wrong chain, target, runtime, or lease state never succeeds', async () => {
  for (const overrides of [ { eth_chainId: '0x1' }, { status: { chainID: 1 } }, { target: { address: key, contracts: [] } },
    { eth_getBlockByNumber: null }, { eth_getCode: '0x5678' }, { eth_call: '0x' },
    { getLease: { kind: 'TransactionToSignResponse', tx: {} } }, { getLease: { kind: 'MethodCallResponse', output: [key, '43', key, '2000000000', '1', false] } },
    { getLease: { kind: 'MethodCallResponse', output: [key, '42', key, '2000000000', '2', false] } } ]) {
    assert.equal(await createRegistryReader(config, fixture(overrides).transport).read(change), null);
  }
});
test('canonical block change after read holds the job', async () => {
  const { transport } = fixture(); let count = 0;
  const changing: typeof fetch = async (url, options) => {
    if (options?.body && JSON.parse(String(options.body)).method === 'eth_getBlockByNumber' && ++count === 2)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { number: '0x64', hash: key } }), { headers: { 'content-type': 'application/json' } });
    return transport(url, options);
  };
  assert.equal(await createRegistryReader(config, changing).read(change), null);
});
test('request errors and provider secrets never escape the reader', async () => {
  const failing: typeof fetch = async () => { throw new Error(config.multibaasApiKey); };
  assert.equal(await createRegistryReader(config, failing).read(change), null);
  assert.throws(() => createRegistryReader({ ...config, multibaasUrl: 'https://fixture.multibaas.com.evil.test/' }), /^Error: invalid-registry-configuration$/);
  assert.throws(() => createRegistryReader({ ...config, chainId: 1 as 11155111 }), /^Error: invalid-registry-configuration$/);
});
test('a total read deadline yields no evidence and cancels further requests', async context => {
  const controller = new AbortController(); controller.abort();
  context.mock.method(AbortSignal, 'timeout', () => controller.signal);
  const { transport, requests } = fixture();
  assert.equal(await createRegistryReader(config, transport).read(change), null);
  assert.equal(requests.length, 0);
});
