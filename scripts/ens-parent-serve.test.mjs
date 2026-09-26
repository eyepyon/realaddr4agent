import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, zeroAddress, zeroHash } from 'viem';
const owner='0x0000000000000000000000000000000000000001';
const registrar='0x0000000000000000000000000000000000000002';
const token='0x0000000000000000000000000000000000000003';
const secret=`0x${'1'.repeat(64)}`;
const abi=parseAbi(['function commit(bytes32 commitment)','function register(string label,address owner,bytes32 secret,address registry,address resolver,uint64 duration,address paymentToken,bytes32 referrer)']);
const commitment=keccak256(encodeAbiParameters([{type:'string'},{type:'address'},{type:'bytes32'},{type:'address'},{type:'address'},{type:'uint64'},{type:'bytes32'}],['example',owner,secret,zeroAddress,zeroAddress,31536000n,zeroHash]));
const tx=(functionName,args)=>({chainId:'0xaa36a7',from:owner,to:registrar,value:'0x0',data:encodeFunctionData({abi,functionName,args})});
const manifest={version:1,chainId:11155111,environment:'testnet',readOnly:true,parentName:'example.eth',owner,paymentToken:token,durationSeconds:'31536000',commitment,price:{decimals:6,scope:'official_ens_test_token_only',baseAtomic:'8000021',premiumAtomic:'0',totalAtomic:'8000021'},balances:{tokenAtomic:'8000021',allowanceAtomic:'8000021'},pins:{ETHRegistrar:{address:registrar,codeHash:keccak256('0x6000')},MockUSDC:{address:token,codeHash:keccak256('0x6000')}},steps:[{action:'commit_parent',transaction:tx('commit',[commitment])},{action:'wait_commitment_age',minimumSeconds:'60',maximumSeconds:'86400'},{action:'register_parent',transaction:tx('register',['example',owner,secret,zeroAddress,zeroAddress,31536000n,token,zeroHash])}]};

test('localhost helper freezes plan and atomically rejects stale tabs or clearing started/unknown guards',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'ens-helper-test-'));
  const plan=join(directory,'plan.json'); const state=join(directory,'state.json');
  const serialized=JSON.stringify(manifest); await writeFile(plan,serialized,'utf8');
  const child=spawn(process.execPath,[resolve('scripts/ens-parent-serve.mjs')],{env:{...process.env,ENS_PARENT_PLAN_FILE:plan,ENS_PARENT_STATE_FILE:state,ENS_PARENT_PLAN_HASH:createHash('sha256').update(serialized).digest('hex')},windowsHide:true,stdio:['ignore','pipe','pipe']});
  try {
    const info=await new Promise((done,fail)=>{
      let output=''; const timer=setTimeout(()=>fail(new Error('helper startup timeout')),15000);
      child.stdout.on('data',chunk=>{output+=chunk;const line=output.split('\n')[0];try{const info=JSON.parse(line);clearTimeout(timer);done(info);}catch{}});
      child.once('exit',()=>{clearTimeout(timer);fail(new Error('helper exited'));});
    });
    const metadata=await fetch(`${info.origin}/plan`).then(r=>r.json());
    const save=(revision,next,origin=info.origin)=>fetch(`${info.origin}/state`,{method:'POST',headers:{origin,'content-type':'application/json','x-ens-helper-token':metadata.token},body:JSON.stringify({revision,state:next})});
    const started={steps:{commit_parent:{started:true}},unknown:false};
    assert.equal((await save(0,started)).status,200);
    assert.equal((await save(0,started)).status,409);
    assert.equal((await save(1,{steps:{},unknown:false})).status,409);
    assert.equal((await save(1,{...started,unknown:true})).status,200);
    assert.equal((await save(2,started)).status,409);
    assert.equal((await save(2,{...started,unknown:true},'https://example.invalid')).status,403);
    const stored=JSON.parse(await readFile(state,'utf8')); assert.equal(stored.revision,2);assert.equal(stored.state.unknown,true);assert.equal(stored.state.steps.commit_parent.started,true);
  } finally {child.kill();}
});
