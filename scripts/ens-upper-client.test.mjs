import test from 'node:test';
import assert from 'node:assert/strict';
import { installUpperClient, createUpperStateSaver, upperErrorMessage, upperResultMessage } from './ens-upper-client.mjs';
function storageFixture(){const values=new Map();return {values,getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};}
function documentFixture(){const controls={nodes:[],append(node){this.nodes.push(node);},querySelectorAll(){return this.nodes;}},status={},details={};return {controls,status,details,querySelector:selector=>({'#controls':controls,'#status':status,'#details':details})[selector],createElement:()=>({disabled:false,addEventListener(type,callback){this.click=callback;}})};}
const metadata={manifestHash:'plan-hash',wrapperPolicyHash:'policy-hash',token:'csrf',wrapperPolicy:{},manifest:{parentName:'example.eth',owner:'owner',upper:{address:'upper'},calls:[{action:'deploy_upper'},{action:'set_upper_parent'},{action:'attach_upper'}]}};
test('upper client sends only after explicit click and prevents concurrent wallet actions',async()=>{
 const document=documentFixture(),storage=storageFixture(),calls=[];let finish;
 const fetcher=async path=>Response.json(path==='/plan'?metadata:{state:{steps:{},unknown:false},revision:0});
 await installUpperClient({document,storage,provider:{},fetcher,flowFactory:()=>({connect:async()=>calls.push('connect'),execute:action=>{calls.push(action);return new Promise(done=>{finish=done;});},verify:async()=>({namespaceReady:false})})});
 assert.deepEqual(calls,[]);assert.match(document.details.textContent,/"namespaceReady": false/);assert.equal(document.controls.nodes.length,8);assert.equal(document.controls.nodes.filter(node=>!node.hidden).length,5);
 const pending=document.controls.nodes[1].click();assert.deepEqual(calls,['deploy_upper']);assert.ok(document.controls.nodes.every(b=>b.disabled));await document.controls.nodes[3].click();assert.deepEqual(calls,['deploy_upper']);finish({namespaceReady:false});await pending;assert.ok([0,1,3,5,7].every(index=>!document.controls.nodes[index].disabled));assert.ok([2,4,6].every(index=>document.controls.nodes[index].disabled));
});
test('upper client preserves local uncertainty and persists before state network mutation',async()=>{
 const document=documentFixture(),storage=storageFixture();storage.setItem('ens-upper-plan-hash-policy-hash',JSON.stringify({state:{steps:{deploy_upper:{started:true}},unknown:false},revision:1}));let captured;
 await installUpperClient({document,storage,provider:{},fetcher:async path=>Response.json(path==='/plan'?metadata:{state:{steps:{},unknown:false},revision:0}),flowFactory:options=>{captured=options;return {};}});assert.equal(captured.state.unknown,true);assert.match(document.status.textContent,/再送禁止/);
 const save=createUpperStateSaver({storage,browserKey:'key',metadata,revision:4,fetcher:async(path,init)=>{const local=JSON.parse(storage.getItem('key'));assert.equal(local.revision,5);assert.equal(JSON.parse(init.body).revision,4);assert.equal(init.headers['x-ens-helper-token'],'csrf');return Response.json({}, {status:409});}});
 await assert.rejects(save({steps:{deploy_upper:{started:true}},unknown:false}),/do_not_resend/);assert.equal(JSON.parse(storage.getItem('key')).state.steps.deploy_upper.started,true);
});
test('upper client handles missing wallet and uncertain outcomes without raw errors',async()=>{
 const document=documentFixture();await installUpperClient({document,storage:storageFixture(),fetcher:async path=>Response.json(path==='/plan'?metadata:{state:{steps:{},unknown:false},revision:0})});assert.match(document.status.textContent,/MetaMask/);assert.equal(document.controls.nodes.length,0);
 assert.match(upperErrorMessage(new Error('submission_unknown_do_not_resend')),/再送せず/);assert.match(upperErrorMessage(new Error('receipt_not_finalized')),/最終確定/);assert.match(upperErrorMessage(new Error('private_provider_response')),/処理を完了/);
});

test('upper client exposes reset only after definite wallet rejection and separate human click',async()=>{
 const document=documentFixture(),storage=storageFixture(),calls=[];let state;
 await installUpperClient({document,storage,provider:{},fetcher:async path=>Response.json(path==='/plan'?metadata:{state:{steps:{},unknown:false},revision:0}),flowFactory:options=>{state=options.state;return {execute:async action=>{calls.push(action);state.steps[action]={started:true,rejected:true};throw {code:4001};},resetRejected:async action=>{calls.push('reset');delete state.steps[action];return {retryAvailable:true,namespaceReady:false};}};}});
 assert.equal(document.controls.nodes[2].disabled,true);assert.equal(document.controls.nodes[2].hidden,true);await document.controls.nodes[1].click();assert.deepEqual(calls,['deploy_upper']);assert.equal(document.controls.nodes[2].disabled,false);assert.equal(document.controls.nodes[2].hidden,false);assert.equal(document.controls.nodes[2].textContent,'拒否した操作2を再試行可能にする');await document.controls.nodes[2].click();assert.deepEqual(calls,['deploy_upper','reset']);assert.equal(document.controls.nodes[2].disabled,true);assert.equal(document.controls.nodes[2].hidden,true);
});

test('upper results explain pending and confirmed phases without inventing finality',()=>{
 for(const [action,step] of [['deploy_upper',2],['set_upper_parent',3],['attach_upper',4]]){
  const pending=upperResultMessage({upperConnected:false,namespaceReady:false,pendingAction:action,receiptFinalized:false});assert.match(pending,new RegExp('操作'+step));assert.match(pending,/最終確定を待っています/);assert.match(pending,/再送せず/);assert.doesNotMatch(pending,/完了です|取引の最終確定と|採掘|receipt/);
 }
 const reconnected=upperResultMessage({connected:true,namespaceReady:false});assert.match(reconnected,/送信履歴がある場合は5/);assert.match(reconnected,/未送信の場合だけ2/);
 const empty=upperResultMessage({upperConnected:false,completedSteps:0,receiptFinalized:false});assert.match(empty,/照合できた取引はまだありません/);assert.match(empty,/不明な場合は再送しない/);assert.doesNotMatch(empty,/送信済み取引はありません/);
 assert.match(upperResultMessage({action:'deploy_upper',hash:'0x'+'1'.repeat(64),namespaceReady:false}),/送信しました/);
 assert.match(upperResultMessage({upperConnected:false,completedSteps:1,receiptFinalized:false,namespaceReady:false}),/次は3/);assert.match(upperResultMessage({upperConnected:false,completedSteps:2,receiptFinalized:false,namespaceReady:false}),/次は4/);
 const completed=upperResultMessage({upperConnected:true,completedSteps:3,receiptFinalized:true,namespaceReady:false});assert.match(completed,/上位接続は完了/);assert.match(completed,/拠点namespaceの構築は別作業/);
 assert.doesNotMatch(upperResultMessage({upperConnected:true,completedSteps:3,receiptFinalized:false}),/完了です/);assert.doesNotMatch(upperResultMessage({upperConnected:false,namespaceReady:false}),/完了です/);
});
