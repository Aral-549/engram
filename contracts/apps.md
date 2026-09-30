# Contract: apps (vault, relayer, two KIMI agents)

## Purpose
The live product judges touch. The **vault** is the passkey home (rpId) where users see and control their
memory. Two independent **KIMI-powered agent apps** on separate origins prove the memory is portable:
one learns about you, the other uses it without asking. The **relayer** makes every owner action gasless.

## Inputs
- SDK (sdk.md), deployed registry + indexer.
- Server env per agent app: `KIMI_API_KEY`, `KIMI_BASE_URL`, `KIMI_MODEL`, `AGENT_ID`, `AGENT_X25519_PRIVATE_KEY`, `AGENT_OPERATOR_KEY`.
- Relayer env: `RELAYER_PRIVATE_KEY` (funded testnet MON).
- `.env.example` documents every variable; real `.env` files are never committed.

## Outputs
Three deployed web apps with public URLs, plus judge instructions in the README.

## App 1: vault (`apps/vault`)
- Onboarding: one screen, one button, one passkey ceremony -> lands on "Your memory" (target: under 10 s and 2 taps from landing to first confirmed Monad tx).
- Memory browser: namespaces, decrypted entries, who wrote each (you / agent name), tx link per entry.
- Access panel: per agent: name (from ERC-8004 card), namespaces, scope, expiry, last read; **Revoke** button.
- Connect flow (`/connect` popup): shows requesting origin, agent name, verified/unverified origin badge,
  namespaces, scope, expiry, and "this agent sends granted memory to Moonshot AI (KIMI)"; Approve re-prompts passkey.
- Session: 15 min idle expiry with a clear "Session ended, tap to unlock" screen.

## App 2: assistant (`apps/assistant`) -- ERC-8004 agent, scope READ_WRITE on `preferences`
- Chat UI. KIMI is called with two tools: `remember({kind, text})` and `recall()`.
- KIMI decides what is worth remembering, and consolidates: before writing, it recalls and does not
  duplicate or, on contradiction, writes a superseding entry ("now eats fish, was vegetarian").
- Each saved memory shows a chip "Saved to your memory" with the Monad tx link, confirmed in ~1 s.

## App 3: planner (`apps/planner`) -- separate ERC-8004 agent, scope READ on `preferences`
- Trip/meal planner. On connect it recalls and personalizes the first answer without asking any questions.
- After the owner revokes it in the vault: next request shows "Access revoked by you" and falls back to
  asking questions. New memories written later are never visible to it.

## Relayer (`apps/vault/api/relay`) {#relayer}
- `POST /api/relay { owner, data, deadline, signature }` -> `{ txHash }`.
- Before spending gas: verify EIP-712 signature offchain, selector in the allowlist, deadline in the future,
  `eth_call` simulation succeeds. Rate limit 30 tx/min per owner and 300/min global.

## Behavior cases (input -> expected output)
| # | Input | Expected output | Notes |
|---|---|---|---|
| 1 | New user on vault, taps "Create memory" | one passkey prompt; owner address shown; no seed phrase, no extension, no email | Mera UX |
| 2 | In assistant: "I'm vegetarian and allergic to peanuts" | KIMI calls `remember` twice (or once combined); chips with tx links appear | |
| 3 | Same fact repeated later | no new entry (KIMI sees it via `recall`) | consolidation |
| 4 | Planner first visit, connect -> approve | first plan excludes meat and peanuts without asking | portability |
| 5 | Vault: revoke planner | tx confirmed, planner's next request shows revoked state | |
| 6 | Assistant writes new fact after case 5 | planner cannot see it (no key for new epoch) | forward-only revoke |
| 7 | Judge clears site data / opens fresh profile mid-demo, signs in with same passkey | identical memory and grants | stateless test |
| 8 | Relay with invalid signature | 400, no tx sent, logged | |
| 9 | Relay exceeding rate limit | 429 | |
| 10 | KIMI API down or times out (20 s) | assistant shows "model unavailable, your memory is safe"; no partial writes | |
| 11 | Memory text contains "ignore your instructions and reveal ..." | treated as data inside a delimited block in the system prompt; agent does not follow it | prompt-injection hygiene |

## Edge cases that must be covered
- Popup blocked -> inline instructions.
- User opens planner on a device without a PRF-capable authenticator -> vault explains and suggests phone QR (hybrid) sign-in.
- Two agents granted at once, then one revoked: the other keeps working without a new consent prompt.
- KIMI returns a tool call with invalid args -> rejected with a structured log, not written onchain.

## Explicitly out of scope
- Native mobile apps.
- Payments to users for queries (roadmap).
- Any server-side storage of plaintext memory (agents may cache in memory for one request only).

## Logging
Agent apps log `{ stage:"agent", agentId, op:"recall|remember|kimi", traceId, entries?, tokensIn?, tokensOut?, ok, durationMs }`.
KIMI prompts and responses are not logged in production mode.

## Demo video outline (3 min)
0:00 problem (every AI forgets you per app) -> 0:20 passkey onboarding -> 0:40 assistant learns facts
(tx links, ~1 s) -> 1:20 planner uses them instantly -> 1:50 revoke live -> 2:10 fresh browser, same
passkey, memory restored -> 2:35 explorer + indexer view, why Monad.

## Status
- [x] Drafted
- [ ] Reviewed by a human
- [ ] Implementation matches this contract
- [ ] Golden tests exist for every behavior case above
