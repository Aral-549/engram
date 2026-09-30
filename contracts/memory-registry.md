# Contract: MemoryRegistry (Solidity, Monad)

## Purpose
Onchain source of truth for who owns which memory namespace, the current key epoch, the ordered log of
encrypted entries, and which ERC-8004 agents hold which access. It enforces write permission and
records key wraps. It never sees plaintext or keys, and it cannot enforce reads (crypto does that).

## Inputs
- Owner calls, either direct (`msg.sender` = owner) or relayed through `relay(...)` with an EIP-712 owner signature.
- Agent calls from the agent's registered `operator` address.
- ERC-8004 IdentityRegistry address (constructor, immutable), used for `ownerOf(agentId)`.

## Outputs
- State (views below) and events (consumed by indexer.md).

## Interface
Scopes: `READ = 1`, `READ_WRITE = 3`. Limits: `MAX_GRANTEES = 16` per namespace, `MAX_EXPIRY = 365 days`,
entry ciphertext length `30..2077`, wrap length `94..125`.

Agent setup
- `setAgentKeys(uint256 agentId, bytes32 x25519Pub, address operator)` -- only `identity.ownerOf(agentId)`.

Owner actions (actor = `_msgSender()`, which is `msg.sender` or the verified signer inside `relay`)
- `createNamespace(bytes32 nsId)`
- `appendAsOwner(bytes32 nsId, uint64 epoch, bytes ciphertext)`
- `grant(bytes32 nsId, uint256 agentId, uint8 scope, uint64 expiry, uint64[] epochs, bytes[] wraps)`
- `revoke(bytes32 nsId, uint256[] revokeIds, uint256[] keepIds, bytes[] keepWraps)` -- removes `revokeIds`, then **prunes every remaining expired grant**, then epoch += 1 and re-wraps for every remaining grantee
- `rotate(bytes32 nsId, uint256[] keepIds, bytes[] keepWraps)` -- same as revoke with no explicit ids (prune expired, epoch += 1, re-wrap)

Rotation rule: an expired grantee, or one whose agent keys are no longer current (token transferred or burned), must never receive a new epoch key. Both are pruned on every rotation. Pruned grants emit `GrantRevoked`.

Agent action
- `appendAsAgent(address owner, bytes32 nsId, uint256 agentId, uint64 epoch, bytes ciphertext)`

Nonce control
- `useNonce()` -- consumes one owner nonce, invalidating any signed-but-unsubmitted relay call. Relayable
  (the relay already consumed the nonce; the call itself is a no-op) or direct (increments `nonces[msg.sender]`).

Gasless path
- `relay(address owner, bytes data, uint256 deadline, bytes signature)` -- EIP-712 domain
  `{name:"EngramMemoryRegistry", version:"1", chainId, verifyingContract}`, struct
  `OwnerCall(address owner, bytes32 dataHash, uint256 nonce, uint256 deadline)`. Allowed selectors: the
  five owner actions plus `useNonce`. Nonce is sequential per owner. The owner identity is passed to the
  self-call through **transient storage** (EIP-1153), not appended calldata, so the executed calldata is
  byte-identical to the signed `data`.

Agent key validity (review 2026-10-01)
- `setAgentKeys` records which address set the keys. Keys count as **present** only while
  `identity.ownerOf(agentId)` is still that address. Read with a raw `staticcall` capped at 100k gas that
  copies at most 32 bytes: a reverting, burned, gas-exhausting, or malformed reply (short returndata, dirty
  upper bits) means absent. An identity whose `ownerOf` costs more than 100k gas is permanently "not current"
  (harmless for the canonical ERC-8004 registry). After an ERC-8004 transfer, the old operator can no longer write and new grants are
  refused until the new holder sets keys.
- The registry does **not** validate X25519 canonicality (frozen golden fixtures use arbitrary bytes32 keys).
  The crypto package rejects non-canonical keys at wrap time and the SDK checks before `setAgentKeys` (BUGLOG B1).

Views: `namespaceOf(owner, nsId) -> (exists, epoch, nextSeq)`, `grantOf(owner, nsId, agentId) -> (scope, expiry)`,
`granteesOf(owner, nsId) -> uint256[]`, `isActive(owner, nsId, agentId) -> bool`, `agentKeysOf(agentId) -> (x25519Pub, operator)`, `hasCurrentKeys(agentId) -> bool`, `nonces(owner)`.
SDKs must check `hasCurrentKeys` before wrapping to `agentKeysOf` (keys of a transferred token are still returned).

