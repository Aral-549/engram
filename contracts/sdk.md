# Contract: sdk (`packages/sdk`, TypeScript)

## Purpose
The developer-facing surface. Three entry points: **owner** (runs only inside the vault origin, holds
keys in memory), **app client** (runs in any third-party app, never sees keys), and **agent** (runs on
an agent's server, holds only its own X25519 key). Plus a **relay handler** the vault serves. It composes
crypto.md, the registry, and the indexer. It is where the "Design & Craft = developer experience" score is
earned: small API, typed errors, runnable examples.

## Inputs
- `EngramConfig`: `{ chainId, registry, identityRegistry, rpcUrl }` plus pluggable I/O:
  - `source: MemorySource` -- where entries, wraps, and grants are read. Implementations:
    `graphqlSource(indexerUrl)` (Envio, fast) and `logsSource(publicClient, registry, fromBlock)` (reads events
    straight from chain; no indexer needed). `firstAvailable([a, b])` tries in order.
  - `relayer: Relayer` -- `httpRelayer(relayerUrl)` (vault API) or `directRelayer(walletClient)` (pays own gas).
  - `testnet` preset exported from `deployments` (addresses from `chain/deployments/10143.json`).
- Owner: Mera ceremonies via `@category-labs/mera` with `rpId` = vault host. An optional `webAuthnClient`
  (Mera's interface) is passed through; tests use a deterministic fake so the real Mera code path runs.
- Agent: `{ agentId, x25519PrivateKey, operator: viem Account }` from server env.
- All chain reads that decide access or keys go to the **chain** (`namespaceOf`, `granteesOf`, `grantOf`,
  `isActive`, `agentKeysOf`, `hasCurrentKeys`, `nonces`), never to the source.

## Outputs
Typed results or a thrown `EngramError { code, message, cause? }`. Codes: `INPUT_INVALID`, `PRF_UNAVAILABLE`,
`PASSKEY_CANCELLED`, `SESSION_ENDED`, `SESSION_EXPIRED`, `REAUTH_MISMATCH`, `ACCESS_REVOKED`, `NOT_AUTHORIZED`,
`AGENT_KEYS_NOT_CURRENT`, `RELAYER_UNAVAILABLE`, `RELAY_REJECTED`, `TX_REVERTED`, `SOURCE_UNAVAILABLE`,
`POPUP_BLOCKED`, `USER_CANCELLED`.

## API
Owner (vault origin only)
- `EngramOwner.signUp({ config, rpId, rpName, userName, webAuthnClient? })` / `EngramOwner.signIn({ config, rpId, webAuthnClient? })`
  -> `OwnerSession`. One ceremony with `prfSalt = ROOT_SALT`; derives keys (crypto.md); opens a Mera secp256k1
  signing session wrapped by `toViemAccount` (EIP-712 signing without prompts).
- `EngramOwner.fromPrf({ config, prfOutput, reauth? })` -- advanced/testing entry that skips WebAuthn.
- `session.owner` -> checksummed address
- `session.remember(label, { kind, text })` -> `{ seq, txHash }` -- relays `createNamespace` first if needed
- `session.recall(label)` -> `{ entries: RecalledEntry[], skipped, complete, missingSeqs }`
  (`RecalledEntry = Entry & { seq, epoch, byOwner, agentId, txHash }`)
- `session.grant(label, agentId, { scope: "read" | "readwrite", expiresInSec, includeHistory })` -> `{ txHash, epochs }`
- `session.revoke(label, agentIds)` -> `{ txHash, newEpoch }`; `session.rotate(label)` -> `{ txHash, newEpoch }`
- `session.grants()` -> `GrantView[]` (`label?`, `agentId`, `agentURI`, `scope`, `expiry`, `active`, `keysCurrent`)
- `session.cancelPending()` -> relays `useNonce` (invalidates any signed-but-unsubmitted call)
- `session.end()` -- zeroes keys, ends the Mera signing session.

App client (any origin)
- `connectEngram({ vaultUrl, agentId, labels, scope, expiresInSec })` -> `{ owner, granted, txHash, sessionProof }`.
  Opens `${vaultUrl}/connect?...` in a popup, resolves on the vault's `postMessage` reply.
- **App sessions.** A grant says *what* an agent may read; it does not prove *who is asking* the app. The vault
  therefore returns a `sessionProof`: an EIP-712 signature by the owner key over
  `AppSession(address owner, uint256 agentId, string origin, uint256 issuedAt, uint256 expiresAt)`, domain
  `{ name: "EngramAppSession", version: "1", chainId, verifyingContract: registry }`. Signed inside the vault
  session (no extra prompt). Lifetime <= the grant's expiry and <= 30 days.
- App server side: `verifyAppSession(proof, { config, agentId, origin, now? })` -> owner address, or
  `NOT_AUTHORIZED`. It checks the signature recovers `owner`, `agentId` and `origin` equal this app's, the proof is
  unexpired, and `issuedAt` is not more than 60 s in the future. A valid proof never grants access by itself: memory
  reads still require an active onchain grant.
- Owner side: `session.signAppSession({ agentId, origin, ttlSec })` -> proof.
- Vault side: `parseConnectRequest(url)` and `replyToOpener(opener, requestOrigin, result)` (posts with an exact
  `targetOrigin`, so a lying opener never receives the result).

Agent (server)
- `new EngramAgent({ config, agentId, x25519PrivateKey, operator })`
- `EngramAgent.publishKeys({ config, agentId, x25519PublicKey, operator, holder })` -> tx (`setAgentKeys`, sent by the token holder)
- `agent.inbox()` -> active grants to this agent with current-generation wraps
- `agent.recall(owner, nsId)` -> `{ label, entries, skipped, complete, missingSeqs }`
- `agent.remember(owner, nsId, { kind, text })` -> `{ seq, txHash }`

Relay handler (vault server)
- `createRelayHandler({ config, wallet, limits })` -> `(body) => Promise<{ status, body }>`; the vault's
  `POST /api/relay` is a thin wrapper.

## Session scoping (Mera UX bounty)
| Action | Passkey prompt? | Why |
|---|---|---|
| sign in / sign up | yes (one ceremony) | root of all keys |
| remember, recall | no, inside session | own data |
| revoke, rotate, cancelPending | no, inside session | only reduces sharing |
| grant | **yes, unless a ceremony happened in the last 60 s** (so "sign in, then approve" in the connect popup is one prompt) | shares data with a third party |
| any call after 15 min idle | yes (`SESSION_EXPIRED`, clean unlock screen) | session expired |

## Behavior cases (input -> expected output)
| # | Input | Expected output | Notes |
|---|---|---|---|
| 1 | `signUp` (device 1), `remember("preferences", "vegetarian")`, then `signIn` with the same passkey from a fresh process/profile, `recall("preferences")` | entries = ["vegetarian"], complete = true | **stateless test** |
| 2 | `signIn` with all local storage cleared | same owner address, same entries | nothing stored |
| 3 | `recall` when the source is missing seq 2 of 0..3 | complete = false, entries seq 0,1,3, missingSeqs [2]; log `{stage:"sdk", op:"recall", missingSeqs:[2]}` | completeness vs `nextSeq` |
| 4 | owner `recall` on a namespace spanning epochs 0 and 1 | entries from both epochs, in seq order | owner derives all epoch keys |
| 5 | `grant("preferences", 7, read, 7d, includeHistory=true)` at epoch 2 | one tx with wraps for epochs [0,1,2] | |
| 6 | same with includeHistory=false | wraps for [2] only; agent recall returns only epoch-2 entries, others counted in `skipped` | |
| 7 | `grant` where the source's copy of agent keys differs from chain | uses `agentKeysOf` from chain; logs a warning | source not trusted for keys |
| 8 | `revoke("preferences", [7])` with grantees [7,9] | tx keepIds [9] with a fresh wrap for the new epoch; returns newEpoch | |
| 9 | agent 7 `recall` after case 8 | throws `ACCESS_REVOKED` (onchain `isActive` false), although it still holds old epoch keys | well-behaved SDK |
| 10 | agent 9 `recall` after case 8 plus a new owner entry at the new epoch | includes the new entry | |
| 11 | agent `remember` with READ only | throws `NOT_AUTHORIZED` before sending a tx | pre-check |
| 12 | connect request whose origin is not listed in the agent's ERC-8004 card | `parseConnectRequest` returns `originVerified: false` | UI shows a warning |
| 13 | `connectEngram`, user closes the popup | rejects `USER_CANCELLED` | |
| 14 | `connectEngram` receives a message from an origin other than `vaultUrl`, or a malformed message | ignored | |
| 15 | authenticator without PRF | `signUp` throws `PRF_UNAVAILABLE` naming supported authenticators | |
| 16 | relayer unreachable | owner write throws `RELAYER_UNAVAILABLE`; no key material in the error | |
| 17 | entry that decrypts but fails JSON validation | skipped, `skipped += 1`, logged without content | |
| 18 | `grant` to an agent with `hasCurrentKeys` false | throws `AGENT_KEYS_NOT_CURRENT` before any prompt or tx | mirrors R2 |
| 19 | `grant` to an agent whose onchain X25519 key is non-canonical | throws `INPUT_INVALID` before any tx | BUGLOG B1 |
| 20 | agent `inbox` after revoke + re-grant | only current-generation wraps are used; old-generation wraps ignored | indexer I-series |
| 21 | `revoke`/`rotate` where a grantee expired or its token moved | keep set = onchain grantees minus expired minus not-current (mirrors contract prune); on `KeepSetMismatch` recompute once and retry | |
| 22 | any relayed call | EIP-712 `OwnerCall` with deadline <= now + 300 s and the current nonce; `cancelPending` makes a signed pending call fail `BadSignature` | |
| 23 | call after `end()`; call after 15 min idle | `SESSION_ENDED`; `SESSION_EXPIRED` | |
| 24 | `grant` 30 s after sign-in; `grant` 90 s after; re-prompt answered by a different passkey | no prompt; one prompt; `REAUTH_MISMATCH` and no tx | |
| 25 | relay handler given: bad signature / disallowed selector / >30 req per min for one owner / call that would revert | 400 `BAD_SIGNATURE` / 400 `SELECTOR_NOT_ALLOWED` / 429 / 400 with decoded error name; no tx sent in any case | |
| 26 | `remember` on a label never used | relays `createNamespace` then `appendAsOwner`; seq 0 | |
| 27 | `firstAvailable([graphql, logs])` with the indexer down | recall succeeds via logs source | read-path fallback |
| 28 | source injects a forged wrap (made with only the agent's public key) | agent ignores it; `remember` encrypts under the real key; `recall` returns no injected entries | chain-verified wraps |
| 29 | relayer returns an old or foreign txHash for `revoke` / `remember` | `RELAY_REJECTED` (`detail: "EFFECT_NOT_FOUND"`); never reports success | verified effects |
| 30 | grantee publishes a low-order key; owner revokes a different agent | revoke succeeds; the low-order grantee is also revoked (logged) | no revocation DoS |
| 31 | 30 forged-signature relay requests naming owner O, then O's real call | O's call succeeds | rate limit after verify |
| 32 | `remember`/`recall` in flight when `end()` runs | `SESSION_ENDED`, nothing written, nothing decrypted | |
| 33 | clock steps back 10 min after sign-in, then +5 min, then `grant` | one passkey prompt | |
| 34 | grantee expires within 60 s of the revoke | revoke succeeds first try (near-expiry grantee revoked explicitly) | |
| 35 | 16 grantees, one expired, grant a 17th | succeeds (rotation first) | |
| 36 | `grant` with agentId < 0 or >= 2^256; agent `remember` with invalid text or a non-operator wallet | `INPUT_INVALID` / `INPUT_INVALID` / `NOT_AUTHORIZED`, no tx | |
| 37 | relay handler body with array owner; relay handler whose RPC is down | 400 `BAD_REQUEST`; 502 `UPSTREAM_UNAVAILABLE` (never throws) | |
| 38 | graphql source returning partial data, an `errors` array, or a page cursor that never advances | `SOURCE_UNAVAILABLE` (fallback applies); paging terminates | |
| 39 | logs source read right after a write; source supplying a negative seq | sees the new entry; negative seq dropped | |
| 40 | popup reply with ok:true but missing/invalid owner, txHash, or granted | ignored; the later valid reply resolves | |
| 41 | `parseConnectRequest` with agentId >= 2^256, non-canonical numbers (`1e3`, `0x10`, `0007`), duplicate or empty labels, or a malformed agent card; `connectEngram` with invalid input | `INPUT_INVALID`; `originVerified: false` for the bad card; returned promise rejects (no sync throw) | |
| 42 | `JSON.stringify` / `inspect` of an `OwnerSession` or `EngramAgent` | no PRF, account key, or X25519 private key | |
| 43 | owner signs an app session for (agent 7, `https://planner.test`); app verifies with the same agentId and origin | returns the owner address | |
| 44 | the same proof verified by an app with another agentId, or another origin | `NOT_AUTHORIZED` | |
| 45 | expired proof; `issuedAt` more than 60 s in the future; ttl > 30 days at signing | `NOT_AUTHORIZED`; `NOT_AUTHORIZED`; `INPUT_INVALID` | |
| 46 | proof signed by owner A with `owner` field changed to B; truncated or garbage signature | `NOT_AUTHORIZED` | |
| 47 | valid proof, but the owner revoked the grant | agent `recall` still throws `ACCESS_REVOKED` | proof is not access |

## Trust boundaries (review 2026-10-01, BUGLOG S-series)
- **Wraps are only trusted when chain-verified.** X25519 wraps give secrecy, not authenticity: anyone with an
  agent's public key can make a wrap it will open. A source must supply `txHash` + `logIndex` for each wrap and
  the agent accepts it only if that receipt holds a `KeyWrapped(owner, nsId, agentId, epoch, wrap)` log emitted
  by the registry with identical fields.
- **Relayed effects are verified.** After every relayed call the owner session checks the receipt: status success,
  emitted by the registry, and the expected event with this owner and namespace (e.g. `EntryAppended` for
  remember, `GrantRevoked` for each revoked id plus `EpochRotated`). A relayer cannot report success it did not get.
- **Unwrappable grantees are revoked, not kept.** If a grantee's current key cannot be wrapped (low-order or
  non-canonical), rotation moves it into the revoke set (logged), so no grantee can block revocation.
- **Near-expiry grantees are revoked explicitly.** Grants expiring within 60 s of chain time are put in the revoke
  set, so a keep set can never go stale at an expiry boundary.
- **A 17th grant rotates first** when the namespace has 16 grantees and any is expired or has stale keys;
  otherwise `INPUT_INVALID` ("16 agents max").
- **Rate limits cannot be turned against an owner.** Each owner has two buckets: requests rejected before the
  signature verifies are charged to an "unverified" bucket (so case 25's flood still gets 429), verified requests to
  a separate one (so forged traffic naming a victim never uses up the victim's budget, case 31).
- **Sessions stay closed.** Every await is followed by a liveness check; a call in flight when `end()` runs rejects
  with `SESSION_ENDED` and sends nothing. A clock that moved backwards never counts as "recent" for the grant
  window. `JSON.stringify`/`inspect` of a session or agent shows only public fields.
- **Popup replies are validated, malformed ones ignored.** `ok:true` replies need an address `owner`, 32-byte
  `txHash`, and a `granted` array of valid labels; anything else is ignored like a foreign message.

Known limitation (documented, not fixed): entry AAD binds owner, namespace, and epoch but not `seq` (the contract assigns
seq after encryption), so a lying source can serve an authentic entry at a different seq or duplicate one. It cannot forge
or inject content. Completeness is still checked against chain `nextSeq`.

## Disclosure mode API (2026-10-02, contracts/disclosure.md)
Owner (vault origin)
- `session.pairwise(agentId)` -> address. `session.signAppSession({ agentId, origin, ttlSec, pairwise: true })`
  signs with the pairwise key (proof.owner = pairwise address).
- `session.approve(agentId, { origin, labels, scope, expiresInSec })` -> `{ txHash, pairwiseOwner }`: appends a
  policy entry to `engram-policy`. Same prompt rule as `grant`: a passkey prompt unless a ceremony happened in the
  last 60 s.
- `session.disapprove(agentId)` -> `{ txHash }` (policy with `active: false`); `session.policies()` -> the latest per agent.
- `session.disclose({ agentId, origin, query, mode, round })` -> `{ entries: DisclosedEntry[], logSeq? }` (selection
  rules in disclosure.md); `session.propose(agentId, origin, { kind, text, label? })` -> `{ seq, txHash }`.
- `session.disclosures({ agentId? })` -> decrypted log entries, newest first.

Vault bridge (vault origin): `startBridge({ session, agentId, window })` answers the `postMessage` protocol and
returns `{ stop() }`.

App client
- `connectEngram({ ..., mode?: "disclosure" | "offline" })`, default `"disclosure"`. Disclosure replies carry
  `mode` and the pairwise `owner`; offline keeps today's behaviour.
- `openVaultBridge({ vaultUrl, agentId, mount: HTMLElement })` -> `{ status(), disclose(query, { mode?, round? }), propose(entry), onStatus(cb), close() }`.
  Request ids are random; replies are matched by id with a 10 s timeout (`BRIDGE_TIMEOUT`).

| # | Input | Expected output | Notes |
|---|---|---|---|
| 48 | `approve` then `policies()` | the new policy; nothing in `grants()`; no `grant` or `setAgentKeys` tx | disclosure.md D1 |
| 49 | `approve` twice for one agent with different labels | `policies()` shows only the latest | latest wins |
| 50 | `disclose` when no policy, or `disapprove`d, or expired | `NOT_APPROVED` / `EXPIRED`; nothing returned | |
| 51 | `openVaultBridge` reply with a mismatched id, a wrong origin, or a non-object | ignored; the request still times out with `BRIDGE_TIMEOUT` | |
| 52 | `JSON.stringify` of a bridge client or the session after `pairwise()` | no key material | |

## Edge cases that must be covered
- Two vault tabs: both sessions valid; a relay that fails on a stale nonce is re-signed once with a fresh nonce.
- Label with uppercase from an app -> `INPUT_INVALID` (crypto.md label rule), no silent lowercasing.
- `expiresInSec` <= 0 or > 365 days -> `INPUT_INVALID` before any prompt.
- Popup blocked -> `POPUP_BLOCKED` with instruction to call from a user gesture.
- Agent with a rotated X25519 key: wraps it cannot open are counted in `skipped` with log code `KEY_MISMATCH`.
- Errors never contain key material, PRF output, plaintext, or wraps.

## Explicitly out of scope
- React components (apps.md builds UI on top).
- Key storage of any kind (by design).
- Mobile native SDKs (Mera has a React Native recipe; roadmap).
- Paying agents per query (roadmap).

## Logging
Every public method logs one structured line at exit via an injectable logger (default: `console.debug` JSON):
`{ stage:"sdk", side:"owner|client|agent|relay", op, traceId, label?, agentId?, ok, code?, durationMs }`.
Never logs plaintext, PRF output, keys, or wraps.

## Status
- [x] Drafted
- [x] Reviewed by a human (approved to build 2026-10-01)
- [x] Implementation matches this contract (adversarial pass: 48 probes, all passing after BUGLOG S1-S7 fixes)
- [x] Golden tests exist for every behavior case above (tests/golden/sdk: 29 golden + 14 regression tests; local anvil + real bytecode + Mera via fake WebAuthn)
