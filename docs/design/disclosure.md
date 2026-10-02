# Design note: Disclosure mode

Spec: [`contracts/disclosure.md`](../../contracts/disclosure.md). Status: drafted 2026-10-02, awaiting human review.

## Why
Every shipping memory layer (Walrus Memory, Plurality, Mem0) still lets an approved agent decrypt the user's
memory. After that, its reads are invisible and it can copy everything. Disclosure mode removes the key from the
agent entirely: the vault answers each question, so a read can be no wider than the answer, and every read
is logged.

## Architecture
```
 agent app page (https://wayfarer.app)                     vault (https://vault.engram)
 +--------------------------------------------+           +-------------------------------+
 | chat UI                                    |           | /connect popup (URL bar shown)|
 |   1. user types "plan dinner"              |           |   approve -> policy entry     |
 |   2. bridge.disclose(msg) ---------------- postMessage -> /bridge iframe (own session) |
 |      <- [ "allergic to peanuts" ] -------- postMessage <-  select + log entry          |
 |   3. POST /api/chat {messages, disclosed}  |           |   propose -> owner relay write|
 +--------------------|-----------------------+           +---------------|---------------+
                      v                                                   v
 agent server (agent-kit, mode "disclosure")                   Monad: MemoryRegistry
   KIMI loop; recall/remember -> {pending, continuation}         ciphertext only: v1 memories,
   client relays the pending tool to the bridge and              v2 proposals / policy / log
   POSTs /api/chat/continue                                      (no grants, no wraps)
```
- The agent server never touches the chain in this mode. It sees only the pairwise identity and the entries it
  was shown.
- Approval is the only consent moment. It happens in the popup, where the URL bar is visible. The iframe only
  unlocks and answers inside an approval.

## Transport decision: a cross-site iframe bridge
Spike: [`spikes/bridge-transport.mjs`](spikes/bridge-transport.mjs). Playwright Chromium, `app.test` framing
`vault.test` (truly cross-site), https with a pinned self-signed cert, CDP virtual authenticator with PRF.

| Check | iframe | popup |
|---|---|---|
| `credentials.create` with the `prf` extension | enabled | enabled |
| `credentials.get` PRF eval | 32 bytes | 32 bytes |
| postMessage round trip to the app | ok | ok |
| CDP virtual authenticator reaches it (e2e-testable) | yes | yes |
| top-level vault storage visible inside | yes in this build (not partitioned) | n/a |

Decision:
- **Primary: an iframe strip.** It stays put during chat and needs no window juggling. Its cost is one passkey tap
  per page load, because we never rely on shared storage. Real browsers partition third-party storage, and this
  design keeps the session in memory regardless.
- **Fallback: the existing popup**, when the iframe cannot unlock (a browser without WebAuthn in cross-origin
  frames, or a strict tracking-protection mode). The protocol is the same; only the transport differs.
- **Requirements on the agent page:** `allow="publickey-credentials-get; publickey-credentials-create"` on the
  iframe. The vault sends `frame-ancestors *` on `/bridge` only.
- **Not yet verified:**
  - Safari and Firefox (WebAuthn get in cross-origin iframes is documented as supported in both);
  - Mera's own WebAuthn client inside the iframe (expected to work, since it calls `navigator.credentials`).

  Both are in the e2e test plan, and the popup fallback covers a failure.

## Threat model
| Attacker | Capability | What they get | Mitigation |
|---|---|---|---|
| Malicious agent (honest page, greedy model) | asks broad queries, asks `full` | at most what an answer contains; every read is logged and visible live | relevant-mode cap 8, full mode logged as `full`, rate limit D26, revoke |
| Agent copies what it was shown | stores disclosed text | the entries it was shown, forever | none possible; minimisation plus an audit trail; honest copy in the UI |
| Agent page fakes the vault UI | draws a look-alike strip | nothing from the vault: the passkey prompt is bound to the vault rpId, so a fake obtains no PRF; it can only lie about reads | the main vault "Reads" log is authoritative (D28) |
| Clickjacking the iframe | overlays, transparent frames | can trigger "Unlock" (harmless) or "Revoke" (reduces sharing) | no approve or confirm controls inside `/bridge` |
| Another site frames `/bridge` | sends postMessage | nothing | origin must equal the approved policy origin, source must be `window.parent` (D9, D10) |
| Network observer / chain reader | reads Monad | that an owner appended entries; sizes and timing | no grants or wraps onchain; pairwise ids never onchain (D4) |
| Colluding agents | compare user identities | nothing from the ids (pairwise); possibly linkable by timing or by identical disclosed text | documented; adversarial pass probes it |
| Tampering with the server continuation | edits the convo, counters or owner | nothing: HMAC, expiry 120 s, owner binding (D24) | replay within 120 s costs only model tokens, bounded by rate limits |
| Malicious agent writes poison | proposes instruction-like text | its own future context only; other agents never see it (D19) | provenance contract: confirm, edit, reject, heuristics |

## What this contradicts or supersedes (flagged, not edited)
Frozen tests stay as they are. Each item below keeps passing because it covers the offline (key-grant) path:
1. `contracts/apps.md` A12 and golden `agent-kit.regressions` A12 (`NO_GRANT`): true for offline agents. Disclosure
   agents cannot check grants, so a self-signed proof can chat without memory. Cost is bounded by A13/A18.
2. `contracts/apps.md` A2 (remember writes onchain as the agent, `appendAsAgent`): offline only. Disclosure writes
   are owner-signed v2 entries with `src.agent`.
3. `contracts/sdk.md` "A valid proof never grants access by itself: memory reads still require an active onchain
   grant": offline only. In disclosure mode the vault policy gates reads, and the agent server never reads.
4. Vault "who wrote each entry": the onchain writer of a disclosure-mode proposal is the owner. The ledger must read
   `src.agent` from the v2 entry instead of the event's `byOwner` / `agentId` fields.
5. README "Revoking rotates the folder key onchain, so a revoked agent cannot read anything written afterwards":
   offline only. Disclosure revoke is "the vault stops answering". The README needs rewording once this ships.
6. Golden crypto case "`{"v":2,...}` -> `ENTRY_INVALID`": still holds, because `parseEntry` stays v1-only and v2 goes
   through a new `parseAnyEntry`.
7. apps/agent personas (Sage readwrite, Wayfarer read) switch to disclosure mode. The existing agents e2e spec
   covers the offline flow, and a new spec covers disclosure.

## Build order (each step: spec cases -> failing golden tests -> code -> adversarial pass)
1. crypto: pairwise derivation and entry v2, with Python vectors (cases 17-21).
2. sdk: approve / disclose / propose / policies / disclosures, plus `startBridge` / `openVaultBridge` (48-52, D1-D20).
3. agent-kit: disclosure mode with continuations (A21-A24, D21-D25).
4. vault: `/connect` disclosure screen, `/bridge`, dashboard "Approved agents" and "Reads" (V6, V7).
5. apps/agent: mount the bridge and the pre-turn disclosure; e2e on testnet (Sage writes, Wayfarer reads and is
   revoked).
6. Provenance and quarantine (next contract), then the demo polish.
