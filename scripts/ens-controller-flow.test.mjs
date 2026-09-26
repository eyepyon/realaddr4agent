import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionResult, getContractAddress, keccak256, parseAbi, stringToHex, zeroAddress, zeroHash } from 'viem';
import { createControllerDeployFlow } from './ens-controller-flow.mjs';
import { makeControllerFixture } from './ens-controller.test-fixture.mjs';
const abi=parseAbi(['function getState(uint256) view returns ((uint8 status,uint64 expiry,address latestOwner,uint256 tokenId,uint256 resource))','function getSubregistry(string) view returns(address)','function getResolver(string) view returns(address)','function getParent() view returns(address,string)','function roles(uint256,address) view returns(uint256)','function roleCount(uint256) view returns(uint256)','function proxyLogic() view returns(address)','function verifyContract(address) view returns(address)','function LEASE_REGISTRY() view returns(address)','function ETH_REGISTRY() view returns(address)','function UPPER_REGISTRY() view returns(address)','function RESOLVER_FACTORY() view returns(address)','function RESOLVER_IMPLEMENTATION() view returns(address)','function NAMESPACE_OWNER() view returns(address)','function PARENT_NODE() view returns(bytes32)','function parentLabel() view returns(string)','function PUBLISHER_ROLE() view returns(bytes32)','function DEFAULT_ADMIN_ROLE() view returns(bytes32)','function hasRole(bytes32,address) view returns(bool)','function paused() view returns(bool)']);
function setup(options={}){
  const {manifest:m}=makeControllerFixture(),hash=`0x${'33'.repeat(32)}`,blockHash=`0x${'44'.repeat(32)}`,address=getContractAddress({from:m.owner,nonce:7n});
  const ownerTopic=`0x${m.owner.slice(2).padStart(64,'0')}`,publisher=keccak256(stringToHex('PUBLISHER_ROLE')),topic=keccak256(stringToHex('RoleGranted(bytes32,address,address)'));
  const tx={hash,from:m.owner,to:null,input:m.transaction.data,value:'0x0',chainId:'0xaa36a7',nonce:'0x7',type:'0x2',blockNumber:'0xb',blockHash};
  const receipt={transactionHash:hash,from:m.owner,to:null,contractAddress:address,status:'0x1',blockNumber:'0xb',blockHash,logs:[zeroHash,publisher].map(role=>({address,topics:[topic,role,ownerTopic,ownerTopic],data:'0x'}))};
  const calls=[],saved=[],state=options.state??{steps:{},unknown:false};let finalNumber=options.pending?'0xa':'0x14';
  const provider={async request({method,params=[]}){
    calls.push({method,params});
    if(method==='eth_chainId')return'0xaa36a7';if(method==='eth_accounts'||method==='eth_requestAccounts')return[m.owner];
    if(method==='eth_getBlockByNumber'){const number=params[0]==='latest'?'0x14':params[0]==='finalized'?(options.badOrder?'0x15':finalNumber):params[0];return{number,hash:(options.reorg&&number==='0xb')||(options.snapshotReorg&&!['latest','finalized'].includes(params[0])&&number==='0x14')?zeroHash:blockHash,timestamp:'0x64'};}
    if(method==='eth_getCode')return params[0].toLowerCase()===address.toLowerCase()?(options.badRuntime?'0x6000':m.expectedRuntime):'0x6000';
    if(method==='eth_estimateGas')return'0x100000';
    if(method==='eth_sendTransaction'){if(options.rejected)throw Object.assign(new Error('rejected'),{code:4001});if(options.unknown)throw new Error('network');return hash;}
    if(method==='eth_getTransactionReceipt')return options.noReceipt?null:receipt;
    if(method==='eth_getTransactionByHash')return tx;
    if(method==='eth_call'){
      if(!params[0].to)return options.badSimulation?'0x6000':m.expectedRuntime;
      const decoded=decodeFunctionData({abi,data:params[0].data}),name=decoded.functionName;
      const values={getState:{status:2,expiry:BigInt(m.evidence.parentExpiry),latestOwner:m.owner,tokenId:1n,resource:1n},getSubregistry:m.pins.upperRegistry.address,getResolver:zeroAddress,getParent:[m.pins.ethRegistry.address,m.parentLabel],roles:options.badRoles?1n:65793n,roleCount:65793n,proxyLogic:m.pins.proxyLogic.address,verifyContract:m.pins.userRegistryImplementation.address,parentLabel:m.parentLabel,PUBLISHER_ROLE:publisher,DEFAULT_ADMIN_ROLE:zeroHash,hasRole:true,paused:false};
      for(const [key,value]of Object.entries(m.immutableValues))values[key]=key==='PARENT_NODE'?value:`0x${value.slice(-40)}`;
      if(options.badGetter)values.LEASE_REGISTRY=zeroAddress;if(options.paused)values.paused=true;
      return encodeFunctionResult({abi,functionName:name,result:values[name]});
    }
    throw new Error(`unexpected fixture request ${method}`);
  }};
  const flow=createControllerDeployFlow({manifest:m,provider,state,save:async value=>{saved.push(value);if(options.saveFailure)throw new Error('disk');}});
  return{flow,m,hash,address,tx,receipt,calls,saved,state,finalize:()=>{finalNumber='0x14';}};
}
test('direct CREATE saves guard then hash and verifies canonical finalized deployment',async()=>{
  const f=setup();await f.flow.connect();await f.flow.execute('deploy_controller');
  assert.deepEqual(f.saved[0].steps.deploy_controller,{started:true});assert.equal(f.saved[1].steps.deploy_controller.hash,f.hash);
  const sent=f.calls.find(call=>call.method==='eth_sendTransaction').params[0];assert.equal(sent.to,undefined);assert.equal(sent.value,'0x0');
  const result=await f.flow.verify();assert.equal(result.controllerDeployed,true);assert.equal(result.receiptFinalized,true);assert.equal(result.contractAddress,f.address);assert.equal(result.namespaceReady,false);assert.equal(result.transactionHash,f.hash);assert.equal(result.receiptBlockNumber,'11');assert.ok(result.checkedAt);assert.equal(f.state.finalized,true);
  await assert.rejects(f.flow.send(),/already_submitted/);
});
test('pending finality exposes fresh diagnostics and later finalizes',async()=>{
  const f=setup({pending:true});await f.flow.send();const result=await f.flow.verify();assert.equal(result.controllerDeployed,false);assert.equal(result.receiptConfirmed,true);assert.equal(result.receiptFinalized,false);assert.equal(result.pendingAction,'deploy_controller');assert.equal(result.receiptFinalizedGapBlocks,'1');f.finalize();assert.equal((await f.flow.verify()).controllerDeployed,true);
});
test('missing receipt never promotes previously stored confirmation',async()=>{
  const f=setup({noReceipt:true});await f.flow.send();f.state.steps.deploy_controller.confirmed=true;f.state.steps.deploy_controller.finalized=true;const result=await f.flow.verify();assert.equal(result.receiptConfirmed,false);assert.equal(result.receiptFinalized,false);assert.equal(result.controllerDeployed,false);assert.equal(result.latestBlockNumber,'20');
});
test('pending and confirmed diagnostics reject reordered or noncanonical snapshots',async()=>{
  for(const noReceipt of [true,false])for(const flag of ['badOrder','snapshotReorg']){const options={noReceipt},f=setup(options);await f.flow.send();options[flag]=true;await assert.rejects(f.flow.verify(),/invalid_block_order|block_noncanonical/);assert.notEqual(f.state.finalized,true);}
});
test('only definite wallet rejection permits explicit reset and a new prompt',async()=>{
  const f=setup({rejected:true});await assert.rejects(f.flow.send(),/user_rejected/);await assert.rejects(f.flow.send(),/already_submitted/);await f.flow.resetRejected('deploy_controller');assert.deepEqual(f.state.steps,{});await assert.rejects(f.flow.send(),/user_rejected/);
  const u=setup({unknown:true});await assert.rejects(u.flow.send(),/submission_unknown/);assert.equal(u.state.unknown,true);await assert.rejects(u.flow.resetRejected(),/unknown_or_busy/);await assert.rejects(u.flow.send(),/unknown_or_busy/);
});
test('persistence failure before prompt prevents broadcast',async()=>{
  const f=setup({saveFailure:true});await assert.rejects(f.flow.send(),/persistence_failed/);assert.equal(f.calls.some(call=>call.method==='eth_sendTransaction'),false);assert.equal(f.state.unknown,true);
});
test('preflight rejects role and simulation mismatch before prompting',async()=>{
  for(const options of [{badRoles:true},{badSimulation:true}]){const f=setup(options);await assert.rejects(f.flow.send());assert.equal(f.calls.some(call=>call.method==='eth_sendTransaction'),false);}
});
test('receipt verification rejects wrappers, altered nonce, runtime, getters, grants and reorg',async()=>{
  for(const mutate of [f=>f.tx.to=f.m.owner,f=>f.tx.type='0x4',f=>f.tx.authorizationList=[{}],f=>f.tx.input+='00',f=>f.tx.nonce='0x8',f=>f.tx.chainId='0x1',f=>f.receipt.logs.pop(),f=>f.receipt.logs[0].topics[3]=zeroHash]){const f=setup();await f.flow.send();mutate(f);await assert.rejects(f.flow.verify());assert.notEqual(f.state.finalized,true);}
  for(const options of [{badRuntime:true},{badGetter:true},{paused:true},{reorg:true}]){const f=setup(options);await f.flow.send();await assert.rejects(f.flow.verify());assert.notEqual(f.state.finalized,true);}
});
