// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Adversarial probes against the 2026-10-01 registry fixes (BUGLOG R1, R2; contracts/memory-registry.md
// "review 2026-10-01", cases 36-42). Each test PASSES when behavior matches the spec and FAILS on a bug.
// test_gap_* record behavior the spec leaves undefined and assert what the implementation currently does.

import {Test} from "forge-std/Test.sol";
import {MemoryRegistry} from "engram/MemoryRegistry.sol";

/// Identity registry with per-token behaviors. ownerOf is deliberately NOT view, so if the registry ever
/// called it with CALL instead of STATICCALL, the reentrant path (mode 6) could mutate registry state.
contract ModeIdentity {
    mapping(uint256 => address) public holder;
    mapping(uint256 => uint8) public mode; // 0 normal, 1 revert, 2 gas bomb, 3 dirty address, 4 empty return, 5 huge return, 6 reenter
    address public reg;
    bytes public reenterCall;

    function setReg(address r) external {
        reg = r;
    }

    function setReenter(bytes calldata c) external {
        reenterCall = c;
    }

    function mint(address to, uint256 id) external {
        holder[id] = to;
    }

    function transfer(uint256 id, address to) external {
        require(msg.sender == holder[id], "not holder");
        holder[id] = to;
    }

    function burn(uint256 id) external {
        holder[id] = address(0);
    }

    function setMode(uint256 id, uint8 m) external {
        mode[id] = m;
    }

    function ownerOf(uint256 id) external returns (address) {
        uint8 m = mode[id];
        address h = holder[id];
        if (m == 1 || h == address(0)) revert("ERC721NonexistentToken");
        if (m == 2) {
            while (true) {}
        }
        if (m == 3) {
            assembly {
                mstore(0, or(h, shl(160, 1)))
                return(0, 32)
            }
        }
        if (m == 4) {
            assembly {
                return(0, 0)
            }
        }
        if (m == 5) {
            assembly {
                mstore(0, h)
                return(0, 200000)
            }
        }
        if (m == 6) {
            (bool ok,) = reg.call(reenterCall);
            ok;
        }
        return h;
    }
}

/// Calls the registry from one contract so several actions share a single transaction (transient storage scope).
contract TxHelper {
    function relayThenCreate(MemoryRegistry reg, address owner, bytes calldata data, uint256 dl, bytes calldata sig, bytes32 ns)
        external
    {
        reg.relay(owner, data, dl, sig);
        reg.createNamespace(ns);
    }

    function failedRelayThenCreate(
        MemoryRegistry reg,
        address owner,
        bytes calldata data,
        uint256 dl,
        bytes calldata sig,
        bytes32 ns
    ) external returns (bool relayOk) {
        try reg.relay(owner, data, dl, sig) {
            relayOk = true;
        } catch {
            relayOk = false;
        }
        reg.createNamespace(ns);
    }

    function twoRelays(
        MemoryRegistry reg,
        address o1,
        bytes calldata d1,
        bytes calldata s1,
        address o2,
        bytes calldata d2,
        bytes calldata s2,
        uint256 dl
    ) external {
        reg.relay(o1, d1, dl, s1);
        reg.relay(o2, d2, dl, s2);
    }

    function useNonceTwice(MemoryRegistry reg) external {
        reg.useNonce();
        reg.useNonce();
    }
}

