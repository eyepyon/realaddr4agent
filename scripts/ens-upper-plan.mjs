import { concatHex, encodeAbiParameters, encodeFunctionData, getCreate2Address, keccak256, parseAbi, stringToHex, zeroAddress } from 'viem';

const factoryAbi=parseAbi(['function deployProxy(address implementation,uint256 salt,bytes data) returns(address)']);
const registryAbi=parseAbi(['function initialize(address rootAccount,uint256 roleBitmap)','function setParent(address parent,string label)','function setSubregistry(uint256 anyId,address registry)']);
export const UPPER_ROOT_ROLES=(1n<<0n)|(1n<<8n)|(1n<<16n);
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const requireValue=(condition,reason)=>{if(!condition)throw new Error(reason);};
const address=value=>/^0x[0-9a-fA-F]{40}$/.test(value??'')&&!same(value,zeroAddress);
const hash=value=>/^0x[0-9a-fA-F]{64}$/.test(value??'')&&!/^0x0{64}$/.test(value);
const uint=value=>typeof value==='bigint'&&value>=0n&&value<(1n<<256n);

/** Builds unsigned calls from explicit reviewed evidence; live preflight is still required. */
export function planUpperRegistry({chainId,owner,parentName,salt,pins,parentSnapshot,predictedCode}) {
  requireValue(chainId===11155111,'wrong_chain');
  requireValue(address(owner),'invalid_owner');
  requireValue(typeof parentName==='string'&&/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])\.eth$/.test(parentName)&&parentName.slice(0,-4).slice(2,4)!=='--','invalid_parent');
  requireValue(uint(salt),'invalid_salt');
  for(const key of ['factory','userRegistryImplementation','proxyLogic','ethRegistry']) requireValue(address(pins?.[key]?.address)&&hash(pins[key].codeHash),'invalid_pin');
  requireValue(new Set(Object.values(pins).map(pin=>pin.address.toLowerCase())).size===4,'duplicate_pin');
  const snapshot=parentSnapshot;
  requireValue(snapshot?.chainId===chainId&&snapshot.finalized===true&&hash(snapshot.blockHash)&&uint(snapshot.blockNumber)&&uint(snapshot.timestamp),'invalid_finalized_snapshot');
  requireValue(snapshot.parentName===parentName&&same(snapshot.registry,pins.ethRegistry.address)&&snapshot.status===2&&same(snapshot.owner,owner)&&uint(snapshot.expiry)&&snapshot.expiry<(1n<<64n)&&snapshot.expiry>snapshot.timestamp,'parent_state_mismatch');
  requireValue(same(snapshot.subregistry,zeroAddress)&&same(snapshot.resolver,zeroAddress)&&snapshot.ownerCanSetSubregistry===true,'parent_pointer_or_role_mismatch');
  requireValue(same(snapshot.factoryProxyLogic,pins.proxyLogic.address),'factory_logic_mismatch');
  const outerSalt=keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}],[owner,salt]));
  const runtime=concatHex(['0x363d3d373d3d3d363d73',pins.proxyLogic.address,'0x5af43d82803e903d91602b57fd5bf3',outerSalt]);
  const creationCode=concatHex(['0x3d604d80600a3d3981f3',runtime]);
  const upper=getCreate2Address({from:pins.factory.address,salt:outerSalt,bytecode:creationCode});
  requireValue(predictedCode==='0x','upper_address_occupied');
  const label=parentName.slice(0,-4),labelHash=keccak256(stringToHex(label));
  const initialize=encodeFunctionData({abi:registryAbi,functionName:'initialize',args:[owner,UPPER_ROOT_ROLES]});
  const calls=[
    {action:'deploy_upper',to:pins.factory.address,value:'0x0',data:encodeFunctionData({abi:factoryAbi,functionName:'deployProxy',args:[pins.userRegistryImplementation.address,salt,initialize]})},
    {action:'set_upper_parent',to:upper,value:'0x0',data:encodeFunctionData({abi:registryAbi,functionName:'setParent',args:[pins.ethRegistry.address,label]})},
    {action:'attach_upper',to:pins.ethRegistry.address,value:'0x0',data:encodeFunctionData({abi:registryAbi,functionName:'setSubregistry',args:[BigInt(labelHash),upper]})},
  ];
  return {version:1,chainId,owner,parentName,salt:salt.toString(),pins,upper:{address:upper,codeHash:keccak256(runtime),runtime,outerSalt},calls,
    evidence:{blockNumber:snapshot.blockNumber.toString(),blockHash:snapshot.blockHash,parentExpiry:snapshot.expiry.toString()},
    expectedPostconditions:{parentOwner:owner,parentExpiry:snapshot.expiry.toString(),parentSubregistry:upper,parentResolver:zeroAddress,upperParent:[pins.ethRegistry.address,label],upperRootAccount:owner,upperRootRoles:UPPER_ROOT_ROLES.toString(),upperImplementation:pins.userRegistryImplementation.address},
    namespaceReady:false,livePreflightRequired:true};
}
