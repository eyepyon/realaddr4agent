import test from 'node:test';
import assert from 'node:assert/strict';
import { concatHex, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, keccak256, parseAbi, zeroHash } from 'viem';
import { decodeExactWrapper, verifyExactWrapper, validateWrapperPolicyUpgrade } from './ens-parent-wrapper.mjs';
const address=n=>`0x${n.toString(16).padStart(40,'0')}`;
const owner=address(1),token=address(2);
const pin=n=>({address:address(n),codeHash:keccak256('0x6000')});
const policy={version:1,chainId:11155111,manager:pin(3),delegator:pin(4),native:pin(5),erc20:pin(6)};
const policyV2={...policy,version:2,erc1155:pin(7)};
test('policy upgrade permits only additive v1 to v2 without changing existing pins',()=>{
  assert.doesNotThrow(()=>validateWrapperPolicyUpgrade(policy,policyV2));
  assert.doesNotThrow(()=>validateWrapperPolicyUpgrade(policy,{...policyV2,manager:{address:policy.manager.address.toUpperCase().replace('0X','0x'),codeHash:policy.manager.codeHash.toUpperCase().replace('0X','0x')}}));
  for(const key of ['manager','delegator','native','erc20']) {
    assert.throws(()=>validateWrapperPolicyUpgrade(policy,{...policyV2,[key]:{...policyV2[key],address:address(30)}}),/pin_changed/);
    assert.throws(()=>validateWrapperPolicyUpgrade(policy,{...policyV2,[key]:{...policyV2[key],codeHash:zeroHash}}),/pin_changed/);
  }
  assert.throws(()=>validateWrapperPolicyUpgrade(policyV2,policy),/upgrade/);
  assert.throws(()=>validateWrapperPolicyUpgrade(policy,policy),/upgrade/);
  assert.throws(()=>validateWrapperPolicyUpgrade(policy,{...policyV2,erc1155:undefined}),/invalid_wrapper_pin/);
});
const registrationGuard={registry:pin(8),label:'example'};
const expected={to:token,value:'0x0',data:'0x12345678'};
const abi=parseAbi(['function redeemDelegations(bytes[],bytes32[],bytes[])']);
const delegationType=[{type:'tuple[]',components:[{name:'delegate',type:'address'},{name:'delegator',type:'address'},{name:'authority',type:'bytes32'},{name:'caveats',type:'tuple[]',components:[{name:'enforcer',type:'address'},{name:'terms',type:'bytes'},{name:'args',type:'bytes'}]},{name:'salt',type:'uint256'},{name:'signature',type:'bytes'}]}];
function fixture(options={}) {
  const native={enforcer:policy.native.address,terms:concatHex(['0x01',owner,zeroHash]),args:'0x'};
  const erc20={enforcer:policy.erc20.address,terms:concatHex(['0x00',token,owner,zeroHash]),args:'0x'};
  if(options.unknownEnforcer)native.enforcer=address(30);
  if(options.hookArgs)native.args='0x01';
  const erc1155={enforcer:policyV2.erc1155.address,terms:concatHex([options.decreaseNFT?'0x01':'0x00',options.wrongNFTRegistry?address(20):registrationGuard.registry.address,options.wrongNFTRecipient?address(21):owner,`0x${(options.wrongNFTId?99n:42n).toString(16).padStart(64,'0')}`,`0x${(options.wrongNFTAmount?2n:1n).toString(16).padStart(64,'0')}`]),args:'0x'};
  const delegation={delegate:options.wrongDelegate?address(20):owner,delegator:owner,authority:`0x${'f'.repeat(64)}`,caveats:options.duplicate?[native,native]:options.nft?[native,erc20,erc1155]:[native,erc20],salt:1n,signature:`0x${'1'.repeat(130)}`};
  const contexts=[encodeAbiParameters(delegationType,[[delegation]])];
  const execution=concatHex([options.wrongTarget?address(20):token,zeroHash,options.wrongData?'0x12345679':expected.data]);
  const input=encodeFunctionData({abi,functionName:'redeemDelegations',args:[contexts,[options.tryMode?`0x0001${'0'.repeat(60)}`:zeroHash],options.extraExecution?[execution,execution]:[execution]]});
  return {from:owner,to:policy.manager.address,value:'0x0',chainId:'0xaa36a7',type:'0x2',input:options.suffix?`${input}00`:input};
}
test('narrow wrapper accepts exactly one root self-delegation and exact planned call',()=>{
  assert.deepEqual(decodeExactWrapper(fixture(),expected,owner,token,policy).usedEnforcers,['native','erc20']);
});
test('wrapper rejects changed target/data, extra calls, try mode, delegation, unknown hooks and suffixes',()=>{
  for(const options of [{wrongTarget:true},{wrongData:true},{extraExecution:true},{tryMode:true},{wrongDelegate:true},{unknownEnforcer:true},{hookArgs:true},{duplicate:true},{suffix:true}]) assert.throws(()=>decodeExactWrapper(fixture(options),expected,owner,token,policy));
});
test('wrapper requires receipt-block runtime pins and owner EIP-7702 implementation designation',async()=>{
  const calls=[];
  const rpc=async(method,params)=>{calls.push([method,params]);return params[0]===owner?`0xef0100${policy.delegator.address.slice(2)}`:'0x6000';};
  assert.equal(await verifyExactWrapper({transaction:fixture(),expected,owner,paymentToken:token,policy,blockNumber:'0x64',rpc}),true);
  assert.ok(calls.every(([method,params])=>method==='eth_getCode'&&params[1]==='0x64'));
  await assert.rejects(verifyExactWrapper({transaction:fixture(),expected,owner,paymentToken:token,policy,blockNumber:'0x64',rpc:async()=> '0x6001'}),/runtime_mismatch/);
});
test('foreign authorization and authorizations for another chain are rejected',async()=>{
  const transaction={...fixture(),type:'0x4',authorizationList:[{address:policy.delegator.address,chainId:'0x1',nonce:'0x1',yParity:'0x0',r:zeroHash,s:zeroHash}]};
  const rpc=async(_method,params)=>params[0]===owner?`0xef0100${policy.delegator.address.slice(2)}`:'0x6000';
  await assert.rejects(verifyExactWrapper({transaction,expected,owner,paymentToken:token,policy,blockNumber:'0x64',rpc}),/authorization_mismatch/);
});
test('ERC1155 guard is accepted only with reviewed v2 policy and registration context',()=>{
  assert.throws(()=>decodeExactWrapper(fixture({nft:true}),expected,owner,token,policy));
  assert.throws(()=>decodeExactWrapper(fixture({nft:true}),expected,owner,token,policyV2));
  assert.deepEqual(decodeExactWrapper(fixture({nft:true}),expected,owner,token,policyV2,registrationGuard).usedEnforcers,['native','erc20','erc1155']);
  for(const options of [{decreaseNFT:true},{wrongNFTRegistry:true},{wrongNFTRecipient:true},{wrongNFTAmount:true}]) assert.throws(()=>decodeExactWrapper(fixture({nft:true,...options}),expected,owner,token,policyV2,registrationGuard));
});
test('ERC1155 guard token ID and owner must match authoritative registry state at receipt block',async()=>{
  const registryAbi=parseAbi(['function getState(uint256) view returns ((uint8 status,uint64 expiry,address latestOwner,uint256 tokenId,uint256 resource))']);
  const rpc=async(method,params)=>{
    assert.equal(params[1],'0x64');
    if(method==='eth_getCode') return params[0]===owner?`0xef0100${policy.delegator.address.slice(2)}`:'0x6000';
    assert.equal(params[0].to,registrationGuard.registry.address);
    return encodeFunctionResult({abi:registryAbi,functionName:'getState',result:{status:2,expiry:1000n,latestOwner:owner,tokenId:42n,resource:1n}});
  };
  const parameters={expected,owner,paymentToken:token,policy:policyV2,blockNumber:'0x64',rpc,registrationGuard};
  assert.equal(await verifyExactWrapper({...parameters,transaction:fixture({nft:true})}),true);
  await assert.rejects(verifyExactWrapper({...parameters,transaction:fixture({nft:true,wrongNFTId:true})}),/registration_token_mismatch/);
});
