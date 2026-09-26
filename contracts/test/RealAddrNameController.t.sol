// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LeaseRegistry} from "../src/LeaseRegistry.sol";
import {RealAddrNameController, IRealAddrEnsRegistry, IRealAddrEnsResolver} from "../src/RealAddrNameController.sol";

interface EnsVm { function prank(address) external; function warp(uint256) external; function expectRevert() external; }

// These protocol doubles exercise controller invariants, not live ENS deployment compatibility.
contract RegistryDouble {
    mapping(uint256 => IRealAddrEnsRegistry.State) private states;
    mapping(uint256 => address) private children;
    mapping(uint256 => address) private resolvers;
    mapping(uint256 => uint256) public ownerRoles;
    address public operator;
    function setOperator(address value) external { operator = value; }
    function seed(string memory label, address owner, address subregistry, address resolver, uint64 expiry) public {
        uint256 id = uint256(keccak256(bytes(label)));
        states[id] = IRealAddrEnsRegistry.State(2, expiry, owner, id, id);
        children[id] = subregistry; resolvers[id] = resolver;
    }
    function getState(uint256 id) public view returns (IRealAddrEnsRegistry.State memory state) {
        state = states[id]; if (state.expiry <= block.timestamp) state.status = 0;
    }
    function getSubregistry(string memory label) external view returns (address) { return children[uint256(keccak256(bytes(label)))]; }
    function getResolver(string memory label) external view returns (address) { return resolvers[uint256(keccak256(bytes(label)))]; }
    function hasRoles(uint256 id, uint256 bitmap, address account) external view returns (bool) {
        if (id == 0) return account == operator;
        return account == states[id].latestOwner && ownerRoles[id] & bitmap == bitmap;
    }
    function register(string memory label, address owner, address child, address resolver, uint256 roles, uint64 expiry) external returns (uint256 id) {
        require(msg.sender == operator); id = uint256(keccak256(bytes(label)));
        require(getState(id).status == 0); seed(label, owner, child, resolver, expiry); ownerRoles[id] = roles;
    }
    function renew(uint256 id, uint64 expiry) external { require(msg.sender == operator && expiry >= states[id].expiry); states[id].expiry = expiry; }
    function unregister(uint256 id) external { require(msg.sender == operator); delete states[id]; delete children[id]; delete resolvers[id]; }
}

contract ResolverDouble {
    address public admin;
    mapping(bytes32 => mapping(string => string)) private texts;
    mapping(address => bool) public descriptionWriters;
    function initialize(address value, uint256, bytes[] calldata) external { require(admin == address(0)); admin = value; }
    function setText(bytes32 node, string calldata key, string calldata value) external {
        require(msg.sender == admin || (descriptionWriters[msg.sender] && keccak256(bytes(key)) == keccak256("description")));
        texts[node][key] = value;
    }
    function text(bytes32 node, string calldata key) external view returns (string memory) { return texts[node][key]; }
    function setAddr(bytes32, uint256 coinType, bytes calldata value) external view { require(msg.sender == admin && coinType == 60 && value.length == 20); }
    function authorizeTextRoles(bytes calldata name, string calldata key, address account, bool grant) external {
        require(msg.sender == admin && name.length > 0 && keccak256(bytes(key)) == keccak256("description"));
        descriptionWriters[account] = grant;
    }
}

contract FactoryDouble {
    mapping(address => address) private implementations;
    uint256 public deployed;
    function deployProxy(address implementation, uint256, bytes calldata data) external returns (address proxy) {
        proxy = address(new ResolverDouble()); implementations[proxy] = implementation; ++deployed;
        (bool ok,) = proxy.call(data); require(ok);
    }
    function verifyContract(address proxy) external view returns (address) { return implementations[proxy]; }
}

