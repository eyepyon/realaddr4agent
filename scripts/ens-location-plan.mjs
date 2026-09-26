import { concatHex, encodeAbiParameters, encodeFunctionData, getCreate2Address, keccak256, namehash, parseAbi, zeroAddress, zeroHash } from 'viem';
import { normalize } from 'viem/ens';
import { UPPER_ROOT_ROLES } from './ens-upper-plan.mjs';

export const LOCATION_CONTROLLER_ROLES = (1n << 0n) | (1n << 12n) | (1n << 16n);
export const LOCATION_ADMIN_ROLES = (1n << 8n) | (LOCATION_CONTROLLER_ROLES << 128n);
const factoryAbi = parseAbi(['function deployProxy(address implementation,uint256 salt,bytes data) returns(address)']);
const registryAbi = parseAbi(['function initialize(address rootAccount,uint256 roleBitmap)', 'function setParent(address parent,string label)', 'function grantRootRoles(uint256 roleBitmap,address account) returns(bool)', 'function register(string label,address owner,address registry,address resolver,uint256 roleBitmap,uint64 expiry) returns(uint256)']);
const controllerAbi = parseAbi(['function configureNamespace(bytes32 buildingKey,string slug,address registry)']);
const pinKeys = ['factory', 'userRegistryImplementation', 'proxyLogic', 'ethRegistry', 'upperRegistry', 'nameController', 'leaseRegistry', 'resolverImplementation'];
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const demand = (value, reason) => { if (!value) throw new Error(reason); };
const address = value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && !same(value, zeroAddress);
const hash = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value) && !same(value, zeroHash);
const uint = value => typeof value === 'bigint' && value >= 0n && value < (1n << 256n);
function label(value, min = 1) {
  if (typeof value !== 'string' || value.length < min || value.length > 63 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) return false;
  try { return normalize(value) === value; } catch { return false; }
}

