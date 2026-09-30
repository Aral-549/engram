// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Golden tests for contracts/memory-registry.md, one test per behavior case (#n in the name).
// Written from the spec before the implementation. FROZEN: add cases, never edit or delete (AGENTS.md rule 3).

import {Test} from "forge-std/Test.sol";
import {MemoryRegistry} from "engram/MemoryRegistry.sol";
import {MockIdentity} from "./MockIdentity.sol";

contract MemoryRegistryGolden is Test {
    MemoryRegistry reg;
    MockIdentity identity;

    uint256 constant OWNER_PK = 0xA11CE;
    address O;
    address O2 = makeAddr("owner2");
    address relayer = makeAddr("relayer");

    uint256 constant A = 7;
    uint256 constant B = 9;
    address agentOwnerA = makeAddr("agentOwnerA");
    address agentOwnerB = makeAddr("agentOwnerB");
    address opA = makeAddr("operatorA");
    address opB = makeAddr("operatorB");
    bytes32 constant KEY_A = bytes32(uint256(0xAAAA));
    bytes32 constant KEY_B = bytes32(uint256(0xBBBB));

    bytes32 constant N = keccak256("namespace-N");
    uint8 constant READ = 1;
    uint8 constant READ_WRITE = 3;
    uint256 constant T0 = 1_790_000_000;

    // Independent EIP-712 constants (from the spec, not read from the contract).
    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant OWNER_CALL_TYPEHASH =
        keccak256("OwnerCall(address owner,bytes32 dataHash,uint256 nonce,uint256 deadline)");
    uint256 constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function setUp() public {
        vm.chainId(10143);
        vm.warp(T0);
        O = vm.addr(OWNER_PK);
        identity = new MockIdentity();
        reg = new MemoryRegistry(address(identity));
        identity.mint(agentOwnerA, A);
        identity.mint(agentOwnerB, B);
        vm.prank(agentOwnerA);
        reg.setAgentKeys(A, KEY_A, opA);
        vm.prank(agentOwnerB);
        reg.setAgentKeys(B, KEY_B, opB);
        vm.prank(O);
        reg.createNamespace(N);
    }

    // ---------- helpers ----------

    function ct(uint256 len) internal pure returns (bytes memory b) {
        b = new bytes(len);
        for (uint256 i; i < len; i++) b[i] = bytes1(uint8(i + 1));
    }

    function wrap(uint8 tag) internal pure returns (bytes memory b) {
        b = new bytes(94);
        b[0] = 0x01;
        b[93] = bytes1(tag);
    }

    function u64s(uint64 a) internal pure returns (uint64[] memory r) {
        r = new uint64[](1);
        r[0] = a;
    }

    function ids() internal pure returns (uint256[] memory r) {
        r = new uint256[](0);
    }

    function ids(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function ids(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }

    function wraps() internal pure returns (bytes[] memory r) {
        r = new bytes[](0);
    }

    function wraps(bytes memory a) internal pure returns (bytes[] memory r) {
        r = new bytes[](1);
        r[0] = a;
    }

    function wraps(bytes memory a, bytes memory b) internal pure returns (bytes[] memory r) {
        r = new bytes[](2);
        r[0] = a;
        r[1] = b;
    }

    function grantA(uint8 scope) internal {
        vm.prank(O);
        reg.grant(N, A, scope, uint64(T0 + 1 days), u64s(0), wraps(wrap(0xA0)));
    }

    function grantB(uint8 scope, uint64 expiry) internal {
        vm.prank(O);
        reg.grant(N, B, scope, expiry, u64s(0), wraps(wrap(0xB0)));
    }

    function digest(uint256 chainId, address verifying, address owner, bytes memory data, uint256 nonce, uint256 deadline)
        internal
        pure
        returns (bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("EngramMemoryRegistry"), keccak256("1"), chainId, verifying)
        );
        bytes32 structHash = keccak256(abi.encode(OWNER_CALL_TYPEHASH, owner, keccak256(data), nonce, deadline));
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function sign(bytes32 d) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, d);
        return abi.encodePacked(r, s, v);
    }

    function signFor(bytes memory data, uint256 deadline) internal view returns (bytes memory) {
        return sign(digest(block.chainid, address(reg), O, data, reg.nonces(O), deadline));
    }

    // ---------- namespaces and owner entries ----------

    function test_01_createNamespace() public {
        bytes32 n2 = keccak256("other");
        vm.expectEmit(true, true, true, true, address(reg));
        emit MemoryRegistry.NamespaceCreated(O, n2);
        vm.prank(O);
        reg.createNamespace(n2);
        (bool exists, uint64 epoch, uint64 nextSeq) = reg.namespaceOf(O, n2);
        assertTrue(exists);
        assertEq(epoch, 0);
        assertEq(nextSeq, 0);
    }

    function test_02_createNamespaceTwiceReverts() public {
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.NamespaceExists.selector);
        reg.createNamespace(N);
    }

    function test_03_appendAsOwner() public {
        bytes memory c = ct(30);
        vm.expectEmit(true, true, true, true, address(reg));
        emit MemoryRegistry.EntryAppended(O, N, 0, 0, true, 0, c);
        vm.prank(O);
        reg.appendAsOwner(N, 0, c);
        (,, uint64 nextSeq) = reg.namespaceOf(O, N);
        assertEq(nextSeq, 1);
        vm.prank(O);
        reg.appendAsOwner(N, 0, c);
        (,, nextSeq) = reg.namespaceOf(O, N);
        assertEq(nextSeq, 2);
    }

    function test_04_appendWrongEpochReverts() public {
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.WrongEpoch.selector);
        reg.appendAsOwner(N, 1, ct(30));
    }

    function test_05_appendBadLengthReverts() public {
        vm.startPrank(O);
        vm.expectRevert(MemoryRegistry.BadCiphertextLength.selector);
        reg.appendAsOwner(N, 0, ct(29));
        vm.expectRevert(MemoryRegistry.BadCiphertextLength.selector);
        reg.appendAsOwner(N, 0, ct(2078));
        reg.appendAsOwner(N, 0, ct(2077)); // max allowed
        vm.stopPrank();
    }

    // ---------- grants ----------

    function test_06_grant() public {
        vm.expectEmit(true, true, true, true, address(reg));
        emit MemoryRegistry.GrantSet(O, N, A, READ, uint64(T0 + 1 days));
        vm.expectEmit(true, true, true, true, address(reg));
        emit MemoryRegistry.KeyWrapped(O, N, A, 0, wrap(0xA0));
        grantA(READ);
        uint256[] memory g = reg.granteesOf(O, N);
        assertEq(g.length, 1);
        assertEq(g[0], A);
        assertTrue(reg.isActive(O, N, A));
        (uint8 scope, uint64 expiry) = reg.grantOf(O, N, A);
        assertEq(scope, READ);
        assertEq(expiry, T0 + 1 days);
    }

    function test_07_grantToAgentWithoutKeysReverts() public {
        identity.mint(makeAddr("x"), 42);
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.AgentKeysMissing.selector);
        reg.grant(N, 42, READ, uint64(T0 + 1 days), u64s(0), wraps(wrap(1)));
    }

    function test_08_grantBadEpochsReverts() public {
        // rotate twice so current epoch = 2
        vm.startPrank(O);
        reg.rotate(N, ids(), wraps());
        reg.rotate(N, ids(), wraps());
        uint64 exp = uint64(T0 + 1 days);

        uint64[] memory notEndingAtCurrent = u64s(1);
        vm.expectRevert(MemoryRegistry.BadEpochs.selector);
        reg.grant(N, A, READ, exp, notEndingAtCurrent, wraps(wrap(1)));

        uint64[] memory notIncreasing = new uint64[](2);
        notIncreasing[0] = 2;
        notIncreasing[1] = 2;
        vm.expectRevert(MemoryRegistry.BadEpochs.selector);
        reg.grant(N, A, READ, exp, notIncreasing, wraps(wrap(1), wrap(2)));

        uint64[] memory two = new uint64[](2);
        two[0] = 1;
        two[1] = 2;
        vm.expectRevert(MemoryRegistry.BadEpochs.selector);
        reg.grant(N, A, READ, exp, two, wraps(wrap(1)));

        uint64[] memory empty = new uint64[](0);
        vm.expectRevert(MemoryRegistry.BadEpochs.selector);
        reg.grant(N, A, READ, exp, empty, wraps());

        reg.grant(N, A, READ, exp, two, wraps(wrap(1), wrap(2))); // valid: history + current
        vm.stopPrank();
    }

    function test_09_grantBadScopeReverts() public {
        uint8[3] memory bad = [uint8(0), 2, 4];
        for (uint256 i; i < bad.length; i++) {
            vm.prank(O);
            vm.expectRevert(MemoryRegistry.BadScope.selector);
            reg.grant(N, A, bad[i], uint64(T0 + 1 days), u64s(0), wraps(wrap(1)));
        }
    }

    function test_10_grantBadExpiryReverts() public {
        vm.startPrank(O);
        vm.expectRevert(MemoryRegistry.BadExpiry.selector);
        reg.grant(N, A, READ, uint64(T0), u64s(0), wraps(wrap(1)));
        vm.expectRevert(MemoryRegistry.BadExpiry.selector);
        reg.grant(N, A, READ, uint64(T0 + 365 days + 1), u64s(0), wraps(wrap(1)));
        reg.grant(N, A, READ, uint64(T0 + 365 days), u64s(0), wraps(wrap(1))); // boundary ok
        vm.stopPrank();
    }

    function test_11_tooManyGranteesReverts() public {
        vm.startPrank(O);
        for (uint256 i; i < 16; i++) {
            uint256 id = 100 + i;
            identity.mint(address(uint160(0x1000 + i)), id);
            vm.stopPrank();
            vm.prank(address(uint160(0x1000 + i)));
            reg.setAgentKeys(id, bytes32(id), address(uint160(0x2000 + i)));
            vm.startPrank(O);
            reg.grant(N, id, READ, uint64(T0 + 1 days), u64s(0), wraps(wrap(uint8(i))));
        }
        vm.expectRevert(MemoryRegistry.TooManyGrantees.selector);
        reg.grant(N, A, READ, uint64(T0 + 1 days), u64s(0), wraps(wrap(1)));
        // re-grant of an existing grantee is still allowed
        reg.grant(N, 100, READ_WRITE, uint64(T0 + 2 days), u64s(0), wraps(wrap(9)));
        vm.stopPrank();
        assertEq(reg.granteesOf(O, N).length, 16);
    }

    function test_12_regrantUpdatesWithoutDuplicate() public {
        grantA(READ);
        vm.expectEmit(true, true, true, true, address(reg));
        emit MemoryRegistry.GrantSet(O, N, A, READ_WRITE, uint64(T0 + 1 days));
        grantA(READ_WRITE);
        assertEq(reg.granteesOf(O, N).length, 1);
        (uint8 scope,) = reg.grantOf(O, N, A);
        assertEq(scope, READ_WRITE);
    }

    function test_grantBadWrapLengthReverts() public {
        bytes memory short = new bytes(93);
        bytes memory long = new bytes(126);
        vm.startPrank(O);
        vm.expectRevert(MemoryRegistry.BadWrapLength.selector);
        reg.grant(N, A, READ, uint64(T0 + 1 days), u64s(0), wraps(short));
        vm.expectRevert(MemoryRegistry.BadWrapLength.selector);
        reg.grant(N, A, READ, uint64(T0 + 1 days), u64s(0), wraps(long));
        vm.stopPrank();
    }

    // ---------- agent writes ----------

    function test_13_appendAsAgentWithWrite() public {
        grantA(READ_WRITE);
        bytes memory c = ct(40);
        vm.expectEmit(true, true, true, true, address(reg));
        emit MemoryRegistry.EntryAppended(O, N, 0, 0, false, A, c);
        vm.prank(opA);
        reg.appendAsAgent(O, N, A, 0, c);
    }

    function test_14_appendAsAgentReadOnlyReverts() public {
        grantA(READ);
        vm.prank(opA);
        vm.expectRevert(MemoryRegistry.NotAuthorized.selector);
        reg.appendAsAgent(O, N, A, 0, ct(40));
    }

    function test_15_appendAsAgentWrongOperatorReverts() public {
        grantA(READ_WRITE);
        vm.prank(opB);
        vm.expectRevert(MemoryRegistry.NotAuthorized.selector);
        reg.appendAsAgent(O, N, A, 0, ct(40));
    }

    function test_16_appendAsAgentAfterExpiryReverts() public {
        grantA(READ_WRITE);
        vm.warp(T0 + 1 days); // expiry is exclusive: at expiry the grant is no longer active
        assertFalse(reg.isActive(O, N, A));
        vm.prank(opA);
        vm.expectRevert(MemoryRegistry.GrantExpired.selector);
        reg.appendAsAgent(O, N, A, 0, ct(40));
    }

    // ---------- revoke / rotate ----------

    function test_17_revokeRotatesAndRewrapsRemaining() public {
        grantA(READ_WRITE);
        grantB(READ, uint64(T0 + 1 days));
        vm.expectEmit(true, true, true, true, address(reg));
        emit MemoryRegistry.GrantRevoked(O, N, A);
        vm.expectEmit(true, true, true, true, address(reg));
        emit MemoryRegistry.EpochRotated(O, N, 1);
        vm.expectEmit(true, true, true, true, address(reg));
        emit MemoryRegistry.KeyWrapped(O, N, B, 1, wrap(0xB1));
        vm.prank(O);
        reg.revoke(N, ids(A), ids(B), wraps(wrap(0xB1)));
        uint256[] memory g = reg.granteesOf(O, N);
        assertEq(g.length, 1);
        assertEq(g[0], B);
        (, uint64 epoch,) = reg.namespaceOf(O, N);
        assertEq(epoch, 1);
        assertFalse(reg.isActive(O, N, A));
        (uint8 scope,) = reg.grantOf(O, N, A);
        assertEq(scope, 0);
    }

    function test_18_revokeKeepSetMismatchReverts() public {
        grantA(READ);
        grantB(READ, uint64(T0 + 1 days));
        uint256 C = 11;
        identity.mint(address(this), C);
        reg.setAgentKeys(C, bytes32(uint256(0xCCCC)), makeAddr("opC"));
        vm.prank(O);
        reg.grant(N, C, READ, uint64(T0 + 1 days), u64s(0), wraps(wrap(0xC0)));

        vm.startPrank(O);
        // missing a remaining grantee (C)
        vm.expectRevert(MemoryRegistry.KeepSetMismatch.selector);
        reg.revoke(N, ids(A), ids(B), wraps(wrap(1)));
        // extra id that is not a grantee (A was just revoked in the same call)
        uint256[] memory extra = new uint256[](3);
        extra[0] = B;
        extra[1] = C;
        extra[2] = A;
        bytes[] memory w3 = new bytes[](3);
        w3[0] = wrap(1);
        w3[1] = wrap(2);
        w3[2] = wrap(3);
        vm.expectRevert(MemoryRegistry.KeepSetMismatch.selector);
        reg.revoke(N, ids(A), extra, w3);
        // duplicate
        vm.expectRevert(MemoryRegistry.KeepSetMismatch.selector);
        reg.revoke(N, ids(A), ids(B, B), wraps(wrap(1), wrap(2)));
        // wraps length mismatch
        vm.expectRevert(MemoryRegistry.KeepSetMismatch.selector);
        reg.revoke(N, ids(A), ids(B, C), wraps(wrap(1)));
        // order does not matter
        reg.revoke(N, ids(A), ids(C, B), wraps(wrap(0xC1), wrap(0xB1)));
        vm.stopPrank();
    }

    function test_19_revokeNonGranteeReverts() public {
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.NotGrantee.selector);
        reg.revoke(N, ids(A), ids(), wraps());
    }

    function test_20_revokeExpiredGrantSucceeds() public {
        grantA(READ);
        vm.warp(T0 + 2 days);
        vm.prank(O);
        reg.revoke(N, ids(A), ids(), wraps());
        assertEq(reg.granteesOf(O, N).length, 0);
    }

    function test_21_revokedAgentCannotAppend() public {
        grantA(READ_WRITE);
        vm.prank(O);
        reg.revoke(N, ids(A), ids(), wraps());
        vm.prank(opA);
        vm.expectRevert(MemoryRegistry.NotAuthorized.selector);
        reg.appendAsAgent(O, N, A, 1, ct(40));
    }

    function test_22_rotate() public {
        grantB(READ, uint64(T0 + 1 days));
        vm.prank(O);
        reg.rotate(N, ids(B), wraps(wrap(0xB1)));
        vm.expectEmit(true, true, true, true, address(reg));
        emit MemoryRegistry.EpochRotated(O, N, 2);
        vm.expectEmit(true, true, true, true, address(reg));
        emit MemoryRegistry.KeyWrapped(O, N, B, 2, wrap(0xB2));
        vm.prank(O);
        reg.rotate(N, ids(B), wraps(wrap(0xB2)));
    }

    function test_32_rotatePrunesExpired() public {
        grantA(READ);
        grantB(READ, uint64(T0 + 1 hours));
        vm.warp(T0 + 2 hours);
        vm.expectEmit(true, true, true, true, address(reg));
        emit MemoryRegistry.GrantRevoked(O, N, B);
        vm.expectEmit(true, true, true, true, address(reg));
        emit MemoryRegistry.EpochRotated(O, N, 1);
        vm.expectEmit(true, true, true, true, address(reg));
        emit MemoryRegistry.KeyWrapped(O, N, A, 1, wrap(0xA1));
        vm.prank(O);
        reg.rotate(N, ids(A), wraps(wrap(0xA1)));
        uint256[] memory g = reg.granteesOf(O, N);
        assertEq(g.length, 1);
        assertEq(g[0], A);
    }

    function test_33_rotateCannotRekeyExpired() public {
        grantA(READ);
        grantB(READ, uint64(T0 + 1 hours));
        vm.warp(T0 + 2 hours);
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.KeepSetMismatch.selector);
        reg.rotate(N, ids(A, B), wraps(wrap(1), wrap(2)));
    }

    function test_33b_revokePrunesExpiredToo() public {
        grantA(READ);
        grantB(READ, uint64(T0 + 1 hours));
        uint256 C = 11;
        identity.mint(address(this), C);
        reg.setAgentKeys(C, bytes32(uint256(0xCCCC)), makeAddr("opC"));
        vm.prank(O);
        reg.grant(N, C, READ, uint64(T0 + 1 days), u64s(0), wraps(wrap(0xC0)));
        vm.warp(T0 + 2 hours);
        vm.prank(O);
        reg.revoke(N, ids(A), ids(C), wraps(wrap(0xC1)));
        uint256[] memory g = reg.granteesOf(O, N);
        assertEq(g.length, 1);
        assertEq(g[0], C);
    }

    function test_34_revokeEmptyReverts() public {
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.NothingToRevoke.selector);
        reg.revoke(N, ids(), ids(), wraps());
    }

    function test_35_revokeDuplicateIdsReverts() public {
        grantA(READ);
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.NotGrantee.selector);
        reg.revoke(N, ids(A, A), ids(), wraps());
    }

    // ---------- relay (gasless) ----------

    function test_23_relayGrant() public {
        bytes memory data =
            abi.encodeCall(MemoryRegistry.grant, (N, A, READ, uint64(T0 + 1 days), u64s(0), wraps(wrap(0xA0))));
        uint256 deadline = T0 + 1 hours;
        bytes memory sig = signFor(data, deadline);
        vm.expectEmit(true, true, true, true, address(reg));
        emit MemoryRegistry.GrantSet(O, N, A, READ, uint64(T0 + 1 days));
        vm.prank(relayer);
        reg.relay(O, data, deadline, sig);
        assertTrue(reg.isActive(O, N, A));
        assertEq(reg.nonces(O), 1);
    }

    function test_23b_relayAppendAsOwner() public {
        bytes memory c = ct(64);
        bytes memory data = abi.encodeCall(MemoryRegistry.appendAsOwner, (N, 0, c));
        bytes memory sig = signFor(data, T0 + 60);
        vm.expectEmit(true, true, true, true, address(reg));
        emit MemoryRegistry.EntryAppended(O, N, 0, 0, true, 0, c);
        vm.prank(relayer);
        reg.relay(O, data, T0 + 60, sig);
    }

    function test_24_relayReplayReverts() public {
        bytes memory data = abi.encodeCall(MemoryRegistry.appendAsOwner, (N, 0, ct(30)));
        bytes memory sig = signFor(data, T0 + 60);
        vm.prank(relayer);
        reg.relay(O, data, T0 + 60, sig);
        vm.prank(relayer);
        vm.expectRevert(MemoryRegistry.BadSignature.selector);
        reg.relay(O, data, T0 + 60, sig);
    }

    function test_25_relayAfterDeadlineReverts() public {
        bytes memory data = abi.encodeCall(MemoryRegistry.appendAsOwner, (N, 0, ct(30)));
        bytes memory sig = signFor(data, T0 + 60);
        vm.warp(T0 + 61);
        vm.prank(relayer);
        vm.expectRevert(MemoryRegistry.Expired.selector);
        reg.relay(O, data, T0 + 60, sig);
    }

    function test_26_relayDomainSeparation() public {
        bytes memory data = abi.encodeCall(MemoryRegistry.appendAsOwner, (N, 0, ct(30)));
        bytes memory sigMainnet = sign(digest(143, address(reg), O, data, 0, T0 + 60));
        vm.prank(relayer);
        vm.expectRevert(MemoryRegistry.BadSignature.selector);
        reg.relay(O, data, T0 + 60, sigMainnet);

        bytes memory sigOtherRegistry = sign(digest(10143, address(0xdead), O, data, 0, T0 + 60));
        vm.prank(relayer);
        vm.expectRevert(MemoryRegistry.BadSignature.selector);
        reg.relay(O, data, T0 + 60, sigOtherRegistry);
    }

    function test_27_relaySelectorNotAllowed() public {
        bytes[3] memory datas = [
            abi.encodeCall(MemoryRegistry.setAgentKeys, (A, KEY_A, opA)),
            abi.encodeCall(MemoryRegistry.appendAsAgent, (O, N, A, 0, ct(30))),
            abi.encodeCall(MemoryRegistry.relay, (O, hex"", 0, hex""))
        ];
        for (uint256 i; i < datas.length; i++) {
            bytes memory sig = signFor(datas[i], T0 + 60);
            vm.prank(relayer);
            vm.expectRevert(MemoryRegistry.SelectorNotAllowed.selector);
            reg.relay(O, datas[i], T0 + 60, sig);
        }
        bytes memory tooShort = hex"0102";
        bytes memory sig2 = signFor(tooShort, T0 + 60);
        vm.prank(relayer);
        vm.expectRevert(MemoryRegistry.SelectorNotAllowed.selector);
        reg.relay(O, tooShort, T0 + 60, sig2);
    }

    function test_28_relayHighSReverts() public {
        bytes memory data = abi.encodeCall(MemoryRegistry.appendAsOwner, (N, 0, ct(30)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, digest(block.chainid, address(reg), O, data, 0, T0 + 60));
        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        vm.prank(relayer);
        vm.expectRevert(MemoryRegistry.BadSignature.selector);
        reg.relay(O, data, T0 + 60, abi.encodePacked(r, highS, flippedV));
    }

    function test_relaySignedByAnotherKeyReverts() public {
        bytes memory data = abi.encodeCall(MemoryRegistry.appendAsOwner, (N, 0, ct(30)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, digest(block.chainid, address(reg), O, data, 0, T0 + 60));
        vm.prank(relayer);
        vm.expectRevert(MemoryRegistry.BadSignature.selector);
        reg.relay(O, data, T0 + 60, abi.encodePacked(r, s, v));
    }

    function test_relayInnerRevertBubblesAndKeepsNonce() public {
        bytes memory data = abi.encodeCall(MemoryRegistry.appendAsOwner, (keccak256("missing"), 0, ct(30)));
        bytes memory sig = signFor(data, T0 + 60);
        vm.prank(relayer);
        vm.expectRevert(MemoryRegistry.NoNamespace.selector);
        reg.relay(O, data, T0 + 60, sig);
        assertEq(reg.nonces(O), 0);
    }

    function test_relayCannotActForAnotherOwner() public {
        // O signs a call, relayer claims it is O2's: the signature does not match O2.
        bytes memory data = abi.encodeCall(MemoryRegistry.createNamespace, (keccak256("x")));
        bytes memory sig = signFor(data, T0 + 60);
        vm.prank(relayer);
        vm.expectRevert(MemoryRegistry.BadSignature.selector);
        reg.relay(O2, data, T0 + 60, sig);
    }

    // ---------- agent keys ----------

    function test_29_setAgentKeysNonOwnerReverts() public {
        vm.prank(agentOwnerB);
        vm.expectRevert(MemoryRegistry.NotAgentOwner.selector);
        reg.setAgentKeys(A, KEY_B, opB);
    }

    function test_30_agentTokenTransferHandsOverKeys() public {
        grantA(READ_WRITE);
        address X = makeAddr("newAgentOwner");
        address opX = makeAddr("opX");
        vm.prank(agentOwnerA);
        identity.transferFrom(agentOwnerA, X, A);
        vm.expectEmit(true, true, true, true, address(reg));
        emit MemoryRegistry.AgentKeysSet(A, bytes32(uint256(0xFFFF)), opX);
        vm.prank(X);
        reg.setAgentKeys(A, bytes32(uint256(0xFFFF)), opX);
        (bytes32 k, address op) = reg.agentKeysOf(A);
        assertEq(k, bytes32(uint256(0xFFFF)));
        assertEq(op, opX);
        vm.prank(opA);
        vm.expectRevert(MemoryRegistry.NotAuthorized.selector);
        reg.appendAsAgent(O, N, A, 0, ct(40));
        vm.prank(opX);
        reg.appendAsAgent(O, N, A, 0, ct(40));
    }

    function test_badAgentKeysReverts() public {
        vm.startPrank(agentOwnerA);
        vm.expectRevert(MemoryRegistry.BadAgentKeys.selector);
        reg.setAgentKeys(A, bytes32(0), opA);
        vm.expectRevert(MemoryRegistry.BadAgentKeys.selector);
        reg.setAgentKeys(A, KEY_A, address(0));
        vm.stopPrank();
    }

    function test_setAgentKeysForNonexistentTokenReverts() public {
        vm.expectRevert(); // ERC-721 ownerOf reverts for unminted tokens
        reg.setAgentKeys(12345, KEY_A, opA);
    }

    // ---------- missing namespaces and isolation ----------

    function test_31_ownerActionsWithoutNamespaceRevert() public {
        bytes32 missing = keccak256("missing");
        vm.startPrank(O);
        vm.expectRevert(MemoryRegistry.NoNamespace.selector);
        reg.appendAsOwner(missing, 0, ct(30));
        vm.expectRevert(MemoryRegistry.NoNamespace.selector);
        reg.grant(missing, A, READ, uint64(T0 + 1 days), u64s(0), wraps(wrap(1)));
        vm.expectRevert(MemoryRegistry.NoNamespace.selector);
        reg.revoke(missing, ids(A), ids(), wraps());
        vm.expectRevert(MemoryRegistry.NoNamespace.selector);
        reg.rotate(missing, ids(), wraps());
        vm.stopPrank();
        vm.prank(opA);
        vm.expectRevert(MemoryRegistry.NoNamespace.selector);
        reg.appendAsAgent(O, missing, A, 0, ct(30));
    }

    function test_sameNsIdDifferentOwnersAreIndependent() public {
        vm.prank(O2);
        reg.createNamespace(N);
        vm.prank(O2);
        reg.appendAsOwner(N, 0, ct(30));
        (,, uint64 seqO) = reg.namespaceOf(O, N);
        (,, uint64 seqO2) = reg.namespaceOf(O2, N);
        assertEq(seqO, 0);
        assertEq(seqO2, 1);
        grantA(READ_WRITE);
        assertTrue(reg.isActive(O, N, A));
        assertFalse(reg.isActive(O2, N, A));
    }

    // ---------- gas bound ----------

    function test_gas_revokeAndRotateWith16GranteesUnder30M() public {
        vm.startPrank(O);
        for (uint256 i; i < 16; i++) {
            uint256 id = 100 + i;
            identity.mint(address(uint160(0x1000 + i)), id);
            vm.stopPrank();
            vm.prank(address(uint160(0x1000 + i)));
            reg.setAgentKeys(id, bytes32(id), address(uint160(0x2000 + i)));
            vm.startPrank(O);
            reg.grant(N, id, READ, uint64(T0 + 1 days), u64s(0), wraps(wrap(uint8(i))));
        }
        uint256[] memory keep = new uint256[](15);
        bytes[] memory w = new bytes[](15);
        for (uint256 i; i < 15; i++) {
            keep[i] = 101 + i;
            w[i] = new bytes(125);
        }
        uint256 g0 = gasleft();
        reg.revoke(N, ids(100), keep, w);
        uint256 used = g0 - gasleft();
        emit log_named_uint("revoke(1 of 16) gas", used);
        assertLt(used, 30_000_000);

        g0 = gasleft();
        reg.rotate(N, keep, w);
        used = g0 - gasleft();
        emit log_named_uint("rotate(15) gas", used);
        assertLt(used, 30_000_000);
        vm.stopPrank();
    }
}
