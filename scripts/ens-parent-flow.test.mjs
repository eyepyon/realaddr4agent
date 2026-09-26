import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, encodeAbiParameters, decodeFunctionData, encodeFunctionResult, keccak256, parseAbi, zeroAddress, zeroHash } from 'viem';
import { createParentFlow, validateParentManifest } from './ens-parent-flow.mjs';
const address = n => `0x${n.toString(16).padStart(40,'0')}`;
const hash = n => `0x${n.toString(16).padStart(64,'0')}`;
const owner = address(1); const registrar = address(2); const token = address(3);
const abi = parseAbi([
  'function commit(bytes32 commitment)',
  'function register(string label,address owner,bytes32 secret,address registry,address resolver,uint64 duration,address paymentToken,bytes32 referrer)',
  'function commitmentAt(bytes32 commitment) view returns (uint64)',
  'function makeCommitment(string label,address owner,bytes32 secret,address registry,address resolver,uint64 duration,bytes32 referrer) view returns (bytes32)',
  'function isAvailable(string label) view returns (bool)',
  'function getRegisterPrice(string label,uint64 duration,address token) view returns (uint256,uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
  'function MIN_COMMITMENT_AGE() view returns (uint64)',
  'function MAX_COMMITMENT_AGE() view returns (uint64)',
]);
const tx = (functionName,args) => ({ chainId:'0xaa36a7',from:owner,to:registrar,value:'0x0',data:encodeFunctionData({abi,functionName,args}) });
const commitment = keccak256(encodeAbiParameters([{type:'string'},{type:'address'},{type:'bytes32'},{type:'address'},{type:'address'},{type:'uint64'},{type:'bytes32'}],['example',owner,hash(6),zeroAddress,zeroAddress,31536000n,zeroHash]));
const manifest = { version:1,chainId:11155111,environment:'testnet',readOnly:true,parentName:'example.eth',owner,paymentToken:token,durationSeconds:'31536000',commitment,price:{decimals:6,scope:'official_ens_test_token_only',baseAtomic:'8000021',premiumAtomic:'0',totalAtomic:'8000021'},balances:{tokenAtomic:'8000021',allowanceAtomic:'8000021'},pins:{ETHRegistrar:{address:registrar,codeHash:keccak256('0x6000')},MockUSDC:{address:token,codeHash:keccak256('0x6000')}},steps:[{action:'commit_parent',transaction:tx('commit',[commitment])},{action:'wait_commitment_age',minimumSeconds:'60',maximumSeconds:'86400'},{action:'register_parent',transaction:tx('register',['example',owner,hash(6),zeroAddress,zeroAddress,31536000n,token,zeroHash])}] };
function provider(options = {}) {
  let sends = 0;
  return { get sends() { return sends; }, async request({method,params=[]}) {
    if(method==='eth_accounts'||method==='eth_requestAccounts') return [options.wrongAccount?address(9):owner];
    if(method==='eth_chainId') return options.wrongChain?'0x1':'0xaa36a7';
    if(method==='eth_getCode') return '0x6000';
    if(method==='eth_estimateGas') return '0x186a0';
    if(method==='eth_sendTransaction') { sends++; if(options.unknown) throw new Error('unknown result'); return hash(100); }
    if(method==='eth_getTransactionReceipt') return options.pending?null:{transactionHash:hash(100),from:owner,to:registrar,status:'0x1',blockNumber:'0xa',blockHash:hash(200)};
    if(method==='eth_getTransactionByHash') return {hash:hash(100),from:owner,to:registrar,input:manifest.steps[0].transaction.data,value:'0x0'};
    if(method==='eth_getBlockByNumber') return { number:'0x64',hash:hash(200),timestamp:'0xc8' };
    if(method==='eth_call') {
      const decoded=decodeFunctionData({abi,data:params[0].data});
      const values={commitmentAt:100n,makeCommitment:commitment,isAvailable:true,getRegisterPrice:[options.priceChanged?9000000n:8000021n,0n],balanceOf:8000021n,allowance:8000021n,MIN_COMMITMENT_AGE:60n,MAX_COMMITMENT_AGE:86400n};
      return encodeFunctionResult({abi,functionName:decoded.functionName,result:values[decoded.functionName]});
    }
    throw new Error('unexpected request');
  } };
}
test('manifest rejects arbitrary targets, changed owner and reordered actions',()=>{
  const changed=structuredClone(manifest); changed.steps[0].transaction.to=address(20);
  assert.throws(()=>validateParentManifest(changed));
  const wrong=structuredClone(manifest); wrong.owner=address(9); assert.throws(()=>validateParentManifest(wrong));
  const reordered=structuredClone(manifest); reordered.steps.reverse(); assert.throws(()=>validateParentManifest(reordered));
});
test('human send persists start then transaction hash and blocks duplicate submission',async()=>{
  const saves=[]; const wallet=provider(); const flow=createParentFlow({manifest,provider:wallet,save:async state=>saves.push(state)});
  await flow.execute('commit_parent');
  assert.equal(wallet.sends,1); assert.equal(saves[0].steps.commit_parent.started,true); assert.equal(saves.at(-1).steps.commit_parent.hash,hash(100));
  await assert.rejects(flow.execute('commit_parent'),/already_submitted/); assert.equal(wallet.sends,1);
});
test('uncertain submission blocks every retry and preserves unknown state',async()=>{
  const wallet=provider({unknown:true}); const flow=createParentFlow({manifest,provider:wallet,save:async()=>{}});
  await assert.rejects(flow.execute('commit_parent'),/submission_unknown/);
  assert.equal(flow.state.unknown,true); await assert.rejects(flow.execute('commit_parent'),/unknown_or_busy/); assert.equal(wallet.sends,1);
});
test('wrong wallet or chain cannot request a signature',async()=>{
  for(const options of [{wrongAccount:true},{wrongChain:true}]) {
    const wallet=provider(options); const flow=createParentFlow({manifest,provider:wallet,save:async()=>{}});
    await assert.rejects(flow.execute('commit_parent')); assert.equal(wallet.sends,0);
  }
});
test('register refuses pending commit and quote above frozen exact allowance',async()=>{
  for(const options of [{pending:true},{priceChanged:true}]) {
    const wallet=provider(options); const state={steps:{commit_parent:{started:true,hash:hash(100)}},unknown:false};
    const flow=createParentFlow({manifest,provider:wallet,state,save:async()=>{}});
    await assert.rejects(flow.execute('register_parent')); assert.equal(wallet.sends,0);
  }
});
test('failed hash persistence blocks advancement and resend',async()=>{
  let count=0; const wallet=provider(); const flow=createParentFlow({manifest,provider:wallet,save:async()=>{if(++count===2)throw new Error('disk failure');}});
  await assert.rejects(flow.execute('commit_parent'),/persistence_failed/); assert.equal(flow.state.unknown,true); assert.equal(wallet.sends,1);
  await assert.rejects(flow.execute('commit_parent')); assert.equal(wallet.sends,1);
});
