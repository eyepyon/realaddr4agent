import { encodeFunctionData, encodeAbiParameters, decodeFunctionResult, decodeFunctionData, keccak256, parseAbi, stringToHex, zeroAddress, zeroHash } from 'viem';
import { verifyExactWrapper, validateWrapperPolicy } from './ens-parent-wrapper.mjs';

const registrarAbi = parseAbi([
  'function isAvailable(string label) view returns (bool)',
  'function commitmentAt(bytes32 commitment) view returns (uint64)',
  'function makeCommitment(string label,address owner,bytes32 secret,address registry,address resolver,uint64 duration,bytes32 referrer) view returns (bytes32)',
  'function getRegisterPrice(string label,uint64 duration,address paymentToken) view returns (uint256,uint256)',
  'function commit(bytes32 commitment)',
  'function register(string label,address owner,bytes32 secret,address registry,address resolver,uint64 duration,address paymentToken,bytes32 referrer)',
  'function MIN_COMMITMENT_AGE() view returns (uint64)',
  'function MAX_COMMITMENT_AGE() view returns (uint64)',
]);
const tokenAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function mint(address owner,uint256 amount)',
  'function approve(address spender,uint256 amount) returns (bool)',
]);
const registryAbi = parseAbi([
  'function getState(uint256 anyId) view returns ((uint8 status,uint64 expiry,address latestOwner,uint256 tokenId,uint256 resource))',
  'function getSubregistry(string label) view returns (address)',
  'function getResolver(string label) view returns (address)',
]);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const demand = (value, reason) => { if (!value) throw new Error(reason); };

export function validateParentManifest(manifest) {
  demand(manifest?.version === 1 && manifest.chainId === 11155111 && manifest.environment === 'testnet' && manifest.readOnly === true, 'invalid_plan');
  demand(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?\.eth$/.test(manifest.parentName), 'invalid_parent');
  demand(/^0x[0-9a-fA-F]{40}$/.test(manifest.owner) && !same(manifest.owner, zeroAddress), 'invalid_owner');
  demand(manifest.price.decimals === 6 && manifest.price.scope === 'official_ens_test_token_only' && BigInt(manifest.price.premiumAtomic) === 0n && BigInt(manifest.price.totalAtomic) > 0n && BigInt(manifest.price.totalAtomic) <= 10000000n && BigInt(manifest.price.baseAtomic) + BigInt(manifest.price.premiumAtomic) === BigInt(manifest.price.totalAtomic), 'invalid_price');
  demand(BigInt(manifest.durationSeconds) >= 2419200n && BigInt(manifest.durationSeconds) <= 31536000n && BigInt(manifest.balances.tokenAtomic) >= 0n && BigInt(manifest.balances.allowanceAtomic) >= 0n, 'invalid_duration_or_balance');
  const registrar = manifest.pins.ETHRegistrar.address; const token = manifest.pins.MockUSDC.address;
  demand(/^0x[0-9a-fA-F]{64}$/.test(manifest.pins.ETHRegistrar.codeHash) && /^0x[0-9a-fA-F]{64}$/.test(manifest.pins.MockUSDC.codeHash), 'invalid_runtime_pin');
  demand(same(token, manifest.paymentToken), 'invalid_token');
  const actions = manifest.steps.map(step => step.action);
  const validOrder = ['test_token_mint', 'reset_token_allowance', 'approve_exact_token_amount', 'commit_parent', 'wait_commitment_age', 'register_parent'];
  let previous = -1;
  for (const step of manifest.steps) {
    const index = validOrder.indexOf(step.action);
    demand(index > previous, 'invalid_step_order'); previous = index;
    if (!step.transaction) { demand(step.action === 'wait_commitment_age' && BigInt(step.minimumSeconds) >= 0n && BigInt(step.maximumSeconds) > BigInt(step.minimumSeconds), 'invalid_step'); continue; }
    const tx = step.transaction;
    demand(tx.chainId === '0xaa36a7' && same(tx.from, manifest.owner) && tx.value === '0x0', 'invalid_transaction');
    const isToken = index < 3;
    demand(same(tx.to, isToken ? token : registrar), 'invalid_transaction_target');
    const decoded = decodeFunctionData({ abi: isToken ? tokenAbi : registrarAbi, data: tx.data });
    const args = decoded.args;
    if (step.action === 'test_token_mint') demand(decoded.functionName === 'mint' && same(args[0], manifest.owner) && args[1] === BigInt(step.amountAtomic) && args[1] === BigInt(manifest.price.totalAtomic) - BigInt(manifest.balances.tokenAtomic), 'invalid_mint');
    if (step.action === 'reset_token_allowance') demand(decoded.functionName === 'approve' && same(args[0], registrar) && args[1] === 0n, 'invalid_allowance_reset');
    if (step.action === 'approve_exact_token_amount') demand(decoded.functionName === 'approve' && same(args[0], registrar) && args[1] === BigInt(manifest.price.totalAtomic), 'invalid_allowance');
    if (step.action === 'commit_parent') demand(decoded.functionName === 'commit' && same(args[0], manifest.commitment), 'invalid_commit');
    if (step.action === 'register_parent') {
      demand(decoded.functionName === 'register' && args[0] === manifest.parentName.slice(0, -4) && same(args[1], manifest.owner) && same(args[3], zeroAddress) && same(args[4], zeroAddress) && args[5] === BigInt(manifest.durationSeconds) && same(args[6], token) && same(args[7], zeroHash), 'invalid_registration');
      const commitment = keccak256(encodeAbiParameters([{type:'string'},{type:'address'},{type:'bytes32'},{type:'address'},{type:'address'},{type:'uint64'},{type:'bytes32'}], [args[0],args[1],args[2],args[3],args[4],args[5],args[7]]));
      demand(same(commitment, manifest.commitment), 'commitment_mismatch');
    }
  }
  demand(actions.includes('commit_parent') && actions.includes('wait_commitment_age') && actions.includes('register_parent'), 'incomplete_plan');
  return manifest;
}

