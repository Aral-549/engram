# Contract: sdk (`packages/sdk`, TypeScript)

## Purpose
The developer-facing surface. Three entry points: **owner** (runs only inside the vault origin, holds
keys in memory), **app client** (runs in any third-party app, never sees keys), and **agent** (runs on
an agent's server, holds only its own X25519 key). It composes crypto.md, the registry, the relayer and
the indexer. It is where the "Design & Craft = developer experience" score is earned: small API, typed
errors, runnable examples.

## Inputs
- Config: `{ chainId, registry, identityRegistry, rpcUrl, indexerUrl, relayerUrl?, vaultUrl }`
- Owner: Mera ceremonies via `@category-labs/mera`, rpId = vault host.
- Agent: `{ agentId, x25519PrivateKey, operatorAccount (viem) }` from server env.

## Outputs
Typed results or a thrown `EngramError { code, message, cause? }`.

## API
Owner (vault origin only)
- `EngramOwner.signUp({ rpId, displayName })` / `EngramOwner.signIn({ rpId })` -> `OwnerSession`
  (one passkey ceremony with `prfSalt = ROOT_SALT`; derives keys; opens a Mera secp256k1 signing session)
- `session.owner` -> address
- `session.remember(label, { kind, text })` -> `{ seq, txHash }` -- creates the namespace on first use
- `session.recall(label)` -> `{ entries: Entry[], skipped: number, complete: boolean }`
- `session.grant(label, agentId, { scope, expiresInSec, includeHistory })` -> `{ txHash }` -- **re-prompts the passkey**
- `session.revoke(label, agentIds)` -> `{ txHash, newEpoch }` -- prompt-free
- `session.grants()` -> `GrantView[]` (agent name from ERC-8004 card, scope, expiry, active)
- `session.end()` -- zeroes keys, ends Mera signing session. Auto-ends after 15 min idle or on tab close.

App client (any origin)
- `connectEngram({ vaultUrl, agentId, labels, scope, expiresInSec })` -> `{ owner, granted: label[], txHash }`
  Opens the vault in a popup, resolves on the vault's `postMessage` reply.

Agent (server)
- `new EngramAgent(config)`
- `agent.publishKeys()` -> tx (calls `setAgentKeys`; agent owner key required once)
- `agent.inbox()` -> active grants to this agent
- `agent.recall(owner, label)` -> `{ entries, skipped, complete }`
- `agent.remember(owner, label, { kind, text })` -> `{ seq, txHash }`

## Session scoping (Mera UX bounty)
| Action | Passkey prompt? | Why |
|---|---|---|
| sign in / sign up | yes (one ceremony) | root of all keys |
| remember, recall | no, inside session | own data, reversible |
| revoke | no, inside session | only reduces sharing |
| grant | **yes, fresh ceremony** | shares data with a third party |
| session older than 15 min idle | yes | session expired; clean re-prompt screen |

## Behavior cases (input -> expected output)
| # | Input | Expected output | Notes |
|---|---|---|---|
| 1 | `signUp` on device 1, `remember("preferences", "vegetarian")`, then `signIn` in a fresh browser profile with the same synced passkey, `recall("preferences")` | entries = ["vegetarian"], complete = true | **stateless test** |
| 2 | `signIn` with localStorage/IndexedDB cleared mid-demo | same owner address, same entries | nothing stored |
| 3 | `recall` when indexer is missing seq 2 of 0..3 | complete = false, entries seq 0,1,3; one log line `{stage:"sdk", op:"recall", missingSeqs:[2]}` | completeness check vs `nextSeq` |
| 4 | `recall` on a namespace spanning epochs 0 and 1 (owner) | entries from both epochs, in seq order | owner derives all epoch keys |
| 5 | `grant("preferences", 7, READ, 7d, includeHistory=true)` at epoch 2 | wraps for epochs [0,1,2] in one tx | |
| 6 | same with includeHistory=false | wraps for epoch [2] only; agent recall returns only epoch-2 entries | |
| 7 | `grant` where agent keys onchain differ from indexer's copy | uses onchain keys (`agentKeysOf`), logs a warning | indexer not trusted for keys |
| 8 | `revoke("preferences", [7])` with grantees [7,9] | tx has keepIds [9] with fresh wraps; returns newEpoch | |
| 9 | agent 7 `recall` after case 8 | throws `ACCESS_REVOKED` (checked onchain before returning), even though it still holds old epoch keys | well-behaved SDK |
| 10 | agent 9 `recall` after case 8, new owner entry at epoch 3 | includes the new entry | |
| 11 | agent `remember` with READ only | throws `NOT_AUTHORIZED` before sending a tx | pre-check |
| 12 | `connectEngram` from origin not listed in the agent's ERC-8004 card | vault consent screen shows a red "unverified origin" warning; grant still possible after explicit confirm | anti-phishing |
| 13 | `connectEngram`, user closes popup | rejects with `USER_CANCELLED` | |
| 14 | vault receives `postMessage` from an unexpected origin | ignored, logged | |
| 15 | authenticator without PRF | `signUp` throws `PRF_UNAVAILABLE` with a human message naming supported authenticators | |
| 16 | relayer down | owner actions fall back to direct tx only if the owner has MON; else `RELAYER_UNAVAILABLE` | |
| 17 | entry that decrypts but fails JSON validation | skipped, `skipped += 1`, logged without content | |

## Edge cases that must be covered
- Two tabs of the vault open: both sessions valid; nonce conflicts on relay retried once with a fresh nonce.
- Label typed with uppercase by an app -> `INPUT_INVALID` (crypto.md label rule), no silent lowercasing.
- `expiresInSec` > 365 days -> `INPUT_INVALID` before any prompt.
- Popup blocked by the browser -> `POPUP_BLOCKED` with instruction to call from a user gesture.
- Agent with rotated X25519 key: `recall` reports wraps it cannot open as `skipped`, with code `KEY_MISMATCH` in logs.

## Explicitly out of scope
- React components (apps.md builds UI on top).
- Key storage of any kind (by design).
- Mobile native SDKs (Mera has a React Native recipe; roadmap).

## Logging
Every public method logs one structured line at entry and exit:
`{ stage:"sdk", side:"owner|client|agent", op, traceId, label?, agentId?, ok, code?, durationMs }`.
Never logs plaintext, PRF output, keys, or wraps.

## Status
- [x] Drafted
- [ ] Reviewed by a human
- [ ] Implementation matches this contract
- [ ] Golden tests exist for every behavior case above
