import { decodeFunctionResult, encodeFunctionData, keccak256, parseAbi, stringToHex, zeroAddress } from 'viem';
import { planUpperRegistry, UPPER_ROOT_ROLES } from './ens-upper-plan.mjs';
import { validateWrapperPolicy, verifyExactWrapper } from './ens-parent-wrapper.mjs';

const registryAbi=parseAbi([
  'function getState(uint256) view returns ((uint8 status,uint64 expiry,address latestOwner,uint256 tokenId,uint256 resource))',
  'function getSubregistry(string) view returns(address)','function getResolver(string) view returns(address)',
  'function getParent() view returns(address,string)','function roles(uint256,address) view returns(uint256)',
  'function roleCount(uint256) view returns(uint256)','function hasRoles(uint256,uint256,address) view returns(bool)',
]);
const factoryAbi=parseAbi(['function proxyLogic() view returns(address)','function verifyContract(address) view returns(address)']);
const actions=['deploy_upper','set_upper_parent','attach_upper'];
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const demand=(condition,reason)=>{if(!condition)throw new Error(reason);};
const hash=value=>typeof value==='string'&&/^0x[0-9a-fA-F]{64}$/.test(value);
const quantity=value=>typeof value==='string'&&/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value);
const decimal=value=>typeof value==='string'&&/^(0|[1-9][0-9]*)$/.test(value);

export function validateUpperManifest(manifest) {
  demand(manifest?.version===1&&manifest.chainId===11155111&&manifest.namespaceReady===false&&manifest.livePreflightRequired===true,'invalid_upper_plan');
  demand(decimal(manifest.salt)&&decimal(manifest.evidence?.blockNumber)&&decimal(manifest.evidence?.parentExpiry),'invalid_upper_evidence');
  const reconstructed=planUpperRegistry({chainId:manifest.chainId,owner:manifest.owner,parentName:manifest.parentName,salt:BigInt(manifest.salt),pins:manifest.pins,predictedCode:'0x',parentSnapshot:{chainId:manifest.chainId,finalized:true,blockHash:manifest.evidence.blockHash,blockNumber:BigInt(manifest.evidence.blockNumber),timestamp:0n,parentName:manifest.parentName,registry:manifest.pins.ethRegistry.address,status:2,owner:manifest.owner,expiry:BigInt(manifest.evidence.parentExpiry),subregistry:zeroAddress,resolver:zeroAddress,ownerCanSetSubregistry:true,factoryProxyLogic:manifest.pins.proxyLogic.address}});
  demand(Array.isArray(manifest.calls)&&manifest.calls.length===3,'invalid_upper_calls');
  for(let index=0;index<3;index++) {
    const actual=manifest.calls[index],expected=reconstructed.calls[index];
    demand(actual&&Object.keys(actual).every(key=>['action','to','value','data'].includes(key))&&actual.action===expected.action&&same(actual.to,expected.to)&&actual.value==='0x0'&&same(actual.data,expected.data),'invalid_upper_call');
  }
  demand(manifest.upper&&Object.keys(reconstructed.upper).every(key=>same(manifest.upper[key],reconstructed.upper[key])),'invalid_upper_derivation');
  const expected=reconstructed.expectedPostconditions,actual=manifest.expectedPostconditions;
  demand(actual&&Object.keys(expected).every(key=>Array.isArray(expected[key])?Array.isArray(actual[key])&&actual[key].length===2&&same(actual[key][0],expected[key][0])&&actual[key][1]===expected[key][1]:typeof expected[key]==='string'&&expected[key].startsWith('0x')?same(actual[key],expected[key]):actual[key]===expected[key]),'invalid_upper_postconditions');
  if(manifest.wrapperPaymentToken) demand(/^0x[0-9a-fA-F]{40}$/.test(manifest.wrapperPaymentToken.address)&&!same(manifest.wrapperPaymentToken.address,zeroAddress)&&hash(manifest.wrapperPaymentToken.codeHash),'invalid_wrapper_token_pin');
  return true;
}

