import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { encodeFunctionData, decodeFunctionResult, keccak256, zeroAddress, zeroHash, stringToHex } = require('viem');
const env = process.env;
const required = ['ENS_OWNER', 'ENS_RPC_URL', 'ENS_ARTIFACTS_DIR', 'ENS_INVENTORY_FILE', 'ENS_OUTPUT_FILE', 'ENS_PARENT_PRIMARY'];
if (required.some(key => !env[key])) throw new Error('ens_parent_configuration_missing');
const owner = env.ENS_OWNER.toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(owner) || owner === zeroAddress) throw new Error('invalid_owner');
const endpoint = new URL(env.ENS_RPC_URL);
if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) throw new Error('invalid_rpc');
const inventory = JSON.parse(await readFile(env.ENS_INVENTORY_FILE, 'utf8'));
const output = resolve(env.ENS_OUTPUT_FILE);
if (!output.endsWith('.json')) throw new Error('invalid_output');
const artifacts = {};
for (const name of ['ETHRegistrar', 'ETHRegistry', 'RootRegistry', 'UniversalResolverV2', 'MockUSDC', 'StandardRentPriceOracle']) {
  artifacts[name] = JSON.parse(await readFile(resolve(env.ENS_ARTIFACTS_DIR, `${name}.json`), 'utf8'));
  if (!inventory.contracts[name]?.maskedRuntimeMatches || inventory.contracts[name].address.toLowerCase() !== artifacts[name].address.toLowerCase()) throw new Error('unverified_artifact');
}
const allowed = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call', 'eth_getBalance', 'eth_estimateGas', 'eth_gasPrice']);
let id = 0;
async function rpc(method, params) {
  if (!allowed.has(method)) throw new Error('read_only_method_required');
  for (let retry = 0; retry < 4; retry++) {
    await new Promise(done => setTimeout(done, 700 + retry * 1400));
    try {
      const requestId = ++id;
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }), signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('rpc_unavailable');
      const text = await response.text(); if (text.length > 262144) throw new Error('rpc_oversized');
      const body = JSON.parse(text);
      if (body.jsonrpc !== '2.0' || body.id !== requestId || body.error || body.result === undefined) throw new Error('rpc_unavailable');
      return body.result;
    } catch { if (retry === 3) throw new Error('rpc_unavailable'); }
  }
}
if (BigInt(await rpc('eth_chainId', [])) !== 11155111n) throw new Error('wrong_chain');
const block = await rpc('eth_getBlockByNumber', ['finalized', false]);
if (!block || !block.hash || !block.number) throw new Error('finalized_block_unavailable');
for (const [name, artifact] of Object.entries(artifacts)) {
  const code = await rpc('eth_getCode', [artifact.address, block.number]);
  if (code === '0x' || keccak256(code).toLowerCase() !== inventory.contracts[name].codeHash.toLowerCase()) throw new Error('runtime_changed');
}
const call = async (name, method, args = []) => decodeFunctionResult({ abi: artifacts[name].abi, functionName: method, data: await rpc('eth_call', [{ to: artifacts[name].address, data: encodeFunctionData({ abi: artifacts[name].abi, functionName: method, args }) }, block.number]) });
const registrar = artifacts.ETHRegistrar.address;
if ((await call('ETHRegistrar', 'ETH_REGISTRY')).toLowerCase() !== artifacts.ETHRegistry.address.toLowerCase()
  || (await call('UniversalResolverV2', 'ROOT_REGISTRY')).toLowerCase() !== artifacts.RootRegistry.address.toLowerCase()
  || (await call('RootRegistry', 'getSubregistry', ['eth'])).toLowerCase() !== artifacts.ETHRegistry.address.toLowerCase()
  || (await call('ETHRegistrar', 'rentPriceOracle')).toLowerCase() !== artifacts.StandardRentPriceOracle.address.toLowerCase()) throw new Error('hierarchy_changed');
