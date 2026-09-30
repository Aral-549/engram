# Contract: indexer (Envio HyperIndex)

## Purpose
Turn MemoryRegistry and ERC-8004 IdentityRegistry events into a queryable GraphQL API so apps and
agents can load memory, grants, and wraps quickly. The indexer is a **convenience, not a trust
anchor**: everything it serves is either ciphertext (authenticated by crypto AAD) or verifiable against
onchain views, and the SDK checks completeness against `namespaceOf().nextSeq`.

## Inputs
- Monad testnet (10143) via HyperSync (`https://10143.hypersync.xyz`, needs `ENVIO_API_TOKEN`).
- MemoryRegistry `0x733d1Bf4DC13B721a2Ce3DDCFb444795eFF59d31` (deploy block 67062103), events per memory-registry.md.
- ERC-8004 IdentityRegistry `0x8004A818BFB912233c491871b3d84c89A494BD9e`. Events confirmed against the official
  ABI (github.com/erc-8004/erc-8004-contracts `abis/IdentityRegistry.json`) and a live `register` tx on testnet
  (`0x988261ef...5d1d`, agentId 1961):
  - `Registered(uint256 indexed agentId, string agentURI, address indexed owner)`
  - `URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)`
  - `Transfer(address indexed from, address indexed to, uint256 indexed tokenId)` (mint, transfer, burn)

## Outputs (GraphQL entities)
All hex values lowercase. Ids are deterministic so reorg replays never duplicate.

| Entity | id | Fields |
|---|---|---|
| `Owner` | owner address | `namespaceCount`, `entryCount`, `firstSeenAt` |
| `Namespace` | `owner-nsId` | `owner`, `nsId`, `epoch`, `nextSeq`, `granteeCount`, `createdAt` |
| `Entry` | `owner-nsId-seq` | `namespace`, `seq`, `epoch`, `byOwner`, `agentId`, `ciphertext`, `txHash`, `blockNumber`, `blockTime` |
| `Grant` | `owner-nsId-agentId` | `namespace`, `owner`, `agent`, `scope`, `expiry`, `active`, `generation`, `grantedAt`, `revokedAt` |
| `WrappedKey` | `owner-nsId-agentId-epoch` | `grant`, `generation`, `epoch`, `wrap` |
| `Agent` | agentId (decimal) | `tokenOwner`, `agentURI`, `x25519Pub`, `operator`, `keysSetBy`, `keysCurrent`, `activeGrantCount`, `entriesWritten`, `registeredAt` |
| `DailyStat` | `yyyy-mm-dd` (UTC of block time) | `entries`, `grantsSet`, `revokes`, `activeOwners` |
| `OwnerDay` | `owner-yyyy-mm-dd` | marker used to count `activeOwners` once per owner per day |
| `IndexerError` | `block-logIndex` | `kind`, `detail` (events that violate registry invariants; should never exist) |

`Grant.generation` increments each time an inactive grant becomes active again (first grant = 1). Each
`WrappedKey` records the generation it was issued under; consumers use only wraps whose generation equals the
grant's current generation (older ones may be wrapped to a previous token holder's key). `grantedAt` is the time
of the latest `GrantSet`.

`Agent.tokenOwner` comes **only** from ERC-721 `Transfer` events (BUGLOG I1): `Registered` is emitted after
`_safeMint`'s receiver callback, so its `owner` can already be stale.

`Agent.keysCurrent` mirrors the contract's rule (BUGLOG R2/R3): true iff keys are set and `keysSetBy` equals the
current `tokenOwner` and the token is not burned. `keysSetBy` is the token holder when `AgentKeysSet` was
processed (the contract only accepts `setAgentKeys` from the holder).

