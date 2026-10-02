# Contract: Disclosure mode (agents ask, the vault answers)

## Purpose
Make it the default that an approved agent **never holds a key** to the user's memory. While the user chats, the
agent's model asks for memory; the user's vault, running in the browser, decrypts locally, returns only the
relevant entries from approved folders, and records every read in a log the user can see. Agent writes become
proposals that the vault writes as the owner, with provenance. Revoke means the vault stops answering.

Hands off:
- crypto (pairwise keys, entry v2) to `contracts/crypto.md`;
- the SDK surface to `contracts/sdk.md`;
- the agent-server tool round-trip and the vault/agent UI to `contracts/apps.md`;
- quarantine rules for proposals to the provenance contract (next spec, `contracts/provenance.md`);
- the old key-grant flow, which stays as "offline access", to `contracts/sdk.md` and `contracts/memory-registry.md`.

Design rationale, transport spike and threat model: [`docs/design/disclosure.md`](../docs/design/disclosure.md).

## Concepts
- **Approval (policy):** `{ agentId, origin, labels, scope: "read" | "readwrite", exp, active }`, stored as an
  encrypted v2 `policy` entry in the owner's reserved folder `engram-policy`. It is not an onchain grant: nothing
  public says which agent a user approved. The latest entry for an `agentId` wins.
- **Pairwise identity:** for each agent, a secp256k1 key derived from the passkey
  (`engram.v1/pairwise/secp256k1/<agentId>`, crypto.md). Its address is the only owner identity the agent ever sees.
  It is stable across devices, different for every agent, and never appears onchain.
- **Bridge:** the vault page `${vaultUrl}/bridge?agentId=N`, embedded by the agent app as a small cross-site iframe
  strip. It holds its own vault session (one passkey tap to unlock) and answers `disclose`, `propose` and
  `status` requests over `postMessage`, only from the approved origin.
- **Disclosure:** one answer to one request: the entries selected for a query, plus one `log` entry recording it.
- **Reserved folders:** labels starting with `engram-` (`engram-index`, `engram-policy`, `engram-log`). They are
  never disclosed, never approvable and never writable by agents.

## Inputs
- Approve (connect popup, `mode: "disclosure"`, the default): `agentId` uint256, `origin` (exact origin,
  `exactOrigin`), `labels` 1..8 non-reserved labels, `scope`, `expiresInSec` 1..31536000.
- `disclose` (bridge, from the approved origin): `{ id: string <= 64, query: string <= 500 chars, mode: "relevant" | "full", round: 0..3 }`
- `propose` (bridge): `{ id, kind: "fact" | "preference" | "note", text: 1..500 code points, label?: approved label }`
- Agent server: `POST /api/chat { messages, disclosed: DisclosedEntry[] <= 20, memory: "ok" | "locked" | "revoked" | "none" }`,
  `POST /api/chat/continue { continuation, result }`

## Outputs
- `DisclosedEntry = { kind, text, by: "owner" | "self" }`. `self` means proposed by the requesting agent. No seq,
  tx, epoch, label or timestamps are disclosed.
- `disclose` reply: `{ id, ok: true, entries: DisclosedEntry[], mode }`, or `{ id, ok: false, code }` with
  `code`: `VAULT_LOCKED`, `NOT_APPROVED`, `EXPIRED`, `BAD_REQUEST` or `RATE_LIMITED`.
- `propose` reply: `{ id, ok: true, seq, txHash }`, or `{ id, ok: false, code }` (also `READ_ONLY`, `QUOTA`).
- Agent server: `{ reply, saved }`, or `{ pending: { id, tool: "recall" | "remember", args }, continuation }`.
- Log entry (encrypted, owner-only): `{ agent, origin, q, mode, refs: [{l, s}], n, round }`.

## Selection rules (`relevant` mode)
1. Normalise the query and each entry text: NFKC, lowercase. Split on runs of characters that are not `\p{L}`,
   `\p{M}` or `\p{N}` (combining marks stay inside words, so Devanagari vowel signs do not split a word). Drop tokens shorter than 2 characters and the fixed stopword list:
   `a an and are about any can do for i in is it know me my of on or please tell the to what with you your`.