Events: `NamespaceCreated(owner, nsId)`, `EntryAppended(owner, nsId, seq, epoch, byOwner, agentId, ciphertext)`,
`GrantSet(owner, nsId, agentId, scope, expiry)`, `KeyWrapped(owner, nsId, agentId, epoch, wrap)`,
`GrantRevoked(owner, nsId, agentId)`, `EpochRotated(owner, nsId, newEpoch)`, `AgentKeysSet(agentId, x25519Pub, operator)`.
`owner`, `nsId`, `agentId` are indexed where present.

## Behavior cases (input -> expected output)
Setup for all cases: owner O, agents A (id 7) and B (id 9) registered in ERC-8004 with keys set; O has namespace N.

| # | Input | Expected output | Notes |
|---|---|---|---|
| 1 | O `createNamespace(N)` | `NamespaceCreated(O,N)`; `namespaceOf(O,N) = (true,0,0)` | |
| 2 | O `createNamespace(N)` again | revert `NamespaceExists` | |
| 3 | O `appendAsOwner(N, 0, ct)` | `EntryAppended(O,N,seq=0,epoch=0,byOwner=true,agentId=0,ct)`; nextSeq = 1 | |
| 4 | O `appendAsOwner(N, 1, ct)` while epoch is 0 | revert `WrongEpoch` | stale or future key |
| 5 | O `appendAsOwner` with 29-byte or 2078-byte ct | revert `BadCiphertextLength` | |
| 6 | O `grant(N, 7, READ, now+1d, [0], [w])` | `GrantSet`, `KeyWrapped(O,N,7,0,w)`; `granteesOf = [7]`; `isActive = true` | |
| 7 | grant to agent with no keys set | revert `AgentKeysMissing` | |
| 8 | grant with `epochs` not ending at current epoch, not strictly increasing, or length != wraps | revert `BadEpochs` | |
| 9 | grant with scope 0, 2, or 4 | revert `BadScope` | WRITE requires READ |
| 10 | grant with expiry <= now or > now+365d | revert `BadExpiry` | |
| 11 | 17th distinct grantee | revert `TooManyGrantees` | re-grant of existing grantee still allowed |
| 12 | re-grant A with READ_WRITE | `GrantSet` with new scope; `granteesOf` unchanged (no duplicate) | |
| 13 | A's operator `appendAsAgent(O,N,7,0,ct)` with READ_WRITE | `EntryAppended(... byOwner=false, agentId=7)` | |
| 14 | same with READ only | revert `NotAuthorized` | |
| 15 | same from an address that is not A's operator | revert `NotAuthorized` | |
| 16 | same after expiry has passed | revert `GrantExpired` | write-expiry is immediate |
| 17 | O `revoke(N, [7], [9], [w9])` with grantees [7,9] | `GrantRevoked(7)`, `EpochRotated(1)`, `KeyWrapped(O,N,9,1,w9)`; `granteesOf = [9]` | |
| 18 | revoke where keepIds is missing a remaining grantee, has an extra id, or a duplicate | revert `KeepSetMismatch` | nobody gets silently locked out |
| 19 | revoke an id that is not a grantee | revert `NotGrantee` | |
| 20 | revoke an expired grant | succeeds like case 17 | cleanup path |
| 21 | after case 17, A appends at epoch 1 | revert `NotAuthorized` | |
| 22 | O `rotate(N, [9], [w9'])` | `EpochRotated(2)`, `KeyWrapped(O,N,9,2,w9')` | |
| 23 | relayer `relay(O, grant-calldata, deadline, sigO)` | same effects as case 6 with actor O; `nonces(O)` += 1 | gasless |
| 24 | replay the same relay signature | revert `BadSignature` (nonce consumed) | |
| 25 | relay after deadline | revert `Expired` | |
| 26 | relay with a signature for chain 143 on chain 10143, or for another registry | revert `BadSignature` | domain separation |
| 27 | relay whose data selector is `setAgentKeys`, `appendAsAgent`, or `relay` | revert `SelectorNotAllowed` | |
| 28 | relay with high-s (malleable) signature | revert `BadSignature` | |
| 29 | `setAgentKeys(7, k, op)` from a non-owner of token 7 | revert `NotAgentOwner` | |
| 30 | ERC-8004 token 7 transferred to X; X calls `setAgentKeys` | succeeds, `AgentKeysSet`; old operator can no longer append | |
| 31 | any owner action on a namespace that does not exist | revert `NoNamespace` | |
| 32 | grantees [7,9], 9 expired; O `rotate(N, [7], [w7])` | `GrantRevoked(O,N,9)` (pruned), `EpochRotated(1)`, `KeyWrapped(O,N,7,1,w7)` only; `granteesOf = [7]` | expired never re-keyed |
| 33 | grantees [7,9], 9 expired; O `rotate(N, [7,9], [w7,w9])` | revert `KeepSetMismatch` | cannot re-key an expired grantee |
| 34 | O `revoke(N, [], [...], [...])` | revert `NothingToRevoke` | use `rotate` instead |
| 35 | O `revoke(N, [7,7], ...)` | revert `NotGrantee` (second 7 already removed) | duplicates |
| 36 | token 7 transferred to X; A's old operator `appendAsAgent` (before X sets keys) | revert `NotAuthorized` | stale keys |
| 37 | token 7 transferred to X; O `grant(N, 7, ...)` before X sets keys | revert `AgentKeysMissing` | |
| 38 | token 7 burned (ownerOf reverts); O `grant(N, 7, ...)` | revert `AgentKeysMissing`; `revoke`/`rotate` still work | |
| 40 | relay whose `data` has a dynamic tail that would run past its end | reverts (ABI decode fails); nothing reads bytes outside the signed data | transient-storage actor |
| 41 | O signs call c (nonce 0), then relays `useNonce` (nonce 0) or calls `useNonce()` directly; relayer submits c | revert `BadSignature` | cancel pending |
| 42 | direct `appendAsOwner` with calldata padded by 20 bytes of another owner | acts as msg.sender | no calldata actor |
| 43 | grantees [7,9], token 9 transferred; O `rotate(N, [7], [w7])` | `GrantRevoked(9)` (pruned), `KeyWrapped` for 7 only; with keepIds [7,9] -> `KeepSetMismatch` | BUGLOG R3 |
| 44 | identity `ownerOf` returns malformed data (dirty upper bits, short returndata) | treated as "keys not current": `grant` -> `AgentKeysMissing`, append -> `NotAuthorized`, rotate prunes | BUGLOG R3 |

