# Antigravity prompts: from "shared encrypted memory" to "agents ask, the vault answers"

How to use:
- Paste the **Shared preamble** first, then one prompt. Run prompts in order; each stops for your review.
- Pick the model shown on each prompt:
  - **Claude Opus 4.6** writes all specs, designs and reviews.
  - **Gemini** (the Pro model in Antigravity's picker) does the implementation.

  The model that writes the code never reviews it (AGENTS.md rule 2).
- Never paste secrets into a prompt. The agent reads `.env*` files only where a step says to, and never prints them.

Why these features (research, 2026-10-02):
- **The core idea is already funded and shipping.** User-owned, encrypted, revocable AI memory exists in Walrus
  Memory (Mysten, June 2026, Seal encryption, gasless grants and revoke), Plurality's Open Context Layer (TEE, MCP,
  revocable), Mem0 ($24M, "Plaid for memory"), and Lethe (Sui Overflow 2026).
- **All of them still give the agent decryption access.** Once an agent can decrypt, its reads are invisible and it
  can copy everything. Imports from ChatGPT, Claude and Gemini are one-time snapshots, not live sync.
- **Memory poisoning is the top open threat.** "Poison Once, Exploit Forever" (Apr 2026); MemGhost (Jul 2026) has
  87.5% end-to-end success. Shared memory makes it worse: one poisoned agent can write into every other agent's
  context.
- **ERC-8004 reputation is not a trust signal yet** (arXiv 2606.26028). 60-90% of reviewers are Sybil, and feedback
  is rarely grounded in a verifiable interaction.
- Decided 2026-10-02: Disclosure mode is the main design; the name stays Engram.

---

## Shared preamble (paste before every prompt)

```
You are working in the repo at ~/Downloads/monad (GitHub: Aral-549/hippo). It is a solo entry for the Monad
Metropolis hackathon (Trust, Identity & AI Infrastructure track), deadline 2026-10-14 09:29 IST.

What exists today ("Engram", working name):
- Users have a passkey vault (WebAuthn PRF via @category-labs/mera). Keys are derived with HKDF
  (packages/crypto). Memory entries are AES-256-GCM encrypted client-side and stored as ciphertext in
  MemoryRegistry on Monad testnet, 0x733d1Bf4DC13B721a2Ce3DDCFb444795eFF59d31.
- Today's sharing model: the owner grants an ERC-8004 agent a folder ("label"). The folder key is X25519-wrapped
  to the agent's published key, so the agent decrypts on its own server. Revoke rotates the folder key (epoch).
- Packages: packages/crypto, packages/sdk (EngramOwner, EngramAgent, connectEngram, verifyAppSession, sources,
  relay), packages/agent-kit (createAgentServer: KIMI tool loop with recall/remember, guardRequest, rate limits).
- Apps:
  - apps/vault (Next.js 16, port 3100): onboarding, ledger, grants, the /connect consent popup, gasless relay.
  - apps/agent (port 3201 Sage, read-write; port 3202 Wayfarer, read-only).
  - indexer/ (Envio HyperIndex; GraphQL on :8090).
- Specs live in contracts/*.md and are the source of truth: crypto.md, memory-registry.md, indexer.md, sdk.md,
  apps.md, integration.md. Bugs are logged in BUGLOG.md.

Workflow rules (from ~/AGENTS.md, mandatory):
0. No emojis anywhere: code, comments, commits, output, replies.
1. Contract before code: write or extend contracts/<module>.md (Purpose, Inputs, Outputs, a Behavior cases table
   of input -> expected output, Edge cases, Out of scope, Status), then STOP for human review before code.
2. Never grade your own work: tests come from the spec, not from code. After implementing, a separate
   adversarial pass (a different agent or model) tries to break it.
3. tests/golden/ is frozen: add new files or cases, never modify or delete existing ones.
4. Every change to core logic (packages/*, chain/) needs a matching contracts/ or tests/golden/ change.
5. Log structured JSON at every pipeline stage boundary ({stage, op, ok, durationMs, ...}); never log memory
   plaintext or keys.
6. Done means: contract matches the code, golden tests pass, an integration test on real testnet input passes,
   an adversarial pass has run, and every bug has a BUGLOG.md entry plus a regression case in tests/golden/.

Testing:
- Unit and golden: `npm run -s build -w @engram/crypto -w @engram/sdk -w @engram/agent-kit`, then vitest in each
  package (local anvil with the real bytecode via tests/support/anvil.ts; FakeKimi in tests/support/fake-kimi.ts).
- Browser: `npm run test:e2e` (Playwright, CDP virtual authenticator with PRF).
- Secrets: chain/.env, indexer/.env, apps/vault/.env.local and apps/agent/.env.* are gitignored. Never print,
  copy or commit them.
- Do not commit or push unless the human says so in this conversation. Do not redeploy contracts without asking.
```

