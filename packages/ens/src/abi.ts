import { parseAbi } from 'viem';

export const registryAbi = parseAbi([
  'function getSubregistry(string label) view returns (address)',
  'function getResolver(string label) view returns (address)',
  'function getState(uint256 anyId) view returns ((uint8 status,uint64 expiry,address latestOwner,uint256 tokenId,uint256 resource))',
  'function hasRootRoles(uint256 roles,address account) view returns (bool)',
  'function hasRoles(uint256 resource,uint256 roles,address account) view returns (bool)',
  'function roles(uint256 resource,address account) view returns (uint256)',
  'function getParent() view returns (address parent,string label)',
]);
export const universalResolverAbi = parseAbi([
  'function ROOT_REGISTRY() view returns (address)',
  'function findParentRegistry(bytes name) view returns (address)',
  'function findResolver(bytes name) view returns (address resolver,bytes32 node,uint256 offset)',
  'function resolve(bytes name,bytes data) view returns (bytes,address)',
]);
export const resolverAbi = parseAbi([
  'function setText(bytes32 node,string key,string value)',
  'function text(bytes32 node,string key) view returns (string)',
  'function addr(bytes32 node) view returns (address)',
  'function authorizeTextRoles(bytes name,string key,address account,bool grant) returns (bool)',
  'function getAlias(bytes name) view returns (bytes)',
  'function hasRootRoles(uint256 roles,address account) view returns (bool)',
  'function hasRoles(uint256 resource,uint256 roles,address account) view returns (bool)',
  'function roles(uint256 resource,address account) view returns (uint256)',
]);
export const factoryAbi = parseAbi([
  'function proxyLogic() view returns (address)',
  'function deployProxy(address implementation,uint256 salt,bytes data) returns (address proxy)',
  'function verifyContract(address proxy) view returns (address implementation)',
]);
export const controllerAbi = parseAbi([
  'function getBinding(bytes32 node) view returns (bytes32 leaseKey,address owner,address resolver,uint64 leaseVersion,bool disabled)',
  'function getNamespace(bytes32 buildingKey) view returns (string slug,address registry,bytes32 node)',
  'function paused() view returns (bool)',
  'function parentLabel() view returns (string)',
  'function ETH_REGISTRY() view returns (address)',
  'function UPPER_REGISTRY() view returns (address)',
  'function RESOLVER_FACTORY() view returns (address)',
  'function RESOLVER_IMPLEMENTATION() view returns (address)',
  'function LEASE_REGISTRY() view returns (address)',
]);
export const leaseRegistryAbi = parseAbi([
  'function getLease(bytes32 leaseKey) view returns (bytes32 buildingKey,uint16 slot,bytes32 holderCommitment,uint64 expiresAt,uint64 version,bool revoked)',
  'function paused() view returns (bool)',
]);
