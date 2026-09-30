// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title Engram MemoryRegistry
/// @notice Onchain source of truth for passkey-owned, encrypted AI memory (spec: contracts/memory-registry.md).
/// Stores namespaces, the ordered log of encrypted entries (as events), and which ERC-8004 agents may use them.
/// It never sees plaintext or keys: reads are enforced by encryption, writes are enforced here.
contract MemoryRegistry is EIP712 {
    // ---------------------------------------------------------------- constants

    uint8 public constant READ = 1;
    uint8 public constant READ_WRITE = 3;
    uint256 public constant MAX_GRANTEES = 16;
    uint256 public constant MAX_EXPIRY = 365 days;
    uint256 public constant MIN_CIPHERTEXT = 30; // 1 version + 12 nonce + 1 byte + 16 tag
    uint256 public constant MAX_CIPHERTEXT = 2077; // 1 + 12 + 2048 + 16
    uint256 public constant MIN_WRAP = 94; // 1 + 32 eph + 12 nonce + 32 key + 1 label byte + 16 tag
    uint256 public constant MAX_WRAP = 125; // label up to 32 bytes

    bytes32 public constant OWNER_CALL_TYPEHASH =
        keccak256("OwnerCall(address owner,bytes32 dataHash,uint256 nonce,uint256 deadline)");

    IERC721 public immutable identityRegistry;

    // ---------------------------------------------------------------- storage

    struct Namespace {
        bool exists;
        uint64 epoch;
        uint64 nextSeq;
        uint256[] grantees;
    }

    struct Grant {
        uint8 scope; // 0 = none
        uint64 expiry; // active while block.timestamp < expiry
    }

    struct AgentKeys {
        bytes32 x25519Pub;
        address operator;
    }

    mapping(address owner => mapping(bytes32 nsId => Namespace)) private _namespaces;
    mapping(address owner => mapping(bytes32 nsId => mapping(uint256 agentId => Grant))) private _grants;
    mapping(uint256 agentId => AgentKeys) private _agentKeys;
    mapping(address owner => uint256) public nonces;

    // ---------------------------------------------------------------- events

    event NamespaceCreated(address indexed owner, bytes32 indexed nsId);
    event EntryAppended(
        address indexed owner,
        bytes32 indexed nsId,
        uint64 seq,
        uint64 epoch,
        bool byOwner,
        uint256 indexed agentId,
        bytes ciphertext
    );
    event GrantSet(address indexed owner, bytes32 indexed nsId, uint256 indexed agentId, uint8 scope, uint64 expiry);
    event KeyWrapped(address indexed owner, bytes32 indexed nsId, uint256 indexed agentId, uint64 epoch, bytes wrap);
    event GrantRevoked(address indexed owner, bytes32 indexed nsId, uint256 indexed agentId);
    event EpochRotated(address indexed owner, bytes32 indexed nsId, uint64 newEpoch);
    event AgentKeysSet(uint256 indexed agentId, bytes32 x25519Pub, address operator);

    // ---------------------------------------------------------------- errors

    error NamespaceExists();
    error NoNamespace();
    error WrongEpoch();
    error BadCiphertextLength();
    error BadWrapLength();
    error AgentKeysMissing();
    error BadEpochs();
    error BadScope();
    error BadExpiry();
    error TooManyGrantees();
    error NotAuthorized();
    error GrantExpired();
    error KeepSetMismatch();
    error NotGrantee();
    error NothingToRevoke();
    error BadSignature();
    error Expired();
    error SelectorNotAllowed();
    error NotAgentOwner();
    error BadAgentKeys();

    constructor(address identityRegistry_) EIP712("EngramMemoryRegistry", "1") {
        identityRegistry = IERC721(identityRegistry_);
    }

    // ---------------------------------------------------------------- agent setup

    /// @notice Publish the X25519 key grants are wrapped to, and the address allowed to write for the agent.
    /// Only the current holder of the ERC-8004 identity token may call this.
    function setAgentKeys(uint256 agentId, bytes32 x25519Pub, address operator) external {
        if (identityRegistry.ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        if (x25519Pub == bytes32(0) || operator == address(0)) revert BadAgentKeys();
        _agentKeys[agentId] = AgentKeys(x25519Pub, operator);
        emit AgentKeysSet(agentId, x25519Pub, operator);
    }

    // ---------------------------------------------------------------- owner actions

    function createNamespace(bytes32 nsId) external {
        address owner = _actor();
        Namespace storage ns = _namespaces[owner][nsId];
        if (ns.exists) revert NamespaceExists();
        ns.exists = true;
        emit NamespaceCreated(owner, nsId);
    }

    function appendAsOwner(bytes32 nsId, uint64 epoch, bytes calldata ciphertext) external {
        address owner = _actor();
        _append(owner, nsId, _requireNamespace(owner, nsId), epoch, ciphertext, true, 0);
    }

    function grant(
        bytes32 nsId,
        uint256 agentId,
        uint8 scope,
        uint64 expiry,
        uint64[] calldata epochs,
        bytes[] calldata wraps
    ) external {
        address owner = _actor();
        Namespace storage ns = _requireNamespace(owner, nsId);
        if (scope != READ && scope != READ_WRITE) revert BadScope();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_EXPIRY) revert BadExpiry();
        if (_agentKeys[agentId].x25519Pub == bytes32(0)) revert AgentKeysMissing();

        uint256 n = epochs.length;
        if (n == 0 || n != wraps.length || epochs[n - 1] != ns.epoch) revert BadEpochs();
        for (uint256 i = 1; i < n; i++) {
            if (epochs[i] <= epochs[i - 1]) revert BadEpochs();
        }

        Grant storage g = _grants[owner][nsId][agentId];
        if (g.scope == 0) {
            if (ns.grantees.length >= MAX_GRANTEES) revert TooManyGrantees();
            ns.grantees.push(agentId);
        }
        g.scope = scope;
        g.expiry = expiry;
        emit GrantSet(owner, nsId, agentId, scope, expiry);
        for (uint256 i; i < n; i++) {
            _checkWrap(wraps[i]);
            emit KeyWrapped(owner, nsId, agentId, epochs[i], wraps[i]);
        }
    }

    /// @notice Remove grants, prune expired ones, rotate the epoch, and re-key every remaining grantee.
    /// `keepIds` must be exactly the grantees left after removal and pruning (any order).
    function revoke(bytes32 nsId, uint256[] calldata revokeIds, uint256[] calldata keepIds, bytes[] calldata keepWraps)
        external
    {
        address owner = _actor();
        Namespace storage ns = _requireNamespace(owner, nsId);
        if (revokeIds.length == 0) revert NothingToRevoke();
        for (uint256 i; i < revokeIds.length; i++) {
            if (_grants[owner][nsId][revokeIds[i]].scope == 0) revert NotGrantee();
            _removeGrantee(owner, nsId, ns, revokeIds[i]);
        }
        _rotate(owner, nsId, ns, keepIds, keepWraps);
    }

    /// @notice Rotate the epoch without an explicit revoke (still prunes expired grants).
    function rotate(bytes32 nsId, uint256[] calldata keepIds, bytes[] calldata keepWraps) external {
        address owner = _actor();
        _rotate(owner, nsId, _requireNamespace(owner, nsId), keepIds, keepWraps);
    }

    // ---------------------------------------------------------------- agent action

    function appendAsAgent(address owner, bytes32 nsId, uint256 agentId, uint64 epoch, bytes calldata ciphertext)
        external
    {
        Namespace storage ns = _requireNamespace(owner, nsId);
        if (_agentKeys[agentId].operator != msg.sender) revert NotAuthorized();
        Grant storage g = _grants[owner][nsId][agentId];
        if (g.scope != READ_WRITE) revert NotAuthorized();
        if (g.expiry <= block.timestamp) revert GrantExpired();
        _append(owner, nsId, ns, epoch, ciphertext, false, agentId);
    }

    // ---------------------------------------------------------------- gasless relay

    /// @notice Execute an owner action signed by `owner` (EIP-712 OwnerCall). Anyone may submit and pay gas.
    function relay(address owner, bytes calldata data, uint256 deadline, bytes calldata signature) external {
        if (block.timestamp > deadline) revert Expired();
        if (data.length < 4 || !_relayable(bytes4(data[:4]))) revert SelectorNotAllowed();

        uint256 nonce = nonces[owner];
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(OWNER_CALL_TYPEHASH, owner, keccak256(data), nonce, deadline)));
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || signer != owner) revert BadSignature();
        nonces[owner] = nonce + 1;

        // ERC-2771 style self-call: the owner address rides at the end of calldata, read back by _actor().
        (bool ok, bytes memory ret) = address(this).call(abi.encodePacked(data, owner));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    // ---------------------------------------------------------------- views

    function namespaceOf(address owner, bytes32 nsId) external view returns (bool exists, uint64 epoch, uint64 nextSeq) {
        Namespace storage ns = _namespaces[owner][nsId];
        return (ns.exists, ns.epoch, ns.nextSeq);
    }

    function grantOf(address owner, bytes32 nsId, uint256 agentId) external view returns (uint8 scope, uint64 expiry) {
        Grant storage g = _grants[owner][nsId][agentId];
        return (g.scope, g.expiry);
    }

    function granteesOf(address owner, bytes32 nsId) external view returns (uint256[] memory) {
        return _namespaces[owner][nsId].grantees;
    }

    function isActive(address owner, bytes32 nsId, uint256 agentId) external view returns (bool) {
        Grant storage g = _grants[owner][nsId][agentId];
        return g.scope != 0 && g.expiry > block.timestamp;
    }

    function agentKeysOf(uint256 agentId) external view returns (bytes32 x25519Pub, address operator) {
        AgentKeys storage k = _agentKeys[agentId];
        return (k.x25519Pub, k.operator);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ---------------------------------------------------------------- internals

    /// @dev The acting owner: msg.sender, or the signer appended by relay() on a self-call.
    function _actor() private view returns (address) {
        if (msg.sender == address(this) && msg.data.length >= 24) {
            return address(bytes20(msg.data[msg.data.length - 20:]));
        }
        return msg.sender;
    }

    function _relayable(bytes4 sel) private pure returns (bool) {
        return sel == this.createNamespace.selector || sel == this.appendAsOwner.selector || sel == this.grant.selector
            || sel == this.revoke.selector || sel == this.rotate.selector;
    }

    function _requireNamespace(address owner, bytes32 nsId) private view returns (Namespace storage ns) {
        ns = _namespaces[owner][nsId];
        if (!ns.exists) revert NoNamespace();
    }

    function _append(
        address owner,
        bytes32 nsId,
        Namespace storage ns,
        uint64 epoch,
        bytes calldata ciphertext,
        bool byOwner,
        uint256 agentId
    ) private {
        if (epoch != ns.epoch) revert WrongEpoch();
        if (ciphertext.length < MIN_CIPHERTEXT || ciphertext.length > MAX_CIPHERTEXT) revert BadCiphertextLength();
        uint64 seq = ns.nextSeq;
        ns.nextSeq = seq + 1;
        emit EntryAppended(owner, nsId, seq, epoch, byOwner, agentId, ciphertext);
    }

    function _checkWrap(bytes calldata w) private pure {
        if (w.length < MIN_WRAP || w.length > MAX_WRAP) revert BadWrapLength();
    }

    function _removeGrantee(address owner, bytes32 nsId, Namespace storage ns, uint256 agentId) private {
        uint256[] storage list = ns.grantees;
        uint256 len = list.length;
        for (uint256 i; i < len; i++) {
            if (list[i] == agentId) {
                list[i] = list[len - 1];
                list.pop();
                break;
            }
        }
        delete _grants[owner][nsId][agentId];
        emit GrantRevoked(owner, nsId, agentId);
    }

    function _rotate(
        address owner,
        bytes32 nsId,
        Namespace storage ns,
        uint256[] calldata keepIds,
        bytes[] calldata keepWraps
    ) private {
        // An expired grantee must never receive a new epoch key.
        uint256[] storage list = ns.grantees;
        for (uint256 i = 0; i < list.length;) {
            uint256 id = list[i];
            if (_grants[owner][nsId][id].expiry <= block.timestamp) {
                _removeGrantee(owner, nsId, ns, id); // swaps the last element into slot i
            } else {
                i++;
            }
        }

        uint64 newEpoch = ns.epoch + 1;
        ns.epoch = newEpoch;
        emit EpochRotated(owner, nsId, newEpoch);

        // keepIds must be a permutation of the remaining grantees, each with a well-formed wrap.
        uint256 n = keepIds.length;
        if (n != list.length || n != keepWraps.length) revert KeepSetMismatch();
        for (uint256 i; i < n; i++) {
            uint256 id = keepIds[i];
            if (_grants[owner][nsId][id].scope == 0) revert KeepSetMismatch();
            for (uint256 j; j < i; j++) {
                if (keepIds[j] == id) revert KeepSetMismatch();
            }
            _checkWrap(keepWraps[i]);
            emit KeyWrapped(owner, nsId, id, newEpoch, keepWraps[i]);
        }
    }
}