---

## Prompt 1: Design "Disclosure mode" (agents ask, the vault answers)
**Done by Claude Code on 2026-10-02:** see contracts/disclosure.md and docs/design/disclosure.md. Skip to prompt 2
once the human has reviewed the design. The prompt is kept for reference.
**Model: Claude Opus 4.6** - output is a contract and a design note only, no code.

```
Goal: design the product's main differentiator. Today an approved agent holds the folder key and can decrypt and
copy everything, and the user never sees what it read. Competitors (Walrus Memory/Seal, Plurality/TEE, Mem0)
share that property. Design "Disclosure mode":

- The agent never receives a key. When its model calls recall(query), the request goes to the user's vault,
  which is open in the browser during the chat. The vault decrypts locally, selects only the relevant entries
  from the folders this agent is approved for, returns them, and records the read in a disclosure log the user
  can see live ("Wayfarer read 2 memories: vegetarian, peanut allergy").
- remember(text) from an agent becomes a proposal the vault writes as the owner through the existing gasless
  relay, with provenance (see prompt 4 for quarantine; just leave room for it here).
- Revoke means the vault stops answering, immediately. No key rotation is needed for this mode.
- Pairwise pseudonyms: each agent sees a different, stable owner identity derived from the passkey (new HKDF
  info string, e.g. "engram.v1/pairwise/<agentId>"), so agents cannot correlate a user across apps. The app
  session proof (EIP-712 AppSession in packages/sdk/src/appsession.ts) is signed by that pairwise key.
- The approval policy (which agent, which folders, scope, expiry) is itself stored as an encrypted entry in the
  owner's own namespace, so it syncs across devices and is not public. Decide whether onchain grants are still
  written in this mode: argue it from privacy versus a public consent record, and recommend one.
- The existing key-grant flow stays as an explicit "offline access" option for agents that must work while the
  user is away. Do not remove it.

Hard questions you must answer in the design note, with a recommendation each:
1. Transport between the agent page (origin A) and the vault (origin B):
   - an iframe (WebAuthn and PRF in cross-origin iframes need allow="publickey-credentials-get", and storage is
     partitioned), or
   - a companion popup kept open (postMessage via opener), or
   - both, with a fallback.
   Name a 30-minute spike that settles it in Chromium with the Mera PRF client, and the exact pass/fail check.
2. The tool round-trip: the model runs server-side in packages/agent-kit, but memory now comes from the
   browser. Specify the protocol: the server returns {pending: "recall", query, id} to the client, the client
   gets the answer from the vault, then posts it back to continue the loop. Cover timeouts, a missing vault, and
   at most 3 tool rounds (the existing cap).
3. Selection: how the vault picks "relevant" entries with no server. Start simple (keyword and recency inside
   approved folders, cap N entries) and state the upgrade path. Exact rules go in the contract cases.
4. Trust: the agent server receives memory from the browser. Who can forge it, and does it matter? The user may
   lie about their own memory, which is fine. A malicious agent page could fake the vault frame: how does the
   user tell the real vault UI apart?
5. Logging and audit: what the disclosure log stores (entry ids, agent, query hash, time), where it lives
   (encrypted, owner-only), and its retention.

Deliverables:
- contracts/disclosure.md in the repo's contract format. At least 20 behavior cases (input -> expected output),
  covering every edge case above: a revoked mid-turn, the vault closed, an expired approval, a cross-origin
  forgery, a replayed request, pseudonym stability across devices, and a query that matches nothing.
- Additions to contracts/crypto.md for the pairwise derivation, and to contracts/sdk.md and contracts/apps.md for
  the new API surface. New cases only; do not rewrite existing ones.
- docs/design/disclosure.md (at most 2 pages): architecture diagram (ASCII), the transport decision, and a
  threat model table (attacker, capability, what they get, mitigation).
- A list of every existing golden test or contract case this design contradicts. Do not edit them; flag them.
STOP after writing these and ask the human to review. Do not write implementation code.
```