export function createParentFlow({ manifest, provider, save, state = { steps: {}, unknown: false }, wrapperPolicy }) {
  validateParentManifest(manifest);
  if(wrapperPolicy) validateWrapperPolicy(wrapperPolicy);
  let busy = false;
  const rpc = (method, params = []) => provider.request({ method, params });
  const registrar = manifest.pins.ETHRegistrar.address; const token = manifest.paymentToken;
  const call = async (address, abi, functionName, args) => decodeFunctionResult({ abi, functionName, data: await rpc('eth_call', [{ to: address, data: encodeFunctionData({ abi, functionName, args }) }, 'latest']) });
  async function account() {
    demand(BigInt(await rpc('eth_chainId')) === 11155111n, 'wrong_chain');
    const accounts = await rpc('eth_accounts');
    demand(Array.isArray(accounts) && same(accounts[0], manifest.owner), 'wrong_account');
  }
  async function persist() { try { await save(structuredClone(state)); } catch { state.unknown = true; throw new Error('persistence_failed_do_not_resend'); } }
  async function receipt(action) {
    const stored = state.steps[action];
    demand(stored?.hash, 'missing_transaction');
    const result = await rpc('eth_getTransactionReceipt', [stored.hash]);
    if (!result) return false;
    const step = manifest.steps.find(step => step.action === action);
    const transaction = await rpc('eth_getTransactionByHash', [stored.hash]);
    const targetPin=action==='test_token_mint' || action.includes('allowance') || action==='approve_exact_token_amount' ? manifest.pins.MockUSDC : manifest.pins.ETHRegistrar;
    demand(same(keccak256(await rpc('eth_getCode',[targetPin.address,result.blockNumber])),targetPin.codeHash),'target_runtime_changed');
    demand(transaction && same(transaction.from, manifest.owner) && BigInt(transaction.value) === 0n && same(transaction.hash, stored.hash), 'transaction_mismatch');
    const direct=same(transaction.to,step.transaction.to) && same(transaction.input,step.transaction.data);
    if(!direct) {
      demand(!!wrapperPolicy,'transaction_mismatch');
      await verifyExactWrapper({transaction,expected:step.transaction,owner:manifest.owner,paymentToken:manifest.paymentToken,policy:wrapperPolicy,blockNumber:result.blockNumber,rpc,...(action==='register_parent'?{registrationGuard:{registry:manifest.pins.ETHRegistry,label:manifest.parentName.slice(0,-4)}}:{})});
    }
    const block = await rpc('eth_getBlockByNumber', [result.blockNumber, false]);
    demand(block && same(block.hash, result.blockHash), 'receipt_noncanonical');
    demand(result.status === '0x1' && same(result.transactionHash, stored.hash) && same(result.from, manifest.owner) && same(result.to, transaction.to), 'transaction_failed');
    if(action==='test_token_mint') {
      const minted=result.logs?.filter(log=>same(log.address,manifest.paymentToken) && log.topics?.length===3 && same(log.topics[0],keccak256(stringToHex('Transfer(address,address,uint256)'))) && same(log.topics[1],zeroHash) && same(log.topics[2],`0x${manifest.owner.slice(2).padStart(64,'0')}`) && log.removed!==true);
      demand(minted?.length===1 && BigInt(minted[0].data)===BigInt(step.amountAtomic),'mint_effect_mismatch');
    }
    stored.receipt = { blockNumber: result.blockNumber, blockHash: result.blockHash, status: result.status };
    stored.confirmed = true;
    await persist();
    return true;
  }
  async function commitmentReady() {
    const committedAt = await call(registrar, registrarAbi, 'commitmentAt', [manifest.commitment]);
    const latest = await rpc('eth_getBlockByNumber', ['latest', false]);
    const wait = manifest.steps.find(step => step.action === 'wait_commitment_age');
    demand(committedAt > 0n, 'commitment_missing');
    const age = BigInt(latest.timestamp) - committedAt;
    demand(age >= BigInt(wait.minimumSeconds), 'commitment_too_new');
    demand(age < BigInt(wait.maximumSeconds), 'commitment_expired');
  }
  async function validateLivePlan() {
    const args = decodeFunctionData({ abi: registrarAbi, data: manifest.steps.find(step => step.action === 'register_parent').transaction.data }).args;
    const computed = await call(registrar, registrarAbi, 'makeCommitment', [args[0], args[1], args[2], args[3], args[4], args[5], args[7]]);
    demand(same(computed, manifest.commitment), 'commitment_mismatch');
    const wait = manifest.steps.find(step => step.action === 'wait_commitment_age');
    demand(await call(registrar, registrarAbi, 'MIN_COMMITMENT_AGE', []) === BigInt(wait.minimumSeconds) && await call(registrar, registrarAbi, 'MAX_COMMITMENT_AGE', []) === BigInt(wait.maximumSeconds), 'commitment_age_changed');
  }
  async function preRegister(step) {
    await commitmentReady();
    const args = decodeFunctionData({ abi: registrarAbi, data: step.transaction.data }).args;
    const computed = await call(registrar, registrarAbi, 'makeCommitment', [args[0], args[1], args[2], args[3], args[4], args[5], args[7]]);
    demand(same(computed, manifest.commitment), 'commitment_mismatch');
    demand(await call(registrar, registrarAbi, 'isAvailable', [args[0]]), 'name_unavailable');
    const [base, premium] = await call(registrar, registrarAbi, 'getRegisterPrice', [args[0], args[5], token]);
    demand(premium === 0n && base + premium <= BigInt(manifest.price.totalAtomic), 'price_changed');
    demand(await call(token, tokenAbi, 'balanceOf', [manifest.owner]) >= base + premium, 'token_balance_insufficient');
    demand(await call(token, tokenAbi, 'allowance', [manifest.owner, registrar]) >= base + premium, 'token_allowance_insufficient');
  }
  return {
    state,
    async connect() {
      await rpc('eth_requestAccounts');
      if (BigInt(await rpc('eth_chainId')) !== 11155111n) await rpc('wallet_switchEthereumChain', [{ chainId: '0xaa36a7' }]);
      await account();
    },
    async check(action) { await account(); return receipt(action); },
    async execute(action) {
      demand(!busy && !state.unknown, 'unknown_or_busy_do_not_resend');
      demand(!state.steps[action]?.hash && !state.steps[action]?.started, 'already_submitted_do_not_resend');
      const index = manifest.steps.findIndex(step => step.action === action);
      demand(index >= 0, 'unknown_action');
      busy = true;
      try {
        await account();
        await validateLivePlan();
        for (const prior of manifest.steps.slice(0, index)) {
          if (prior.transaction) demand(await receipt(prior.action), 'prior_transaction_pending');
          else await commitmentReady();
        }
        const step = manifest.steps[index];
        if (!step.transaction) { await commitmentReady(); state.steps[action] = { confirmed: true }; await persist(); return { waitCompleted: true }; }
        const pin = action === 'test_token_mint' || action.includes('allowance') || action === 'approve_exact_token_amount' ? manifest.pins.MockUSDC : manifest.pins.ETHRegistrar;
        demand(same(keccak256(await rpc('eth_getCode', [pin.address, 'latest'])), pin.codeHash), 'target_runtime_changed');
        if (action === 'register_parent') await preRegister(step);
        const estimatedGas = BigInt(await rpc('eth_estimateGas', [step.transaction]));
        demand(estimatedGas > 0n && estimatedGas <= 2000000n, 'gas_limit_exceeded');
        const tx = { ...step.transaction, gas: `0x${((estimatedGas * 125n + 99n) / 100n).toString(16)}` };
        state.steps[action] = { started: true };
        await persist();
        let hash;
        try { hash = await rpc('eth_sendTransaction', [tx]); }
        catch (error) {
          if (error?.code === 4001) { state.steps[action].rejected = true; await persist(); throw new Error('user_rejected_review_before_retry'); }
          state.unknown = true; await persist(); throw new Error('submission_unknown_do_not_resend');
        }
        demand(/^0x[0-9a-fA-F]{64}$/.test(hash), 'submission_unknown_do_not_resend');
        state.steps[action].hash = hash;
        await persist();
        return { hash, action };
      } finally { busy = false; }
    },
    async finalize() {
      await account();
      demand(await receipt('register_parent'), 'registration_pending');
      const finalized = await rpc('eth_getBlockByNumber', ['finalized', false]);
      demand(finalized && BigInt(finalized.number) >= BigInt(state.steps.register_parent.receipt.blockNumber), 'registration_not_finalized');
      const registry = manifest.pins.ETHRegistry;
      demand(same(keccak256(await rpc('eth_getCode', [registry.address, 'latest'])), registry.codeHash), 'registry_runtime_changed');
      const label = manifest.parentName.slice(0,-4);
      const registration = await call(registry.address, registryAbi, 'getState', [BigInt(keccak256(stringToHex(label)))]);
      const registrationBlock = await rpc('eth_getBlockByNumber', [state.steps.register_parent.receipt.blockNumber, false]);
      demand(registration.status === 2 && same(registration.latestOwner,manifest.owner) && registration.expiry === BigInt(registrationBlock.timestamp)+BigInt(manifest.durationSeconds), 'parent_registration_mismatch');
      demand(same(await call(registry.address, registryAbi, 'getSubregistry', [label]), zeroAddress) && same(await call(registry.address, registryAbi, 'getResolver', [label]), zeroAddress), 'parent_pointer_mismatch');
      state.finalized = true; await persist();
      return { registeredReceiptFinalized: true, namespaceReady: false };
    },
  };
}
