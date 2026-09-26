import { keccak256, namehash, zeroAddress, zeroHash } from 'viem';
import { planLocationNamespace } from './ens-location-plan.mjs';
import { UPPER_ROOT_ROLES } from './ens-upper-plan.mjs';
// Synthetic addresses and snapshots exercise only the unsigned planner and flow boundary.
export function makeLocationFixture(){
  const address=n=>`0x${n.toString(16).padStart(40,'0')}`,hash=n=>`0x${n.toString(16).padStart(64,'0')}`,pin=n=>({address:address(n),codeHash:keccak256('0x6000')});
  const pins={factory:pin(2),userRegistryImplementation:pin(3),proxyLogic:pin(4),ethRegistry:pin(5),upperRegistry:pin(6),nameController:pin(7),leaseRegistry:pin(8),resolverImplementation:pin(9)},owner=address(1),publisher=address(10),buildingKey=hash(42),parentName='example.eth',locationSlug='demo-place';
  const input={chainId:11155111,owner,publisher,parentName,locationSlug,buildingKey,salt:43n,pins,predictedCode:'0x',snapshot:{chainId:11155111,finalized:true,blockNumber:100n,blockHash:hash(100),timestamp:1000n,codeHashes:Object.fromEntries(Object.entries(pins).map(([key,value])=>[key,value.codeHash])),factoryProxyLogic:pins.proxyLogic.address,
    parent:{parentName,registry:pins.ethRegistry.address,status:2,owner,expiry:2000n,subregistry:pins.upperRegistry.address,resolver:zeroAddress},
    upper:{registry:pins.upperRegistry.address,parentRegistry:pins.ethRegistry.address,parentLabel:'example',implementation:pins.userRegistryImplementation.address,rootAccount:owner,ownerRootRoles:UPPER_ROOT_ROLES,rootRoleCount:UPPER_ROOT_ROLES,location:{slug:locationSlug,status:0,expiry:0n,owner:zeroAddress,subregistry:zeroAddress,resolver:zeroAddress}},
    controller:{address:pins.nameController.address,namespaceOwner:owner,leaseRegistry:pins.leaseRegistry.address,ethRegistry:pins.ethRegistry.address,upperRegistry:pins.upperRegistry.address,resolverFactory:pins.factory.address,resolverImplementation:pins.resolverImplementation.address,parentLabel:'example',parentNode:namehash(parentName),adminAuthorized:true,publisher,publisherAuthorized:true,paused:false,namespace:{buildingKey,slug:'',registry:zeroAddress,node:zeroHash},pristine:{deploymentVerified:true,deploymentBlockNumber:90n,eventsComplete:true,eventsFromBlock:90n,eventsThroughBlock:100n,namespaceConfiguredEvents:0}}}};
  return{input,manifest:planLocationNamespace(input)};
}