## Prompt 2: Golden tests for Disclosure mode
**Model: Claude Opus 4.6** - only after you approve prompt 1.

```
Read contracts/disclosure.md (approved) and the new cases in crypto.md, sdk.md and apps.md. Write golden tests
for every behavior case, from the spec only. Do not read or write implementation code beyond the existing
public APIs you need to import.
- tests/golden/disclosure/*.golden.test.ts (vitest; reuse tests/support/anvil.ts, fake-authenticator.ts and
  fake-kimi.ts).
- Pairwise derivation vectors: generate them with an independent implementation. Extend the Python reference in
  tests/golden/crypto/ (`npm run golden:crypto`); do not compute them in TypeScript.
- A test for the browser transport: add a Playwright spec under tests/e2e/ that will fail until it is
  implemented.
Run them. They must fail (missing modules or wrong behavior), never pass by accident. Report the failing list,
mapped to case numbers. Add a header to each file: "Written from the spec before the implementation. FROZEN:
add cases, never edit." STOP.
```

## Prompt 3: Implement Disclosure mode
**Model: Gemini** - only after prompt 2's failing tests are reviewed.

```
Implement contracts/disclosure.md until every test in tests/golden/disclosure/ and the new e2e spec passes,
without modifying any file under tests/golden/.
Scope:
- packages/crypto: the pairwise derivation.
- packages/sdk: the vault-side disclosure API and the app-side client.
- packages/agent-kit: the pending-tool round-trip.
- apps/vault: the bridge (the transport chosen in docs/design/disclosure.md) and the live disclosure log UI.
- apps/agent: send the round-trip from the page.
Keep the key-grant "offline access" path working: all existing suites must still pass (crypto, sdk, agent-kit,
vault, indexer, and both existing e2e specs).
Structured logs at each new boundary: bridge request in/out, selection, round-trip.
Never log memory text.
If a golden test looks wrong, do not change it. Stop and explain why, citing the contract case.
Finish with: the full test output summary, a list of files changed, and any contract ambiguity you hit. Do not
commit.
```

## Prompt 4: Design poison-resistant shared memory
**Model: Claude Opus 4.6** - can run in parallel with prompt 3 (spec only).

```
Threat: in shared memory, one compromised or malicious agent can write a memory that every other agent then
reads as context. This is cross-agent memory poisoning: "Poison Once, Exploit Forever" (2026); MemGhost reached
87.5% success via one email. Today agent writes go straight into the user's folder. Memory text is JSON-escaped
inside <user_memory> blocks (packages/agent-kit memoryBlock), but it is still shown to every agent.

Design provenance and quarantine, as additions to contracts/disclosure.md, contracts/crypto.md (entry format)
and contracts/apps.md:
- Entry provenance:
  - owner-written,
  - agent-proposed(agentId),
  - owner-confirmed(from agentId).
  Put it in the encrypted entry as a new entry version (v2). v1 stays readable, and existing crypto vectors are
  never changed.
- Quarantine: agent-proposed entries are visible to the proposing agent and to the owner (a vault "Review" inbox
  with confirm / edit / reject), but are disclosed to OTHER agents only after the owner confirms. Add an
  auto-confirm setting that is off by default.
- Instruction-like content (imperatives aimed at an AI, URLs, "ignore previous", tool-call-shaped text) always
  needs confirmation, even with auto-confirm on. Specify the exact heuristic as contract cases, with false
  positives listed on purpose.
- Lineage: each disclosure lists the provenance of every entry it returned, so a poisoned answer can be traced
  to the entry and agent that introduced it. One click revokes that agent and quarantines all its proposals.
- What the agent's model is told: the provenance label goes inside the data block, never as an instruction.
Cases: at least 15 rows, including a proposal that becomes poisonous after edit, a confirmed entry later found
malicious, an agent proposing 50 entries in a day (cap), and entries in other languages.
Also write a short threat model table. STOP for review. No code.
```

## Prompt 5: Tests, then implementation, for poison resistance
**Models: Opus 4.6 writes the tests; Gemini implements** (two separate conversations).

```
(Opus 4.6) From the approved provenance and quarantine cases, write tests/golden/provenance/*.golden.test.ts plus
v2 entry vectors via the Python reference. Make them fail first, report, STOP.
```
```
(Gemini) Implement the approved provenance and quarantine cases until tests/golden/provenance passes and all
other suites still pass. Vault UI: a "Review" inbox in the ledger's design language, with confirm, edit and
reject; lineage shown on each disclosure log row. No edits under tests/golden/. Do not commit.
```

