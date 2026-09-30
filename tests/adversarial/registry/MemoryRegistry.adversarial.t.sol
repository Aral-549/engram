// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Adversarial probes for contracts/memory-registry.md. Each test PASSES when the implementation behaves per
// spec and FAILS when a bug is found. Tests named test_gap_* record behavior the spec leaves undefined.

import {Test, Vm} from "forge-std/Test.sol";
import {MemoryRegistry} from "engram/MemoryRegistry.sol";
import {MockIdentity} from "../../golden/registry/MockIdentity.sol";

/// Identity registry whose ownerOf can be made to revert or burn gas for one id (hostile agent owner).
contract HostileIdentity is MockIdentity {
    uint256 public bomb = type(uint256).max;

    function setBomb(uint256 id) external {
        bomb = id;
    }

    function ownerOf(uint256 id) public view override returns (address) {
        if (id == bomb) {
            while (true) {} // burns all gas
        }
        return super.ownerOf(id);
    }

    function burn(uint256 id) external {
        _burn(id);
    }
}

contract MemoryRegistryAdversarial is Test {
    MemoryRegistry reg;
    HostileIdentity identity;

    uint256 constant OWNER_PK = 0xA11CE;
    address O;
    address attacker = makeAddr("attacker");
    address relayer = makeAddr("relayer");

    uint256 constant A = 7;
    uint256 constant B = 9;
    address agentOwnerA = makeAddr("agentOwnerA");
    address agentOwnerB = makeAddr("agentOwnerB");
    address opA = makeAddr("operatorA");
    address opB = makeAddr("operatorB");

    bytes32 constant N = keccak256("namespace-N");
    uint8 constant READ = 1;
    uint8 constant READ_WRITE = 3;
    uint256 constant T0 = 1_790_000_000;
    uint256 constant POOL = 20; // agents 100..119 for the bookkeeping fuzz

    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant OWNER_CALL_TYPEHASH =
        keccak256("OwnerCall(address owner,bytes32 dataHash,uint256 nonce,uint256 deadline)");
    uint256 constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function setUp() public {
        vm.chainId(10143);
        vm.warp(T0);
        O = vm.addr(OWNER_PK);
        identity = new HostileIdentity();
        reg = new MemoryRegistry(address(identity));
        identity.mint(agentOwnerA, A);
        identity.mint(agentOwnerB, B);
        vm.prank(agentOwnerA);
        reg.setAgentKeys(A, bytes32(uint256(0xAAAA)), opA);
        vm.prank(agentOwnerB);
        reg.setAgentKeys(B, bytes32(uint256(0xBBBB)), opB);
        for (uint256 i; i < POOL; i++) {
            address ao = address(uint160(0x5000 + i));
            identity.mint(ao, 100 + i);
            vm.prank(ao);
            reg.setAgentKeys(100 + i, bytes32(0x1000 + i), address(uint160(0x6000 + i)));
        }
        vm.prank(O);
        reg.createNamespace(N);
    }

    // ---------------------------------------------------------------- helpers

    function ct(uint256 len) internal pure returns (bytes memory b) {
        b = new bytes(len);
        for (uint256 i; i < len; i++) b[i] = bytes1(uint8(i + 1));
    }

    function w(uint8 tag) internal pure returns (bytes memory b) {
        b = new bytes(94);
        b[0] = 0x01;
        b[93] = bytes1(tag);
    }

    function u64s(uint64 a) internal pure returns (uint64[] memory r) {
        r = new uint64[](1);
        r[0] = a;
    }

    function one(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function two(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }

    function none() internal pure returns (uint256[] memory r) {
        r = new uint256[](0);
    }

    function nWraps(uint256 n) internal pure returns (bytes[] memory r) {
        r = new bytes[](n);
        for (uint256 i; i < n; i++) r[i] = w(uint8(i));
    }

    function grantTo(uint256 id, uint8 scope, uint64 expiry) internal {
        (, uint64 epoch,) = reg.namespaceOf(O, N);
        vm.prank(O);
        reg.grant(N, id, scope, expiry, u64s(epoch), nWraps(1));
    }

    function digest(address owner, bytes memory data, uint256 nonce, uint256 deadline) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("EngramMemoryRegistry"), keccak256("1"), block.chainid, address(reg))
        );
        bytes32 structHash = keccak256(abi.encode(OWNER_CALL_TYPEHASH, owner, keccak256(data), nonce, deadline));
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function signFor(bytes memory data, uint256 deadline) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, digest(O, data, reg.nonces(O), deadline));
        return abi.encodePacked(r, s, v);
    }

    function contains(uint256[] memory list, uint256 x) internal pure returns (bool) {
        for (uint256 i; i < list.length; i++) if (list[i] == x) return true;
        return false;
    }

    /// granteesOf has no duplicates, every listed id has scope != 0, and every pool id with scope != 0 is listed.
    function assertBookkeeping() internal view {
        uint256[] memory g = reg.granteesOf(O, N);
        assertLe(g.length, 16, "more than MAX_GRANTEES");
        for (uint256 i; i < g.length; i++) {
            (uint8 scope,) = reg.grantOf(O, N, g[i]);
            assertTrue(scope != 0, "listed grantee has no grant (ghost)");
            for (uint256 j; j < i; j++) assertTrue(g[i] != g[j], "duplicate grantee");
        }
        for (uint256 id = 100; id < 100 + POOL; id++) {
            (uint8 scope,) = reg.grantOf(O, N, id);
            if (scope != 0) assertTrue(contains(g, id), "active grant missing from granteesOf");
        }
    }

    // ---------------------------------------------------------------- relay / _actor

    function test_relay_signatureForDataA_cannotExecuteDataB() public {
        bytes memory dataA = abi.encodeCall(MemoryRegistry.createNamespace, (keccak256("A")));
        bytes memory dataB = abi.encodeCall(MemoryRegistry.createNamespace, (keccak256("B")));
        bytes memory sig = signFor(dataA, T0 + 1 hours);
        vm.prank(relayer);
        vm.expectRevert(MemoryRegistry.BadSignature.selector);
        reg.relay(O, dataB, T0 + 1 hours, sig);
    }

    function test_relay_trailingBytesChangeDataHash() public {
        bytes memory data = abi.encodeCall(MemoryRegistry.createNamespace, (keccak256("A")));
        bytes memory sig = signFor(data, T0 + 1 hours);
        vm.prank(relayer);
        vm.expectRevert(MemoryRegistry.BadSignature.selector);
        reg.relay(O, abi.encodePacked(data, attacker), T0 + 1 hours, sig);
    }

    function test_relay_signatureForOwnerCannotBeReassignedToOtherOwner() public {
        bytes memory data = abi.encodeCall(MemoryRegistry.createNamespace, (keccak256("A")));
        bytes memory sig = signFor(data, T0 + 1 hours);
        vm.prank(relayer);
        vm.expectRevert(MemoryRegistry.BadSignature.selector);
        reg.relay(attacker, data, T0 + 1 hours, sig);
    }

    function test_relay_compact64ByteSignatureRejected() public {
        bytes memory data = abi.encodeCall(MemoryRegistry.createNamespace, (keccak256("A")));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, digest(O, data, 0, T0 + 1 hours));
        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));
        vm.expectRevert(MemoryRegistry.BadSignature.selector);
        reg.relay(O, data, T0 + 1 hours, abi.encodePacked(r, vs));
    }

    function test_relay_signatureLengths66And0Rejected() public {
        bytes memory data = abi.encodeCall(MemoryRegistry.createNamespace, (keccak256("A")));
        bytes memory sig = signFor(data, T0 + 1 hours);
        vm.expectRevert(MemoryRegistry.BadSignature.selector);
        reg.relay(O, data, T0 + 1 hours, abi.encodePacked(sig, uint8(0)));
        vm.expectRevert(MemoryRegistry.BadSignature.selector);
        reg.relay(O, data, T0 + 1 hours, "");
    }

    function test_relay_vZeroOrOneRejected() public {
        bytes memory data = abi.encodeCall(MemoryRegistry.createNamespace, (keccak256("A")));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, digest(O, data, 0, T0 + 1 hours));
        vm.expectRevert(MemoryRegistry.BadSignature.selector);
        reg.relay(O, data, T0 + 1 hours, abi.encodePacked(r, s, uint8(v - 27)));
    }

    function test_relay_ownerZeroWithGarbageSignatureRejected() public {
        bytes memory data = abi.encodeCall(MemoryRegistry.createNamespace, (keccak256("A")));
        vm.expectRevert(MemoryRegistry.BadSignature.selector);
        reg.relay(address(0), data, T0 + 1 hours, new bytes(65));
        vm.expectRevert(MemoryRegistry.BadSignature.selector);
        reg.relay(address(0), data, T0 + 1 hours, abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(1)), uint8(27)));
    }

    function test_relay_deadlineEqualToNowAccepted_nextSecondExpired() public {
        bytes memory data = abi.encodeCall(MemoryRegistry.createNamespace, (keccak256("A")));
        bytes memory sig = signFor(data, T0);
        reg.relay(O, data, T0, sig);
        bytes memory data2 = abi.encodeCall(MemoryRegistry.createNamespace, (keccak256("B")));
        bytes memory sig2 = signFor(data2, T0);
        vm.warp(T0 + 1);
        vm.expectRevert(MemoryRegistry.Expired.selector);
        reg.relay(O, data2, T0, sig2);
    }

    function test_relay_selectorOnlyDataDoesNotCreateNamespaceFromOwnerBytes() public {
        // data = 4-byte selector; calldata becomes selector || owner (24 bytes): too short for bytes32 nsId.
        bytes memory data = abi.encodePacked(MemoryRegistry.createNamespace.selector);
        bytes memory sig = signFor(data, T0 + 1 hours);
        vm.expectRevert();
        reg.relay(O, data, T0 + 1 hours, sig);
        assertEq(reg.nonces(O), 0);
    }

    function test_relay_innerRevertDoesNotBurnNonce() public {
        bytes memory data = abi.encodeCall(MemoryRegistry.createNamespace, (N)); // exists -> NamespaceExists
        bytes memory sig = signFor(data, T0 + 1 hours);
        vm.expectRevert(MemoryRegistry.NamespaceExists.selector);
        reg.relay(O, data, T0 + 1 hours, sig);
        assertEq(reg.nonces(O), 0);
    }

    function test_relay_innerOutOfGasRevertsWholeTxAndKeepsNonce() public {
        // Relayer griefing: supply just enough gas for signature checks so the inner self-call runs out.
        bytes memory data = abi.encodeCall(MemoryRegistry.appendAsOwner, (N, 0, ct(2077)));
        bytes memory sig = signFor(data, T0 + 1 hours);
        for (uint256 gasLimit = 20_000; gasLimit < 80_000; gasLimit += 2_000) {
            (bool ok,) = address(reg).call{gas: gasLimit}(abi.encodeCall(MemoryRegistry.relay, (O, data, T0 + 1 hours, sig)));
            if (!ok) assertEq(reg.nonces(O), 0, "nonce consumed by a failed relay");
            else break;
        }
    }

    function test_relay_cannotReachAppendAsAgentEvenIfOperatorIsRegistry() public {
        // Agent owner sets operator = the registry itself. A relayed appendAsAgent would pass the operator check.
        vm.prank(agentOwnerA);
        reg.setAgentKeys(A, bytes32(uint256(0xAAAA)), address(reg));
        grantTo(A, READ_WRITE, uint64(T0 + 1 days));
        bytes memory data = abi.encodeCall(MemoryRegistry.appendAsAgent, (O, N, A, 0, ct(30)));
        bytes memory sig = signFor(data, T0 + 1 hours);
        vm.expectRevert(MemoryRegistry.SelectorNotAllowed.selector);
        reg.relay(O, data, T0 + 1 hours, sig);
    }

    function test_directCall_paddedWithVictimAddressDoesNotSpoofActor() public {
        // ERC-2771 spoof attempt: append victim address to calldata when calling directly.
        bytes32 n2 = keccak256("spoof");
        vm.prank(attacker);
        (bool ok,) = address(reg).call(abi.encodePacked(abi.encodeCall(MemoryRegistry.createNamespace, (n2)), O));
        assertTrue(ok);
        (bool existsO,,) = reg.namespaceOf(O, n2);
        (bool existsAtk,,) = reg.namespaceOf(attacker, n2);
        assertFalse(existsO, "victim namespace created by attacker");
        assertTrue(existsAtk);
    }

    function test_directCall_grantPaddedWithVictimAddressCannotGrantOnVictimNamespace() public {
        vm.prank(attacker);
        (bool ok,) = address(reg).call(
            abi.encodePacked(abi.encodeCall(MemoryRegistry.grant, (N, A, READ_WRITE, uint64(T0 + 1 days), u64s(0), nWraps(1))), O)
        );
        assertFalse(ok); // attacker has no namespace N
        (uint8 scope,) = reg.grantOf(O, N, A);
        assertEq(scope, 0);
    }

    function test_relay_dynamicOffsetIntoAppendedOwnerBytes() public {
        // Hand-craft appendAsOwner calldata whose ciphertext length word claims more bytes than `data` holds,
        // so the tail is read from the 20 appended owner bytes. Owner signs this data, so the question is only
        // whether it is decoded consistently (no crash, entry length within bounds).
        bytes memory body = new bytes(30);
        for (uint256 i; i < 30; i++) body[i] = 0x42;
        bytes memory data = abi.encodePacked(
            MemoryRegistry.appendAsOwner.selector, N, uint256(0), uint256(0x60), uint256(30 + 20), body, bytes2(0)
        );
        // data holds 32 bytes of payload region after the length word; ABI decoder will need 50 bytes -> reads owner.
        bytes memory sig = signFor(data, T0 + 1 hours);
        vm.recordLogs();
        (bool ok,) = address(reg).call(abi.encodeCall(MemoryRegistry.relay, (O, data, T0 + 1 hours, sig)));
        if (ok) {
            Vm.Log[] memory logs = vm.getRecordedLogs();
            (,,, bytes memory c) = abi.decode(logs[logs.length - 1].data, (uint64, uint64, bool, bytes));
            assertEq(c.length, 50);
        }
    }

    // ---------------------------------------------------------------- grant / revoke / rotate bookkeeping

    function test_revokeThenRegrant_noDuplicateNoGhost() public {
        grantTo(A, READ, uint64(T0 + 1 days));
        grantTo(B, READ, uint64(T0 + 1 days));
        vm.prank(O);
        reg.revoke(N, one(A), one(B), nWraps(1));
        grantTo(A, READ_WRITE, uint64(T0 + 2 days));
        uint256[] memory g = reg.granteesOf(O, N);
        assertEq(g.length, 2);
        assertTrue(contains(g, A) && contains(g, B));
    }

    function test_grantAfterExpiryBeforePrune_noDuplicate() public {
        grantTo(A, READ, uint64(T0 + 1 days));
        vm.warp(T0 + 2 days);
        assertFalse(reg.isActive(O, N, A));
        grantTo(A, READ, uint64(T0 + 3 days));
        assertEq(reg.granteesOf(O, N).length, 1);
        assertTrue(reg.isActive(O, N, A));
    }

    function test_pruneLoop_swapAndPopDoesNotSkip_allButOneExpired() public {
        // grantees [100..115]; every even one expires. After rotate only the odd ones remain.
        uint256[] memory keep = new uint256[](8);
        uint256 k;
        for (uint256 i; i < 16; i++) {
            uint64 exp = i % 2 == 0 ? uint64(T0 + 1 hours) : uint64(T0 + 10 days);
            grantTo(100 + i, READ, exp);
            if (i % 2 == 1) keep[k++] = 100 + i;
        }
        vm.warp(T0 + 2 hours);
        vm.prank(O);
        reg.rotate(N, keep, nWraps(8));
        uint256[] memory g = reg.granteesOf(O, N);
        assertEq(g.length, 8);
        for (uint256 i; i < 16; i++) assertEq(contains(g, 100 + i), i % 2 == 1);
        assertBookkeeping();
    }

    function test_pruneLoop_consecutiveExpiredAtTail() public {
        // last three expire; swap-and-pop from the tail must still remove all of them.
        for (uint256 i; i < 6; i++) grantTo(100 + i, READ, uint64(i >= 3 ? T0 + 1 hours : T0 + 10 days));
        vm.warp(T0 + 2 hours);
        vm.prank(O);
        uint256[] memory keep = new uint256[](3);
        keep[0] = 102;
        keep[1] = 100;
        keep[2] = 101;
        reg.rotate(N, keep, nWraps(3));
        assertEq(reg.granteesOf(O, N).length, 3);
        assertBookkeeping();
    }

    function test_revokeExpiredId_emitsGrantRevokedExactlyOnce() public {
        grantTo(A, READ, uint64(T0 + 1 hours));
        grantTo(B, READ, uint64(T0 + 1 hours));
        vm.warp(T0 + 2 hours);
        vm.recordLogs();
        vm.prank(O);
        reg.revoke(N, one(A), none(), new bytes[](0));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 countA;
        uint256 countB;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == MemoryRegistry.GrantRevoked.selector) {
                if (uint256(logs[i].topics[3]) == A) countA++;
                if (uint256(logs[i].topics[3]) == B) countB++;
            }
            assertTrue(logs[i].topics[0] != MemoryRegistry.KeyWrapped.selector, "expired grantee re-keyed");
        }
        assertEq(countA, 1);
        assertEq(countB, 1);
        assertEq(reg.granteesOf(O, N).length, 0);
    }

    function test_revoke_keepIdsContainingJustRevokedId_reverts() public {
        grantTo(A, READ, uint64(T0 + 1 days));
        grantTo(B, READ, uint64(T0 + 1 days));
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.KeepSetMismatch.selector);
        reg.revoke(N, one(A), one(A), nWraps(1));
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.KeepSetMismatch.selector);
        reg.revoke(N, one(A), two(A, B), nWraps(2));
    }

    function test_rotate_keepIdsWithNeverGrantedIdOfCorrectLength_reverts() public {
        grantTo(A, READ, uint64(T0 + 1 days));
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.KeepSetMismatch.selector);
        reg.rotate(N, one(B), nWraps(1));
    }

    function test_rotate_keepWrapsBadLength_reverts() public {
        grantTo(A, READ, uint64(T0 + 1 days));
        bytes[] memory ws = new bytes[](1);
        ws[0] = new bytes(93);
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.BadWrapLength.selector);
        reg.rotate(N, one(A), ws);
    }

    function test_expiryBoundary_expiryEqualNowIsExpiredEverywhere() public {
        grantTo(A, READ_WRITE, uint64(T0 + 1 hours));
        vm.warp(T0 + 1 hours);
        assertFalse(reg.isActive(O, N, A));
        vm.prank(opA);
        vm.expectRevert(MemoryRegistry.GrantExpired.selector);
        reg.appendAsAgent(O, N, A, 0, ct(30));
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.KeepSetMismatch.selector);
        reg.rotate(N, one(A), nWraps(1));
    }

    function test_revokedAgent_cannotAppendAtOldOrNewEpoch() public {
        grantTo(A, READ_WRITE, uint64(T0 + 1 days));
        vm.prank(O);
        reg.revoke(N, one(A), none(), new bytes[](0));
        vm.startPrank(opA);
        vm.expectRevert(MemoryRegistry.NotAuthorized.selector);
        reg.appendAsAgent(O, N, A, 0, ct(30));
        vm.expectRevert(MemoryRegistry.NotAuthorized.selector);
        reg.appendAsAgent(O, N, A, 1, ct(30));
        vm.stopPrank();
    }

    function test_grant_epochsAboveCurrentOrHuge_reverts() public {
        uint64[] memory e = new uint64[](2);
        e[0] = 0;
        e[1] = type(uint64).max;
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.BadEpochs.selector);
        reg.grant(N, A, READ, uint64(T0 + 1 days), e, nWraps(2));
        e[0] = type(uint64).max;
        e[1] = 0;
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.BadEpochs.selector);
        reg.grant(N, A, READ, uint64(T0 + 1 days), e, nWraps(2));
    }

    function test_grant_expiryExactlyMax_acceptedAndOneMoreRejected() public {
        grantTo(A, READ, uint64(T0 + 365 days));
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.BadExpiry.selector);
        reg.grant(N, B, READ, uint64(T0 + 365 days + 1), u64s(0), nWraps(1));
    }

    function test_grant_badWrapLengthReverts_andLeavesNoGrantee() public {
        bytes[] memory ws = new bytes[](1);
        ws[0] = new bytes(126);
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.BadWrapLength.selector);
        reg.grant(N, A, READ, uint64(T0 + 1 days), u64s(0), ws);
        assertEq(reg.granteesOf(O, N).length, 0);
    }

    /// Randomized sequence of grant / revoke / rotate / warp over a pool of 20 agents. After every op the
    /// grantee list and grant mapping must agree, and no rotation may re-key an expired or revoked grantee.
    function testFuzz_bookkeepingInvariant(uint256 seed) public {
        for (uint256 step; step < 40; step++) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 op = seed % 4;
            uint256 id = 100 + (seed >> 8) % POOL;
            if (op == 0) {
                uint64 exp = uint64(block.timestamp + 1 + (seed >> 16) % 3 days);
                (, uint64 epoch,) = reg.namespaceOf(O, N);
                vm.prank(O);
                try reg.grant(N, id, (seed >> 32) % 2 == 0 ? READ : READ_WRITE, exp, u64s(epoch), nWraps(1)) {} catch {}
            } else if (op == 1 || op == 2) {
                uint256[] memory g = reg.granteesOf(O, N);
                bool doRevoke = op == 1 && g.length > 0;
                uint256 victim = doRevoke ? g[(seed >> 40) % g.length] : 0;
                uint256 k;
                uint256[] memory keep = new uint256[](g.length);
                for (uint256 i; i < g.length; i++) {
                    (, uint64 exp) = reg.grantOf(O, N, g[i]);
                    if (exp > block.timestamp && !(doRevoke && g[i] == victim)) keep[k++] = g[i];
                }
                assembly {
                    mstore(keep, k)
                }
                vm.recordLogs();
                vm.prank(O);
                if (doRevoke) reg.revoke(N, one(victim), keep, nWraps(k));
                else reg.rotate(N, keep, nWraps(k));
                Vm.Log[] memory logs = vm.getRecordedLogs();
                for (uint256 i; i < logs.length; i++) {
                    if (logs[i].topics[0] == MemoryRegistry.KeyWrapped.selector) {
                        uint256 who = uint256(logs[i].topics[3]);
                        assertTrue(reg.isActive(O, N, who), "rotation re-keyed an inactive grantee");
                        assertTrue(!(doRevoke && who == victim), "revoked agent re-keyed");
                    }
                }
                if (doRevoke) {
                    (uint8 s,) = reg.grantOf(O, N, victim);
                    assertEq(s, 0);
                }
            } else {
                vm.warp(block.timestamp + (seed >> 48) % 2 days);
            }
            assertBookkeeping();
        }
    }

    // ---------------------------------------------------------------- agent keys / operators

    function test_operatorOfA_cannotWriteToBGrantClaimingA() public {
        grantTo(B, READ_WRITE, uint64(T0 + 1 days));
        vm.startPrank(opA);
        vm.expectRevert(MemoryRegistry.NotAuthorized.selector);
        reg.appendAsAgent(O, N, B, 0, ct(30));
        vm.expectRevert(MemoryRegistry.NotAuthorized.selector);
        reg.appendAsAgent(O, N, A, 0, ct(30)); // A has no grant
        vm.stopPrank();
    }

    function test_sharedOperator_writeAttributedToClaimedAgentOnlyIfThatAgentAuthorized() public {
        // Agent B's owner points B's operator at opA. opA can now write as B (B's owner authorized it),
        // but A's READ-only grant must still not be writable.
        vm.prank(agentOwnerB);
        reg.setAgentKeys(B, bytes32(uint256(0xBBBB)), opA);
        grantTo(A, READ, uint64(T0 + 1 days));
        grantTo(B, READ_WRITE, uint64(T0 + 1 days));
        vm.startPrank(opA);
        vm.expectRevert(MemoryRegistry.NotAuthorized.selector);
        reg.appendAsAgent(O, N, A, 0, ct(30));
        reg.appendAsAgent(O, N, B, 0, ct(30));
        vm.stopPrank();
    }

    function test_transfer_oldHolderCannotSetKeys() public {
        vm.prank(agentOwnerA);
        identity.transferFrom(agentOwnerA, attacker, A);
        vm.prank(agentOwnerA);
        vm.expectRevert(MemoryRegistry.NotAgentOwner.selector);
        reg.setAgentKeys(A, bytes32(uint256(1)), agentOwnerA);
    }

    // Was a gap; now specified (BUGLOG R2): transfer invalidates the old operator immediately.
    function test_transfer_oldOperatorLosesWriteImmediately() public {
        grantTo(A, READ_WRITE, uint64(T0 + 1 days));
        vm.prank(agentOwnerA);
        identity.transferFrom(agentOwnerA, attacker, A);
        vm.prank(opA);
        vm.expectRevert(MemoryRegistry.NotAuthorized.selector);
        reg.appendAsAgent(O, N, A, 0, ct(30));
    }

    function test_gap_agentCanRegisterAnotherAgentsX25519Key() public {
        (bytes32 keyA,) = reg.agentKeysOf(A);
        vm.prank(agentOwnerB);
        reg.setAgentKeys(B, keyA, opB); // succeeds: no uniqueness check on x25519Pub or operator
        (bytes32 keyB,) = reg.agentKeysOf(B);
        assertEq(keyB, keyA);
    }

    function test_gap_tooManyGranteesCountsExpiredUntilRotate() public {
        for (uint256 i; i < 16; i++) grantTo(100 + i, READ, uint64(T0 + 1 hours));
        vm.warp(T0 + 2 hours);
        (, uint64 epoch,) = reg.namespaceOf(O, N);
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.TooManyGrantees.selector);
        reg.grant(N, 116, READ, uint64(T0 + 1 days), u64s(epoch), nWraps(1));
    }

    // ---------------------------------------------------------------- DoS

    // Updated for BUGLOG R3: burned B is pruned on rotation, so the correct keep set is empty; never blocked.
    function test_dos_hostileIdentityCannotBlockRevokeOrRotate() public {
        grantTo(A, READ, uint64(T0 + 1 days));
        grantTo(B, READ, uint64(T0 + 1 days));
        identity.setBomb(A);
        identity.burn(B);
        vm.prank(O);
        reg.revoke(N, one(A), new uint256[](0), nWraps(0));
        assertEq(reg.granteesOf(O, N).length, 0);
        vm.prank(O);
        reg.rotate(N, new uint256[](0), nWraps(0));
    }

    function test_dos_revokeRotateWith16GranteesUnder30M() public {
        for (uint256 i; i < 16; i++) grantTo(100 + i, READ, uint64(T0 + 1 days));
        uint256[] memory keep = new uint256[](15);
        for (uint256 i; i < 15; i++) keep[i] = 115 - i; // reverse order: worst case for the duplicate scan
        uint256 g0 = gasleft();
        vm.prank(O);
        reg.revoke(N, one(100), keep, nWraps(15));
        uint256 used = g0 - gasleft();
        assertLt(used, 30_000_000);
        emit log_named_uint("revoke 16 grantees gas", used);
    }

    function test_dos_hugeKeepIdsRevertsCheaply() public {
        grantTo(A, READ, uint64(T0 + 1 days));
        uint256[] memory keep = new uint256[](5000);
        uint256 g0 = gasleft();
        vm.prank(O);
        try reg.rotate(N, keep, new bytes[](5000)) {
            fail();
        } catch (bytes memory err) {
            assertEq(bytes4(err), MemoryRegistry.KeepSetMismatch.selector);
        }
        assertLt(g0 - gasleft(), 30_000_000);
    }
}
