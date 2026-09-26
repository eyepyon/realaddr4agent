import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { keccak256, namehash, zeroAddress, zeroHash } from 'viem';
import { planLocationNamespace } from './ens-location-plan.mjs';
import { UPPER_ROOT_ROLES } from './ens-upper-plan.mjs';
const address = n => `0x${n.toString(16).padStart(40,'0')}`;
const fixtureHash = n => `0x${n.toString(16).padStart(64,'0')}`;
const pin = n => ({address:address(n),codeHash:keccak256('0x6000')});
function fixture() {
 const pins={factory:pin(2),userRegistryImplementation:pin(3),proxyLogic:pin(4),ethRegistry:pin(5),upperRegistry:pin(6),nameController:pin(7),leaseRegistry:pin(8),resolverImplementation:pin(9)};
 const owner=address(1),publisher=address(10),buildingKey=fixtureHash(42),parentName='example.eth',locationSlug='demo-place';
 return {chainId:11155111,owner,publisher,parentName,locationSlug,buildingKey,salt:43n,pins,predictedCode:'0x',snapshot:{chainId:11155111,finalized:true,blockNumber:100n,blockHash:fixtureHash(100),timestamp:1000n,codeHashes:Object.fromEntries(Object.entries(pins).map(([key,value])=>[key,value.codeHash])),factoryProxyLogic:pins.proxyLogic.address,
 parent:{parentName,registry:pins.ethRegistry.address,status:2,owner,expiry:2000n,subregistry:pins.upperRegistry.address,resolver:zeroAddress},
 upper:{registry:pins.upperRegistry.address,parentRegistry:pins.ethRegistry.address,parentLabel:'example',implementation:pins.userRegistryImplementation.address,rootAccount:owner,ownerRootRoles:UPPER_ROOT_ROLES,rootRoleCount:UPPER_ROOT_ROLES,location:{slug:locationSlug,status:0,expiry:0n,owner:zeroAddress,subregistry:zeroAddress,resolver:zeroAddress}},
 controller:{address:pins.nameController.address,namespaceOwner:owner,leaseRegistry:pins.leaseRegistry.address,ethRegistry:pins.ethRegistry.address,upperRegistry:pins.upperRegistry.address,resolverFactory:pins.factory.address,resolverImplementation:pins.resolverImplementation.address,parentLabel:'example',parentNode:namehash(parentName),adminAuthorized:true,publisher,publisherAuthorized:true,paused:false,namespace:{buildingKey,slug:'',registry:zeroAddress,node:zeroHash},pristine:{deploymentVerified:true,deploymentBlockNumber:90n,eventsComplete:true,eventsFromBlock:90n,eventsThroughBlock:100n,namespaceConfiguredEvents:0}}}};
}
const manifest=planLocationNamespace(fixture());
const addr=address;
const policy={version:2,chainId:11155111,manager:pin(6),delegator:pin(7),native:pin(8),erc20:pin(9),erc1155:pin(10)};
const hash=value=>createHash('sha256').update(value).digest('hex');
function start(env) {
 const child=spawn(process.execPath,[resolve('scripts/ens-location-serve.mjs')],{env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});
 const ready=new Promise((done,fail)=>{let output='';const timer=setTimeout(()=>{child.kill();fail(new Error('helper_startup_timeout'));},20000);child.stdout.on('data',chunk=>{output+=chunk;try{const info=JSON.parse(output.split('\n')[0]);clearTimeout(timer);done(info);}catch{}});child.once('exit',()=>{clearTimeout(timer);fail(new Error('helper_exited'));});});
 return {child,ready};
}
test('location localhost helper binds plan/policy, checks browser guards and persists monotonic CAS state',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ens-location-helper-test-')),plan=join(directory,'plan.json'),state=join(directory,'state.json'),wrapper=join(directory,'wrapper.json');
 const serialized=JSON.stringify(manifest),policyRaw=JSON.stringify(policy);await writeFile(plan,serialized);await writeFile(wrapper,policyRaw);
 const env={ENS_LOCATION_PLAN_FILE:plan,ENS_LOCATION_STATE_FILE:state,ENS_LOCATION_PLAN_HASH:hash(serialized),ENS_LOCATION_WRAPPER_POLICY_FILE:wrapper,ENS_LOCATION_WRAPPER_POLICY_HASH:hash(policyRaw)};
 const {child,ready}=start(env);
 try {
  const info=await ready;assert.equal(info.namespaceReady,false);const response=await fetch(info.origin+'/plan'),metadata=await response.json();assert.equal(metadata.wrapperPolicyHash,hash(policyRaw));assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  const wrongHost = await new Promise((done, fail) => { const request = httpRequest(info.origin+'/plan', { headers: { host: 'localhost:1' } }, response => {response.resume();done(response.statusCode);});request.on('error',fail);request.end();});assert.equal(wrongHost,403);assert.equal((await fetch(info.origin+'/plan',{headers:{origin:'https://other.example'}})).status,403);
  const save=(revision,next,extra={})=>fetch(info.origin+'/state',{method:'POST',headers:{origin:info.origin,'content-type':'application/json','x-ens-helper-token':metadata.token,...extra},body:JSON.stringify({revision,state:next})});
  const rejected={steps:{deploy_location:{started:true,rejected:true}},unknown:false};
  const started={steps:{deploy_location:{started:true}},unknown:false};
  assert.equal((await save(0,started,{'x-ens-helper-token':'wrong'})).status,403);assert.equal((await save(0,started,{origin:''})).status,403);
  assert.equal((await save(0,rejected)).status,200);assert.equal((await save(1,{steps:{},unknown:false})).status,200);
  const concurrent=await Promise.all([save(2,started),save(2,started)]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
  assert.equal((await save(3,{steps:{},unknown:false})).status,409);
  const submitted={steps:{deploy_location:{started:true,hash:'0x'+'1'.repeat(64),confirmed:true,finalized:true}},unknown:false};assert.equal((await save(3,submitted)).status,200);
  assert.equal((await save(4,{steps:{deploy_location:{started:true,hash:'0x'+'2'.repeat(64)}},unknown:false})).status,409);
  assert.equal((await save(4,{steps:{deploy_location:{...submitted.steps.deploy_location,confirmed:false}},unknown:false})).status,409);
  assert.equal((await save(4,{steps:{},unknown:false})).status,409);assert.equal((await save(4,{...submitted,unknown:true})).status,200);assert.equal((await save(5,submitted)).status,409);
  assert.equal((await save(5,{steps:[],unknown:true})).status,400);assert.equal((await save(5,{...submitted,namespaceReady:true})).status,400);
  const oversized=await fetch(info.origin+'/state',{method:'POST',headers:{origin:info.origin,'content-type':'application/json','x-ens-helper-token':metadata.token},body:JSON.stringify({revision:5,state:{...submitted,extra:'あ'.repeat(12000)}})});assert.equal(oversized.status,413);
  const stored=JSON.parse(await readFile(state,'utf8'));assert.equal(stored.revision,5);assert.equal(stored.manifestHash,hash(serialized));assert.equal(stored.wrapperPolicyHash,hash(policyRaw));assert.equal(stored.state.unknown,true);
 }finally{child.kill();}
 const changed={...policy,manager:pin(11)},changedRaw=JSON.stringify(changed);await writeFile(wrapper,changedRaw);const restarted=start({...env,ENS_LOCATION_WRAPPER_POLICY_HASH:hash(changedRaw)});await assert.rejects(restarted.ready,/helper_exited/);restarted.child.kill();
});
