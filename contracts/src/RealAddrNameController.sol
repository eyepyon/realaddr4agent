// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface IRealAddrLeaseReader {
    function getLease(bytes32 key) external view returns
        (bytes32 buildingKey, uint16 slot, bytes32 holderCommitment, uint64 expiresAt, uint64 version, bool revoked);
}

interface IRealAddrEnsRegistry {
    struct State { uint8 status; uint64 expiry; address latestOwner; uint256 tokenId; uint256 resource; }
    function getState(uint256 anyId) external view returns (State memory);
    function getSubregistry(string calldata label) external view returns (address);
    function getResolver(string calldata label) external view returns (address);
    function hasRoles(uint256 anyId, uint256 bitmap, address account) external view returns (bool);
    function register(string calldata label, address owner, address subregistry, address resolver,
        uint256 ownerRoles, uint64 expiry) external returns (uint256);
    function renew(uint256 anyId, uint64 expiry) external;
    function unregister(uint256 anyId) external;
}

interface IRealAddrEnsFactory {
    function deployProxy(address implementation, uint256 salt, bytes calldata data) external returns (address);
    function verifyContract(address proxy) external view returns (address implementation);
}

interface IRealAddrEnsResolver {
    function initialize(address admin, uint256 bitmap, bytes[] calldata setters) external;
    function setText(bytes32 node, string calldata key, string calldata value) external;
    function setAddr(bytes32 node, uint256 coinType, bytes calldata value) external;
    function authorizeTextRoles(bytes calldata name, string calldata key, address account, bool grant) external;
}

