import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, keccak256, namehash, parseAbi, zeroAddress, zeroHash } from 'viem';
import { planLocationNamespace, LOCATION_ADMIN_ROLES, LOCATION_CONTROLLER_ROLES } from './ens-location-plan.mjs';
import { UPPER_ROOT_ROLES } from './ens-upper-plan.mjs';
const address = n => `0x${n.toString(16).padStart(40,'0')}`;
const hash = n => `0x${n.toString(16).padStart(64,'0')}`;
const pin = n => ({address:address(n),codeHash:keccak256('0x6000')});
function fixture() {
 const pins={factory:pin(2),userRegistryImplementation:pin(3),proxyLogic:pin(4),ethRegistry:pin(5),upperRegistry:pin(6),nameController:pin(7),leaseRegistry:pin(8),resolverImplementation:pin(9)};
 const owner=address(1),publisher=address(10),buildingKey=hash(42),parentName='example.eth',locationSlug='demo-place';
 return {chainId:11155111,owner,publisher,parentName,locationSlug,buildingKey,salt:43n,pins,predictedCode:'0x',snapshot:{chainId:11155111,finalized:true,blockNumber:100n,blockHash:hash(100),timestamp:1000n,codeHashes:Object.fromEntries(Object.entries(pins).map(([key,value])=>[key,value.codeHash])),factoryProxyLogic:pins.proxyLogic.address,
 parent:{parentName,registry:pins.ethRegistry.address,status:2,owner,expiry:2000n,subregistry:pins.upperRegistry.address,resolver:zeroAddress},
 upper:{registry:pins.upperRegistry.address,parentRegistry:pins.ethRegistry.address,parentLabel:'example',implementation:pins.userRegistryImplementation.address,rootAccount:owner,ownerRootRoles:UPPER_ROOT_ROLES,rootRoleCount:UPPER_ROOT_ROLES,location:{slug:locationSlug,status:0,expiry:0n,owner:zeroAddress,subregistry:zeroAddress,resolver:zeroAddress}},
 controller:{address:pins.nameController.address,namespaceOwner:owner,leaseRegistry:pins.leaseRegistry.address,ethRegistry:pins.ethRegistry.address,upperRegistry:pins.upperRegistry.address,resolverFactory:pins.factory.address,resolverImplementation:pins.resolverImplementation.address,parentLabel:'example',parentNode:namehash(parentName),adminAuthorized:true,publisher,publisherAuthorized:true,paused:false,namespace:{buildingKey,slug:'',registry:zeroAddress,node:zeroHash},pristine:{deploymentVerified:true,deploymentBlockNumber:90n,eventsComplete:true,eventsFromBlock:90n,eventsThroughBlock:100n,namespaceConfiguredEvents:0}}}};
}
test('location plan uses exactly five zero-value calls and separates admin from controller operational roles',()=>{
 const input=fixture(),plan=planLocationNamespace(input);
 assert.equal(LOCATION_CONTROLLER_ROLES,69633n);assert.equal(LOCATION_ADMIN_ROLES,(1n<<8n)|(69633n<<128n));assert.equal(LOCATION_ADMIN_ROLES&LOCATION_CONTROLLER_ROLES,0n);
 assert.deepEqual(plan.calls.map(call=>call.action),['deploy_location','set_location_parent','grant_location_controller','register_location','configure_location_namespace']);assert.ok(plan.calls.every(call=>call.value==='0x0'));
 const deployed=decodeFunctionData({abi:parseAbi(['function deployProxy(address implementation,uint256 salt,bytes data) returns(address)']),data:plan.calls[0].data});assert.equal(deployed.args[0],input.pins.userRegistryImplementation.address);assert.equal(deployed.args[1],43n);
 const initialized=decodeFunctionData({abi:parseAbi(['function initialize(address rootAccount,uint256 roleBitmap)']),data:deployed.args[2]});assert.deepEqual(initialized.args,[input.owner,LOCATION_ADMIN_ROLES]);
 const parent=decodeFunctionData({abi:parseAbi(['function setParent(address parent,string label)']),data:plan.calls[1].data});assert.deepEqual(parent.args,[input.pins.upperRegistry.address,input.locationSlug]);
 const grant=decodeFunctionData({abi:parseAbi(['function grantRootRoles(uint256 roleBitmap,address account) returns(bool)']),data:plan.calls[2].data});assert.deepEqual(grant.args,[LOCATION_CONTROLLER_ROLES,input.pins.nameController.address]);
 const register=decodeFunctionData({abi:parseAbi(['function register(string label,address owner,address registry,address resolver,uint256 roleBitmap,uint64 expiry) returns(uint256)']),data:plan.calls[3].data});assert.deepEqual(register.args,[input.locationSlug,input.owner,plan.location.address,zeroAddress,0n,2000n]);
 const configure=decodeFunctionData({abi:parseAbi(['function configureNamespace(bytes32 buildingKey,string slug,address registry)']),data:plan.calls[4].data});assert.deepEqual(configure.args,[input.buildingKey,input.locationSlug,plan.location.address]);
 assert.equal(plan.expectedPostconditions.namespace.node,namehash('demo-place.example.eth'));assert.equal(plan.namespaceReady,false);assert.equal(plan.livePreflightRequired,true);assert.equal(plan.location.codeHash,keccak256(plan.location.runtime));
});
test('planner rejects unverified hierarchy, roles, controller binding and non-pristine log evidence',()=>{
 for(const change of [
  i=>i.snapshot.finalized=false,i=>i.snapshot.codeHashes.nameController=hash(999),i=>i.snapshot.factoryProxyLogic=address(99),i=>i.snapshot.parent.owner=address(99),i=>i.snapshot.parent.expiry=1000n,i=>i.snapshot.parent.subregistry=zeroAddress,i=>i.snapshot.parent.resolver=address(99),i=>i.snapshot.upper.parentLabel='other',i=>i.snapshot.upper.implementation=address(99),i=>i.snapshot.upper.ownerRootRoles|=1n<<28n,i=>i.snapshot.upper.rootRoleCount|=1n<<124n,
  i=>i.snapshot.controller.upperRegistry=address(99),i=>i.snapshot.controller.leaseRegistry=address(99),i=>i.snapshot.controller.namespaceOwner=address(99),i=>i.snapshot.controller.parentNode=hash(99),i=>i.snapshot.controller.adminAuthorized=false,i=>i.snapshot.controller.publisherAuthorized=false,i=>i.snapshot.controller.namespace.registry=address(99),i=>i.snapshot.controller.namespace.buildingKey=hash(99),i=>i.snapshot.controller.pristine.eventsComplete=false,i=>i.snapshot.controller.pristine.eventsFromBlock=91n,i=>i.snapshot.controller.pristine.eventsThroughBlock=99n,i=>i.snapshot.controller.pristine.namespaceConfiguredEvents=1,i=>i.snapshot.controller.pristine.deploymentVerified=false,
 ]) {const input=fixture();change(input);assert.throws(()=>planLocationNamespace(input));}
});
test('planner rejects unavailable slug, occupied proxy, malformed identity and duplicate pins',()=>{
 for(const change of [i=>i.predictedCode='0x6000',i=>i.snapshot.upper.location.status=2,i=>i.snapshot.upper.location.subregistry=address(99),i=>i.snapshot.upper.location.owner=address(99),i=>i.snapshot.upper.location.expiry=2000n,i=>i.buildingKey=zeroHash,i=>i.locationSlug='Mixed',i=>i.locationSlug='a.b',i=>i.locationSlug='xn--bad',i=>i.salt=-1n,i=>i.salt=1n<<256n,i=>i.chainId=84532,i=>i.pins.nameController=i.pins.upperRegistry]){const input=fixture();change(input);assert.throws(()=>planLocationNamespace(input));}
});
test('proxy derivation freezes caller and salt independently of implementation',()=>{
 const first=planLocationNamespace(fixture()),secondInput=fixture();secondInput.salt=44n;assert.notEqual(planLocationNamespace(secondInput).location.address,first.location.address);
 const implementation=fixture();implementation.pins.userRegistryImplementation=pin(11);implementation.snapshot.codeHashes.userRegistryImplementation=implementation.pins.userRegistryImplementation.codeHash;implementation.snapshot.upper.implementation=implementation.pins.userRegistryImplementation.address;assert.equal(planLocationNamespace(implementation).location.address,first.location.address);assert.notEqual(planLocationNamespace(implementation).calls[0].data,first.calls[0].data);
});