## Behavior cases (input -> expected output)
| # | Input event sequence | Expected entity state | Notes |
|---|---|---|---|
| 1 | `NamespaceCreated(O,N)` | Namespace(O-N) epoch 0, nextSeq 0, granteeCount 0; Owner O namespaceCount 1 | |
| 2 | case 1 + 3 x `EntryAppended(O,N,seq 0..2, byOwner)` | 3 Entry rows with ciphertext hex and txHash; Namespace.nextSeq 3; Owner.entryCount 3 | |
| 3 | case 1 + `GrantSet(O,N,7,READ,exp)` + `KeyWrapped(O,N,7,0,w)` | Grant active, scope 1, expiry exp; WrappedKey(epoch 0, wrap w); Agent 7 activeGrantCount 1; Namespace.granteeCount 1 | |
| 4 | case 3 + `GrantSet(O,N,7,READ_WRITE,exp2)` | same Grant row, scope 3, expiry exp2; activeGrantCount and granteeCount still 1 | re-grant |
| 5 | case 3 + `GrantRevoked(O,N,7)` + `EpochRotated(O,N,1)` | Grant inactive with revokedAt; Namespace.epoch 1; activeGrantCount 0; granteeCount 0 | |
| 6 | `AgentKeysSet(7,k,op)` then `AgentKeysSet(7,k2,op2)` | Agent 7 x25519Pub k2, operator op2 | latest wins |
| 7 | `Registered(7,uri,H)` + `Transfer(0,H,7)` + `AgentKeysSet(7,k,op)`, then `Transfer(H,X,7)` | tokenOwner X, keysCurrent false; after `AgentKeysSet` again: keysSetBy X, keysCurrent true | mirrors R2 |
| 8 | case 3 + `EntryAppended(O,N,seq, byOwner=false, agentId 7)` | Entry.byOwner false, agentId 7; Agent 7 entriesWritten 1 | |
| 9 | two `EntryAppended` in the same block | both rows present, seq order preserved | |
| 10 | `Registered(7,uri,H)` | Agent 7 agentURI uri, registeredAt set | |
| 11 | `URIUpdated(7,uri2,H)` | Agent 7 agentURI uri2 | |
| 12 | `Transfer(H,0x0,7)` (burn) | tokenOwner 0x0, keysCurrent false | |
| 13 | `GrantRevoked` for a grant already inactive, or `EntryAppended` for an unknown namespace | no counter goes negative; IndexerError row recorded; handler does not throw | defensive |
| 14 | events on two different days | two DailyStat rows; an owner active twice on one day counts once in activeOwners | |
| 15 | revoke then re-grant the same agent | Grant active again, revokedAt cleared; activeGrantCount back to 1 | |
| 16 | mint callback: `Transfer(0,W,7)`, `Transfer(W,X,7)`, `Registered(7,uri,W)` | tokenOwner X | BUGLOG I1 |
| 17 | mint callback: `Transfer(0,W,7)`, `AgentKeysSet(7)` (by W), `Transfer(W,X,7)`, `Registered(7,uri,W)` | keysSetBy W, tokenOwner X, keysCurrent false | BUGLOG I1 |
| 18 | `EntryAppended` with seq already indexed (duplicate) | Entry row unchanged, no counter increments, one IndexerError | BUGLOG I2 |
| 19 | `EntryAppended` with seq > nextSeq (gap) | Entry stored, nextSeq = seq + 1, one IndexerError | BUGLOG I2 |
| 20 | grant gen 1 with wraps epochs 0,1; revoke; re-grant with wrap epoch 2 | Grant.generation 2; wraps 0,1 keep generation 1, wrap 2 has generation 2 | stale wraps |
| 21 | `KeyWrapped` with no Grant row | IndexerError, no WrappedKey row | no dangling refs |
| 22 | revoke that would drive a counter below zero | IndexerError recorded (counter stays 0) | no silent clamping |
| 23 | Grant rows carry `owner` | grants for an owner are queryable by `owner` directly | |

## Queries the SDK depends on (stable API)
- entries for `(owner, nsId)` with `seq >= since`, ordered by seq, page size 500
- active grants for `agentId` (agent inbox)
- wrapped keys for `(owner, nsId, agentId)` all epochs
- grants for `owner` (vault dashboard)
- agents with `keysCurrent = true` (vault agent picker)

## Edge cases that must be covered
- Chain reorg: rely on Envio reorg handling; deterministic ids mean replays overwrite, never duplicate.
- Handlers run twice under Envio preload optimization: handlers only use `context` reads and writes.
- Ciphertext and wraps stored as hex; no decoding or decryption in the indexer.
- Lag target: entry queryable within 3 s of inclusion (Monad finality ~600 ms). Measured in the integration test.

## Definitions and documented behavior (review 2026-10-01)
- `DailyStat.activeOwners`: owners whose namespaces saw any registry event that day (including agent writes
  and prunes). `revokes` counts every `GrantRevoked` (explicit, expiry prunes, stale-key prunes).
- `Grant.active` mirrors contract storage: it stays true after the agent's token moves until a rotation prunes it
  (the contract's `isActive` also ignores key currency). Agent inboxes must also check `Agent.keysCurrent`.
- `start_block: 0` is load-bearing: agents minted before the MemoryRegistry deploy must be indexed for
  `tokenOwner` and `keysCurrent` to be right. Do not raise it to the registry deploy block.
- A block timestamp that cannot form a date records an IndexerError and skips day statistics.

## Explicitly out of scope
- Decryption or any key material (never reaches the indexer).
- Being the only read path: the SDK can fall back to `eth_getLogs` against RPC.
- Time-based expiry: `Grant.active` flips only on `GrantRevoked` (including prunes). Expiry is exposed as a field;
  consumers compare it to the current time.

## Logging
Handlers log `{ stage:"indexer", event, owner?, nsId?, agentId?, block, logIndex }` at debug level via `context.log`.

## Status
- [x] Drafted
- [x] Reviewed by a human (approved to build 2026-10-01)
- [ ] Implementation matches this contract
- [ ] Golden tests exist for every behavior case above