2. A query token matches an entry token when they are equal, or when their common prefix is at least
   `min(5, len(shorter))` and the shorter token is at least 3 characters (`allergy` matches `allergic`, `veg` matches `vegetarian`, `tea`
   matches `team`).
3. Score = the number of distinct query tokens that match at least one token of the entry. Keep entries with a
   score of 1 or more, order by score descending then newest first, and return at most 8.
4. `full` mode: the newest 20 entries across approved folders, and the log marks it `full`.
5. Candidates are only:
   - entries in approved, non-reserved folders;
   - entries that are owner-written (v1, or v2 without `src`) or proposed by **this** agent (v2 with
     `src.agent == agentId`).

   Entries proposed by other agents are never candidates; confirmation is in `contracts/provenance.md`.
6. Before each turn, the agent page runs one `relevant` disclosure with the user's latest message as the query
   (truncated to 500 characters).

## Behavior cases (input -> expected output)
| # | Input | Expected output | Notes |
|---|-------|------------------|-------|
| D1 | connect popup, mode disclosure, approve `preferences` read for agent 7 at `https://app.x` | one relayed append to `engram-policy` (policy entry); reply `{ owner: pairwise(7), granted: ["preferences"], txHash, sessionProof, mode: "disclosure" }`; **no** `grant` call onchain | no key leaves the vault |
| D2 | `sessionProof` from D1 | verifies with `verifyAppSession` and recovers `pairwise(7)`, not the owner address | pseudonym |
| D3 | same passkey on a second device, approve agent 7 again | identical `pairwise(7)` address | stable |
| D4 | `pairwise(7)` vs `pairwise(8)` vs owner address | all three different; no onchain tx ever has `pairwise(*)` as sender or argument | unlinkable |
| D5 | bridge locked, `disclose` arrives | `{ ok: false, code: "VAULT_LOCKED" }`; nothing logged | |
| D6 | bridge unlocked, approved, entries "vegetarian", "allergic to peanuts", "likes jazz"; query "Plan dinner, any allergy concerns?" | entries `["allergic to peanuts"]`, `by: "owner"`; one log entry with `q`, `mode: relevant`, 1 ref | minimal |
| D7 | query "What do you know about me?" (all stopwords) | `entries: []` (relevant); a following `full` request returns all 3, log marks `full` | explicit full read |
| D8 | query matches nothing | `entries: []`, still logged with `n: 0` | every read logged |
| D9 | `disclose` from an origin other than the approved one (another frame, a popup, a redirect) | ignored, no reply posted, nothing logged | origin-bound |
| D10 | message from the right origin but not from `window.parent` | ignored | source-bound |
| D11 | approval expired (`exp` passed by the vault clock) | `{ ok: false, code: "EXPIRED" }` | |
| D12 | owner revokes agent 7 in the main vault, then a `disclose` arrives 5 s later in the bridge | `NOT_APPROVED` | policy re-read when cached > 3 s |
| D13 | revoke while a `disclose` is in flight (selection already done) | that reply is still delivered and logged; the next request gets `NOT_APPROVED` | no unsend; honest |
| D14 | folder `work` exists but only `preferences` is approved; query "salary" | no `work` entries; the reply never reveals that `work` exists | |
| D15 | request names a reserved folder or approval asks for `engram-log` | `BAD_REQUEST` / approval rejected | reserved |
| D16 | `propose` from a `read` approval | `READ_ONLY`, nothing written | |
| D17 | `propose` "prefers window seats" from a `readwrite` approval | owner-signed relay append of a v2 entry with `src.agent: "7"`; reply `{ seq, txHash }`; logged as a write | owner pays nothing |
| D18 | D17's entry, then agent 7 discloses "seats" | returned with `by: "self"` | own proposals visible |
| D19 | D17's entry, then agent 8 (also approved for `preferences`) discloses "seats" | not returned | quarantine default |
| D20 | key-grant ("offline") agent reads `preferences` after D17 | the v2 entry is skipped (counted in `skipped`), v1 entries readable as before | v1 `parseEntry` unchanged |
| D21 | agent server gets `memory: "locked"` with no `disclosed` | model is told the user's memory is locked and how to unlock it; no recall tool round-trips are attempted | |
| D22 | model calls `recall({ query: "diet" })` | server returns `{ pending: { tool: "recall", args: { query: "diet", mode: "relevant" } }, continuation }` | stateless server |
| D23 | `continue` with a valid continuation and the bridge's result | the loop resumes with the result inside `<user_memory>` | |
| D24 | `continue` with a tampered continuation, an expired one (> 120 s), another owner's cookie, or a result id that does not match | 400 `BAD_CONTINUATION`; the model is not called | HMAC-bound |
| D25 | 4th tool round requested via continuations | final answer without the tool; never more than 3 rounds | existing cap |
| D26 | more than 60 `disclose` requests from one agent in 10 minutes | `RATE_LIMITED` (vault side), logged once | |
| D27 | the log append fails (relay down) | the disclosure still answers; the log entry is queued in the bridge and retried; the UI shows "log pending" | the user's own audit, eventually consistent |
| D28 | the agent page draws a fake vault UI instead of the real iframe | it cannot unlock: the passkey prompt is bound to the vault rpId, and a fake can obtain no PRF; it can only lie about reads, which the main vault log contradicts | see design note |
| D29 | a folder read during `disclose` is incomplete (the indexer trails the chain, e.g. right after a `propose`) | the vault re-reads for up to ~3 s until complete, then answers with what it has | same rule as apps.md A10 |
| D30 | the owner revokes on this device; more than 3 s later the policy cache refreshes from a source that has not indexed the revoke yet | `NOT_APPROVED`: a refresh never replaces a cached policy with an older one (higher `seq` wins), and an incomplete policy folder is re-read briefly | revocation is never undone by lag (BUGLOG D-3) |