contract FixesAdversarial is Test {
    MemoryRegistry reg;
    ModeIdentity identity;
    TxHelper helper;

    uint256 constant OWNER_PK = 0xA11CE;
    uint256 constant OWNER2_PK = 0xB0B;
    address O;
    address O2;
    address relayer = makeAddr("relayer");
    address X = makeAddr("newHolderX");

    uint256 constant A = 7;
    uint256 constant B = 9;
    address agentOwnerA = makeAddr("agentOwnerA");
    address agentOwnerB = makeAddr("agentOwnerB");
    address opA = makeAddr("operatorA");
    address opB = makeAddr("operatorB");
    address opX = makeAddr("operatorX");

    bytes32 constant N = keccak256("namespace-N");
    uint8 constant READ = 1;
    uint8 constant READ_WRITE = 3;
    uint256 constant T0 = 1_790_000_000;
    uint256 DL;

    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant OWNER_CALL_TYPEHASH =
        keccak256("OwnerCall(address owner,bytes32 dataHash,uint256 nonce,uint256 deadline)");

    function setUp() public {
        vm.chainId(10143);
        vm.warp(T0);
        DL = T0 + 5 minutes;
        O = vm.addr(OWNER_PK);
        O2 = vm.addr(OWNER2_PK);
        identity = new ModeIdentity();
        reg = new MemoryRegistry(address(identity));
        identity.setReg(address(reg));
        helper = new TxHelper();
        identity.mint(agentOwnerA, A);
        identity.mint(agentOwnerB, B);
        vm.prank(agentOwnerA);
        reg.setAgentKeys(A, bytes32(uint256(0xAAAA)), opA);
        vm.prank(agentOwnerB);
        reg.setAgentKeys(B, bytes32(uint256(0xBBBB)), opB);
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

    function none() internal pure returns (uint256[] memory r) {
        r = new uint256[](0);
    }

    function wraps(uint256 n) internal pure returns (bytes[] memory r) {
        r = new bytes[](n);
        for (uint256 i; i < n; i++) r[i] = w(uint8(i));
    }

    function grantData(uint256 id, uint8 scope) internal view returns (bytes memory) {
        (, uint64 epoch,) = reg.namespaceOf(O, N);
        return abi.encodeCall(MemoryRegistry.grant, (N, id, scope, uint64(block.timestamp + 30 days), u64s(epoch), wraps(1)));
    }

    function grantTo(uint256 id, uint8 scope) internal {
        (, uint64 epoch,) = reg.namespaceOf(O, N);
        vm.prank(O);
        reg.grant(N, id, scope, uint64(block.timestamp + 30 days), u64s(epoch), wraps(1));
    }

    function digest(address owner, bytes memory data, uint256 nonce, uint256 deadline) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("EngramMemoryRegistry"), keccak256("1"), block.chainid, address(reg))
        );
        bytes32 structHash = keccak256(abi.encode(OWNER_CALL_TYPEHASH, owner, keccak256(data), nonce, deadline));
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function sig(uint256 pk, bytes memory data, uint256 nonce) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest(vm.addr(pk), data, nonce, DL));
        return abi.encodePacked(r, s, v);
    }

    function exists(address owner, bytes32 ns) internal view returns (bool e) {
        (e,,) = reg.namespaceOf(owner, ns);
    }

    // ---------------------------------------------------------------- transient actor

    function test_transient_clearedAfterRelay_sameTxDirectCallActsAsCaller() public {
        bytes32 n1 = keccak256("relayed");
        bytes32 n2 = keccak256("direct");
        bytes memory d = abi.encodeCall(MemoryRegistry.createNamespace, (n1));
        helper.relayThenCreate(reg, O, d, DL, sig(OWNER_PK, d, 0), n2);
        assertTrue(exists(O, n1), "relayed ns owned by O");
        assertTrue(exists(address(helper), n2), "direct ns owned by helper");
        assertFalse(exists(O, n2), "direct call after relay must not act as O");
        assertFalse(exists(address(reg), n1), "self-call must not act as the registry");
    }

    function test_transient_failedRelayInsideTryCatch_doesNotLeakActor() public {
        // Inner call reverts (N already exists for O), relay bubbles, helper catches, then calls directly.
        bytes memory d = abi.encodeCall(MemoryRegistry.createNamespace, (N));
        bytes32 n2 = keccak256("after-failed");
        bool ok = helper.failedRelayThenCreate(reg, O, d, DL, sig(OWNER_PK, d, 0), n2);
        assertFalse(ok);
        assertTrue(exists(address(helper), n2));
        assertFalse(exists(O, n2));
        assertEq(reg.nonces(O), 0, "failed relay keeps the nonce (documented)");
    }

    function test_transient_twoRelaysDifferentOwnersSameTx() public {
        bytes32 n1 = keccak256("o1");
        bytes32 n2 = keccak256("o2");
        bytes memory d1 = abi.encodeCall(MemoryRegistry.createNamespace, (n1));
        bytes memory d2 = abi.encodeCall(MemoryRegistry.createNamespace, (n2));
        helper.twoRelays(reg, O, d1, sig(OWNER_PK, d1, 0), O2, d2, sig(OWNER2_PK, d2, 0), DL);
        assertTrue(exists(O, n1));
        assertTrue(exists(O2, n2));
        assertFalse(exists(O, n2));
        assertFalse(exists(O2, n1));
    }

    function test_transient_doesNotTouchPersistentStorage() public {
        bytes32[8] memory before;
        for (uint256 i; i < 8; i++) before[i] = vm.load(address(reg), bytes32(i));
        bytes32 dsBefore = reg.domainSeparator();
        bytes memory d = abi.encodeCall(MemoryRegistry.createNamespace, (keccak256("x")));
        vm.prank(relayer);
        reg.relay(O, d, DL, sig(OWNER_PK, d, 0));
        for (uint256 i; i < 8; i++) assertEq(vm.load(address(reg), bytes32(i)), before[i], "persistent slot changed");
        assertEq(reg.domainSeparator(), dsBefore);
        (, string memory name, string memory version,,,,) = reg.eip712Domain();
        assertEq(name, "EngramMemoryRegistry");
        assertEq(version, "1");
    }

    function test_transient_reentryFromOwnerOfDuringRelayedGrantCannotAct() public {
        // During O's relayed grant, agent 7's ownerOf tries to relay a second O-signed call (nonce 1) and a direct
        // createNamespace. The registry must call ownerOf statically, so neither lands.
        bytes32 evil = keccak256("reentered");
        bytes memory inner = abi.encodeCall(MemoryRegistry.createNamespace, (evil));
        identity.setReenter(abi.encodeCall(MemoryRegistry.relay, (O, inner, DL, sig(OWNER_PK, inner, 1))));
        identity.setMode(A, 6);
        bytes memory d = grantData(A, READ);
        vm.prank(relayer);
        reg.relay(O, d, DL, sig(OWNER_PK, d, 0));
        (uint8 scope,) = reg.grantOf(O, N, A);
        assertEq(scope, READ, "grant applied");
        assertFalse(exists(O, evil), "reentrant relay must not execute");
        assertEq(reg.nonces(O), 1, "only the outer relay consumed a nonce");
    }

    function test_transient_reentryFromOwnerOfDirectCreate() public {
        bytes32 evil = keccak256("reentered-direct");
        identity.setReenter(abi.encodeCall(MemoryRegistry.createNamespace, (evil)));
        identity.setMode(A, 6);
        grantTo(A, READ_WRITE);
        vm.prank(opA);
        reg.appendAsAgent(O, N, A, 0, ct(40));
        assertFalse(exists(address(identity), evil));
        assertFalse(exists(O, evil));
        assertFalse(exists(address(reg), evil));
    }

    function test_directCallWithRegistryAddressPaddingActsAsSender() public {
        // Case 42 variant: pad with the owner address AND with address(this)-looking bytes; still msg.sender.
        bytes32 n1 = keccak256("pad");
        (bool ok,) = address(reg).call(abi.encodePacked(abi.encodeCall(MemoryRegistry.createNamespace, (n1)), O));
        assertTrue(ok);
        assertTrue(exists(address(this), n1));
        assertFalse(exists(O, n1));
    }

    // ---------------------------------------------------------------- useNonce

    function test_useNonce_relayedIncrementsExactlyOnce() public {
        bytes memory d = abi.encodeCall(MemoryRegistry.useNonce, ());
        vm.prank(relayer);
        reg.relay(O, d, DL, sig(OWNER_PK, d, 0));
        assertEq(reg.nonces(O), 1);
        assertEq(reg.nonces(address(reg)), 0, "registry's own nonce untouched");
        assertEq(reg.nonces(relayer), 0);
    }

    function test_useNonce_directIncrementsCallerOnly() public {
        vm.prank(relayer);
        reg.useNonce();
        assertEq(reg.nonces(relayer), 1);
        assertEq(reg.nonces(O), 0, "a third party cannot burn O's nonce");
        helper.useNonceTwice(reg);
        assertEq(reg.nonces(address(helper)), 2);
    }

    function test_useNonce_directCancelsPendingSignedCall() public {
        bytes memory c = abi.encodeCall(MemoryRegistry.createNamespace, (keccak256("pending")));
        bytes memory s = sig(OWNER_PK, c, 0);
        vm.prank(O);
        reg.useNonce();
        vm.prank(relayer);
        vm.expectRevert(MemoryRegistry.BadSignature.selector);
        reg.relay(O, c, DL, s);
    }

    function test_useNonce_relayedCancelPreventsLaterPendingButNotEarlierOnes() public {
        // Signed c at nonce 0 and cancel at nonce 0. Whichever lands first wins; the other is dead.
        bytes memory c = abi.encodeCall(MemoryRegistry.createNamespace, (keccak256("pending2")));
        bytes memory cSig = sig(OWNER_PK, c, 0);
        bytes memory u = abi.encodeCall(MemoryRegistry.useNonce, ());
        bytes memory uSig = sig(OWNER_PK, u, 0);
        vm.prank(relayer);
        reg.relay(O, u, DL, uSig);
        vm.prank(relayer);
        vm.expectRevert(MemoryRegistry.BadSignature.selector);
        reg.relay(O, c, DL, cSig);
        // the cancel itself cannot be replayed
        vm.prank(relayer);
        vm.expectRevert(MemoryRegistry.BadSignature.selector);
        reg.relay(O, u, DL, uSig);
    }

    function test_useNonce_withTrailingCalldataStillSingleIncrement() public {
        bytes memory d = abi.encodePacked(abi.encodeCall(MemoryRegistry.useNonce, ()), bytes32(uint256(uint160(O))));
        vm.prank(relayer);
        reg.relay(O, d, DL, sig(OWNER_PK, d, 0));
        assertEq(reg.nonces(O), 1);
    }

    // ---------------------------------------------------------------- _keysCurrent

    // Updated for BUGLOG R3: agents whose ownerOf reverts or gas-bombs are pruned on rotation (keys not
    // current); the owner is never blocked, the correct keep set simply excludes them.
    function test_keys_revokeAndRotateNotBlockedByHostileOwnerOf_revertGasbombBurn() public {
        grantTo(A, READ_WRITE);
        grantTo(B, READ);
        identity.setMode(A, 2); // gas bomb
        identity.setMode(B, 1); // revert
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.KeepSetMismatch.selector);
        reg.rotate(N, _two(A, B), wraps(2)); // cannot re-key agents with non-current keys
        uint256 g0 = gasleft();
        vm.prank(O);
        reg.rotate(N, none(), wraps(0)); // prunes both
        assertLt(g0 - gasleft(), 1_000_000, "bounded by OWNER_OF_GAS per grantee");
        assertEq(reg.granteesOf(O, N).length, 0);
    }

    function test_keys_gasBombOwnerOfMakesGrantRevertCleanly() public {
        identity.setMode(A, 2);
        (, uint64 epoch,) = reg.namespaceOf(O, N);
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.AgentKeysMissing.selector);
        reg.grant{gas: 5_000_000}(N, A, READ, uint64(T0 + 1 days), u64s(epoch), wraps(1));
    }

    function test_keys_hugeReturndataOwnerOfStillWorks() public {
        identity.setMode(A, 5);
        grantTo(A, READ_WRITE);
        vm.prank(opA);
        reg.appendAsAgent{gas: 2_000_000}(O, N, A, 0, ct(40));
    }

    // Was a gap (BUGLOG R3): malformed ownerOf now means "keys not current".
    function test_dirtyAddressReturnFromOwnerOf_meansKeysNotCurrent() public {
        identity.setMode(A, 3);
        (, uint64 epoch,) = reg.namespaceOf(O, N);
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.AgentKeysMissing.selector);
        reg.grant(N, A, READ, uint64(T0 + 1 days), u64s(epoch), wraps(1));
        assertFalse(reg.hasCurrentKeys(A));
    }

    function test_emptyReturnFromOwnerOf_meansKeysNotCurrent() public {
        identity.setMode(A, 4);
        (, uint64 epoch,) = reg.namespaceOf(O, N);
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.AgentKeysMissing.selector);
        reg.grant(N, A, READ, uint64(T0 + 1 days), u64s(epoch), wraps(1));
        assertFalse(reg.hasCurrentKeys(A));
    }

    function test_keys_case36_37_afterTransferBothRefused() public {
        grantTo(A, READ_WRITE);
        vm.prank(agentOwnerA);
        identity.transfer(A, X);
        assertFalse(reg.hasCurrentKeys(A));
        vm.prank(opA);
        vm.expectRevert(MemoryRegistry.NotAuthorized.selector);
        reg.appendAsAgent(O, N, A, 0, ct(40));
        bytes memory d = grantData(A, READ);
        vm.prank(relayer);
        vm.expectRevert(MemoryRegistry.AgentKeysMissing.selector);
        reg.relay(O, d, DL, sig(OWNER_PK, d, 0));
    }

    function test_keys_newHolderSetsKeys_oldOperatorStillRefused() public {
        grantTo(A, READ_WRITE);
        vm.prank(agentOwnerA);
        identity.transfer(A, X);
        vm.prank(X);
        reg.setAgentKeys(A, bytes32(uint256(0xCCCC)), opX);
        vm.prank(opA);
        vm.expectRevert(MemoryRegistry.NotAuthorized.selector);
        reg.appendAsAgent(O, N, A, 0, ct(40));
    }

    function test_keys_oldHolderCannotResetKeysAfterTransfer() public {
        vm.prank(agentOwnerA);
        identity.transfer(A, X);
        vm.prank(agentOwnerA);
        vm.expectRevert(MemoryRegistry.NotAgentOwner.selector);
        reg.setAgentKeys(A, bytes32(uint256(0xDDDD)), opA);
    }

    function test_gap_newHolderInheritsPreTransferWriteGrant() public {
        // O granted READ_WRITE to agentId 7 while agentOwnerA held it. X buys the token and sets keys:
        // X's operator can now append to O's namespace with no action by O. Spec keys grants to agentId.
        grantTo(A, READ_WRITE);
        vm.prank(agentOwnerA);
        identity.transfer(A, X);
        vm.prank(X);
        reg.setAgentKeys(A, bytes32(uint256(0xCCCC)), opX);
        vm.prank(opX);
        reg.appendAsAgent(O, N, A, 0, ct(40));
        (,, uint64 nextSeq) = reg.namespaceOf(O, N);
        assertEq(nextSeq, 1);
    }

    function test_gap_transferAwayAndBack_oldKeysCurrentAgain() public {
        grantTo(A, READ_WRITE);
        vm.prank(agentOwnerA);
        identity.transfer(A, X);
        assertFalse(reg.hasCurrentKeys(A));
        vm.prank(X);
        identity.transfer(A, agentOwnerA);
        assertTrue(reg.hasCurrentKeys(A));
        vm.prank(opA);
        reg.appendAsAgent(O, N, A, 0, ct(40));
    }

    // Was a gap (BUGLOG R3): a grantee whose token moved is pruned on rotation and can never be re-keyed.
    function test_rotateCannotRekeyGranteeWithStaleKeys() public {
        grantTo(A, READ);
        vm.prank(agentOwnerA);
        identity.transfer(A, X);
        (bytes32 pub, address op) = reg.agentKeysOf(A);
        assertEq(pub, bytes32(uint256(0xAAAA))); // still returned: SDKs must check hasCurrentKeys
        assertEq(op, opA);
        assertFalse(reg.hasCurrentKeys(A));
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.KeepSetMismatch.selector);
        reg.rotate(N, one(A), wraps(1));
        vm.prank(O);
        reg.rotate(N, none(), wraps(0));
        assertEq(reg.granteesOf(O, N).length, 0);
    }

    function test_keys_burnedToken_grantRefused_appendRefused() public {
        grantTo(A, READ_WRITE);
        identity.burn(A);
        vm.prank(opA);
        vm.expectRevert(MemoryRegistry.NotAuthorized.selector);
        reg.appendAsAgent(O, N, A, 0, ct(40));
        (, uint64 epoch,) = reg.namespaceOf(O, N);
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.AgentKeysMissing.selector);
        reg.grant(N, A, READ, uint64(T0 + 1 days), u64s(epoch), wraps(1));
        // re-minting to the same address restores the old keys (same address = same setBy)
        identity.mint(agentOwnerA, A);
        assertTrue(reg.hasCurrentKeys(A));
    }

    function test_keys_neverSetKeysForExistingToken() public {
        identity.mint(X, 55);
        assertFalse(reg.hasCurrentKeys(55));
        (, uint64 epoch,) = reg.namespaceOf(O, N);
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.AgentKeysMissing.selector);
        reg.grant(N, 55, READ, uint64(T0 + 1 days), u64s(epoch), wraps(1));
    }

    function testFuzz_keys_operatorMustMatchAndBeCurrent(address caller) public {
        vm.assume(caller != opA);
        grantTo(A, READ_WRITE);
        vm.prank(caller);
        vm.expectRevert(MemoryRegistry.NotAuthorized.selector);
        reg.appendAsAgent(O, N, A, 0, ct(40));
    }

    // ---------------------------------------------------------------- internals

    function _two(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }

    function _tryHasCurrentKeys(uint256 id) internal view returns (bool) {
        try reg.hasCurrentKeys(id) returns (bool v) {
            return v;
        } catch {
            return false;
        }
    }
}
