import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionResult, keccak256, parseAbi, zeroAddress } from 'viem';
import { createUpperFlow, validateUpperManifest } from './ens-upper-flow.mjs';
import { planUpperRegistry, UPPER_ROOT_ROLES } from './ens-upper-plan.mjs';
const address=n=>`0x${n.toString(16).padStart(40,'0')}`;
const hash=n=>`0x${n.toString(16).padStart(64,'0')}`;
const pin=n=>({address:address(n),codeHash:keccak256('0x6000')});
const owner=address(1),pins={factory:pin(2),userRegistryImplementation:pin(3),proxyLogic:pin(4),ethRegistry:pin(5)};
const manifest=planUpperRegistry({chainId:11155111,owner,parentName:'example.eth',salt:42n,pins,predictedCode:'0x',parentSnapshot:{chainId:11155111,finalized:true,blockHash:hash(100),blockNumber:10n,timestamp:100n,parentName:'example.eth',registry:pins.ethRegistry.address,status:2,owner,expiry:2000n,subregistry:zeroAddress,resolver:zeroAddress,ownerCanSetSubregistry:true,factoryProxyLogic:pins.proxyLogic.address}});
const readAbi=parseAbi(['function getState(uint256) view returns ((uint8 status,uint64 expiry,address latestOwner,uint256 tokenId,uint256 resource))','function getSubregistry(string) view returns(address)','function getResolver(string) view returns(address)','function getParent() view returns(address,string)','function roles(uint256,address) view returns(uint256)','function roleCount(uint256) view returns(uint256)','function hasRoles(uint256,uint256,address) view returns(bool)','function proxyLogic() view returns(address)','function verifyContract(address) view returns(address)']);
function provider(options={}) {
  const transactions=[];
  const phaseAt=at=>transactions.filter((_,index)=>11+index<=Number(BigInt(at))).length;
  return {get sends(){return transactions.length;},async request({method,params=[]}){
    if(method==='eth_requestAccounts'||method==='eth_accounts')return [options.wrongAccount?address(99):owner];
    if(method==='eth_chainId')return options.wrongChain?'0x1':'0xaa36a7';
    if(method==='eth_getBlockByNumber') {const number=params[0]==='latest'?'0x14':params[0]==='finalized'?(options.unfinalized?'0xa':'0x14'):params[0];return{number,hash:options.reorg?hash(999):hash(100+Number(BigInt(number))),timestamp:'0x64'};}
    if(method==='eth_getCode'){if(params[0]===manifest.upper.address)return phaseAt(params[1])?manifest.upper.runtime:'0x';return options.wrongCode?'0x6001':'0x6000';}
    if(method==='eth_call') {
      if(params[0].from)return'0x';
      const decoded=decodeFunctionData({abi:readAbi,data:params[0].data}),phase=phaseAt(params[1]);
      const values={getState:{status:2,expiry:options.wrongExpiry?2001n:2000n,latestOwner:options.wrongOwner?address(99):owner,tokenId:42n,resource:42n},getSubregistry:phase>=3?manifest.upper.address:zeroAddress,getResolver:zeroAddress,hasRoles:!options.missingRole,proxyLogic:pins.proxyLogic.address,verifyContract:options.wrongImplementation?address(99):pins.userRegistryImplementation.address,roles:UPPER_ROOT_ROLES,roleCount:options.extraRole?UPPER_ROOT_ROLES|(1n<<124n):UPPER_ROOT_ROLES,getParent:[phase>=2?pins.ethRegistry.address:zeroAddress,phase>=2?'example':'']};
      return encodeFunctionResult({abi:readAbi,functionName:decoded.functionName,result:values[decoded.functionName]});
    }
    if(method==='eth_estimateGas')return'0x186a0';
    if(method==='eth_sendTransaction'){if(options.rejected){const error=new Error('user rejected');error.code=4001;throw error;}if(options.unknown){transactions.push(params[0]);throw new Error('unknown result');}transactions.push(params[0]);return hash(transactions.length);}
    if(method==='eth_getTransactionReceipt'){
      if(options.pending)return null;const index=Number(BigInt(params[0]))-1,transaction=transactions[index],number=`0x${(11+index).toString(16)}`;
      if(!transaction)return null;
      return{transactionHash:params[0],from:owner,to:transaction.to,status:'0x1',blockNumber:number,blockHash:hash(111+index)};
    }
    if(method==='eth_getTransactionByHash'){const index=Number(BigInt(params[0]))-1,transaction=transactions[index];return{hash:params[0],from:owner,to:transaction.to,input:options.wrongData?'0x12345678':transaction.data,value:'0x0',chainId:'0xaa36a7',blockNumber:`0x${(11+index).toString(16)}`,blockHash:hash(111+index)};}
    throw new Error(`unexpected_${method}`);
  }};
}
test('upper manifest rejects changed call, salt, derived runtime, role grant or order',()=>{
  assert.equal(validateUpperManifest(manifest),true);
  for(const mutate of [m=>m.calls[0].data+='00',m=>m.calls[0].to=address(99),m=>m.calls[1].value='0x1',m=>m.calls.reverse(),m=>m.salt='43',m=>m.upper.runtime='0x6000',m=>m.expectedPostconditions.upperRootRoles='1']){const changed=structuredClone(manifest);mutate(changed);assert.throws(()=>validateUpperManifest(changed));}
});
test('three human calls persist start/hash and verify finalized exact hierarchy without namespace readiness',async()=>{
  const wallet=provider(),saves=[],flow=createUpperFlow({manifest,provider:wallet,save:async state=>saves.push(state)});
  await flow.connect();
  for(const call of manifest.calls){await flow.execute(call.action);await flow.verify();}
  assert.equal(wallet.sends,3);assert.equal(saves[0].steps.deploy_upper.started,true);assert.equal(saves[1].steps.deploy_upper.hash,hash(1));
  assert.deepEqual(await flow.verify(),{upperConnected:true,namespaceReady:false,completedSteps:3,receiptFinalized:true});assert.equal(flow.state.finalized,true);
  await assert.rejects(flow.execute('deploy_upper'),/already_submitted/);assert.equal(wallet.sends,3);
});
test('wrong wallet, chain, pinned code, owner, expiry and root permission cannot send',async()=>{
  for(const options of [{wrongAccount:true},{wrongChain:true},{wrongCode:true},{wrongOwner:true},{wrongExpiry:true},{missingRole:true}]){const wallet=provider(options),flow=createUpperFlow({manifest,provider:wallet,save:async()=>{}});await assert.rejects(flow.execute('deploy_upper'));assert.equal(wallet.sends,0);}
});
test('later action requires prior receipt and finality, and implementation/extra roles cannot advance',async()=>{
  for(const options of [{pending:true},{unfinalized:true},{wrongImplementation:true},{extraRole:true}]){const wallet=provider(options),flow=createUpperFlow({manifest,provider:wallet,save:async()=>{}});await flow.execute('deploy_upper');await assert.rejects(flow.execute('set_upper_parent'));assert.equal(wallet.sends,1);}
});
test('unknown send or persistence failure permanently blocks resend in current state',async()=>{
  for(const options of [{unknown:true},{}]){const wallet=provider(options);let saves=0;const flow=createUpperFlow({manifest,provider:wallet,save:async()=>{if(!options.unknown&&++saves===2)throw new Error('disk unavailable');}});await assert.rejects(flow.execute('deploy_upper'),/unknown|persistence_failed/);assert.equal(flow.state.unknown,true);await assert.rejects(flow.execute('deploy_upper'),/unknown_or_busy/);assert.equal(wallet.sends,1);}
});
test('canonical receipt and exact calldata are required, pending finality remains explicit',async()=>{
  const options={},wallet=provider(options),flow=createUpperFlow({manifest,provider:wallet,save:async()=>{}});await flow.execute('deploy_upper');
  options.wrongData=true;await assert.rejects(flow.verify(),/transaction_mismatch/);options.wrongData=false;options.reorg=true;await assert.rejects(flow.verify(),/noncanonical/);options.reorg=false;options.unfinalized=true;
  const pending=await flow.verify();assert.equal(pending.upperConnected,false);assert.equal(pending.namespaceReady,false);assert.equal(pending.pendingAction,'deploy_upper');assert.equal(pending.receiptFinalized,false);assert.equal(pending.receiptConfirmed,true);assert.equal(pending.receiptBlockNumber,'11');assert.equal(pending.receiptBlockTime,'1970-01-01T00:01:40.000Z');assert.equal(pending.finalizedBlockNumber,'10');assert.equal(pending.latestBlockNumber,'20');assert.equal(pending.latestFinalizedLagBlocks,'10');assert.equal(pending.receiptFinalizedGapBlocks,'1');assert.ok(Number.isFinite(Date.parse(pending.checkedAt)));assert.equal(wallet.sends,1);
});
test('only explicit definite rejection without a hash permits a persisted human reset',async()=>{
  const options={rejected:true},wallet=provider(options),saves=[],flow=createUpperFlow({manifest,provider:wallet,save:async state=>saves.push(state)});
  await assert.rejects(flow.execute('deploy_upper'),/user_rejected/);assert.equal(flow.state.steps.deploy_upper.rejected,true);assert.equal(wallet.sends,0);
  await assert.rejects(flow.execute('deploy_upper'),/already_submitted/);
  assert.deepEqual(await flow.resetRejected('deploy_upper'),{rejectedStepReset:'deploy_upper',namespaceReady:false});assert.equal(saves.at(-1).steps.deploy_upper,undefined);
  options.rejected=false;await flow.execute('deploy_upper');assert.equal(wallet.sends,1);
  await assert.rejects(flow.resetRejected('deploy_upper'),/only_definite_rejection/);
  flow.state.unknown=true;await assert.rejects(flow.resetRejected('deploy_upper'),/unknown_or_busy/);
});
test('final connected state rejects extra root roles and changed implementation on every verification',async()=>{
  const options={},wallet=provider(options),flow=createUpperFlow({manifest,provider:wallet,save:async()=>{}});
  for(const call of manifest.calls)await flow.execute(call.action);assert.equal((await flow.verify()).upperConnected,true);
  options.extraRole=true;await assert.rejects(flow.verify(),/roles_mismatch/);options.extraRole=false;options.wrongImplementation=true;await assert.rejects(flow.verify(),/roles_mismatch/);
});

test('pending diagnostic evidence never promotes a saved receipt missing from the fresh RPC response',async()=>{
 const options={unfinalized:true},wallet=provider(options),flow=createUpperFlow({manifest,provider:wallet,save:async()=>{}});await flow.execute('deploy_upper');
 assert.equal((await flow.verify()).receiptConfirmed,true);assert.equal(flow.state.steps.deploy_upper.confirmed,true);assert.ok(flow.state.steps.deploy_upper.receipt);
 options.pending=true;const pending=await flow.verify();assert.equal(pending.receiptConfirmed,false);assert.equal(pending.receiptFinalized,false);assert.equal(pending.receiptBlockNumber,undefined);assert.equal(pending.receiptBlockTime,undefined);assert.equal(pending.receiptFinalizedGapBlocks,undefined);assert.equal(pending.finalizedBlockNumber,'10');assert.equal(pending.latestBlockNumber,'20');assert.equal(wallet.sends,1);
 await assert.rejects(flow.execute('set_upper_parent'),/prior_transaction_not_finalized/);assert.equal(wallet.sends,1);
});
