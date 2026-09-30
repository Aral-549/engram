# Contract: indexer (Envio HyperIndex)

## Purpose
Turn MemoryRegistry and ERC-8004 IdentityRegistry events into a queryable GraphQL API so apps and
agents can load memory, grants, and wraps quickly. The indexer is a **convenience, not a trust
anchor**: everything it serves is either ciphertext (authenticated by crypto AAD) or verifiable against
onchain views, and the SDK checks completeness against `namespaceOf().nextSeq`.

## Inputs
- MemoryRegistry events (memory-registry.md), Monad testnet, from the deployment block.
- ERC-8004 IdentityRegistry `Registered` / `Transfer` events (exact event signatures to be confirmed
  from the deployed ABI before implementation).

## Outputs (GraphQL entities)
- `Owner { id: address, namespaceCount, entryCount, firstSeenAt }`
- `Namespace { id: owner-nsId, owner, nsId, epoch, nextSeq, granteeCount, createdAt }`
- `Entry { id: owner-nsId-seq, namespace, seq, epoch, byOwner, agentId, ciphertext, txHash, blockTime }`
- `Grant { id: owner-nsId-agentId, namespace, agent, scope, expiry, active, grantedAt, revokedAt }`
- `WrappedKey { id: owner-nsId-agentId-epoch, grant, epoch, wrap }`
- `Agent { id: agentId, tokenOwner, x25519Pub, operator, tokenURI, activeGrantCount, entriesWritten }`
- `DailyStat { id: yyyy-mm-dd, entries, grants, revokes, activeOwners }` (derived; powers the traction chart)

## Behavior cases (input -> expected output)
| # | Input event sequence | Expected entity state | Notes |
|---|---|---|---|
| 1 | `NamespaceCreated(O,N)` | Namespace(O-N) epoch 0, nextSeq 0; Owner O namespaceCount 1 | |
| 2 | 3 x `EntryAppended(O,N,seq 0..2)` | 3 Entry rows; Namespace.nextSeq 3; Owner.entryCount 3 | |
| 3 | `GrantSet(O,N,7,READ,exp)` + `KeyWrapped(O,N,7,0,w)` | Grant active, WrappedKey(epoch 0); Agent 7 activeGrantCount 1 | |
| 4 | `GrantSet` again for same (O,N,7) with READ_WRITE | same Grant row updated, not duplicated; activeGrantCount still 1 | |
| 5 | `GrantRevoked(O,N,7)` + `EpochRotated(O,N,1)` | Grant inactive with revokedAt; Namespace.epoch 1; activeGrantCount 0 | |
| 6 | `AgentKeysSet(7,k,op)` then again with k2 | Agent 7 x25519Pub = k2 | latest wins |
| 7 | ERC-8004 `Transfer` of token 7 | Agent.tokenOwner updated | |
| 8 | `EntryAppended` by agent 7 | Entry.byOwner false, agentId 7; Agent.entriesWritten += 1 | |
| 9 | events in two txs in the same block | ordered by log index; seq order preserved | |

## Queries the SDK depends on (stable API)
- entries for `(owner, nsId)` with `seq >= since`, ordered by seq, page size 500
- active grants for `agentId` (agent inbox)
- wrapped keys for `(owner, nsId, agentId)` all epochs
- grants for `owner` (vault dashboard)

## Edge cases that must be covered
- Chain reorg: rely on Envio reorg handling; entries re-emitted must not duplicate (ids are deterministic).
- Event for an unknown namespace (should be impossible) -> log an error entity, do not crash the handler.
- Ciphertext stored as hex; no decoding or decryption in the indexer.
- Lag target: entry queryable within 3 s of inclusion (Monad finality is ~600 ms). Measure in the integration test.

## Explicitly out of scope
- Decryption or any key material (never reaches the indexer).
- Being the only read path: the SDK can fall back to `eth_getLogs` against RPC.

## Logging
Handlers log `{ stage:"indexer", event, owner?, nsId?, agentId?, block, logIndex }` at debug level.

## Status
- [x] Drafted
- [ ] Reviewed by a human
- [ ] Implementation matches this contract
- [ ] Golden tests exist for every behavior case above
