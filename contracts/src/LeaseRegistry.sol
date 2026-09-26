// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice Operator attestations of address-service leases, not property ownership.
contract LeaseRegistry is AccessControl, Pausable {
    bytes32 public constant WRITER_ROLE = keccak256("WRITER_ROLE");

    struct Lease {
        bytes32 buildingKey;
        uint16 slot;
        bytes32 holderCommitment;
        uint64 expiresAt;
        uint64 version;
        bool revoked;
    }

    mapping(bytes32 leaseKey => Lease) private leases;
    mapping(bytes32 buildingKey => mapping(uint16 slot => bytes32 leaseKey)) private occupants;

    error InvalidLease();
    error UnknownLease(bytes32 leaseKey);
    error ImmutableLeaseFields();
    error StaleVersion();
    error ConflictingVersion();
    error LeaseAlreadyRevoked();
    error SlotOccupied(bytes32 leaseKey);

    event LeaseRecorded(bytes32 indexed leaseKey, bytes32 indexed buildingKey, uint16 slot,
        bytes32 holderCommitment, uint64 expiresAt, uint64 version);
    event LeaseRevoked(bytes32 indexed leaseKey, uint64 version);

    constructor(address admin, address writer) {
        if (admin == address(0) || writer == address(0)) revert InvalidLease();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(WRITER_ROLE, writer);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    function recordLease(bytes32 leaseKey, bytes32 buildingKey, uint16 slot,
        bytes32 holderCommitment, uint64 expiresAt, uint64 version)
        external onlyRole(WRITER_ROLE) whenNotPaused
    {
        if (leaseKey == bytes32(0) || buildingKey == bytes32(0) || slot == 0
            || holderCommitment == bytes32(0) || expiresAt == 0 || version == 0) revert InvalidLease();
        Lease storage lease = leases[leaseKey];
        if (lease.version != 0) {
            if (lease.revoked) revert LeaseAlreadyRevoked();
            if (version < lease.version) revert StaleVersion();
            if (version == lease.version) {
                if (lease.buildingKey != buildingKey || lease.slot != slot
                    || lease.holderCommitment != holderCommitment || lease.expiresAt != expiresAt) {
                    revert ConflictingVersion();
                }
                // A historical retry must never reclaim a slot from its current lease.
                return;
            }
            if (lease.buildingKey != buildingKey || lease.slot != slot
                || lease.holderCommitment != holderCommitment) revert ImmutableLeaseFields();
        }
        // Only current, unexpired records occupy a slot; delayed historical records remain readable.
        if (expiresAt > block.timestamp) {
            bytes32 occupantKey = occupants[buildingKey][slot];
            if (occupantKey != bytes32(0) && occupantKey != leaseKey) {
                Lease storage occupant = leases[occupantKey];
                if (!occupant.revoked && occupant.expiresAt > block.timestamp) revert SlotOccupied(occupantKey);
            }
            occupants[buildingKey][slot] = leaseKey;
        } else if (occupants[buildingKey][slot] == leaseKey) {
            delete occupants[buildingKey][slot];
        }
        leases[leaseKey] = Lease(buildingKey, slot, holderCommitment, expiresAt, version, false);
        emit LeaseRecorded(leaseKey, buildingKey, slot, holderCommitment, expiresAt, version);
    }

    function revokeLease(bytes32 leaseKey, uint64 version) external onlyRole(WRITER_ROLE) whenNotPaused {
        Lease storage lease = leases[leaseKey];
        if (lease.version == 0) revert UnknownLease(leaseKey);
        if (version < lease.version) revert StaleVersion();
        if (version == lease.version) {
            if (!lease.revoked) revert ConflictingVersion();
            return;
        }
        lease.version = version;
        lease.revoked = true;
        if (occupants[lease.buildingKey][lease.slot] == leaseKey) {
            delete occupants[lease.buildingKey][lease.slot];
        }
        emit LeaseRevoked(leaseKey, version);
    }

    function getLease(bytes32 leaseKey) external view returns (bytes32 buildingKey, uint16 slot,
        bytes32 holderCommitment, uint64 expiresAt, uint64 version, bool revoked)
    {
        Lease storage lease = leases[leaseKey];
        if (lease.version == 0) revert UnknownLease(leaseKey);
        return (lease.buildingKey, lease.slot, lease.holderCommitment, lease.expiresAt, lease.version, lease.revoked);
    }
}