contract RealAddrNameControllerTest {
    EnsVm private constant vm = EnsVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant OWNER = address(0xA);
    bytes32 private constant KEY = bytes32(uint256(11));
    bytes32 private constant BUILDING = bytes32(uint256(12));
    bytes32 private constant SALT = bytes32(uint256(13));
    LeaseRegistry private leases;
    RegistryDouble private eth;
    RegistryDouble private upper;
    RegistryDouble private location;
    FactoryDouble private factory;
    RealAddrNameController private controller;

    function setUp() public {
        vm.warp(100);
        leases = new LeaseRegistry(address(this), address(this));
        eth = new RegistryDouble(); upper = new RegistryDouble(); location = new RegistryDouble();
        factory = new FactoryDouble();
        controller = new RealAddrNameController(address(this), address(this), address(leases), address(eth), address(upper), address(factory), address(new ResolverDouble()), "example");
        location.setOperator(address(controller));
        eth.seed("example", address(this), address(upper), address(0), 10000);
        upper.seed("office", address(this), address(location), address(0), 10000);
        controller.configureNamespace(BUILDING, "office", address(location));
        record(KEY, 42, 500, 1);
    }
    function record(bytes32 key, uint16 slot, uint64 expiry, uint64 version) private {
        leases.recordLease(key, BUILDING, slot, keccak256(abi.encode(OWNER, SALT)), expiry, version);
    }
    function request(bytes32 key, uint16 slot, string memory label, uint8 kind, uint64 version)
        private pure returns (RealAddrNameController.BindRequest memory)
    {
        return RealAddrNameController.BindRequest(key, BUILDING, slot, kind, 1, label, OWNER, SALT, version);
    }
    function bind() private returns (bytes32 node, address resolver) { return controller.bindLease(request(KEY, 42, "f00042", 0, 1)); }

    function testAtomicBindingAndDedicatedResolverIdempotency() public {
        (bytes32 node, address resolver) = bind();
        (bytes32 retryNode, address retryResolver) = bind();
        require(node == retryNode && resolver == retryResolver && factory.deployed() == 1);
        require(location.ownerRoles(uint256(keccak256("f00042"))) == 0);
        require(location.getState(uint256(keccak256("f00042"))).expiry == 500);
        (bytes32 key, address owner, address saved, uint64 version, bool disabled) = controller.getBinding(node);
        require(key == KEY && owner == OWNER && saved == resolver && version == 1 && !disabled);
        record(bytes32(uint256(22)), 43, 500, 1);
        (, address other) = controller.bindLease(request(bytes32(uint256(22)), 43, "f00043", 0, 1));
        require(other != resolver && factory.deployed() == 2);
    }
    function testDescriptionOnlyAndDisableCannotRenew() public {
        (bytes32 node, address resolver) = bind();
        vm.prank(OWNER); ResolverDouble(resolver).setText(node, "description", "Public description");
        vm.prank(OWNER); vm.expectRevert(); ResolverDouble(resolver).setText(node, "realaddr.api", "untrusted");
        controller.disableName(node, 1);
        vm.prank(OWNER); vm.expectRevert(); ResolverDouble(resolver).setText(node, "description", "after disable");
        record(KEY, 42, 900, 2);
        vm.expectRevert(); controller.syncLease(node, 2);
        vm.expectRevert(); controller.bindLease(request(KEY, 42, "f00042", 0, 2));
    }
    function testRenewRevivalAndNoNewResolver() public {
        (bytes32 node,) = bind();
        vm.warp(600); record(KEY, 42, 1000, 2); controller.syncLease(node, 2);
        require(location.getState(uint256(keccak256("f00042"))).expiry == 1000 && factory.deployed() == 1);
        vm.expectRevert(); controller.syncLease(node, 1);
        leases.revokeLease(KEY, 3);
        vm.expectRevert(); controller.syncLease(node, 3);
        controller.disableName(node, 3);
    }
    function testWrongHolderNamePolicyAndRenameReject() public {
        RealAddrNameController.BindRequest memory input = request(KEY, 42, "f00042", 0, 1);
        input.holderSalt = bytes32(0); vm.expectRevert(); controller.bindLease(input);
        vm.expectRevert(); controller.bindLease(request(KEY, 42, "f00043", 0, 1));
        vm.expectRevert(); controller.bindLease(request(KEY, 42, "f42", 1, 1));
        vm.expectRevert(); controller.bindLease(request(KEY, 42, "admin", 1, 1));
        vm.expectRevert(); controller.bindLease(request(KEY, 42, "Upper", 1, 1));
        vm.expectRevert(); controller.bindLease(request(KEY, 42, "ab--cd", 1, 1));
        bind(); vm.expectRevert(); controller.bindLease(request(KEY, 42, "custom", 1, 1));
    }
    function testParentPointerExpiryAndPublisherChecks() public {
        vm.prank(OWNER); vm.expectRevert(); controller.bindLease(request(KEY, 42, "f00042", 0, 1));
        eth.seed("example", address(this), address(upper), address(0), 499);
        vm.expectRevert(); bind();
        eth.seed("example", address(this), address(location), address(0), 10000);
        vm.expectRevert(); bind();
    }
}