let label;
const candidates = [env.ENS_PARENT_PRIMARY, env.ENS_PARENT_FALLBACK].filter(Boolean);
if (candidates.some(candidate => !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(candidate))) throw new Error('invalid_parent_candidate');
for (const candidate of candidates) if (await call('ETHRegistrar', 'isAvailable', [candidate])) { label = candidate; break; }
if (!label) throw new Error('requested_names_unavailable');
const nameState = await call('ETHRegistry', 'getState', [BigInt(keccak256(stringToHex(label)))]);
if (nameState.status !== 0) throw new Error('name_not_available');
const token = artifacts.MockUSDC.address;
if (await call('MockUSDC', 'decimals') !== 6 || !(await call('StandardRentPriceOracle', 'isPaymentToken', [token]))) throw new Error('unsupported_payment_token');
const duration = BigInt(env.ENS_PARENT_DURATION_SECONDS ?? '31536000');
const minDuration = await call('ETHRegistrar', 'MIN_REGISTER_DURATION');
if (duration < minDuration || duration > 31536000n) throw new Error('invalid_duration');
const [base, premium] = await call('ETHRegistrar', 'getRegisterPrice', [label, duration, token]);
const total = base + premium;
if (total <= 0n || total > 10000000n || premium !== 0n) throw new Error('parent_price_limit');
const tokenBalance = await call('MockUSDC', 'balanceOf', [owner]);
const allowance = await call('MockUSDC', 'allowance', [owner, registrar]);
const ethBalance = BigInt(await rpc('eth_getBalance', [owner, block.number]));
const minAge = await call('ETHRegistrar', 'MIN_COMMITMENT_AGE');
const maxAge = await call('ETHRegistrar', 'MAX_COMMITMENT_AGE');
const secret = `0x${randomBytes(32).toString('hex')}`;
const commitment = await call('ETHRegistrar', 'makeCommitment', [label, owner, secret, zeroAddress, zeroAddress, duration, zeroHash]);
const tx = (artifact, functionName, args) => ({ chainId: '0xaa36a7', from: owner, to: artifact.address, value: '0x0', data: encodeFunctionData({ abi: artifact.abi, functionName, args }) });
const steps = [];
if (tokenBalance < total) {
  const mint = tx(artifacts.MockUSDC, 'mint', [owner, total - tokenBalance]);
  await rpc('eth_call', [mint, block.number]);
  steps.push({ action: 'test_token_mint', transaction: mint, amountAtomic: (total - tokenBalance).toString(), simulation: 'passed' });
}
if (allowance < total) {
  if (allowance !== 0n) steps.push({ action: 'reset_token_allowance', transaction: tx(artifacts.MockUSDC, 'approve', [registrar, 0n]), amountAtomic: '0' });
  steps.push({ action: 'approve_exact_token_amount', transaction: tx(artifacts.MockUSDC, 'approve', [registrar, total]), amountAtomic: total.toString() });
}
steps.push({ action: 'commit_parent', transaction: tx(artifacts.ETHRegistrar, 'commit', [commitment]) });
steps.push({ action: 'wait_commitment_age', minimumSeconds: minAge.toString(), maximumSeconds: maxAge.toString() });
steps.push({ action: 'register_parent', transaction: tx(artifacts.ETHRegistrar, 'register', [label, owner, secret, zeroAddress, zeroAddress, duration, token, zeroHash]), prerequisites: ['confirmed_commit', 'minimum_age_elapsed', 'fresh_name_availability', 'fresh_price_within_exact_allowance', 'token_balance_sufficient'], estimate: 'deferred_until_prerequisites' });
let estimatedGas = 0n;
for (const step of steps) if (step.transaction && step.action !== 'register_parent') {
  step.estimatedGas = await rpc('eth_estimateGas', [step.transaction]);
  estimatedGas += BigInt(step.estimatedGas);
}
const gasPrice = BigInt(await rpc('eth_gasPrice', []));
const endBlock = await rpc('eth_getBlockByNumber', [block.number, false]);
if (endBlock.hash !== block.hash) throw new Error('canonical_block_changed');
const manifest = { version: 1, environment: 'testnet', chainId: 11155111, readOnly: true, createdAt: new Date().toISOString(), sourceCommit: inventory.sourceCommit, owner, parentName: `${label}.eth`, durationSeconds: duration.toString(), paymentToken: token, price: { baseAtomic: base.toString(), premiumAtomic: premium.toString(), totalAtomic: total.toString(), decimals: 6, symbol: await call('MockUSDC', 'symbol'), scope: 'official_ens_test_token_only' }, balances: { ethWei: ethBalance.toString(), tokenAtomic: tokenBalance.toString(), allowanceAtomic: allowance.toString() }, gas: { gasPriceWei: gasPrice.toString(), preRegisterEstimatedGas: estimatedGas.toString(), preRegisterEstimatedCostWei: (estimatedGas * gasPrice).toString(), registerEstimateDeferred: true }, commitment, finalizedBlock: { number: block.number, hash: block.hash }, pins: inventory.contracts, steps, registrationReadback: { registry: artifacts.ETHRegistry.address, expectedOwner: owner, expectedSubregistry: zeroAddress, expectedResolver: zeroAddress, minimumExpiryAfterReceiptSeconds: duration.toString() }, namespaceReady: false };
const serialized = JSON.stringify(manifest, null, 2) + '\n';
await writeFile(output, serialized, { flag: 'wx', encoding: 'utf8' });
console.log(JSON.stringify({ status: 'prepared_unsigned', environment: 'testnet', parentName: manifest.parentName, price: manifest.price, gas: manifest.gas, steps: steps.map(step => step.action), manifestSha256: createHash('sha256').update(serialized).digest('hex'), namespaceReady: false }));
