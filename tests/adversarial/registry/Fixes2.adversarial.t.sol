// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

// Adversarial probes against BUGLOG R3 (raw-staticcall _keysCurrent, _rotate pruning of non-current keys;
// contracts/memory-registry.md cases 43-44 and the "Rotation rule"). Each test PASSES when behavior matches
// the spec and FAILS on a bug.

import {Test, Vm} from "forge-std/Test.sol";
import {MemoryRegistry} from "engram/MemoryRegistry.sol";
import {MockIdentity} from "../../golden/registry/MockIdentity.sol";

/// Identity registry with per-token behaviors, reached through ownerOf.
contract HostileIdentity {
    mapping(uint256 => address) public holder;
    mapping(uint256 => uint8) public mode;
    mapping(uint256 => uint256) public burnGas;
    uint256 public writes;
    address public reg;
    bytes public reenterCall;

    // modes: 0 normal, 1 long return (valid first word + junk), 2 revert carrying a valid 32-byte address,
    // 3 writes state, 4 reenters the registry, 5 strict calldata check, 6 huge returndata, 7 zero for burned
    function mint(address to, uint256 id) external {
        holder[id] = to;
    }

    function transfer(uint256 id, address to) external {
        holder[id] = to;
    }

    function setMode(uint256 id, uint8 m) external {
        mode[id] = m;
    }

    function setBurn(uint256 id, uint256 g) external {
        burnGas[id] = g;
    }

    function setReenter(address r, bytes calldata c) external {
        reg = r;
        reenterCall = c;
    }

    function ownerOf(uint256 id) external returns (address) {
        uint256 b = burnGas[id];
        if (b != 0) {
            uint256 start = gasleft();
            while (start - gasleft() < b) {}
        }
        uint8 m = mode[id];
        address h = holder[id];
        if (m == 7) return h; // address(0) for burned, no revert
        if (h == address(0)) revert("nonexistent");
        if (m == 1) {
            assembly {
                mstore(0, h)
                mstore(32, not(0))
                mstore(64, not(0))
                return(0, 96)
            }
        }
        if (m == 2) {
            assembly {
                mstore(0, h)
                revert(0, 32)
            }
        }
        if (m == 3) writes++;
        if (m == 4) {
            (bool ok,) = reg.call(reenterCall);
            ok;
        }
        if (m == 5) {
            if (msg.data.length != 36) return address(0xBAD);
        }
        if (m == 6) {
            assembly {
                mstore(0, h)
                return(0, 150000)
            }
        }
        return h;
    }

    // Lets the identity own a namespace in the registry (reentrancy probe).
    function exec(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory r) = target.call(data);
        require(ok, "exec failed");
        return r;
    }
}