/// @notice Publishes operator-confirmed paid add-ons; it does not verify cross-chain payments.
contract RealAddrNameController is AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant PUBLISHER_ROLE = keccak256("PUBLISHER_ROLE");
    uint256 private constant REGISTRY_ROLES = (1 << 0) | (1 << 12) | (1 << 16);
    uint256 private constant RESOLVER_ROLES = (1 << 0) | (1 << 4) | (uint256(1) << 132);
    uint256 private constant TRANSFER_ADMIN = uint256(1) << 156;
    string public constant API_ORIGIN = "https://address.chain.tokyo";
    IRealAddrLeaseReader public immutable LEASE_REGISTRY;
    IRealAddrEnsRegistry public immutable ETH_REGISTRY;
    IRealAddrEnsRegistry public immutable UPPER_REGISTRY;
    IRealAddrEnsFactory public immutable RESOLVER_FACTORY;
    address public immutable RESOLVER_IMPLEMENTATION;
    address public immutable NAMESPACE_OWNER;
    bytes32 public immutable PARENT_NODE;
    string public parentLabel;

    struct Namespace { string slug; address registry; bytes32 node; }
    struct Binding {
        bytes32 leaseKey; bytes32 buildingKey; address owner; address resolver;
        uint64 leaseVersion; bool disabled; string label;
    }
    struct Lease {
        bytes32 buildingKey; uint16 slot; bytes32 holderCommitment;
        uint64 expiresAt; uint64 version; bool revoked;
    }
    struct BindRequest {
        bytes32 leaseKey; bytes32 buildingKey; uint16 slot; uint8 nameType; uint16 namePolicyVersion;
        string label; address owner; bytes32 holderSalt; uint64 leaseVersion;
    }
    mapping(bytes32 buildingKey => Namespace) private namespaces;
    mapping(bytes32 node => Binding) private bindings;
    mapping(bytes32 leaseKey => bytes32 node) public leaseNames;
    mapping(bytes32 slugHash => bytes32 buildingKey) private namespaceBuildings;

    error InvalidConfiguration();
    error InvalidName();
    error InvalidLease();
    error NamespaceUnavailable();
    error BindingConflict();
    error NameDisabled();
    event NamespaceConfigured(bytes32 indexed buildingKey, string slug, address registry);
    event NameBound(bytes32 indexed node, bytes32 indexed leaseKey, address resolver, uint64 version);
    event NameDisabledEvent(bytes32 indexed node, uint64 version);

    constructor(address admin, address publisher, address leaseRegistry, address ethRegistry,
        address upperRegistry, address factory, address resolverImplementation, string memory parent)
    {
        if (admin == address(0) || publisher == address(0) || leaseRegistry.code.length == 0
            || ethRegistry.code.length == 0 || upperRegistry.code.length == 0
            || factory.code.length == 0 || resolverImplementation.code.length == 0) revert InvalidConfiguration();
        _label(parent, 3, 63);
        LEASE_REGISTRY = IRealAddrLeaseReader(leaseRegistry);
        ETH_REGISTRY = IRealAddrEnsRegistry(ethRegistry);
        UPPER_REGISTRY = IRealAddrEnsRegistry(upperRegistry);
        RESOLVER_FACTORY = IRealAddrEnsFactory(factory);
        RESOLVER_IMPLEMENTATION = resolverImplementation;
        NAMESPACE_OWNER = admin;
        parentLabel = parent;
        PARENT_NODE = keccak256(abi.encodePacked(keccak256(abi.encodePacked(bytes32(0), keccak256("eth"))), keccak256(bytes(parent))));
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PUBLISHER_ROLE, publisher);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    function configureNamespace(bytes32 buildingKey, string calldata slug, address registry)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _label(slug, 1, 63);
        if (buildingKey == bytes32(0) || registry.code.length == 0) revert InvalidConfiguration();
        Namespace storage previous = namespaces[buildingKey];
        bytes32 slugHash = keccak256(bytes(slug));
        if ((previous.registry != address(0) && (previous.registry != registry || keccak256(bytes(previous.slug)) != slugHash))
            || (namespaceBuildings[slugHash] != bytes32(0) && namespaceBuildings[slugHash] != buildingKey)) revert BindingConflict();
        Namespace memory candidate = Namespace(slug, registry, keccak256(abi.encodePacked(PARENT_NODE, slugHash)));
        _namespace(candidate, uint64(block.timestamp + 1));
        namespaces[buildingKey] = candidate;
        namespaceBuildings[slugHash] = buildingKey;
        emit NamespaceConfigured(buildingKey, slug, registry);
    }

    function getNamespace(bytes32 buildingKey) external view returns (string memory slug, address registry, bytes32 node) {
        Namespace storage n = namespaces[buildingKey];
        return (n.slug, n.registry, n.node);
    }

    function bindLease(BindRequest calldata request)
        external onlyRole(PUBLISHER_ROLE) whenNotPaused nonReentrant returns (bytes32 node, address resolver)
    {
        Lease memory lease = _lease(request.leaseKey);
        if (request.leaseKey == bytes32(0) || request.owner == address(0) || lease.buildingKey != request.buildingKey || lease.slot != request.slot
            || lease.version != request.leaseVersion || lease.holderCommitment != keccak256(abi.encode(request.owner, request.holderSalt))) revert InvalidLease();
        _active(lease);
        _name(request.label, request.nameType, request.namePolicyVersion, request.slot);
        Namespace memory ns = namespaces[request.buildingKey];
        _namespace(ns, lease.expiresAt);
        node = keccak256(abi.encodePacked(ns.node, keccak256(bytes(request.label))));
        Binding storage binding = bindings[node];
        if ((leaseNames[request.leaseKey] != bytes32(0) && leaseNames[request.leaseKey] != node)
            || (binding.leaseKey != bytes32(0) && (binding.leaseKey != request.leaseKey || binding.owner != request.owner))) revert BindingConflict();
        if (binding.disabled) revert NameDisabled();
        if (binding.leaseKey == bytes32(0)) {
            bytes[] memory setters = new bytes[](0);
            resolver = RESOLVER_FACTORY.deployProxy(RESOLVER_IMPLEMENTATION, uint256(request.leaseKey),
                abi.encodeCall(IRealAddrEnsResolver.initialize, (address(this), RESOLVER_ROLES, setters)));
            if (RESOLVER_FACTORY.verifyContract(resolver) != RESOLVER_IMPLEMENTATION) revert InvalidConfiguration();
            bindings[node] = Binding(request.leaseKey, request.buildingKey, request.owner, resolver, request.leaseVersion, false, request.label);
            leaseNames[request.leaseKey] = node;
            _records(node, bindings[node], ns);
        } else {
            if (request.leaseVersion < binding.leaseVersion) revert InvalidLease();
            resolver = binding.resolver;
        }
        _register(node, bindings[node], ns, lease.expiresAt);
        bindings[node].leaseVersion = request.leaseVersion;
        emit NameBound(node, request.leaseKey, resolver, request.leaseVersion);
    }

    function syncLease(bytes32 node, uint64 leaseVersion) external onlyRole(PUBLISHER_ROLE) whenNotPaused nonReentrant {
        Binding storage binding = bindings[node];
        if (binding.leaseKey == bytes32(0)) revert BindingConflict();
        if (binding.disabled) revert NameDisabled();
        Lease memory lease = _lease(binding.leaseKey);
        _active(lease);
        if (lease.version != leaseVersion || leaseVersion < binding.leaseVersion || lease.buildingKey != binding.buildingKey) revert InvalidLease();
        Namespace memory ns = namespaces[binding.buildingKey];
        _namespace(ns, lease.expiresAt);
        _register(node, binding, ns, lease.expiresAt);
        binding.leaseVersion = leaseVersion;
        emit NameBound(node, binding.leaseKey, binding.resolver, leaseVersion);
    }

    function disableName(bytes32 node, uint64 leaseVersion) external onlyRole(PUBLISHER_ROLE) nonReentrant {
        Binding storage binding = bindings[node];
        if (binding.leaseKey == bytes32(0)) revert BindingConflict();
        Lease memory lease = _lease(binding.leaseKey);
        if (lease.version != leaseVersion || leaseVersion < binding.leaseVersion) revert InvalidLease();
        if (binding.disabled) return;
        Namespace memory ns = namespaces[binding.buildingKey];
        IRealAddrEnsRegistry registry = IRealAddrEnsRegistry(ns.registry);
        uint256 labelId = uint256(keccak256(bytes(binding.label)));
        IRealAddrEnsRegistry.State memory state = registry.getState(labelId);
        if (state.status != 0) {
            if (state.latestOwner != binding.owner || registry.getResolver(binding.label) != binding.resolver) revert BindingConflict();
            registry.unregister(labelId);
        }
        IRealAddrEnsResolver(binding.resolver).authorizeTextRoles(_dns(binding.label, ns.slug), "description", binding.owner, false);
        binding.disabled = true;
        binding.leaseVersion = leaseVersion;
        emit NameDisabledEvent(node, leaseVersion);
    }

    function getBinding(bytes32 node) external view returns
        (bytes32 leaseKey, address owner, address resolver, uint64 leaseVersion, bool disabled)
    {
        Binding storage binding = bindings[node];
        return (binding.leaseKey, binding.owner, binding.resolver, binding.leaseVersion, binding.disabled);
    }

    function _register(bytes32, Binding storage binding, Namespace memory ns, uint64 expiresAt) private {
        IRealAddrEnsRegistry registry = IRealAddrEnsRegistry(ns.registry);
        uint256 labelId = uint256(keccak256(bytes(binding.label)));
        IRealAddrEnsRegistry.State memory state = registry.getState(labelId);
        if (state.status == 0) {
            registry.register(binding.label, binding.owner, address(0), binding.resolver, 0, expiresAt);
        } else {
            if (state.status != 2 || state.latestOwner != binding.owner || registry.getResolver(binding.label) != binding.resolver
                || registry.getSubregistry(binding.label) != address(0) || state.expiry > expiresAt) revert BindingConflict();
            if (state.expiry < expiresAt) registry.renew(labelId, expiresAt);
        }
        if (registry.hasRoles(labelId, TRANSFER_ADMIN, binding.owner)) revert InvalidConfiguration();
    }

    function _records(bytes32 node, Binding storage binding, Namespace memory ns) private {
        IRealAddrEnsResolver resolver = IRealAddrEnsResolver(binding.resolver);
        resolver.setAddr(node, 60, abi.encodePacked(binding.owner));
        resolver.setText(node, "realaddr.schema", "1");
        resolver.setText(node, "realaddr.lease", string.concat("eip155:11155111:", Strings.toHexString(address(LEASE_REGISTRY)), ":", Strings.toHexString(uint256(binding.leaseKey), 32)));
        resolver.setText(node, "realaddr.binding", Strings.toHexString(address(this)));
        resolver.setText(node, "realaddr.api", API_ORIGIN);
        resolver.authorizeTextRoles(_dns(binding.label, ns.slug), "description", binding.owner, true);
    }

    function _namespace(Namespace memory ns, uint64 expiresAt) private view {
        if (ns.registry == address(0)) revert NamespaceUnavailable();
        IRealAddrEnsRegistry.State memory parent = ETH_REGISTRY.getState(uint256(keccak256(bytes(parentLabel))));
        IRealAddrEnsRegistry.State memory location = UPPER_REGISTRY.getState(uint256(keccak256(bytes(ns.slug))));
        if (parent.status != 2 || location.status != 2 || parent.expiry < expiresAt || location.expiry < expiresAt
            || parent.latestOwner != NAMESPACE_OWNER || location.latestOwner != NAMESPACE_OWNER
            || ETH_REGISTRY.getSubregistry(parentLabel) != address(UPPER_REGISTRY)
            || UPPER_REGISTRY.getSubregistry(ns.slug) != ns.registry
            || !IRealAddrEnsRegistry(ns.registry).hasRoles(0, REGISTRY_ROLES, address(this))) revert NamespaceUnavailable();
    }

    function _lease(bytes32 key) private view returns (Lease memory lease) {
        (lease.buildingKey, lease.slot, lease.holderCommitment, lease.expiresAt, lease.version, lease.revoked) = LEASE_REGISTRY.getLease(key);
    }
    function _active(Lease memory lease) private view {
        if (lease.revoked || lease.expiresAt <= block.timestamp || lease.slot == 0 || lease.version == 0) revert InvalidLease();
    }
    function _dns(string memory label, string memory slug) private view returns (bytes memory) {
        return abi.encodePacked(uint8(bytes(label).length), label, uint8(bytes(slug).length), slug,
            uint8(bytes(parentLabel).length), parentLabel, hex"0365746800");
    }
    function _label(string memory label, uint256 minimum, uint256 maximum) private pure {
        bytes memory value = bytes(label);
        if (value.length < minimum || value.length > maximum) revert InvalidName();
        if (value.length >= 4 && value[2] == "-" && value[3] == "-") revert InvalidName();
        for (uint256 i; i < value.length; ++i) {
            bytes1 c = value[i];
            if (!((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || (c == "-" && i > 0 && i + 1 < value.length))) revert InvalidName();
        }
    }
    function _name(string memory label, uint8 nameType, uint16 policy, uint16 slot) private pure {
        if (policy != 1) revert InvalidName();
        if (nameType == 0) {
            bytes memory expected = bytes("f00000");
            uint256 number = slot;
            for (uint256 i = 5; i > 0; --i) { expected[i] = bytes1(uint8(48 + number % 10)); number /= 10; }
            if (keccak256(bytes(label)) != keccak256(expected)) revert InvalidName();
        } else if (nameType == 1) {
            _label(label, 3, 32);
            bytes32 hashed = keccak256(bytes(label));
            if (hashed == keccak256("admin") || hashed == keccak256("api") || hashed == keccak256("www")) revert InvalidName();
            bytes memory value = bytes(label);
            if (value[0] == "f") {
                bool digits = true;
                for (uint256 i = 1; i < value.length; ++i) if (value[i] < "0" || value[i] > "9") digits = false;
                if (digits) revert InvalidName();
            }
        } else revert InvalidName();
    }
}