/** Produces unsigned calls only. Snapshot code/roles and complete deployment-to-snapshot logs must already be verified by the caller. */
export function planLocationNamespace({ chainId, owner, publisher, parentName, locationSlug, buildingKey, salt, pins, snapshot, predictedCode }) {
  demand(chainId === 11155111, 'wrong_chain');
  demand(address(owner) && address(publisher), 'invalid_principal');
  demand(typeof parentName === 'string' && parentName.endsWith('.eth') && label(parentName.slice(0, -4), 3), 'invalid_parent');
  demand(label(locationSlug), 'invalid_location_slug');
  demand(hash(buildingKey) && uint(salt), 'invalid_location_identity');
  for (const key of pinKeys) demand(address(pins?.[key]?.address) && hash(pins[key].codeHash), 'invalid_pin');
  demand(new Set(pinKeys.map(key => pins[key].address.toLowerCase())).size === pinKeys.length, 'duplicate_pin');
  demand(snapshot?.chainId === chainId && snapshot.finalized === true && hash(snapshot.blockHash) && uint(snapshot.blockNumber) && uint(snapshot.timestamp), 'invalid_finalized_snapshot');
  for (const key of pinKeys) demand(same(snapshot.codeHashes?.[key], pins[key].codeHash), 'unverified_runtime_pin');
  demand(same(snapshot.factoryProxyLogic, pins.proxyLogic.address), 'factory_logic_mismatch');
  const parent = snapshot.parent, upper = snapshot.upper, controller = snapshot.controller;
  demand(parent?.parentName === parentName && same(parent.registry, pins.ethRegistry.address) && parent.status === 2 && same(parent.owner, owner) && uint(parent.expiry) && parent.expiry < (1n << 64n) && parent.expiry > snapshot.timestamp, 'parent_state_mismatch');
  demand(same(parent.subregistry, pins.upperRegistry.address) && same(parent.resolver, zeroAddress), 'parent_pointer_mismatch');
  demand(same(upper?.registry, pins.upperRegistry.address) && same(upper.parentRegistry, pins.ethRegistry.address) && upper.parentLabel === parentName.slice(0, -4) && same(upper.implementation, pins.userRegistryImplementation.address), 'upper_binding_mismatch');
  demand(same(upper.rootAccount, owner) && upper.ownerRootRoles === UPPER_ROOT_ROLES && upper.rootRoleCount === UPPER_ROOT_ROLES, 'upper_roles_mismatch');
  const free = upper.location;
  demand(free?.slug === locationSlug && free.status === 0 && free.expiry === 0n && same(free.owner, zeroAddress) && same(free.subregistry, zeroAddress) && same(free.resolver, zeroAddress), 'location_slug_unavailable');
  demand(same(controller?.address, pins.nameController.address) && same(controller.namespaceOwner, owner) && same(controller.leaseRegistry, pins.leaseRegistry.address) && same(controller.ethRegistry, pins.ethRegistry.address) && same(controller.upperRegistry, pins.upperRegistry.address) && same(controller.resolverFactory, pins.factory.address) && same(controller.resolverImplementation, pins.resolverImplementation.address) && controller.parentLabel === parentName.slice(0, -4) && same(controller.parentNode, namehash(parentName)), 'controller_binding_mismatch');
  demand(controller.adminAuthorized === true && same(controller.publisher, publisher) && controller.publisherAuthorized === true && controller.paused === false, 'controller_authorization_mismatch');
  const namespace = controller.namespace;
  demand(same(namespace?.buildingKey, buildingKey) && namespace.slug === '' && same(namespace.registry, zeroAddress) && same(namespace.node, zeroHash), 'building_namespace_already_configured');
  // There is no public slug-binding getter. Pristine evidence covers every NamespaceConfigured log from the verified deployment block to this snapshot.
  const pristine = controller.pristine;
  demand(pristine?.deploymentVerified === true && uint(pristine.deploymentBlockNumber) && pristine.deploymentBlockNumber <= snapshot.blockNumber && pristine.eventsComplete === true && pristine.eventsFromBlock === pristine.deploymentBlockNumber && pristine.eventsThroughBlock === snapshot.blockNumber && pristine.namespaceConfiguredEvents === 0, 'controller_not_verified_pristine');
  const outerSalt = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner, salt]));
  const runtime = concatHex(['0x363d3d373d3d3d363d73', pins.proxyLogic.address, '0x5af43d82803e903d91602b57fd5bf3', outerSalt]);
  const location = getCreate2Address({ from: pins.factory.address, salt: outerSalt, bytecode: concatHex(['0x3d604d80600a3d3981f3', runtime]) });
  demand(!pinKeys.some(key => same(location, pins[key].address)) && !same(location, owner) && !same(location, publisher), 'predicted_address_conflict');
  demand(predictedCode === '0x', 'location_address_occupied');
  const initialize = encodeFunctionData({ abi: registryAbi, functionName: 'initialize', args: [owner, LOCATION_ADMIN_ROLES] });
  const calls = [
    { action: 'deploy_location', to: pins.factory.address, value: '0x0', data: encodeFunctionData({ abi: factoryAbi, functionName: 'deployProxy', args: [pins.userRegistryImplementation.address, salt, initialize] }) },
    { action: 'set_location_parent', to: location, value: '0x0', data: encodeFunctionData({ abi: registryAbi, functionName: 'setParent', args: [pins.upperRegistry.address, locationSlug] }) },
    { action: 'grant_location_controller', to: location, value: '0x0', data: encodeFunctionData({ abi: registryAbi, functionName: 'grantRootRoles', args: [LOCATION_CONTROLLER_ROLES, pins.nameController.address] }) },
    { action: 'register_location', to: pins.upperRegistry.address, value: '0x0', data: encodeFunctionData({ abi: registryAbi, functionName: 'register', args: [locationSlug, owner, location, zeroAddress, 0n, parent.expiry] }) },
    { action: 'configure_location_namespace', to: pins.nameController.address, value: '0x0', data: encodeFunctionData({ abi: controllerAbi, functionName: 'configureNamespace', args: [buildingKey, locationSlug, location] }) },
  ];
  return { version: 1, chainId, owner, publisher, parentName, locationSlug, buildingKey, salt: salt.toString(), pins, location: { address: location, codeHash: keccak256(runtime), runtime, outerSalt }, calls,
    evidence: { blockNumber: snapshot.blockNumber.toString(), blockHash: snapshot.blockHash, parentExpiry: parent.expiry.toString(), controllerDeploymentBlock: pristine.deploymentBlockNumber.toString(), controllerLogsThroughBlock: pristine.eventsThroughBlock.toString() },
    expectedPostconditions: { parentOwner: owner, parentExpiry: parent.expiry.toString(), parentSubregistry: pins.upperRegistry.address, parentResolver: zeroAddress, upperParent: [pins.ethRegistry.address, parentName.slice(0, -4)], upperOwnerRoles: UPPER_ROOT_ROLES.toString(), locationStatus: 2, locationOwner: owner, locationOwnerRoles: '0', locationExpiry: parent.expiry.toString(), locationSubregistry: location, locationResolver: zeroAddress, locationParent: [pins.upperRegistry.address, locationSlug], locationOwnerRootRoles: LOCATION_ADMIN_ROLES.toString(), controllerRootRoles: LOCATION_CONTROLLER_ROLES.toString(), locationRootRoleCount: (LOCATION_ADMIN_ROLES | LOCATION_CONTROLLER_ROLES).toString(), locationImplementation: pins.userRegistryImplementation.address, namespace: { buildingKey, slug: locationSlug, registry: location, node: namehash(`${locationSlug}.${parentName}`) } },
    namespaceReady: false, livePreflightRequired: true };
}