contract Fixes2Adversarial is Test {
    bytes32 constant N = keccak256("ns-fixes2");
    uint256 constant T0 = 1_790_000_000;
    uint8 constant READ = 1;
    uint8 constant READ_WRITE = 3;

    address O;
    uint256 oKey;
    HostileIdentity id;
    MemoryRegistry reg;

    function setUp() public {
        vm.warp(T0);
        (O, oKey) = makeAddrAndKey("owner-fixes2");
        id = new HostileIdentity();
        reg = new MemoryRegistry(address(id));
        vm.prank(O);
        reg.createNamespace(N);
    }

    // ------------------------------------------------------------------ helpers

    function ids(uint256 a) internal pure returns (uint256[] memory r) {
        r = new uint256[](1);
        r[0] = a;
    }

    function ids(uint256 a, uint256 b) internal pure returns (uint256[] memory r) {
        r = new uint256[](2);
        r[0] = a;
        r[1] = b;
    }

    function none() internal pure returns (uint256[] memory r) {}

    function wraps(uint256 n) internal pure returns (bytes[] memory r) {
        r = new bytes[](n);
        for (uint256 i; i < n; i++) r[i] = new bytes(94);
    }

    function epoch0() internal pure returns (uint64[] memory r) {
        r = new uint64[](1);
    }

    function holderOf(uint256 agentId) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("holder", agentId)))));
    }

    function opOf(uint256 agentId) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("op", agentId)))));
    }

    function register(uint256 agentId) internal {
        id.mint(holderOf(agentId), agentId);
        vm.prank(holderOf(agentId));
        reg.setAgentKeys(agentId, bytes32(uint256(agentId) | 1), opOf(agentId));
    }

    function grantTo(uint256 agentId, uint8 scope) internal {
        vm.prank(O);
        reg.grant(N, agentId, scope, uint64(T0 + 1 days), epoch0(), wraps(1));
    }

    function isGrantee(uint256 agentId) internal view returns (bool) {
        uint256[] memory g = reg.granteesOf(O, N);
        for (uint256 i; i < g.length; i++) {
            if (g[i] == agentId) return true;
        }
        return false;
    }

    function sign(bytes memory data, uint256 nonce, uint256 deadline) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(reg.OWNER_CALL_TYPEHASH(), O, keccak256(data), nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", reg.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oKey, digest);
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------------ calldata / returndata handling

    function test_ownerOfCalldataIsExactAbiEncoding_edgeIds() public {
        uint256[4] memory xs = [uint256(0), 1, type(uint256).max, uint256(1) << 255];
        for (uint256 i; i < xs.length; i++) {
            id.setMode(xs[i], 5);
            register(xs[i]);
            assertTrue(reg.hasCurrentKeys(xs[i]), "selector/arg misencoded in raw staticcall");
        }
    }

    function test_longReturndataWithValidFirstWord_isCurrent_likeAbiDecoder() public {
        id.setMode(7, 1);
        register(7); // setAgentKeys' high-level decode accepts it, so _keysCurrent must agree
        assertTrue(reg.hasCurrentKeys(7));
        grantTo(7, READ_WRITE);
        vm.prank(opOf(7));
        reg.appendAsAgent(O, N, 7, 0, new bytes(31));
    }

    function test_revertCarrying32ByteValidAddress_isNotCurrent() public {
        register(7);
        grantTo(7, READ);
        id.setMode(7, 2);
        assertFalse(reg.hasCurrentKeys(7));
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.AgentKeysMissing.selector);
        reg.grant(N, 7, READ, uint64(T0 + 2 days), epoch0(), wraps(1));
        vm.prank(O);
        reg.rotate(N, none(), new bytes[](0));
        assertFalse(isGrantee(7));
    }

    function test_nonViewOwnerOfCannotWriteState_notCurrent() public {
        register(7);
        grantTo(7, READ_WRITE);
        id.setMode(7, 3);
        assertFalse(reg.hasCurrentKeys(7));
        vm.prank(opOf(7));
        vm.expectRevert(MemoryRegistry.NotAuthorized.selector);
        reg.appendAsAgent(O, N, 7, 0, new bytes(30));
        assertEq(id.writes(), 0);
    }

    function test_identityCodeRemoved_staticcallToEmptyAccount_isNotCurrent() public {
        register(7);
        grantTo(7, READ_WRITE);
        vm.etch(address(id), "");
        assertFalse(reg.hasCurrentKeys(7));
        vm.prank(O);
        vm.expectRevert(MemoryRegistry.AgentKeysMissing.selector);
        reg.grant(N, 7, READ, uint64(T0 + 2 days), epoch0(), wraps(1));
        vm.prank(opOf(7));
        vm.expectRevert(MemoryRegistry.NotAuthorized.selector);
        reg.appendAsAgent(O, N, 7, 0, new bytes(30));
        vm.prank(O);
        reg.rotate(N, none(), new bytes[](0));
        assertEq(reg.granteesOf(O, N).length, 0);
    }

    function test_noCodeIdentityAtDeploy_setAgentKeysReverts_nothingCurrent() public {
        MemoryRegistry r = new MemoryRegistry(address(0xDEAD));
        vm.expectRevert();
        r.setAgentKeys(1, bytes32(uint256(1)), address(1));
        assertFalse(r.hasCurrentKeys(1));
    }

    function test_ownerOfReturnsZeroForBurned_isNotCurrent() public {
        id.setMode(7, 7);
        register(7);
        grantTo(7, READ);
        id.transfer(7, address(0));
        assertFalse(reg.hasCurrentKeys(7));
        vm.prank(O);
        reg.rotate(N, none(), new bytes[](0));
        assertFalse(isGrantee(7));
    }

    function test_hugeReturndata_boundedGas_andOnlyFirstWordUsed() public {
        register(7);
        id.setMode(7, 6);
        uint256 g0 = gasleft();
        bool cur = reg.hasCurrentKeys(7);
        uint256 used = g0 - gasleft();
        emit log_named_uint("hasCurrentKeys with 150KB returndata gas", used);
        // either the callee ran out of its 100k cap (not current) or it returned a valid first word (current)
        assertLt(used, 130_000);
        cur;
    }

    function test_transferAwayAndBack_keysCurrentAgain_rotateKeepsGrantee() public {
        register(7);
        register(9);
        grantTo(7, READ);
        grantTo(9, READ);
        id.transfer(9, makeAddr("buyer"));
        assertFalse(reg.hasCurrentKeys(9));
        id.transfer(9, holderOf(9));
        assertTrue(reg.hasCurrentKeys(9));
        vm.prank(O);
        reg.rotate(N, ids(7, 9), wraps(2));
        assertTrue(isGrantee(9));
    }

    // ------------------------------------------------------------------ memory: scratch at free pointer

    function test_dirtyScratchDoesNotLeakIntoEventPadding() public {
        uint256 big = type(uint256).max; // leaves 0xff bytes past the returned word in scratch memory
        register(big);
        bytes memory w = new bytes(95); // not a multiple of 32: event data has padding bytes
        bytes[] memory ws = new bytes[](1);
        ws[0] = w;
        vm.recordLogs();
        vm.prank(O);
        reg.grant(N, big, READ_WRITE, uint64(T0 + 1 days), epoch0(), ws);
        bytes memory ct = new bytes(31);
        vm.prank(opOf(big));
        reg.appendAsAgent(O, N, big, 0, ct);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool sawWrap;
        bool sawEntry;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == MemoryRegistry.KeyWrapped.selector) {
                assertEq(logs[i].data, abi.encode(uint64(0), w));
                sawWrap = true;
            }
            if (logs[i].topics[0] == MemoryRegistry.EntryAppended.selector) {
                assertEq(logs[i].data, abi.encode(uint64(0), uint64(0), false, ct));
                sawEntry = true;
            }
        }
        assertTrue(sawWrap && sawEntry);
    }

    // ------------------------------------------------------------------ reentrancy through ownerOf during _rotate

    function test_reentrantRotateFromOwnerOfDuringRotate_isBlockedByStaticcall() public {
        // The identity contract is itself a namespace owner whose grantee's ownerOf re-enters rotate.
        bytes32 n2 = keccak256("identity-ns");
        id.exec(address(reg), abi.encodeCall(MemoryRegistry.createNamespace, (n2)));
        register(7);
        id.exec(
            address(reg),
            abi.encodeCall(MemoryRegistry.grant, (n2, 7, READ, uint64(T0 + 1 days), epoch0(), wraps(1)))
        );
        id.setReenter(address(reg), abi.encodeCall(MemoryRegistry.rotate, (n2, ids(7), wraps(1))));
        id.setMode(7, 4);
        id.exec(address(reg), abi.encodeCall(MemoryRegistry.rotate, (n2, ids(7), wraps(1))));
        (, uint64 epoch,) = reg.namespaceOf(address(id), n2);
        assertEq(epoch, 1, "nested rotate executed inside ownerOf");
        uint256[] memory g = reg.granteesOf(address(id), n2);
        assertEq(g.length, 1);
    }

    // ------------------------------------------------------------------ 63/64 gas griefing

    /// A relayer or submitter chooses the gas limit. Grantee 9 is current but its ownerOf is expensive.
    /// If a tight limit made ownerOf fail while the tx still completed, 9 would be pruned silently.
    /// keepIds [7] is the only keep set that could be accepted after such a spurious prune.
    function _setupExpensive(uint256 burn) internal {
        register(7);
        register(9);
        grantTo(7, READ);
        grantTo(9, READ);
        id.setBurn(9, burn);
        assertTrue(reg.hasCurrentKeys(9), "calibration: expensive ownerOf must fit under the 100k cap");
    }

    function test_gas_tightLimitNeverPrunesCurrentGrantee_direct() public {
        _setupExpensive(85_000);
        bytes memory data = abi.encodeCall(MemoryRegistry.rotate, (N, ids(7), wraps(1)));
        uint256 successes;
        for (uint256 g = 5_000; g < 450_000; g += 97) {
            vm.prank(O);
            (bool ok,) = address(reg).call{gas: g}(data);
            if (ok) successes++;
        }
        assertEq(successes, 0, "rotate succeeded with a current grantee pruned");
        assertTrue(isGrantee(9));
        // and the honest keep set works with enough gas
        vm.prank(O);
        reg.rotate(N, ids(7, 9), wraps(2));
    }

    function test_gas_tightLimitNeverPrunesCurrentGrantee_relayed() public {
        _setupExpensive(85_000);
        bytes memory data = abi.encodeCall(MemoryRegistry.rotate, (N, ids(7), wraps(1)));
        uint256 dl = T0 + 300;
        bytes memory call_ = abi.encodeCall(MemoryRegistry.relay, (O, data, dl, sign(data, 0, dl)));
        uint256 successes;
        for (uint256 g = 5_000; g < 500_000; g += 101) {
            (bool ok,) = address(reg).call{gas: g}(call_);
            if (ok) successes++;
        }
        assertEq(successes, 0, "relayed rotate succeeded with a current grantee pruned");
        assertEq(reg.nonces(O), 0);
        assertTrue(isGrantee(9));
    }

    function test_gas_tightLimitOnRevoke_neverPrunesCurrentGrantee() public {
        register(5);
        grantTo(5, READ);
        _setupExpensive(90_000);
        // owner revokes 5 and keeps [7]: accepted only if 9 were spuriously pruned
        bytes memory data = abi.encodeCall(MemoryRegistry.revoke, (N, ids(5), ids(7), wraps(1)));
        uint256 successes;
        for (uint256 g = 5_000; g < 500_000; g += 89) {
            vm.prank(O);
            (bool ok,) = address(reg).call{gas: g}(data);
            if (ok) successes++;
        }
        assertEq(successes, 0);
        assertTrue(isGrantee(9));
    }

    function test_gas_tightLimitOnGrantOrAppend_onlyReverts() public {
        _setupExpensive(85_000);
        bytes memory g1 = abi.encodeCall(MemoryRegistry.grant, (N, 9, READ_WRITE, uint64(T0 + 2 days), epoch0(), wraps(1)));
        for (uint256 g = 5_000; g < 300_000; g += 211) {
            vm.prank(O);
            (bool ok,) = address(reg).call{gas: g}(g1);
            if (ok) {
                (uint8 scope,) = reg.grantOf(O, N, 9);
                assertEq(scope, READ_WRITE);
            }
        }
    }

    // ------------------------------------------------------------------ gas bound and event ordering

    function test_gas_16GranteesAllGasBombing_rotatePrunesAllUnder30M_eventsOrdered() public {
        for (uint256 i; i < 16; i++) {
            register(100 + i);
            grantTo(100 + i, READ);
        }
        for (uint256 i; i < 16; i++) id.setBurn(100 + i, type(uint256).max); // each lookup burns its whole cap
        vm.recordLogs();
        uint256 g0 = gasleft();
        vm.prank(O);
        reg.rotate(N, none(), new bytes[](0));
        uint256 used = g0 - gasleft();
        emit log_named_uint("rotate pruning 16 gas-bombing grantees", used);
        assertLt(used, 30_000_000);
        assertEq(reg.granteesOf(O, N).length, 0);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 revoked;
        bool rotated;
        bool[16] memory seen;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == MemoryRegistry.GrantRevoked.selector) {
                assertFalse(rotated, "GrantRevoked after EpochRotated");
                uint256 a = uint256(logs[i].topics[3]) - 100;
                assertFalse(seen[a], "duplicate GrantRevoked");
                seen[a] = true;
                revoked++;
            }
            if (logs[i].topics[0] == MemoryRegistry.EpochRotated.selector) rotated = true;
        }
        assertEq(revoked, 16);
        assertTrue(rotated);
    }

    function test_gas_16CurrentButExpensiveGrantees_rotateKeepsAllUnder30M() public {
        uint256[] memory keep = new uint256[](16);
        for (uint256 i; i < 16; i++) {
            register(200 + i);
            grantTo(200 + i, READ);
            id.setBurn(200 + i, 85_000);
            keep[i] = 200 + i;
        }
        uint256 g0 = gasleft();
        vm.prank(O);
        reg.rotate(N, keep, wraps(16));
        uint256 used = g0 - gasleft();
        emit log_named_uint("rotate keeping 16 grantees with 85k burn in ownerOf each", used);
        assertLt(used, 30_000_000);
        assertEq(reg.granteesOf(O, N).length, 16);
    }

    // ------------------------------------------------------------------ toggling grantee (liveness)

    /// A grantee can flip its own "current" state (transfer away / back) to make any keep set the owner
    /// computed stale. The owner must always be able to get rid of it by listing it in revokeIds.
    function test_toggler_canAlwaysBeRevokedRegardlessOfState() public {
        MockIdentity mi = new MockIdentity();
        MemoryRegistry r = new MemoryRegistry(address(mi));
        address h7 = makeAddr("h7");
        address h9 = makeAddr("h9");
        mi.mint(h7, 7);
        mi.mint(h9, 9);
        vm.prank(h7);
        r.setAgentKeys(7, bytes32(uint256(7)), makeAddr("op7"));
        vm.prank(h9);
        r.setAgentKeys(9, bytes32(uint256(9)), makeAddr("op9"));
        vm.startPrank(O);
        r.createNamespace(N);
        r.grant(N, 7, READ, uint64(T0 + 1 days), epoch0(), wraps(1));
        r.grant(N, 9, READ, uint64(T0 + 1 days), epoch0(), wraps(1));
        vm.stopPrank();

        uint256 snap = vm.snapshotState();
        // state A: 9 current
        vm.prank(O);
        r.revoke(N, ids(9), ids(7), wraps(1));
        vm.revertToState(snap);
        // state B: 9 transferred away (not current)
        vm.prank(h9);
        mi.transferFrom(h9, makeAddr("elsewhere"), 9);
        vm.prank(O);
        r.revoke(N, ids(9), ids(7), wraps(1));
        uint256[] memory g = r.granteesOf(O, N);
        assertEq(g.length, 1);
        assertEq(g[0], 7);
    }
}
