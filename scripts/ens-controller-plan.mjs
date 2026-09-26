import { encodeDeployData, keccak256, namehash, zeroAddress } from 'viem';
const names=['LEASE_REGISTRY','ETH_REGISTRY','UPPER_REGISTRY','RESOLVER_FACTORY','RESOLVER_IMPLEMENTATION','NAMESPACE_OWNER','PARENT_NODE'];
const constructorNames=['admin','publisher','leaseRegistry','ethRegistry','upperRegistry','factory','resolverImplementation','parent'];
const demand=(condition,reason)=>{if(!condition)throw new Error(reason);};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const address=value=>typeof value==='string'&&/^0x[0-9a-fA-F]{40}$/.test(value)&&!same(value,zeroAddress);
const hash=value=>typeof value==='string'&&/^0x[0-9a-fA-F]{64}$/.test(value);
const hex=value=>typeof value==='string'&&/^0x(?:[0-9a-fA-F]{2})+$/.test(value);
const bytes=value=>value.startsWith('0x')?value:`0x${value}`;
const roles=65793n;

export function controllerImmutableLayout(artifact,ast){
  const contract=ast?.nodes?.find(node=>node.nodeType==='ContractDefinition'&&node.name==='RealAddrNameController');
  demand(contract,'controller_ast_missing');
  const declarations=contract.nodes.filter(node=>node.nodeType==='VariableDeclaration'&&node.mutability==='immutable');
  demand(declarations.length===7&&names.every(name=>declarations.filter(node=>node.name===name).length===1),'controller_immutable_declarations_mismatch');
  const references=artifact?.deployedBytecode?.immutableReferences;
  demand(references&&Object.keys(references).length===7,'controller_immutable_references_missing');
  const ranges=[];
  const layout=names.map(name=>{
    const declaration=declarations.find(node=>node.name===name),entries=references[String(declaration.id)];
    const expectedTypes={LEASE_REGISTRY:'contract IRealAddrLeaseReader',ETH_REGISTRY:'contract IRealAddrEnsRegistry',UPPER_REGISTRY:'contract IRealAddrEnsRegistry',RESOLVER_FACTORY:'contract IRealAddrEnsFactory',RESOLVER_IMPLEMENTATION:'address',NAMESPACE_OWNER:'address',PARENT_NODE:'bytes32'};
    demand(declaration.stateVariable===true&&declaration.typeDescriptions?.typeString===expectedTypes[name],'controller_immutable_type_mismatch');
    demand(Number.isSafeInteger(declaration.id)&&Array.isArray(entries)&&entries.length>0,'controller_ast_reference_mismatch');
    for(const range of entries){demand(Object.keys(range).every(key=>['start','length'].includes(key))&&Number.isSafeInteger(range.start)&&range.start>=0&&range.length===32,'invalid_controller_immutable_range');ranges.push(range);}
    return{name,ranges:entries.map(({start,length})=>({start,length}))};
  });
  ranges.sort((a,b)=>a.start-b.start);for(let index=1;index<ranges.length;index++)demand(ranges[index].start>=ranges[index-1].start+32,'overlapping_controller_immutables');
  return layout;
}
export function controllerRuntime(template,layout,expected){
  demand(hex(template)&&Array.isArray(layout)&&layout.length===7&&names.every(name=>layout.filter(entry=>entry.name===name).length===1),'invalid_controller_runtime_layout');
  const output=template.slice(2).split(''),occupied=new Set();
  for(const entry of layout){const value=expected[entry.name];demand(hash(value),'invalid_controller_immutable_value');demand(Array.isArray(entry.ranges)&&entry.ranges.length>0,'invalid_controller_immutable_range');
    for(const range of entry.ranges){demand(Number.isSafeInteger(range.start)&&range.start>=0&&range.length===32&&(range.start+32)*2<=output.length,'invalid_controller_immutable_range');
      for(let index=range.start*2;index<(range.start+32)*2;index++){demand(!occupied.has(index)&&template.slice(2)[index]==='0','invalid_controller_immutable_placeholder');occupied.add(index);output[index]=value.slice(2)[index-range.start*2];}
    }
  }
  return`0x${output.join('')}`;
}
export function controllerValues(owner,parentLabel,pins){
  const word=value=>`0x${value.slice(2).toLowerCase().padStart(64,'0')}`;
  return{LEASE_REGISTRY:word(pins.leaseRegistry.address),ETH_REGISTRY:word(pins.ethRegistry.address),UPPER_REGISTRY:word(pins.upperRegistry.address),RESOLVER_FACTORY:word(pins.factory.address),RESOLVER_IMPLEMENTATION:word(pins.resolverImplementation.address),NAMESPACE_OWNER:word(owner),PARENT_NODE:namehash(`${parentLabel}.eth`)};
}
export function planControllerDeployment({artifact,ast,owner,parentLabel,pins,upperProof,simulationRuntime}){
  demand(address(owner)&&typeof parentLabel==='string'&&/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(parentLabel)&&parentLabel.slice(2,4)!=='--','invalid_controller_configuration');
  const keys=['leaseRegistry','ethRegistry','upperRegistry','factory','resolverImplementation','userRegistryImplementation','proxyLogic'];
  demand(pins&&Object.keys(pins).length===7&&keys.every(key=>address(pins[key]?.address)&&hash(pins[key]?.codeHash)),'invalid_controller_pin');
  demand(new Set(keys.map(key=>pins[key].address.toLowerCase())).size===7,'duplicate_controller_pin');
  const metadata=typeof artifact?.rawMetadata==='string'?JSON.parse(artifact.rawMetadata):artifact?.metadata;
  demand(metadata?.compiler?.version?.startsWith('0.8.30+')&&metadata.settings?.evmVersion==='cancun'&&metadata.settings.optimizer?.enabled===true&&metadata.settings.optimizer.runs===200&&metadata.settings.compilationTarget?.['src/RealAddrNameController.sol']==='RealAddrNameController','controller_build_mismatch');
  const ctor=artifact.abi?.find(entry=>entry.type==='constructor');
  demand(ctor?.inputs?.length===8&&ctor.inputs.every((entry,index)=>entry.name===constructorNames[index]&&entry.type===(index===7?'string':'address')),'controller_constructor_mismatch');
  const creation=bytes(artifact.bytecode?.object??''),template=bytes(artifact.deployedBytecode?.object??'');
  demand(hex(creation)&&hex(template)&&Object.keys(artifact.bytecode.linkReferences??{}).length===0&&Object.keys(artifact.deployedBytecode.linkReferences??{}).length===0,'invalid_controller_bytecode');
  demand(upperProof?.finalized===true&&typeof upperProof.blockNumber==='bigint'&&upperProof.blockNumber>=0n&&hash(upperProof.blockHash)&&typeof upperProof.timestamp==='bigint'&&upperProof.timestamp>=0n&&typeof upperProof.parentExpiry==='bigint'&&upperProof.parentExpiry>upperProof.timestamp&&upperProof.parentExpiry<(1n<<64n)&&same(upperProof.owner,owner)&&same(upperProof.upperParent?.[0],pins.ethRegistry.address)&&upperProof.upperParent?.[1]===parentLabel&&upperProof.rootRoles===roles&&upperProof.rootRoleCount===roles,'invalid_upper_proof');
  const layout=controllerImmutableLayout(artifact,ast),immutableValues=controllerValues(owner,parentLabel,pins),runtime=controllerRuntime(template,layout,immutableValues);
  demand(same(runtime,simulationRuntime),'controller_simulation_runtime_mismatch');
  const args=[owner,owner,pins.leaseRegistry.address,pins.ethRegistry.address,pins.upperRegistry.address,pins.factory.address,pins.resolverImplementation.address,parentLabel];
  const data=encodeDeployData({abi:artifact.abi,bytecode:creation,args});
  return{version:1,chainId:11155111,environment:'testnet',owner,parentLabel,pins,namespaceReady:false,livePreflightRequired:true,
    artifact:{abi:artifact.abi,creationBytecode:creation,runtimeTemplate:template,immutableLayout:layout,creationCodeHash:keccak256(creation),runtimeTemplateHash:keccak256(template)},
    transaction:{from:owner,chainId:'0xaa36a7',value:'0x0',data},initCodeHash:keccak256(data),expectedRuntime:runtime,expectedRuntimeCodeHash:keccak256(runtime),immutableValues,
    constructor:{admin:owner,publisher:owner,leaseRegistry:pins.leaseRegistry.address,ethRegistry:pins.ethRegistry.address,upperRegistry:pins.upperRegistry.address,factory:pins.factory.address,resolverImplementation:pins.resolverImplementation.address,parent:parentLabel},
    evidence:{blockNumber:upperProof.blockNumber.toString(),blockHash:upperProof.blockHash,parentExpiry:upperProof.parentExpiry.toString()},
  };
}
