import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { keccak256 } from 'viem';
import { controllerValues, controllerRuntime, planControllerDeployment } from './ens-controller-plan.mjs';
const addr=n=>'0x'+n.toString(16).padStart(40,'0');
const names=['LEASE_REGISTRY','ETH_REGISTRY','UPPER_REGISTRY','RESOLVER_FACTORY','RESOLVER_IMPLEMENTATION','NAMESPACE_OWNER','PARENT_NODE'];
const pins=Object.fromEntries(['leaseRegistry','ethRegistry','upperRegistry','factory','resolverImplementation','userRegistryImplementation','proxyLogic'].map((key,index)=>[key,{address:addr(index+2),codeHash:keccak256('0x6000')}]));
const template='0x'+'00'.repeat(224),layout=names.map((name,index)=>({name,ranges:[{start:index*32,length:32}]}));
const artifact={metadata:{compiler:{version:'0.8.30+test'},settings:{evmVersion:'cancun',optimizer:{enabled:true,runs:200},compilationTarget:{'src/RealAddrNameController.sol':'RealAddrNameController'}}},abi:[{type:'constructor',inputs:['admin','publisher','leaseRegistry','ethRegistry','upperRegistry','factory','resolverImplementation','parent'].map((name,index)=>({name,type:index===7?'string':'address'})),stateMutability:'nonpayable'}],bytecode:{object:'0x6000'},deployedBytecode:{object:template,immutableReferences:Object.fromEntries(names.map((name,index)=>[String(index+1),[{start:index*32,length:32}]]))}};
const ast={nodes:[{nodeType:'ContractDefinition',name:'RealAddrNameController',nodes:names.map((name,index)=>({nodeType:'VariableDeclaration',mutability:'immutable',name,id:index+1,stateVariable:true,typeDescriptions:{typeString:['contract IRealAddrLeaseReader','contract IRealAddrEnsRegistry','contract IRealAddrEnsRegistry','contract IRealAddrEnsFactory','address','address','bytes32'][index]}}))}]};
const manifest=planControllerDeployment({artifact,ast,owner:addr(1),parentLabel:'example',pins,upperProof:{finalized:true,blockNumber:100n,blockHash:keccak256('0x01'),timestamp:1000n,parentExpiry:2000n,owner:addr(1),upperParent:[pins.ethRegistry.address,'example'],rootRoles:65793n,rootRoleCount:65793n},simulationRuntime:controllerRuntime(template,layout,controllerValues(addr(1),'example',pins))});
const hash=value=>createHash('sha256').update(value).digest('hex');
function start(env) {
 const child=spawn(process.execPath,[resolve('scripts/ens-controller-serve.mjs')],{env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});
 const ready=new Promise((done,fail)=>{let output='';const timer=setTimeout(()=>{child.kill();fail(new Error('helper_startup_timeout'));},20000);child.stdout.on('data',chunk=>{output+=chunk;try{const info=JSON.parse(output.split('\n')[0]);clearTimeout(timer);done(info);}catch{}});child.once('exit',()=>{clearTimeout(timer);fail(new Error('helper_exited'));});});
 return {child,ready};
}
test('controller localhost helper binds exact CREATE plan, checks browser guards and persists monotonic CAS state',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'ens-controller-helper-test-')),plan=join(directory,'plan.json'),state=join(directory,'state.json');
 const serialized=JSON.stringify(manifest);await writeFile(plan,serialized);
 const env={ENS_CONTROLLER_PLAN_FILE:plan,ENS_CONTROLLER_STATE_FILE:state,ENS_CONTROLLER_PLAN_HASH:hash(serialized)};
 const {child,ready}=start(env);
 try {
  const info=await ready;assert.equal(info.namespaceReady,false);const response=await fetch(info.origin+'/plan'),metadata=await response.json();assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  const wrongHost = await new Promise((done, fail) => { const request = httpRequest(info.origin+'/plan', { headers: { host: 'localhost:1' } }, response => {response.resume();done(response.statusCode);});request.on('error',fail);request.end();});assert.equal(wrongHost,403);assert.equal((await fetch(info.origin+'/plan',{headers:{origin:'https://other.example'}})).status,403);
  const save=(revision,next,extra={})=>fetch(info.origin+'/state',{method:'POST',headers:{origin:info.origin,'content-type':'application/json','x-ens-helper-token':metadata.token,...extra},body:JSON.stringify({revision,state:next})});
  const rejected={steps:{deploy_controller:{started:true,rejected:true}},unknown:false};
  const started={steps:{deploy_controller:{started:true}},unknown:false};
  assert.equal((await save(0,started,{'x-ens-helper-token':'wrong'})).status,403);assert.equal((await save(0,started,{origin:''})).status,403);
  assert.equal((await save(0,rejected)).status,200);assert.equal((await save(1,{steps:{},unknown:false})).status,200);
  const concurrent=await Promise.all([save(2,started),save(2,started)]);assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);
  assert.equal((await save(3,{steps:{},unknown:false})).status,409);
  const submitted={steps:{deploy_controller:{started:true,hash:'0x'+'1'.repeat(64),confirmed:true,finalized:true}},unknown:false};assert.equal((await save(3,submitted)).status,200);
  assert.equal((await save(4,{steps:{deploy_controller:{started:true,hash:'0x'+'2'.repeat(64)}},unknown:false})).status,409);
  assert.equal((await save(4,{steps:{deploy_controller:{...submitted.steps.deploy_controller,confirmed:false}},unknown:false})).status,409);
  assert.equal((await save(4,{steps:{},unknown:false})).status,409);assert.equal((await save(4,{...submitted,unknown:true})).status,200);assert.equal((await save(5,submitted)).status,409);
  assert.equal((await save(5,{steps:[],unknown:true})).status,400);assert.equal((await save(5,{...submitted,namespaceReady:true})).status,400);
  const oversized=await fetch(info.origin+'/state',{method:'POST',headers:{origin:info.origin,'content-type':'application/json','x-ens-helper-token':metadata.token},body:JSON.stringify({revision:5,state:{...submitted,extra:'あ'.repeat(12000)}})});assert.equal(oversized.status,413);
  const stored=JSON.parse(await readFile(state,'utf8'));assert.equal(stored.revision,5);assert.equal(stored.manifestHash,hash(serialized));assert.equal(stored.state.unknown,true);
 }finally{child.kill();}
 const changed=JSON.stringify({...manifest,owner:addr(11)});await writeFile(plan,changed);const restarted=start({...env,ENS_CONTROLLER_PLAN_HASH:hash(changed)});await assert.rejects(restarted.ready,/helper_exited/);restarted.child.kill();
});
