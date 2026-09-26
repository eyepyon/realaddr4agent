import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, type Hex } from 'viem';
import type { RegistryChange, RegistryReadbackEvidence } from '@realaddr/db';

export interface RegistryReaderConfig {
  rpcUrl: string;
  multibaasUrl: string;
  multibaasApiKey: string;
  chainId: 11155111;
  registryAddress: Hex;
  contractLabel: string;
  contractVersion: string;
  runtimeCodeHash: Hex;
}
const abi = parseAbi(['function getLease(bytes32 leaseKey) view returns (bytes32 buildingKey,uint16 slot,bytes32 holderCommitment,uint64 expiresAt,uint64 version,bool revoked)']);
const hash = (value: unknown): value is Hex => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-response');
  return value as Record<string, unknown>;
};
function httpsUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
    return url;
  } catch { throw new Error('invalid-registry-configuration'); }
}

export function createRegistryReader(config: RegistryReaderConfig, transport: typeof fetch = fetch) {
  const base = httpsUrl(config.multibaasUrl);
  const rpc = httpsUrl(config.rpcUrl);
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.multibaas\.com$/.test(base.hostname)
    || base.port || base.search || !['/', '/api/v0', '/api/v0/'].includes(base.pathname)
    || config.chainId !== 11155111 || !/^0x[0-9a-f]{40}$/i.test(config.registryAddress)
    || /^0x0+$/i.test(config.registryAddress) || /^0x0+$/i.test(config.runtimeCodeHash) || !hash(config.runtimeCodeHash) || !/^[a-z0-9_-]+$/.test(config.contractLabel)
    || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(config.contractVersion)
    || !config.multibaasApiKey || /\s/.test(config.multibaasApiKey)) throw new Error('invalid-registry-configuration');

  async function json(url: URL, payload?: unknown, authenticated = false, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    const response = await transport(url, {
      method: payload === undefined ? 'GET' : 'POST', redirect: 'error', signal: signal ?? AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json', ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(authenticated ? { Authorization: `Bearer ${config.multibaasApiKey}` } : {}) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
    });
    if (!response.ok || !/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) throw new Error('invalid-response');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('invalid-response');
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length;
      if (size > 262_144) throw new Error('invalid-response'); chunks.push(chunk.value); } }
    finally { await reader.cancel(); }
    signal?.throwIfAborted();
    return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  }
  async function call(method: string, params: unknown[], signal: AbortSignal): Promise<unknown> {
    const body = await json(rpc, { jsonrpc: '2.0', id: 1, method, params }, false, signal);
    if (body.jsonrpc !== '2.0' || body.id !== 1 || Object.hasOwn(body, 'error') || !Object.hasOwn(body, 'result')) throw new Error('invalid-response');
    return body.result;
  }
  async function mb(path: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    const body = await json(new URL(`/api/v0${path}`, base), payload, true, signal);
    if (body.status !== 200 || !Object.hasOwn(body, 'result')) throw new Error('invalid-response');
    return body.result;
  }
  return {
    async read(requestedChange: RegistryChange): Promise<RegistryReadbackEvidence | null> {
      try {
        const change = { ...requestedChange };
        const signal = AbortSignal.timeout(20_000);
        const readRpc = (method: string, params: unknown[]) => call(method, params, signal);
        const readMb = (path: string, payload?: unknown) => mb(path, payload, signal);
        if (!hash(change.leaseKey) || !hash(change.buildingKey) || !hash(change.holderCommitment)
          || !Number.isInteger(change.slot) || change.slot < 1 || change.slot > 65535
          || !Number.isSafeInteger(change.version) || change.version < 1
          || !/^[1-9][0-9]*$/.test(change.expiresAt) || BigInt(change.expiresAt) >= 2n ** 64n
          || !['record', 'revoke'].includes(change.kind)) return null;
        if (await readRpc('eth_chainId', []) !== '0xaa36a7' || object(await readMb('/chains/ethereum/status')).chainID !== 11155111) return null;
        const target = object(await readMb(`/chains/ethereum/addresses/${config.registryAddress}`));
        if (typeof target.address !== 'string' || target.address.toLowerCase() !== config.registryAddress.toLowerCase()
          || !Array.isArray(target.contracts) || !target.contracts.some(item => {
            const linked = object(item); return linked.label === config.contractLabel && linked.version === config.contractVersion;
          })) return null;
        const block = object(await readRpc('eth_getBlockByNumber', ['finalized', false]));
        if (!hash(block.hash) || typeof block.number !== 'string' || !/^0x[0-9a-f]+$/i.test(block.number)) return null;
        const code = await readRpc('eth_getCode', [config.registryAddress, block.number]);
        if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(code) || keccak256(code as Hex).toLowerCase() !== config.runtimeCodeHash.toLowerCase()) return null;
        const raw = await readRpc('eth_call', [{ to: config.registryAddress, data: encodeFunctionData({ abi, functionName: 'getLease', args: [change.leaseKey] }) }, block.number]);
        if (typeof raw !== 'string' || !/^0x[0-9a-f]+$/i.test(raw)) return null;
        const chainValues = decodeFunctionResult({ abi, functionName: 'getLease', data: raw as Hex });
        const result = object(await readMb(`/chains/ethereum/addresses/${config.registryAddress}/contracts/${config.contractLabel}/methods/getLease`, {
          signature: 'getLease(bytes32)', args: [change.leaseKey], signAndSubmit: false, nonceManagement: false,
          contractOverride: false, formatInts: 'as_strings', blockNumber: BigInt(block.number).toString()
        }));
        if (result.kind !== 'MethodCallResponse' || Object.hasOwn(result, 'tx') || result.submitted === true) return null;
        const fields = ['buildingKey', 'slot', 'holderCommitment', 'expiresAt', 'version', 'revoked'];
        const values = Array.isArray(result.output) ? result.output : fields.map(field => object(result.output)[field]);
        if (values.length !== 6) return null;
        const expected = [change.buildingKey.toLowerCase(), String(change.slot), change.holderCommitment.toLowerCase(), change.expiresAt, String(change.version), change.kind === 'revoke'];
        const normalize = (value: unknown) => typeof value === 'string' ? value.toLowerCase() : typeof value === 'bigint' || typeof value === 'number' ? String(value) : value;
        if (values.some((value, index) => normalize(value) !== expected[index]) || chainValues.some((value, index) => normalize(value) !== expected[index])) return null;
        const canonical = object(await readRpc('eth_getBlockByNumber', [block.number, false]));
        if (canonical.hash !== block.hash || canonical.number !== block.number) return null;
        signal.throwIfAborted();
        return { change: { ...change }, chainId: 11155111, registryAddress: config.registryAddress,
          blockNumber: BigInt(block.number).toString(), blockHash: block.hash, finalityVerified: true };
      } catch { return null; }
    }
  };
}
