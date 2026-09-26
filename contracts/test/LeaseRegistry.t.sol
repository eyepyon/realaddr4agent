// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {LeaseRegistry} from "../src/LeaseRegistry.sol";

interface Vm {
    struct Log { bytes32[] topics; bytes data; address emitter; }
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function expectRevert() external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract LeaseRegistryTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    LeaseRegistry private registry;
    address private constant ADMIN = address(0xA);
    address private constant WRITER = address(0xB);
    bytes32 private constant KEY = bytes32(uint256(1));
    bytes32 private constant BUILDING = bytes32(uint256(2));
    bytes32 private constant HOLDER = bytes32(uint256(3));

    function setUp() public { vm.warp(100); registry = new LeaseRegistry(ADMIN, WRITER); }
    function record(bytes32 key, uint16 slot, uint64 expiry, uint64 version) private {
        vm.prank(WRITER); registry.recordLease(key, BUILDING, slot, HOLDER, expiry, version);
    }
    function revoke(bytes32 key, uint64 version) private { vm.prank(WRITER); registry.revokeLease(key, version); }

    function testConstructorRolesAndZeroAddresses() public {
        require(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), ADMIN));
        require(registry.hasRole(registry.WRITER_ROLE(), WRITER));
        require(!registry.hasRole(registry.WRITER_ROLE(), ADMIN));
        vm.expectRevert(LeaseRegistry.InvalidLease.selector); new LeaseRegistry(address(0), WRITER);
        vm.expectRevert(LeaseRegistry.InvalidLease.selector); new LeaseRegistry(ADMIN, address(0));
    }
    function testRoleManagementAndDenial() public {
        vm.expectRevert(); registry.recordLease(KEY, BUILDING, 1, HOLDER, 200, 1);
        bytes32 role = registry.WRITER_ROLE();
        vm.prank(WRITER); vm.expectRevert(); registry.grantRole(role, address(this));
        vm.prank(ADMIN); registry.grantRole(role, address(this));
        registry.recordLease(KEY, BUILDING, 1, HOLDER, 200, 1);
        vm.prank(ADMIN); registry.revokeRole(role, address(this));
        vm.expectRevert(); registry.revokeLease(KEY, 2);
        vm.prank(WRITER); vm.expectRevert(); registry.pause();
    }
    function testNonzeroFieldsAndSlotBoundaries() public {
        vm.expectRevert(LeaseRegistry.InvalidLease.selector); record(KEY, 0, 200, 1);
        vm.expectRevert(LeaseRegistry.InvalidLease.selector); record(bytes32(0), 1, 200, 1);
        vm.expectRevert(LeaseRegistry.InvalidLease.selector); record(KEY, 1, 0, 1);
        vm.expectRevert(LeaseRegistry.InvalidLease.selector); record(KEY, 1, 200, 0);
        vm.prank(WRITER); vm.expectRevert(LeaseRegistry.InvalidLease.selector);
        registry.recordLease(KEY, bytes32(0), 1, HOLDER, 200, 1);
        vm.prank(WRITER); vm.expectRevert(LeaseRegistry.InvalidLease.selector);
        registry.recordLease(KEY, BUILDING, 1, bytes32(0), 200, 1);
        record(KEY, 1, 200, 1); record(bytes32(uint256(4)), 65535, 200, 1);
    }
    function testReadReturnsExactAttestation() public {
        record(KEY, 65535, 200, 7);
        (bytes32 building, uint16 slot, bytes32 holder, uint64 expiry, uint64 version, bool revoked)
            = registry.getLease(KEY);
        require(building == BUILDING && slot == 65535 && holder == HOLDER);
        require(expiry == 200 && version == 7 && !revoked);
    }
    function testIdempotentAndConflictingVersions() public {
        vm.recordLogs(); record(KEY, 1, 200, 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1 && logs[0].emitter == address(registry));
        require(logs[0].topics[0] == keccak256("LeaseRecorded(bytes32,bytes32,uint16,bytes32,uint64,uint64)"));
        vm.recordLogs(); record(KEY, 1, 200, 1);
        require(vm.getRecordedLogs().length == 0);
        vm.expectRevert(LeaseRegistry.ConflictingVersion.selector); record(KEY, 1, 201, 1);
        record(KEY, 1, 300, 7);
        vm.expectRevert(LeaseRegistry.StaleVersion.selector); record(KEY, 1, 200, 2);
        vm.expectRevert(LeaseRegistry.ImmutableLeaseFields.selector); record(KEY, 2, 300, 8);
        vm.prank(WRITER); vm.expectRevert(LeaseRegistry.ImmutableLeaseFields.selector);
        registry.recordLease(KEY, bytes32(uint256(9)), 1, HOLDER, 300, 8);
        vm.prank(WRITER); vm.expectRevert(LeaseRegistry.ImmutableLeaseFields.selector);
        registry.recordLease(KEY, BUILDING, 1, bytes32(uint256(9)), 300, 8);
    }
    function testRevocationIsTerminalAndIdempotent() public {
        record(KEY, 1, 200, 1);
        vm.expectRevert(LeaseRegistry.ConflictingVersion.selector); revoke(KEY, 1);
        vm.recordLogs(); revoke(KEY, 2);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1 && logs[0].topics[0] == keccak256("LeaseRevoked(bytes32,uint64)"));
        vm.recordLogs(); revoke(KEY, 2); require(vm.getRecordedLogs().length == 0);
        vm.expectRevert(LeaseRegistry.StaleVersion.selector); revoke(KEY, 1);
        vm.expectRevert(LeaseRegistry.LeaseAlreadyRevoked.selector); record(KEY, 1, 300, 3);
        revoke(KEY, 4); (, , , , uint64 version, bool revoked) = registry.getLease(KEY);
        require(version == 4 && revoked);
        record(bytes32(uint256(4)), 1, 300, 1);
    }
    function testPauseBlocksWritesPreservesReads() public {
        record(KEY, 1, 200, 1); vm.prank(ADMIN); registry.pause();
        registry.getLease(KEY);
        vm.expectRevert(); record(KEY, 1, 300, 2);
        vm.expectRevert(); revoke(KEY, 2);
        vm.prank(ADMIN); registry.unpause(); record(KEY, 1, 300, 2);
    }
    function testUnknownLeaseExplicitlyReverts() public {
        vm.expectRevert(abi.encodeWithSelector(LeaseRegistry.UnknownLease.selector, KEY)); registry.getLease(KEY);
        vm.expectRevert(abi.encodeWithSelector(LeaseRegistry.UnknownLease.selector, KEY)); revoke(KEY, 1);
    }
    function testExclusiveSlotAndBuildingIsolation() public {
        record(KEY, 1, 200, 1);
        vm.expectRevert(abi.encodeWithSelector(LeaseRegistry.SlotOccupied.selector, KEY)); record(bytes32(uint256(4)), 1, 300, 1);
        vm.prank(WRITER); registry.recordLease(bytes32(uint256(4)), bytes32(uint256(5)), 1, HOLDER, 300, 1);
    }
    function testSlotReuseOldReplayAndOldRevokeCannotReleaseNewOccupant() public {
        record(KEY, 1, 200, 1); vm.warp(200); bytes32 next = bytes32(uint256(4));
        record(next, 1, 400, 1); record(KEY, 1, 200, 1); revoke(KEY, 2);
        vm.expectRevert(abi.encodeWithSelector(LeaseRegistry.SlotOccupied.selector, next)); record(bytes32(uint256(5)), 1, 500, 1);
        (, , , uint64 expiry, , bool revoked) = registry.getLease(next); require(expiry == 400 && !revoked);
    }
    function testOldRenewalCannotStealAndCanRecoverAfterExpiry() public {
        record(KEY, 1, 200, 1); vm.warp(200); record(bytes32(uint256(4)), 1, 400, 1);
        vm.expectRevert(abi.encodeWithSelector(LeaseRegistry.SlotOccupied.selector, bytes32(uint256(4)))); record(KEY, 1, 500, 2);
        vm.warp(400); record(KEY, 1, 500, 2);
        vm.expectRevert(abi.encodeWithSelector(LeaseRegistry.SlotOccupied.selector, KEY)); record(bytes32(uint256(4)), 1, 600, 2);
    }
    function testHistoricalRecordCannotDisplaceActiveOccupant() public {
        record(KEY, 1, 200, 1); record(bytes32(uint256(4)), 1, 99, 1);
        record(bytes32(uint256(4)), 1, 100, 2);
        vm.expectRevert(abi.encodeWithSelector(LeaseRegistry.SlotOccupied.selector, KEY)); record(bytes32(uint256(5)), 1, 300, 1);
    }
}
