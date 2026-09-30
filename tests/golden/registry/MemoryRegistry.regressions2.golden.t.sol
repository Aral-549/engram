// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Regression cases for BUGLOG R3 (spec cases 43, 44). Written before the fix. FROZEN: add cases, never edit.

import {Test} from "forge-std/Test.sol";
import {MemoryRegistry} from "engram/MemoryRegistry.sol";
import {MockIdentity} from "./MockIdentity.sol";

/// Non-conforming identity registry: ownerOf returns attacker-chosen raw bytes.
contract WeirdIdentity {
    mapping(uint256 => bytes) public raw;

    function setRaw(uint256 id, bytes calldata r) external {
        raw[id] = r;
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        uint256 id = abi.decode(data[4:], (uint256));
        bytes memory r = raw[id];
        assembly {
            return(add(r, 32), mload(r))
        }
    }
}

contract MemoryRegistryRegressions2 is Test {
    bytes32 constant N = keccak256("namespace-N");
    uint256 constant T0 = 1_790_000_000;
    address O = makeAddr("owner");

    function one(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function two(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }

    function wraps(uint256 n) internal pure returns (bytes[] memory r) {
        r = new bytes[](n);
        for (uint256 i; i < n; i++) r[i] = new bytes(94);
    }

    function epoch0() internal pure returns (uint64[] memory r) {
        r = new uint64[](1);
    }

    // case 43
    function test_43_rotatePrunesGranteeWhoseTokenMoved() public {
        vm.warp(T0);
        MockIdentity identity = new MockIdentity();
        MemoryRegistry reg = new MemoryRegistry(address(identity));
        address h7 = makeAddr("h7");
        address h9 = makeAddr("h9");
        identity.mint(h7, 7);
        identity.mint(h9, 9);
        vm.prank(h7);
        reg.setAgentKeys(7, bytes32(uint256(0x77)), makeAddr("op7"));
        vm.prank(h9);
        reg.setAgentKeys(9, bytes32(uint256(0x99)), makeAddr("op9"));
        vm.startPrank(O);
        reg.createNamespace(N);
        reg.grant(N, 7, 1, uint64(T0 + 1 days), epoch0(), wraps(1));
        reg.grant(N, 9, 1, uint64(T0 + 1 days), epoch0(), wraps(1));
        vm.stopPrank();

        vm.prank(h9);
        identity.transferFrom(h9, makeAddr("buyer"), 9);
        assertFalse(reg.hasCurrentKeys(9));

        vm.prank(O);
        vm.expectRevert(MemoryRegistry.KeepSetMismatch.selector);
        reg.rotate(N, two(7, 9), wraps(2));

        vm.expectEmit(true, true, true, true, address(reg));
        emit MemoryRegistry.GrantRevoked(O, N, 9);
        vm.expectEmit(true, true, true, true, address(reg));
        emit MemoryRegistry.EpochRotated(O, N, 1);
        vm.expectEmit(true, true, true, true, address(reg));
        emit MemoryRegistry.KeyWrapped(O, N, 7, 1, new bytes(94));
        vm.prank(O);
        reg.rotate(N, one(7), wraps(1));
        uint256[] memory g = reg.granteesOf(O, N);
        assertEq(g.length, 1);
        assertEq(g[0], 7);
    }

    // case 44
    function test_44_malformedOwnerOfMeansKeysNotCurrent() public {
        vm.warp(T0);
        WeirdIdentity weird = new WeirdIdentity();
        MemoryRegistry reg = new MemoryRegistry(address(weird));
        address h = makeAddr("holder");
        address op = makeAddr("op");
        weird.setRaw(7, abi.encode(h));
        vm.prank(h);
        reg.setAgentKeys(7, bytes32(uint256(0x77)), op);
        vm.startPrank(O);
        reg.createNamespace(N);
        reg.grant(N, 7, 3, uint64(T0 + 1 days), epoch0(), wraps(1));
        vm.stopPrank();

        bytes[3] memory malformed = [
            abi.encodePacked(bytes32(uint256(uint160(h)) | (uint256(1) << 200))), // dirty upper bits
            abi.encodePacked(bytes20(h)), // short returndata
            bytes("")
        ];
        for (uint256 i; i < malformed.length; i++) {
            weird.setRaw(7, malformed[i]);
            assertFalse(reg.hasCurrentKeys(7));
            vm.prank(O);
            vm.expectRevert(MemoryRegistry.AgentKeysMissing.selector);
            reg.grant(N, 7, 3, uint64(T0 + 2 days), epoch0(), wraps(1));
            vm.prank(op);
            vm.expectRevert(MemoryRegistry.NotAuthorized.selector);
            reg.appendAsAgent(O, N, 7, 0, new bytes(30));
        }
        uint256[] memory none = new uint256[](0);
        vm.prank(O);
        reg.rotate(N, none, new bytes[](0)); // prunes 7, does not revert
        assertEq(reg.granteesOf(O, N).length, 0);
    }
}
