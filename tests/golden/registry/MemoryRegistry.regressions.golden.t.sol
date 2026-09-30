// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Regression cases for BUGLOG R1, R2 and spec cases 36-42 (contracts/memory-registry.md, review 2026-10-01).
// Written from the bug reports before the fixes. FROZEN: add cases, never edit or delete.

import {Test} from "forge-std/Test.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {MemoryRegistry} from "engram/MemoryRegistry.sol";

contract BurnableIdentity is ERC721("AgentIdentity", "AGENT") {
    function mint(address to, uint256 id) external {
        _mint(to, id);
    }

    function burn(uint256 id) external {
        _burn(id);
    }
}

contract MemoryRegistryRegressions is Test {
    MemoryRegistry reg;
    BurnableIdentity identity;

    uint256 constant OWNER_PK = 0xA11CE;
    address O;
    address O2 = makeAddr("owner2");
    address relayer = makeAddr("relayer");
    uint256 constant A = 7;
    address agentOwnerA = makeAddr("agentOwnerA");
    address opA = makeAddr("operatorA");
    bytes32 constant KEY_A = bytes32(uint256(0x1234));
    bytes32 constant N = keccak256("namespace-N");
    uint8 constant READ_WRITE = 3;
    uint256 constant T0 = 1_790_000_000;

    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant OWNER_CALL_TYPEHASH =
        keccak256("OwnerCall(address owner,bytes32 dataHash,uint256 nonce,uint256 deadline)");

    function setUp() public {
        vm.chainId(10143);
        vm.warp(T0);
        O = vm.addr(OWNER_PK);
        identity = new BurnableIdentity();
        reg = new MemoryRegistry(address(identity));
        identity.mint(agentOwnerA, A);
        vm.prank(agentOwnerA);
        reg.setAgentKeys(A, KEY_A, opA);
        vm.prank(O);
        reg.createNamespace(N);
    }

    function ct(uint256 len) internal pure returns (bytes memory b) {
        b = new bytes(len);
        for (uint256 i; i < len; i++) b[i] = bytes1(uint8(i + 1));
    }

    function wrap1() internal pure returns (bytes[] memory r) {
        r = new bytes[](1);
        r[0] = new bytes(94);
    }

    function epoch0() internal pure returns (uint64[] memory r) {
        r = new uint64[](1);
    }

    function signFor(bytes memory data, uint256 nonce, uint256 deadline) internal view returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("EngramMemoryRegistry"), keccak256("1"), block.chainid, address(reg))
        );
        bytes32 structHash = keccak256(abi.encode(OWNER_CALL_TYPEHASH, O, keccak256(data), nonce, deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    // R2 -- case 36
    function test_36_transferredTokenInvalidatesOldOperator() public {
        vm.prank(O);
        reg.grant(N, A, READ_WRITE, uint64(T0 + 1 days), epoch0(), wrap1());
        vm.prank(agentOwnerA);
        identity.transferFrom(agentOwnerA, makeAddr("X"), A);
        vm.prank(opA);
        vm.expectRevert(MemoryRegistry.NotAuthorized.selector);
        reg.appendAsAgent(O, N, A, 0, ct(40));
    }

    // R2 -- case 37
    function test_37_transferredTokenBlocksNewGrantsUntilNewHolderSetsKeys() public {
        address X = makeAddr("X");
        vm.prank(agentOwnerA);
        identity.transferFrom(agentOwnerA, X, A);
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.AgentKeysMissing.selector);
        reg.grant(N, A, READ_WRITE, uint64(T0 + 1 days), epoch0(), wrap1());

        vm.prank(X);
        reg.setAgentKeys(A, bytes32(uint256(0x5678)), makeAddr("opX"));
        vm.prank(O);
        reg.grant(N, A, READ_WRITE, uint64(T0 + 1 days), epoch0(), wrap1());
    }

    // R2 -- case 38
    function test_38_burnedTokenCannotBeGrantedButOwnerCanStillRevoke() public {
        vm.prank(O);
        reg.grant(N, A, READ_WRITE, uint64(T0 + 1 days), epoch0(), wrap1());
        identity.burn(A);

        vm.prank(O);
        vm.expectRevert(MemoryRegistry.AgentKeysMissing.selector);
        reg.grant(N, A, READ_WRITE, uint64(T0 + 2 days), epoch0(), wrap1());

        vm.prank(opA);
        vm.expectRevert(MemoryRegistry.NotAuthorized.selector);
        reg.appendAsAgent(O, N, A, 0, ct(40));

        uint256[] memory none = new uint256[](0);
        uint256[] memory revokeIds = new uint256[](1);
        revokeIds[0] = A;
        vm.prank(O);
        reg.revoke(N, revokeIds, none, new bytes[](0));
        vm.prank(O);
        reg.rotate(N, none, new bytes[](0));
    }

    // R1 -- case 40: a signed dynamic tail that runs past the end of `data` must not read anything else
    function test_40_relayTailPastEndOfSignedDataReverts() public {
        bytes memory data = abi.encodeCall(MemoryRegistry.appendAsOwner, (N, 0, ct(32)));
        // layout: selector | nsId | epoch | offset | length | payload(32). Claim 50 bytes of payload.
        assembly {
            mstore(add(add(data, 32), 100), 50)
        }
        bytes memory sig = signFor(data, 0, T0 + 60);
        vm.prank(relayer);
        vm.expectRevert();
        reg.relay(O, data, T0 + 60, sig);
        (,, uint64 nextSeq) = reg.namespaceOf(O, N);
        assertEq(nextSeq, 0);
    }

    // R1 -- case 42: padding a direct call with another owner's address changes nothing
    function test_42_directCallPaddedWithOtherOwnerActsAsSender() public {
        bytes32 n2 = keccak256("n2");
        vm.prank(O);
        (bool ok,) = address(reg).call(abi.encodePacked(abi.encodeCall(MemoryRegistry.createNamespace, (n2)), O2));
        assertTrue(ok);
        (bool existsO,,) = reg.namespaceOf(O, n2);
        (bool existsO2,,) = reg.namespaceOf(O2, n2);
        assertTrue(existsO);
        assertFalse(existsO2);
    }

    // case 42b: relayed call acts as the signer, and the actor does not leak into a later direct call
    function test_42b_relayActorDoesNotPersistAfterRelay() public {
        bytes memory data = abi.encodeCall(MemoryRegistry.createNamespace, (keccak256("r")));
        vm.prank(relayer);
        reg.relay(O, data, T0 + 60, signFor(data, 0, T0 + 60));
        (bool existsO,,) = reg.namespaceOf(O, keccak256("r"));
        assertTrue(existsO);
        vm.prank(relayer);
        reg.createNamespace(keccak256("r"));
        (bool existsRelayer,,) = reg.namespaceOf(relayer, keccak256("r"));
        assertTrue(existsRelayer);
    }

    // case 41: useNonce cancels a signed-but-unsubmitted call (relayed form)
    function test_41_relayedUseNonceCancelsPendingCall() public {
        bytes memory pending = abi.encodeCall(MemoryRegistry.appendAsOwner, (N, 0, ct(30)));
        bytes memory pendingSig = signFor(pending, 0, T0 + 600);
        bytes memory cancel = abi.encodeCall(MemoryRegistry.useNonce, ());
        vm.prank(relayer);
        reg.relay(O, cancel, T0 + 60, signFor(cancel, 0, T0 + 60));
        assertEq(reg.nonces(O), 1);
        vm.prank(relayer);
        vm.expectRevert(MemoryRegistry.BadSignature.selector);
        reg.relay(O, pending, T0 + 600, pendingSig);
    }

    // case 41b: useNonce cancels a pending call (direct form)
    function test_41b_directUseNonceCancelsPendingCall() public {
        bytes memory pending = abi.encodeCall(MemoryRegistry.appendAsOwner, (N, 0, ct(30)));
        bytes memory pendingSig = signFor(pending, 0, T0 + 600);
        vm.prank(O);
        reg.useNonce();
        assertEq(reg.nonces(O), 1);
        vm.prank(relayer);
        vm.expectRevert(MemoryRegistry.BadSignature.selector);
        reg.relay(O, pending, T0 + 600, pendingSig);
    }
}