## Prompt 6: Adversarial review (run after prompts 3 and 5)
**Model: Claude Opus 4.6** - a fresh conversation, not the one that wrote the code.

```
You are the adversarial reviewer. Your only goal is to break the Disclosure mode and provenance implementation
against contracts/disclosure.md, contracts/crypto.md and contracts/apps.md. Write probes ONLY in new files under
tests/adversarial/disclosure/. Do not fix anything or edit any other file.
Attack ideas, minimum:
- A malicious agent page faking the vault UI or bridge.
- postMessage origin confusion; replaying an old disclosure answer into a new turn.
- Forcing more than 3 tool rounds; a query crafted to make selection return a different folder.
- Pseudonym linkage across two agents (timing, entry ids, txHash).
- A proposal bypassing quarantine via edit or confirm races; the instruction heuristic evaded with unicode
  look-alikes or zero-width characters.
- The disclosure log leaking plaintext into logs.
- The revoke race: revoke while a recall is in flight.
- The offline key-grant path still working, and not undermining Disclosure mode's guarantees for agents that
  never got a key grant.
Output a table: probe, file:line, input, expected per spec (cite the case), actual, severity. Then list spec gaps
and the probes that passed. Run every probe and include the raw pass/fail summary.
```
Then, for every confirmed bug (Gemini, a separate conversation):
```
For each confirmed finding in <paste table>: add a BUGLOG.md entry (Symptom / Root cause / Stage / Regression
case / Status), add a regression case in a NEW file under tests/golden/ that fails first, then fix the code until
it passes. Never edit existing golden files. Report the before/after test output.
```

## Prompt 7 (stretch): Interaction-grounded agent reputation
**Model: Claude Opus 4.6** - only if prompts 1-6 are done by about 2026-10-09.

```
ERC-8004 reputation fails as a trust signal: 60-90% of reviewers are Sybil and feedback is rarely tied to a real
interaction (arXiv 2606.26028). Our vault sees real, consented interactions: approvals, disclosures, revokes.
Design "grounded reputation" without breaking the pairwise privacy from Disclosure mode.
- Option A: the vault offers feedback only after N real disclosures to that agent. Feedback goes to the ERC-8004
  Reputation Registry from the pairwise address, with proof it came from an approved relationship.
- Option B: aggregate signals instead of reviews: retention (approval renewed or still active after 7 / 30 days)
  and early revoke rate, published in a privacy-preserving aggregate.
Compare Sybil cost, privacy leak and build time. Recommend one that can be built in 2 days, or recommend
skipping. Show it on the consent screen next to the agent's ERC-8004 identity. Contract cases first, then STOP.
```

## Prompt 8: Consent screen and disclosure log UI polish
**Model: Claude Opus 4.6** - design pass after prompt 3 lands.

```
Polish apps/vault and apps/agent for a 3-minute demo video. Keep the existing "archival ledger" language
(Instrument Serif + IBM Plex, ink-on-paper palette, see apps/vault/app/globals.css). Do not introduce a new
design system.
Demo moments that must read clearly at 1080p:
1. Consent screen: which agent (ERC-8004 identity, verified origin badge), what it asks for, and "it will never
   hold your memory; every read appears here".
2. Live disclosure log: animates in as Wayfarer reads entries, showing provenance chips.
3. Review inbox: Sage's proposed memory waits for confirm.
4. Revoke: one tap; the next Wayfarer reply says it no longer has access.
Write a short UI spec (states, copy, empty and error states) into contracts/apps.md as new V-cases first. STOP
for review, then implement in a second pass. Check accessibility: focus order, contrast AA, keyboard-only
consent.
```

## Prompt 10: Pre-submission review
**Model: Claude Opus 4.6** - around 2026-10-12, a fresh conversation.

```
Review the whole repo as a hackathon judge and as a security reviewer. Read HACKATHON_BRIEF.md and README.md.
Report:
(1) Every claim in README, docs/INTEGRATE.md and the pitch that the code does not actually back. Quote the claim
    and point to the missing code.
(2) Spec drift: contract cases whose implementation does not match. Run the suites and cite the cases.
(3) Demo risks: anything that can fail live (RPC limits, indexer lag, popup blockers, passkey prompts).
(4) Submission checklist gaps: deployed URLs, contract addresses, AI disclosure, third-party attribution,
    license, video links.
Do not edit code. Output a prioritized list with file:line references.
```
