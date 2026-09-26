import test from 'node:test';
import assert from 'node:assert/strict';
import { concatHex, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, encodeFunctionResult, keccak256, namehash, parseAbi, stringToHex, zeroAddress, zeroHash } from 'viem';
import { createLocationFlow, validateLocationManifest } from './ens-location-flow.mjs';
import { LOCATION_ADMIN_ROLES, LOCATION_CONTROLLER_ROLES } from './ens-location-plan.mjs';
import { UPPER_ROOT_ROLES } from './ens-upper-plan.mjs';
import { makeLocationFixture } from './ens-location.test-fixture.mjs';
const abi=parseAbi(['function getState(uint256) view returns ((uint8 status,uint64 expiry,address latestOwner,uint256 tokenId,uint256 resource))','function getSubregistry(string) view returns(address)','function getResolver(string) view returns(address)','function getParent() view returns(address,string)','function roles(uint256,address) view returns(uint256)','function roleCount(uint256) view returns(uint256)','function proxyLogic() view returns(address)','function verifyContract(address) view returns(address)','function LEASE_REGISTRY() view returns(address)','function ETH_REGISTRY() view returns(address)','function UPPER_REGISTRY() view returns(address)','function RESOLVER_FACTORY() view returns(address)','function RESOLVER_IMPLEMENTATION() view returns(address)','function NAMESPACE_OWNER() view returns(address)','function PARENT_NODE() view returns(bytes32)','function parentLabel() view returns(string)','function PUBLISHER_ROLE() view returns(bytes32)','function DEFAULT_ADMIN_ROLE() view returns(bytes32)','function hasRole(bytes32,address) view returns(bool)','function paused() view returns(bool)','function getNamespace(bytes32) view returns(string,address,bytes32)','event NamespaceConfigured(bytes32 indexed buildingKey,string slug,address registry)']);
const hex=n=>`0x${BigInt(n).toString(16)}`,hash=n=>`0x${BigInt(n).toString(16).padStart(64,'0')}`;
function setup(options={}){
  const {manifest:m}=makeLocationFixture(),p=m.pins,calls=[],saved=[],state={steps:{},unknown:false},transactions=new Map(),receipts=new Map();let current=100n,finalized=100n;
  const phaseAt=at=>Math.max(0,Math.min(5,Number(BigInt(at)-100n))),topic=encodeEventTopics({abi,eventName:'NamespaceConfigured',args:{buildingKey:m.buildingKey}}),event={address:p.nameController.address,topics:topic,data:encodeAbiParameters([{type:'string'},{type:'address'}],[m.locationSlug,m.location.address]),blockNumber:'0x69',blockHash:hash(105),transactionHash:hash(1005),logIndex:'0x0'};
  const provider={async request({method,params=[]}){
    calls.push({method,params});
    if(method==='eth_chainId')return'0xaa36a7';if(method==='eth_accounts'||method==='eth_requestAccounts')return[m.owner];
    if(method==='eth_getBlockByNumber'){const number=params[0]==='latest'?current:params[0]==='finalized'?(options.badOrder?current+1n:finalized):BigInt(params[0]);return{number:hex(number),hash:options.reorg&&number===101n?zeroHash:hash(number),timestamp:'0x3e8'};}
    if(method==='eth_getCode'){if(options.policy&&params[0].toLowerCase()===m.owner.toLowerCase())return`0xef0100${options.policy.delegator.address.slice(2)}`;if(params[0].toLowerCase()===m.location.address.toLowerCase())return phaseAt(params[1])>=1?(options.badRuntime?'0x6000':m.location.runtime):'0x';return'0x6000';}
    if(method==='eth_estimateGas')return'0x100000';
    if(method==='eth_sendTransaction'){if(options.rejected)throw Object.assign(new Error('rejected'),{code:4001});if(options.unknown)throw new Error('network');current++;if(!options.pending)finalized=current;const index=Number(current-101n),txHash=hash(1001+index),expected=m.calls[index];transactions.set(txHash,{hash:txHash,from:m.owner,to:expected.to,input:expected.data,value:'0x0',chainId:'0xaa36a7',blockNumber:hex(current),blockHash:hash(current),type:'0x2'});receipts.set(txHash,{transactionHash:txHash,from:m.owner,to:expected.to,status:'0x1',blockNumber:hex(current),blockHash:hash(current),logs:index===4?[event]:[]});return txHash;}
    if(method==='eth_getTransactionReceipt')return options.noReceipt?null:receipts.get(params[0]);
    if(method==='eth_getTransactionByHash')return transactions.get(params[0]);
    if(method==='eth_getLogs'){const filter=params[0];return options.extraHistory?[{...event,blockNumber:hex(100),blockHash:hash(100)}]:BigInt(filter.fromBlock)<=105n&&BigInt(filter.toBlock)>=105n&&current>=105n?[event]:[];}
    if(method==='eth_call'){
      if(params[0].from)return'0x';const phase=phaseAt(params[1]),to=params[0].to.toLowerCase(),decoded=decodeFunctionData({abi,data:params[0].data}),name=decoded.functionName,args=decoded.args??[],isUpper=to===p.upperRegistry.address.toLowerCase(),isLocation=to===m.location.address.toLowerCase();let value;
      if(name==='getState')value=to===p.ethRegistry.address.toLowerCase()?{status:2,expiry:2000n,latestOwner:m.owner,tokenId:1n,resource:1n}:{status:phase>=4?2:0,expiry:phase>=4?2000n:0n,latestOwner:phase>=4?m.owner:zeroAddress,tokenId:phase>=4?2n:0n,resource:phase>=4?2n:0n};
      else if(name==='getSubregistry')value=to===p.ethRegistry.address.toLowerCase()?p.upperRegistry.address:phase>=4?m.location.address:zeroAddress;
      else if(name==='getResolver')value=zeroAddress;
      else if(name==='getParent')value=isUpper?[p.ethRegistry.address,'example']:[phase>=2?p.upperRegistry.address:zeroAddress,phase>=2?m.locationSlug:''];
      else if(name==='roles')value=isUpper?(args[0]===0n?UPPER_ROOT_ROLES:0n):args[1].toLowerCase()===m.owner.toLowerCase()?LOCATION_ADMIN_ROLES:phase>=3?LOCATION_CONTROLLER_ROLES:0n;
      else if(name==='roleCount')value=isUpper?UPPER_ROOT_ROLES:LOCATION_ADMIN_ROLES|(phase>=3?LOCATION_CONTROLLER_ROLES:0n);
      else if(name==='proxyLogic')value=p.proxyLogic.address;
      else if(name==='verifyContract')value=p.userRegistryImplementation.address;
      else if(name==='getNamespace')value=phase>=5?[m.locationSlug,m.location.address,namehash(`${m.locationSlug}.${m.parentName}`)]:['',zeroAddress,zeroHash];
      else value={LEASE_REGISTRY:p.leaseRegistry.address,ETH_REGISTRY:p.ethRegistry.address,UPPER_REGISTRY:p.upperRegistry.address,RESOLVER_FACTORY:p.factory.address,RESOLVER_IMPLEMENTATION:p.resolverImplementation.address,NAMESPACE_OWNER:m.owner,PARENT_NODE:namehash(m.parentName),parentLabel:'example',PUBLISHER_ROLE:keccak256(stringToHex('PUBLISHER_ROLE')),DEFAULT_ADMIN_ROLE:zeroHash,hasRole:true,paused:false}[name];
      if(options.badRoles&&isLocation&&name==='roles')value=1n;if(options.badCount&&isLocation&&name==='roleCount')value|=1n<<124n;if(options.badOwner&&name==='getState'&&to===p.ethRegistry.address.toLowerCase())value.latestOwner=zeroAddress;if(options.badGetter&&name==='NAMESPACE_OWNER')value=zeroAddress;
      return encodeFunctionResult({abi,functionName:name,result:value});
    }
    throw new Error(`unexpected fixture request ${method}`);
  }};
  const flow=createLocationFlow({manifest:m,provider,state,wrapperPolicy:options.policy,save:async value=>{saved.push(value);if(options.saveFailure||saved.length===options.saveFailureAt)throw new Error('disk');}});
  return{flow,m,calls,saved,state,options,transactions,receipts,event,finalize:()=>{finalized=current;options.pending=false;},async first(){return flow.execute(m.calls[0].action);},async all(){for(const call of m.calls)await flow.execute(call.action);return flow.verify();}};
}
test('manifest reconstructs exact five calls, runtime and role postconditions',()=>{
  assert.equal(validateLocationManifest(makeLocationFixture().manifest),true);
  for(const change of [m=>m.calls[1].data+='00',m=>m.calls[0].value='0x1',m=>m.calls.reverse(),m=>m.location.runtime='0x6000',m=>m.expectedPostconditions.controllerRootRoles='1',m=>m.evidence.controllerLogsThroughBlock='99',m=>m.evidence.controllerDeploymentBlock='101',m=>m.pins.nameController=m.pins.upperRegistry]){const m=makeLocationFixture().manifest;change(m);assert.throws(()=>validateLocationManifest(m));}
});
test('five ordered finalized receipts connect location but do not enable namespace sale',async()=>{
  const f=setup();await f.flow.connect();await assert.rejects(f.flow.execute(f.m.calls[1].action),/prior_transaction_not_finalized/);const result=await f.all();assert.equal(result.locationConnected,true);assert.equal(result.completedSteps,5);assert.equal(result.receiptFinalized,true);assert.equal(result.namespaceReady,false);assert.equal(f.state.finalized,true);assert.equal(f.calls.filter(call=>call.method==='eth_sendTransaction').length,5);assert.deepEqual(f.saved[0].steps.deploy_location,{started:true});await assert.rejects(f.first(),/already_submitted/);
});
test('pending receipt and finality diagnostics stop next operation',async()=>{
  const f=setup({pending:true});await f.first();let result=await f.flow.verify();assert.equal(result.pendingAction,'deploy_location');assert.equal(result.receiptConfirmed,true);assert.equal(result.receiptFinalized,false);assert.equal(result.receiptFinalizedGapBlocks,'1');await assert.rejects(f.flow.execute(f.m.calls[1].action),/prior_transaction_not_finalized/);f.finalize();result=await f.flow.verify();assert.equal(result.completedSteps,1);assert.equal(result.locationConnected,false);
  f.options.noReceipt=true;result=await f.flow.verify();assert.equal(result.receiptConfirmed,false);assert.equal(result.receiptFinalized,false);assert.ok(result.checkedAt);
});
test('definite rejection can be explicitly reset; unknown and persistence failure never resend',async()=>{
  const rejected=setup({rejected:true});await assert.rejects(rejected.first(),/user_rejected/);await assert.rejects(rejected.first(),/already_submitted/);await rejected.flow.resetRejected('deploy_location');assert.deepEqual(rejected.state.steps,{});
  const unknown=setup({unknown:true});await assert.rejects(unknown.first(),/submission_unknown/);await assert.rejects(unknown.first(),/unknown_or_busy/);await assert.rejects(unknown.flow.resetRejected('deploy_location'),/unknown_or_busy/);
  const disk=setup({saveFailure:true});await assert.rejects(disk.first(),/persistence_failed/);assert.equal(disk.calls.some(call=>call.method==='eth_sendTransaction'),false);
  const sent=setup({saveFailureAt:2});await assert.rejects(sent.first(),/persistence_failed/);assert.ok(sent.state.steps.deploy_location.hash);assert.equal(sent.state.unknown,true);await assert.rejects(sent.first(),/unknown_or_busy/);assert.equal(sent.calls.filter(call=>call.method==='eth_sendTransaction').length,1);
});
test('preflight refuses altered controller, hierarchy and non-pristine history',async()=>{
  for(const options of [{badOwner:true},{badGetter:true},{extraHistory:true},{badOrder:true}]){const f=setup(options);await assert.rejects(f.first());assert.equal(f.calls.some(call=>call.method==='eth_sendTransaction'),false);}
});
test('canonical receipt runtime roles and exact transaction are mandatory',async()=>{
  for(const flag of ['badRoles','badCount','badRuntime','reorg']){const f=setup();await f.first();f.options[flag]=true;await assert.rejects(f.flow.verify());assert.notEqual(f.state.finalized,true);}
  for(const change of [tx=>tx.input+='00',tx=>tx.to=zeroAddress,tx=>tx.chainId='0x1',tx=>tx.from=zeroAddress]){const f=setup();await f.first();change(f.transactions.values().next().value);await assert.rejects(f.flow.verify());}
});
function registrationWrapper(f,policy,{wrongToken=false,wrongRegistry=false,extraExecution=false}={}){
  const expected=f.m.calls[3],owner=f.m.owner,contextType=[{type:'tuple[]',components:[{name:'delegate',type:'address'},{name:'delegator',type:'address'},{name:'authority',type:'bytes32'},{name:'caveats',type:'tuple[]',components:[{name:'enforcer',type:'address'},{name:'terms',type:'bytes'},{name:'args',type:'bytes'}]},{name:'salt',type:'uint256'},{name:'signature',type:'bytes'}]}];
  const caveats=[{enforcer:policy.native.address,terms:concatHex(['0x01',owner,zeroHash]),args:'0x'},{enforcer:policy.erc1155.address,terms:concatHex(['0x00',wrongRegistry?f.m.pins.ethRegistry.address:f.m.pins.upperRegistry.address,owner,hash(wrongToken?99:2),hash(1)]),args:'0x'}],delegation={delegate:owner,delegator:owner,authority:`0x${'f'.repeat(64)}`,caveats,salt:1n,signature:`0x${'11'.repeat(65)}`};
  const context=encodeAbiParameters(contextType,[[delegation]]),execution=concatHex([expected.to,zeroHash,expected.data]),input=encodeFunctionData({abi:parseAbi(['function redeemDelegations(bytes[],bytes32[],bytes[])']),functionName:'redeemDelegations',args:[[context],[zeroHash],extraExecution?[execution,execution]:[execution]]});
  return{input,to:policy.manager.address};
}
test('register location supports existing v2 ERC1155 guard only for exact upper token mint',async()=>{
  const pin=n=>({address:`0x${n.toString(16).padStart(40,'0')}`,codeHash:keccak256('0x6000')}),policy={version:2,chainId:11155111,manager:pin(20),delegator:pin(21),native:pin(22),erc20:pin(23),erc1155:pin(24)};
  for(const options of [{},{wrongToken:true},{wrongRegistry:true},{extraExecution:true}]){
    const f=setup({policy});for(const call of f.m.calls.slice(0,4))await f.flow.execute(call.action);const txHash=hash(1004),wrapped=registrationWrapper(f,policy,options);Object.assign(f.transactions.get(txHash),wrapped);f.receipts.get(txHash).to=wrapped.to;
    if(Object.keys(options).length===0){assert.equal((await f.flow.verify()).completedSteps,4);await f.flow.execute(f.m.calls[4].action);assert.equal((await f.flow.verify()).locationConnected,true);}else await assert.rejects(f.flow.verify());
  }
});
