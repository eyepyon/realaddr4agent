import { keccak256, parseAbi } from 'viem';
import { controllerImmutableLayout, controllerRuntime, controllerValues, planControllerDeployment } from './ens-controller-plan.mjs';

// Synthetic bytecode and AST exercise the planner boundary; they are not deployment artifacts.
export function makeControllerFixture(){
  const owner=`0x${'10'.repeat(20)}`,parentLabel='example';
  const keys=['leaseRegistry','ethRegistry','upperRegistry','factory','resolverImplementation','userRegistryImplementation','proxyLogic'];
  const pins=Object.fromEntries(keys.map((key,index)=>[key,{address:`0x${(index+1).toString(16).padStart(40,'0')}`,codeHash:keccak256('0x6000')}]));
  const names=['LEASE_REGISTRY','ETH_REGISTRY','UPPER_REGISTRY','RESOLVER_FACTORY','RESOLVER_IMPLEMENTATION','NAMESPACE_OWNER','PARENT_NODE'];
  const types=['contract IRealAddrLeaseReader','contract IRealAddrEnsRegistry','contract IRealAddrEnsRegistry','contract IRealAddrEnsFactory','address','address','bytes32'];
  const ast={nodes:[{nodeType:'ContractDefinition',name:'RealAddrNameController',nodes:names.map((name,index)=>({nodeType:'VariableDeclaration',name,id:index+1,stateVariable:true,mutability:'immutable',typeDescriptions:{typeString:types[index]}}))}]};
  const artifact={abi:parseAbi(['constructor(address admin,address publisher,address leaseRegistry,address ethRegistry,address upperRegistry,address factory,address resolverImplementation,string parent)']),bytecode:{object:'0x6000',linkReferences:{}},deployedBytecode:{object:`0x6000${'00'.repeat(224)}6001`,linkReferences:{},immutableReferences:Object.fromEntries(names.map((_,index)=>[String(index+1),[{start:2+32*index,length:32}]]))},metadata:{compiler:{version:'0.8.30+synthetic'},settings:{evmVersion:'cancun',optimizer:{enabled:true,runs:200},compilationTarget:{'src/RealAddrNameController.sol':'RealAddrNameController'}}}};
  const upperProof={finalized:true,blockNumber:1n,blockHash:`0x${'11'.repeat(32)}`,timestamp:100n,parentExpiry:100000n,owner,upperParent:[pins.ethRegistry.address,parentLabel],rootRoles:65793n,rootRoleCount:65793n};
  const simulationRuntime=controllerRuntime(artifact.deployedBytecode.object,controllerImmutableLayout(artifact,ast),controllerValues(owner,parentLabel,pins));
  const input={artifact,ast,owner,parentLabel,pins,upperProof,simulationRuntime};
  return{...input,manifest:planControllerDeployment(input)};
}