## Edge cases that must be covered
- An unlocked bridge idle for 15 minutes locks itself (`SESSION_IDLE_MS`) and answers `VAULT_LOCKED`.
- Two tabs of the same agent each have their own bridge and unlock; both obey the same policy.
- Unicode queries (Hindi, Japanese) tokenise on `\p{L}\p{M}\p{N}`; scripts without spaces (Japanese, Chinese) fall
  back to whole-run tokens, so they match only by shared prefix (documented weakness).
- The latest policy entry wins, even if an older one appears later in indexer order: order by `seq`, not arrival.
- `disclosed` sent to the server is capped at 20 entries and 4000 characters each; extra entries are dropped.
- Malformed messages to the bridge (non-object, missing `id`, huge strings) are ignored without a reply.

## Explicitly out of scope
- Confirming, editing or rejecting proposals; instruction-like content heuristics: `contracts/provenance.md`.
- Background or offline agents: they use the existing key-grant flow, which needs an explicit `mode: "offline"`
  approval with its own warning (`contracts/apps.md`).
- Agents copying what they were shown: no design prevents this; Disclosure mode minimises and logs it.
- Semantic (embedding) selection: a later upgrade; rules above are the contract.

## Logging
Bridge stage lines: `{ stage: "bridge", op: "disclose" | "propose" | "status", ok, code?, durationMs, n, mode }`.
Agent server: `{ stage: "agent", op: "pending" | "continue", tool, round }`. Never query text, entry text or keys.

## Status
- [x] Drafted (2026-10-02)
- [x] Reviewed by a human (2026-10-02: approved to proceed, no case changes requested)
- [x] Implementation matches this contract (2026-10-02; e2e on Monad testnet: tests/e2e/agents.e2e.spec.ts)
- [ ] Golden tests exist for every behavior case above: all except D27 (log-append failure and retry) and D28
  (fake vault UI, a property of WebAuthn rpId binding), which have no automated test yet
