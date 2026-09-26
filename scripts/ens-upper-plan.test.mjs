import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, keccak256, parseAbi, zeroAddress } from 'viem';
import { planUpperRegistry, UPPER_ROOT_ROLES } from './ens-upper-plan.mjs';
const addr=n=>`0x${n.toString(16).padStart(40,'0')}`;
const pin=n=>({address:addr(n),codeHash:keccak256('0x6000')});
function fixture(){return {chainId:11155111,owner:addr(1),parentName:'example.eth',salt:42n,predictedCode:'0x',pins:{factory:pin(2),userRegistryImplementation:pin(3),proxyLogic:pin(4),ethRegistry:pin(5)},parentSnapshot:{chainId:11155111,finalized:true,blockHash:keccak256('0x01'),blockNumber:100n,timestamp:1000n,parentName:'example.eth',registry:addr(5),status:2,owner:addr(1),expiry:2000n,subregistry:zeroAddress,resolver:zeroAddress,ownerCanSetSubregistry:true,factoryProxyLogic:addr(4)}};}
test('upper plan encodes exactly three zero-value calls and narrow initialization',()=>{
  const input=fixture(),plan=planUpperRegistry(input);
  assert.equal(plan.upper.runtime.length,156);
  assert.equal(plan.upper.codeHash,keccak256(plan.upper.runtime));
  assert.equal(plan.calls.length,3);assert.ok(plan.calls.every(call=>call.value==='0x0'));
  const factoryAbi=parseAbi(['function deployProxy(address,uint256,bytes) returns(address)']);
  const deployed=decodeFunctionData({abi:factoryAbi,data:plan.calls[0].data});
  assert.equal(deployed.args[0],addr(3));assert.equal(deployed.args[1],42n);
  const init=decodeFunctionData({abi:parseAbi(['function initialize(address,uint256)']),data:deployed.args[2]});
  assert.deepEqual(init.args,[addr(1),UPPER_ROOT_ROLES]);assert.equal(UPPER_ROOT_ROLES,65793n);
  assert.deepEqual(decodeFunctionData({abi:parseAbi(['function setParent(address,string)']),data:plan.calls[1].data}).args,[addr(5),'example']);
  assert.deepEqual(decodeFunctionData({abi:parseAbi(['function setSubregistry(uint256,address)']),data:plan.calls[2].data}).args,[BigInt(keccak256(new TextEncoder().encode('example'))),plan.upper.address]);
  assert.equal(plan.namespaceReady,false);assert.equal(plan.livePreflightRequired,true);
});
test('deterministic address separates salts and callers, not implementation or initializer',()=>{
  const input=fixture(),first=planUpperRegistry(input);
  assert.equal(planUpperRegistry(fixture()).upper.address,first.upper.address);
  assert.notEqual(planUpperRegistry({...input,salt:43n}).upper.address,first.upper.address);
  assert.notEqual(planUpperRegistry({...input,owner:addr(9),parentSnapshot:{...input.parentSnapshot,owner:addr(9)}}).upper.address,first.upper.address);
  assert.equal(planUpperRegistry({...input,pins:{...input.pins,userRegistryImplementation:pin(8)}}).upper.address,first.upper.address);
  assert.throws(()=>planUpperRegistry({...input,predictedCode:'0x6000'}),/occupied/);
  assert.throws(()=>planUpperRegistry({...input,predictedCode:undefined}),/occupied/);
});
test('invalid chain, input, finalized state, parent pointers and factory logic fail closed',()=>{
  for(const change of [{chainId:1},{owner:zeroAddress},{parentName:'Example.eth'},{parentName:'ab--cd.eth'},{salt:-1n},{salt:1n<<256n},{pins:{}}])assert.throws(()=>planUpperRegistry({...fixture(),...change}));
  for(const change of [{finalized:false},{owner:addr(9)},{expiry:1000n},{subregistry:addr(8)},{resolver:addr(8)},{ownerCanSetSubregistry:false},{factoryProxyLogic:addr(9)},{status:1},{blockHash:'0x01'}]){const input=fixture();assert.throws(()=>planUpperRegistry({...input,parentSnapshot:{...input.parentSnapshot,...change}}));}
});
