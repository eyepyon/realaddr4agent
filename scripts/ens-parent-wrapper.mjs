import { decodeFunctionData, encodeFunctionData, decodeAbiParameters, encodeAbiParameters, parseAbi, keccak256, zeroHash } from 'viem';
import { recoverAuthorizationAddress } from 'viem/utils';

const abi = parseAbi(['function redeemDelegations(bytes[] permissionContexts,bytes32[] modes,bytes[] executionCallDatas)']);
const delegationType = [{ type: 'tuple[]', components: [
  {name:'delegate',type:'address'}, {name:'delegator',type:'address'}, {name:'authority',type:'bytes32'},
  {name:'caveats',type:'tuple[]',components:[{name:'enforcer',type:'address'},{name:'terms',type:'bytes'},{name:'args',type:'bytes'}]},
  {name:'salt',type:'uint256'}, {name:'signature',type:'bytes'},
] }];
const same = (a,b) => typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();
const demand = (condition,reason) => { if(!condition) throw new Error(reason); };

export function validateWrapperPolicy(policy) {
  demand(policy?.version===1 && policy.chainId===11155111,'invalid_wrapper_policy');
  for(const key of ['manager','delegator','native','erc20']) demand(/^0x[0-9a-fA-F]{40}$/.test(policy[key]?.address??'') && !/^0x0{40}$/.test(policy[key].address) && /^0x[0-9a-fA-F]{64}$/.test(policy[key]?.codeHash??''),'invalid_wrapper_pin');
}

export function decodeExactWrapper(transaction,expected,owner,paymentToken,policy) {
  validateWrapperPolicy(policy);
  demand(same(transaction.from,owner) && same(transaction.to,policy.manager.address) && BigInt(transaction.value)===0n && BigInt(transaction.chainId)===11155111n,'wrapper_transaction_mismatch');
  demand(transaction.type==='0x4' || transaction.type==='0x2','unsupported_wrapper_type');
  const decoded=decodeFunctionData({abi,data:transaction.input});
  demand(same(encodeFunctionData({abi,functionName:decoded.functionName,args:decoded.args}),transaction.input),'noncanonical_wrapper_calldata');
  const [contexts,modes,executions]=decoded.args;
  demand(contexts.length===1 && modes.length===1 && executions.length===1 && same(modes[0],zeroHash),'unsupported_wrapper_execution');
  const execution=executions[0];
  demand(/^0x[0-9a-fA-F]+$/.test(execution) && execution.length>=106 && same(execution.slice(0,42),expected.to) && BigInt(`0x${execution.slice(42,106)}`)===BigInt(expected.value) && same(`0x${execution.slice(106)}`,expected.data),'wrapper_inner_call_mismatch');
  const [delegations]=decodeAbiParameters(delegationType,contexts[0]);
  demand(same(encodeAbiParameters(delegationType,[delegations]),contexts[0]),'noncanonical_wrapper_context');
  demand(delegations.length===1,'unsupported_wrapper_delegation_chain');
  const delegation=delegations[0];
  demand(same(delegation.delegate,owner) && same(delegation.delegator,owner) && delegation.authority===`0x${'f'.repeat(64)}` && /^0x[0-9a-fA-F]{130}$/.test(delegation.signature),'unsupported_wrapper_authority');
  demand(delegation.caveats.length>=1 && delegation.caveats.length<=2,'unsupported_wrapper_caveats');
  const used=new Set();
  for(const caveat of delegation.caveats) {
    const kind=same(caveat.enforcer,policy.native.address)?'native':same(caveat.enforcer,policy.erc20.address)?'erc20':undefined;
    demand(kind && !used.has(kind) && caveat.args==='0x','unsupported_wrapper_caveat'); used.add(kind);
    if(kind==='native') {
      demand(/^0x[0-9a-fA-F]{106}$/.test(caveat.terms) && caveat.terms.slice(2,4)==='01' && same(`0x${caveat.terms.slice(4,44)}`,owner) && BigInt(`0x${caveat.terms.slice(44)}`)===0n,'unsupported_native_balance_guard');
    } else demand(/^0x[0-9a-fA-F]{146}$/.test(caveat.terms) && ['00','01'].includes(caveat.terms.slice(2,4)) && same(`0x${caveat.terms.slice(4,44)}`,paymentToken) && same(`0x${caveat.terms.slice(44,84)}`,owner),'unsupported_token_balance_guard');
  }
  demand(used.has('native'),'native_balance_guard_missing');
  const authorizations=transaction.authorizationList??[];
  demand(Array.isArray(authorizations) && authorizations.length<=1 && (transaction.type!=='0x4' || authorizations.length===1),'unsupported_wrapper_authorizations');
  return { usedEnforcers:[...used],authorizations };
}

export async function verifyExactWrapper({transaction,expected,owner,paymentToken,policy,blockNumber,rpc}) {
  const decoded=decodeExactWrapper(transaction,expected,owner,paymentToken,policy);
  for(const key of ['manager','delegator',...decoded.usedEnforcers]) {
    const code=await rpc('eth_getCode',[policy[key].address,blockNumber]);
    demand(code!=='0x' && same(keccak256(code),policy[key].codeHash),'wrapper_runtime_mismatch');
  }
  demand(same(await rpc('eth_getCode',[owner,blockNumber]),`0xef0100${policy.delegator.address.slice(2)}`),'owner_delegation_mismatch');
  for(const authorization of decoded.authorizations) {
    demand(same(authorization.address,policy.delegator.address) && BigInt(authorization.chainId)===11155111n,'wrapper_authorization_mismatch');
    const recovered=await recoverAuthorizationAddress({authorization:{address:authorization.address,chainId:11155111,nonce:BigInt(authorization.nonce),yParity:Number(BigInt(authorization.yParity)),r:authorization.r,s:authorization.s}});
    demand(same(recovered,owner),'wrapper_authorization_owner_mismatch');
  }
  return true;
}