## Edge cases that must be covered
- Owner O2 using the same `nsId` bytes as O: independent namespace (keyed by `(owner, nsId)`).
- `x25519Pub` = 0 or `operator` = address(0) in `setAgentKeys` -> revert `BadAgentKeys`.
- Agent rotates its X25519 key after grants exist: old wraps stay valid only for the old key. The SDK
  surfaces this; the contract does not re-wrap (cannot, it has no keys).
- Gas: `revoke`/`rotate` with 16 grantees must stay under the 30M per-tx limit (measure and record in the test).
- `relay` must not be re-entrant through the self-call (selector allowlist + nonce bumped before the call).
- Monad charges gas on gas limit, not gas used: the SDK must estimate and not over-provision limits.

Documented, not enforced (review 2026-10-01):
- **Open decision (needs human approval to change golden case 30):** a new ERC-8004 holder who sets keys
  inherits existing READ_WRITE grants to that agentId (golden case 30 requires the new operator can append).
  Alternative: bind each grant to a key version so any key change voids it.
- Expired-but-unpruned grants count toward `MAX_GRANTEES`; the SDK rotates before adding a 17th agent.
- Two agents may register the same X25519 key or operator. That is the agent owners' choice (an agent can
  always forward what it decrypts); grants are to an agentId the user chose.
- A grantee can flip itself between current and not current (transfer its token away and back), which makes
  an owner's signed keep set stale so `rotate`/`revoke` revert `KeepSetMismatch`. The owner always recovers
  by listing that grantee in `revokeIds` (works in both states). The SDK retries once with a fresh keep set.
- A relay whose inner call reverts leaves the nonce unconsumed; the signature stays valid until its
  deadline. The SDK uses short deadlines (5 min) and `useNonce` to cancel.

## Explicitly out of scope
- Read enforcement and read-expiry (crypto.md; documented forward-only model).
- Paying agents or charging per query (post-hackathon roadmap).
- Validation Registry integration (ERC-8004 validation registry is "coming soon" on Monad).
- Upgradeability. The contract is immutable; a new version is a new deployment.
- P256 precompile. Owner keys are secp256k1 keys derived from the PRF so signing sessions are prompt-free;
  onchain WebAuthn assertion verification is noted as future work.

## Logging
Events are the onchain log. Foundry tests assert on events. Relayer logs `{ stage:"relayer", owner, selector, nonce, txHash, ok, error? }`.

## Status
- [x] Drafted
- [ ] Reviewed by a human
- [ ] Implementation matches this contract
- [ ] Golden tests exist for every behavior case above
