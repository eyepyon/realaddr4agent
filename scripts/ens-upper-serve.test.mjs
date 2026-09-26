import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { keccak256, zeroAddress } from 'viem';
import { planUpperRegistry } from './ens-upper-plan.mjs';
const addr=n=>`0x${n.toString(16).padStart(40,'0')}`,pin=n=>({address:addr(n),codeHash:keccak256('0x6000')});
const manifest=planUpperRegistry({chainId:11155111,owner:addr(1),parentName:'example.eth',salt:42n,predictedCode:'0x',pins:{factory:pin(2),userRegistryImplementation:pin(3),proxyLogic:pin(4),ethRegistry:pin(5)},parentSnapshot:{chainId:11155111,finalized:true,blockHash:keccak256('0x01'),blockNumber:100n,timestamp:1000n,parentName:'example.eth',registry:addr(5),status:2,owner:addr(1),expiry:2000n,subregistry:zeroAddress,resolver:zeroAddress,ownerCanSetSubregistry:true,factoryProxyLogic:addr(4)}});
const policy={version:2,chainId:11155111,manager:pin(6),delegator:pin(7),native:pin(8),erc20:pin(9),erc1155:pin(10)};
const hash=value=>createHash('sha256').update(value).digest('hex');
function start(env) {
 const child=spawn(process.execPath,[resolve('scripts/ens-upper-serve.mjs')],{env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});
 const ready=new Promise((done,fail)=>{let output='';const timer=setTimeout(()=>{child.kill();fail(new Error('helper_startup_timeout'));},20000);child.stdout.on('data',chunk=>{output+=chunk;try{const info=JSON.parse(output.split('\n')[0]);clearTimeout(timer);done(info);}catch{}});child.once('exit',()=>{clearTimeout(timer);fail(new Error('helper_exited'));});});
 return {child,ready};
}
test('upper localhost helper binds plan/policy, checks browser guards and persists monotonic CAS state',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ens-upper-helper-test-')),plan=join(directory,'plan.json'),state=join(directory,'state.json'),wrapper=join(directory,'wrapper.json');
 const serialized=JSON.stringify(manifest),policyRaw=JSON.stringify(policy);await writeFile(plan,serialized);await writeFile(wrapper,policyRaw);
 const env={ENS_UPPER_PLAN_FILE:plan,ENS_UPPER_STATE_FILE:state,ENS_UPPER_PLAN_HASH:hash(serialized),ENS_UPPER_WRAPPER_POLICY_FILE:wrapper,ENS_UPPER_WRAPPER_POLICY_HASH:hash(policyRaw)};
 const {child,ready}=start(env);
 try {
  const info=await ready;assert.equal(info.namespaceReady,false);const response=await fetch(info.origin+'/plan'),metadata=await response.json();assert.equal(metadata.wrapperPolicyHash,hash(policyRaw));assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  const wrongHost = await new Promise((done, fail) => { const request = httpRequest(info.origin+'/plan', { headers: { host: 'localhost:1' } }, response => {response.resume();done(response.statusCode);});request.on('error',fail);request.end();});assert.equal(wrongHost,403);assert.equal((await fetch(info.origin+'/plan',{headers:{origin:'https://other.example'}})).status,403);
  const save=(revision,next,extra={})=>fetch(info.origin+'/state',{method:'POST',headers:{origin:info.origin,'content-type':'application/json','x-ens-helper-token':metadata.token,...extra},body:JSON.stringify({revision,state:next})});
  const rejected={steps:{deploy_upper:{started:true,rejected:true}},unknown:false};
  const started={steps:{deploy_upper:{started:true}},unknown:false};
  assert.equal((await save(0,started,{'x-ens-helper-token':'wrong'})).status,403);assert.equal((await save(0,started,{origin:''})).status,403);
  assert.equal((await save(0,rejected)).status,200);assert.equal((await save(1,{steps:{},unknown:false})).status,200);
  const concurrent=await Promise.all([save(2,started),save(2,started)]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
  assert.equal((await save(3,{steps:{},unknown:false})).status,409);
  const submitted={steps:{deploy_upper:{started:true,hash:'0x'+'1'.repeat(64),confirmed:true,finalized:true}},unknown:false};assert.equal((await save(3,submitted)).status,200);
  assert.equal((await save(4,{steps:{deploy_upper:{started:true,hash:'0x'+'2'.repeat(64)}},unknown:false})).status,409);
  assert.equal((await save(4,{steps:{deploy_upper:{...submitted.steps.deploy_upper,confirmed:false}},unknown:false})).status,409);
  assert.equal((await save(4,{steps:{},unknown:false})).status,409);assert.equal((await save(4,{...submitted,unknown:true})).status,200);assert.equal((await save(5,submitted)).status,409);
  assert.equal((await save(5,{steps:[],unknown:true})).status,400);assert.equal((await save(5,{...submitted,namespaceReady:true})).status,400);
  const oversized=await fetch(info.origin+'/state',{method:'POST',headers:{origin:info.origin,'content-type':'application/json','x-ens-helper-token':metadata.token},body:JSON.stringify({revision:5,state:{...submitted,extra:'あ'.repeat(12000)}})});assert.equal(oversized.status,413);
  const stored=JSON.parse(await readFile(state,'utf8'));assert.equal(stored.revision,5);assert.equal(stored.manifestHash,hash(serialized));assert.equal(stored.wrapperPolicyHash,hash(policyRaw));assert.equal(stored.state.unknown,true);
 }finally{child.kill();}
 const changed={...policy,manager:pin(11)},changedRaw=JSON.stringify(changed);await writeFile(wrapper,changedRaw);const restarted=start({...env,ENS_UPPER_WRAPPER_POLICY_HASH:hash(changedRaw)});await assert.rejects(restarted.ready,/helper_exited/);restarted.child.kill();
});