export function createUpperFlow({manifest,provider,save,state={steps:{},unknown:false},wrapperPolicy}) {
  validateUpperManifest(manifest); if(wrapperPolicy)validateWrapperPolicy(wrapperPolicy);
  demand(state&&typeof state.steps==='object'&&state.steps!==null&&!Array.isArray(state.steps)&&typeof state.unknown==='boolean'&&Object.keys(state.steps).every(action=>actions.includes(action)),'invalid_upper_state');
  const rpc=(method,params=[])=>provider.request({method,params});
  const label=manifest.parentName.slice(0,-4),labelId=BigInt(keccak256(stringToHex(label))),upper=manifest.upper.address,pins=manifest.pins;
  let busy=false;
  async function account(){demand(BigInt(await rpc('eth_chainId'))===11155111n,'wrong_chain');const accounts=await rpc('eth_accounts');demand(Array.isArray(accounts)&&same(accounts[0],manifest.owner),'wrong_account');}
  async function persist(){try{await save(structuredClone(state));}catch{state.unknown=true;throw new Error('persistence_failed_do_not_resend');}}
  async function block(tag){const result=await rpc('eth_getBlockByNumber',[tag,false]);demand(result&&quantity(result.number)&&hash(result.hash)&&quantity(result.timestamp),'block_unavailable');return result;}
  async function canonical(snapshot){demand(same((await block(snapshot.number)).hash,snapshot.hash),'block_noncanonical');}
  async function call(address,abi,functionName,args,at){return decodeFunctionResult({abi,functionName,data:await rpc('eth_call',[{to:address,data:encodeFunctionData({abi,functionName,args})},at])});}
  async function code(pin,at){const runtime=await rpc('eth_getCode',[pin.address,at]);demand(runtime!=='0x'&&same(keccak256(runtime),pin.codeHash),'runtime_pin_mismatch');}
  async function pinsAt(at){await Promise.all(Object.values(pins).map(pin=>code(pin,at)));demand(same(await call(pins.factory.address,factoryAbi,'proxyLogic',[],at),pins.proxyLogic.address),'factory_logic_mismatch');if(manifest.wrapperPaymentToken)await code(manifest.wrapperPaymentToken,at);}
  async function parentAt(snapshot,attached){
    const at=snapshot.number,registration=await call(pins.ethRegistry.address,registryAbi,'getState',[labelId],at);
    demand(registration.status===2&&same(registration.latestOwner,manifest.owner)&&registration.expiry===BigInt(manifest.evidence.parentExpiry)&&registration.expiry>BigInt(snapshot.timestamp),'parent_state_mismatch');
    const [subregistry,resolver,authorized]=await Promise.all([call(pins.ethRegistry.address,registryAbi,'getSubregistry',[label],at),call(pins.ethRegistry.address,registryAbi,'getResolver',[label],at),call(pins.ethRegistry.address,registryAbi,'hasRoles',[labelId,1n<<20n,manifest.owner],at)]);
    demand(same(subregistry,attached?upper:zeroAddress)&&same(resolver,zeroAddress)&&authorized===true,'parent_pointer_or_role_mismatch');
  }
  async function upperAt(snapshot,phase){
    const at=snapshot.number;
    if(phase<1){demand(await rpc('eth_getCode',[upper,at])==='0x','upper_address_occupied');return;}
    await code(manifest.upper,at);
    const [implementation,roles,count,parent]=await Promise.all([call(pins.factory.address,factoryAbi,'verifyContract',[upper],at),call(upper,registryAbi,'roles',[0n,manifest.owner],at),call(upper,registryAbi,'roleCount',[0n],at),call(upper,registryAbi,'getParent',[],at)]);
    demand(same(implementation,pins.userRegistryImplementation.address)&&roles===UPPER_ROOT_ROLES&&count===UPPER_ROOT_ROLES,'upper_implementation_or_roles_mismatch');
    demand(same(parent[0],phase>=2?pins.ethRegistry.address:zeroAddress)&&parent[1]===(phase>=2?label:''),'upper_parent_mismatch');
  }
  async function conditions(snapshot,phase){await pinsAt(snapshot.number);await Promise.all([parentAt(snapshot,phase>=3),upperAt(snapshot,phase)]);await canonical(snapshot);}
  async function latestAndFinalized(phase){const snapshots=await Promise.all([block('latest'),block('finalized')]);await Promise.all(snapshots.map(snapshot=>conditions(snapshot,phase)));return snapshots[1];}
  async function receipt(action,finalized,diagnostics){
    const step=state.steps[action];demand(step?.hash&&hash(step.hash),'missing_transaction');const result=await rpc('eth_getTransactionReceipt',[step.hash]);if(!result){if(diagnostics)diagnostics[action]={receiptConfirmed:false,receiptFinalized:false};return false;}
    demand(quantity(result.blockNumber)&&hash(result.blockHash)&&same(result.transactionHash,step.hash),'receipt_mismatch');
    const transaction=await rpc('eth_getTransactionByHash',[step.hash]),expected=manifest.calls[actions.indexOf(action)];
    demand(transaction&&same(transaction.hash,step.hash)&&same(transaction.from,manifest.owner)&&BigInt(transaction.value)===0n&&BigInt(transaction.chainId)===11155111n&&same(transaction.blockHash,result.blockHash)&&transaction.blockNumber===result.blockNumber,'transaction_mismatch');
    const direct=same(transaction.to,expected.to)&&same(transaction.input,expected.data);
    if(!direct){demand(wrapperPolicy,'transaction_mismatch');await verifyExactWrapper({transaction,expected,owner:manifest.owner,paymentToken:manifest.wrapperPaymentToken?.address,policy:wrapperPolicy,blockNumber:result.blockNumber,rpc});}
    demand(result.status==='0x1'&&same(result.from,manifest.owner)&&same(result.to,transaction.to),'transaction_failed');
    const snapshot=await block(result.blockNumber);demand(same(snapshot.hash,result.blockHash),'receipt_noncanonical');
    await conditions(snapshot,actions.indexOf(action)+1);
    if(step.receipt)demand(step.receipt.blockNumber===result.blockNumber&&same(step.receipt.blockHash,result.blockHash),'receipt_changed');
    step.receipt={blockNumber:result.blockNumber,blockHash:result.blockHash,status:result.status};step.confirmed=true;
    const isFinalized=BigInt(finalized.number)>=BigInt(result.blockNumber);
    demand(!step.finalized||isFinalized,'finality_regressed');step.finalized=isFinalized;await persist();
    if(diagnostics)diagnostics[action]={receiptConfirmed:true,receiptFinalized:isFinalized,receiptBlockNumber:BigInt(snapshot.number).toString(),receiptBlockTime:blockTime(snapshot)};
    return step.finalized;
  }
  function blockTime(snapshot){const milliseconds=Number(BigInt(snapshot.timestamp))*1000;demand(Number.isSafeInteger(milliseconds)&&Math.abs(milliseconds)<=8640000000000000,'invalid_block_timestamp');return new Date(milliseconds).toISOString();}
  async function verifiedPhase(finalized,diagnostics){let phase=0;for(const action of actions){if(!state.steps[action]?.hash)break;if(!await receipt(action,finalized,diagnostics))break;phase++;}return phase;}
  return {
    state,
    async connect(){demand(!busy,'flow_busy');await rpc('eth_requestAccounts');if(BigInt(await rpc('eth_chainId'))!==11155111n)await rpc('wallet_switchEthereumChain',[{chainId:'0xaa36a7'}]);await account();return{connected:true,namespaceReady:false};},
    async resetRejected(action){
      demand(!busy&&!state.unknown&&!state.finalized,'unknown_or_busy_do_not_resend');demand(actions.includes(action),'unknown_action');
      const step=state.steps[action];demand(step?.started===true&&step.rejected===true&&!step.hash&&!step.receipt&&!step.confirmed&&!step.finalized,'only_definite_rejection_can_reset');
      demand(actions.slice(actions.indexOf(action)+1).every(later=>!state.steps[later]),'later_step_prevents_reset');busy=true;
      try{await account();delete state.steps[action];try{await persist();}catch(error){state.steps[action]=step;throw error;}return{rejectedStepReset:action,namespaceReady:false};}finally{busy=false;}
    },
    async execute(action){
      demand(!busy&&!state.unknown,'unknown_or_busy_do_not_resend');demand(actions.includes(action),'unknown_action');demand(!state.steps[action]?.hash&&!state.steps[action]?.started,'already_submitted_do_not_resend');busy=true;
      try{
        await account();const finalized=await block('finalized'),phase=await verifiedPhase(finalized),index=actions.indexOf(action);demand(phase===index,'prior_transaction_not_finalized');
        await latestAndFinalized(phase);const expected=manifest.calls[index],tx={chainId:'0xaa36a7',from:manifest.owner,to:expected.to,value:'0x0',data:expected.data};
        await rpc('eth_call',[tx,'latest']);const gas=BigInt(await rpc('eth_estimateGas',[tx]));demand(gas>0n&&gas<=2000000n,'gas_limit_exceeded');
        state.steps[action]={started:true};await persist();let submitted;
        try{submitted=await rpc('eth_sendTransaction',[{...tx,gas:`0x${((gas*125n+99n)/100n).toString(16)}`}]);}
        catch(error){if(error?.code===4001){state.steps[action].rejected=true;await persist();throw new Error('user_rejected_review_before_retry');}state.unknown=true;await persist();throw new Error('submission_unknown_do_not_resend');}
        if(!hash(submitted)){state.unknown=true;await persist();throw new Error('submission_unknown_do_not_resend');}
        state.steps[action].hash=submitted;await persist();return{action,hash:submitted,namespaceReady:false};
      }finally{busy=false;}
    },
    async verify(){
      demand(!busy,'flow_busy');busy=true;
      try{await account();const [finalized,latest]=await Promise.all([block('finalized'),block('latest')]);await Promise.all([canonical(finalized),canonical(latest)]);demand(BigInt(latest.number)>=BigInt(finalized.number),'finalized_ahead_of_latest');
        const diagnostics={},phase=await verifiedPhase(finalized,diagnostics);
        const pending=actions.find(action=>diagnostics[action]&&!diagnostics[action].receiptFinalized);
        if(pending){const evidence=diagnostics[pending];return{upperConnected:false,namespaceReady:false,pendingAction:pending,transactionHash:state.steps[pending].hash,...evidence,finalizedBlockNumber:BigInt(finalized.number).toString(),finalizedBlockTime:blockTime(finalized),latestBlockNumber:BigInt(latest.number).toString(),latestBlockTime:blockTime(latest),latestFinalizedLagBlocks:(BigInt(latest.number)-BigInt(finalized.number)).toString(),...(evidence.receiptConfirmed?{receiptFinalizedGapBlocks:(BigInt(evidence.receiptBlockNumber)-BigInt(finalized.number)).toString()}:{}),checkedAt:new Date().toISOString()};}
        await latestAndFinalized(phase);
        const upperConnected=phase===3;
        if(upperConnected){demand(!state.unknown,'unknown_outcome_requires_reconciliation');state.finalized=true;await persist();}
        return{upperConnected,namespaceReady:false,completedSteps:phase,receiptFinalized:upperConnected};
      }finally{busy=false;}
    },
  };
}
