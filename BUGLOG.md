# Bug Log

Every entry here must result in a permanent case added to `tests/golden/`
before it's marked resolved. A patched bug without a regression case is not
resolved -- it's just hidden until the next rewrite.

---

## 2026-10-01 -- B1: non-canonical agent X25519 key makes every wrap unopenable
- **Symptom:** `wrapNamespaceKey` succeeded for an agent public key with the top bit of byte 31 set (or a u+p encoding), but the agent's real private key then got `DECRYPT_FAILED` on unwrap.
- **Root cause:** X25519 masks the top bit and reduces mod p, so the shared secret matches, but the KEK salt used the raw public-key bytes on wrap and the canonical `getPublicKey(priv)` on unwrap. The spec did not require canonical keys, and `setAgentKeys` only rejected zero.
- **Stage/module:** crypto (envelope.ts wrap)
- **Regression case added:** `tests/golden/crypto/crypto.regressions.golden.test.ts` -- B1 (enforced in crypto wrap; the SDK validates before `setAgentKeys`. Not enforced onchain: frozen golden fixtures use such keys, changing them needs human approval)
- **Status:** fixed

## 2026-10-01 -- B2: parseEntry accepted documents over 2048 bytes
- **Symptom:** a 6000-byte entry (1500 emoji) or a valid entry padded with 2100 spaces parsed successfully.
- **Root cause:** only `encodeEntry` enforced the byte limit; `parseEntry` checked fields only.
- **Stage/module:** crypto (entry.ts)
- **Regression case added:** `tests/golden/crypto/crypto.regressions.golden.test.ts` -- B2
- **Status:** fixed

## 2026-10-01 -- B3: exhausted account candidates threw a plain Error
- **Symptom:** `deriveAccountWith(() => new Uint8Array(32))` threw `Error` without a `.code`.
- **Root cause:** fallback `throw new Error(...)` in derive.ts.
- **Stage/module:** crypto (derive.ts)
- **Regression case added:** `tests/golden/crypto/crypto.regressions.golden.test.ts` -- B3
- **Status:** fixed

## 2026-10-01 -- B4: encodeEntry could emit bytes parseEntry rejects (getter TOCTOU)
- **Symptom:** an entry object whose `kind` getter changed value between reads was validated as "fact" and serialized as "evil".
- **Root cause:** validation and serialization read the caller's object separately.
- **Stage/module:** crypto (entry.ts)
- **Regression case added:** `tests/golden/crypto/crypto.regressions.golden.test.ts` -- B4
- **Status:** fixed

## 2026-10-01 -- R1: relayed calldata executed was not byte-identical to the signed data
- **Symptom:** a signed `appendAsOwner` whose ciphertext length pointed past the end of `data` executed, storing 18 bytes of the appended owner address as ciphertext.
- **Root cause:** ERC-2771-style actor passing appended `owner` to the self-call, so ABI tails could read it.
- **Stage/module:** registry (relay/_actor)
- **Regression case added:** `tests/golden/registry/MemoryRegistry.regressions.golden.t.sol` -- case 40, 42
- **Status:** fixed

## 2026-10-01 -- R2: agent keys stayed valid after the ERC-8004 token changed hands
- **Symptom:** after transferring agent token 7, the previous operator could still append and new grants still wrapped to the previous X25519 key until the new holder called `setAgentKeys`.
- **Root cause:** keys were stored per agentId with no link to the current token holder.
- **Stage/module:** registry (setAgentKeys, grant, appendAsAgent)
- **Regression case added:** `tests/golden/registry/MemoryRegistry.regressions.golden.t.sol` -- cases 36, 37, 38
- **Status:** fixed

## 2026-10-01 -- B5: zeroing fix destroyed a caller's Node Buffer key (regression from B-series fix)
- **Symptom:** after `encryptEntry({ key: Buffer.from(nsKey) })`, the caller's key was all zeros, and a second `encryptEntry` with it silently encrypted under the zero key. Same for `decryptEntry`, and `deriveAccountWith` returned a view of a Buffer candidate.
- **Root cause:** `Buffer.prototype.slice()` returns a view, not a copy (unlike `Uint8Array.prototype.slice`). The fix zeroed that "copy", i.e. the caller's memory. Found by the second adversarial pass.
- **Stage/module:** crypto (envelope.ts aesGcm, derive.ts)
- **Regression case added:** `tests/golden/crypto/crypto.regressions2.golden.test.ts` -- B5
- **Status:** fixed

## 2026-10-01 -- R3: rotation could re-key an agent whose ERC-8004 token changed hands
- **Symptom:** after agent 9's token was transferred, `rotate(N, [7, 9], ...)` succeeded and emitted `KeyWrapped` for 9, and an SDK wrapping to `agentKeysOf(9)` would give the new epoch key to the previous holder's X25519 key.
- **Root cause:** R2 gated `grant`/`appendAsAgent` on current keys but `_rotate` only pruned expired grants. Also `_keysCurrent` used try/catch, which does not catch malformed `ownerOf` returndata (grant reverted with empty data).
- **Stage/module:** registry (_rotate, _keysCurrent)
- **Regression case added:** `tests/golden/registry/MemoryRegistry.regressions2.golden.t.sol` -- cases 43, 44
- **Status:** fixed

## 2026-10-01 -- B6: inputs validated and used from different reads (third adversarial pass)
- **Symptom:** (a) zeroing `plaintext` or a supplied `nonce` right after calling `encryptEntry` (before awaiting) produced an envelope of the zeroed bytes; a length-tracking view over a resizable buffer grown after the call produced a 4029-byte envelope (> 2077 max). (b) a Uint8Array subclass whose `length` getter claims 32 while holding 16 bytes passed validation and encrypted under a 128-bit key; a 31-byte `deriveAccountWith` candidate threw a noble error instead of `EngramCryptoError`.
- **Root cause:** inputs were copied after `await importKey`, and `assertBytes` trusted the `.length` getter while the copy used the real bytes. Parameters like `p.key` were read more than once.
- **Stage/module:** crypto (encoding.ts, envelope.ts, derive.ts)
- **Regression case added:** `tests/golden/crypto/crypto.regressions3.golden.test.ts` -- B6
- **Status:** fixed

## 2026-10-01 -- I1: indexer took tokenOwner from ERC-8004 Registered, which can be stale
- **Symptom:** a contract wallet that transfers its freshly minted agent token (or sets keys, then transfers) inside the ERC-721 receiver callback ends up indexed with tokenOwner = the minter and keysCurrent = true, while onchain `hasCurrentKeys` is false.
- **Root cause:** the IdentityRegistry emits `Registered(owner)` after `_safeMint` (live receipt: Transfer at logIndex 43, Registered at 45), so `owner` can be stale; the Registered handler overwrote tokenOwner with it.
- **Stage/module:** indexer (handlers/IdentityRegistry.ts)
- **Regression case added:** `tests/golden/indexer/indexer.regressions.golden.test.ts` -- cases 16, 17
- **Status:** fixed

## 2026-10-01 -- I2: EntryAppended did not check seq against nextSeq
- **Symptom:** a duplicate EntryAppended seq double-counted Owner.entryCount and DailyStat.entries with no IndexerError; a seq gap was accepted silently.
- **Root cause:** no invariant check that seq == Namespace.nextSeq (the contract guarantees it).
- **Stage/module:** indexer (handlers/MemoryRegistry.ts)
- **Regression case added:** `tests/golden/indexer/indexer.regressions.golden.test.ts` -- cases 18-23
- **Status:** fixed

## 2026-10-01 -- V-UI1: "Unlock and approve" in the consent popup unlocked but never granted
- **Symptom:** in the connect popup, clicking "Unlock and approve" completed the passkey ceremony, then returned to the review screen without granting (found by the browser e2e test).
- **Root cause:** `approve()` called `signIn()` and then `run()`, but `run` was a closure over the React `session` state captured before sign-in (null), so it returned immediately.
- **Stage/module:** vault (components/SessionProvider.tsx)
- **Regression case added:** `tests/e2e/vault.e2e.spec.ts` step 3 (consent grant straight after unlock). UI flow, so the regression lives in the e2e suite rather than tests/golden.
- **Status:** fixed

## 2026-10-01 -- V-UI2: a new memory could stay invisible after saving
- **Symptom:** after "Remember" succeeded (both relayed txs confirmed), the memory list stayed empty until a manual refresh (found while scripting screenshots; the first e2e run passed by timing luck).
- **Root cause:** the vault re-read immediately; the indexer trails the chain by up to ~1 s, so recall returned `complete: false` with no entries. `discoverLabels` then dropped the well-known namespace (no readable entries), so the "wait until every namespace is complete" check passed vacuously.
- **Stage/module:** vault (components/Dashboard.tsx), indexer lag at the SDK source boundary
- **Regression case added:** `tests/e2e/vault.e2e.spec.ts` step 1 waits for the saved card without reloading; the vault now re-reads until the SDK reports every namespace complete (`untilSettled`), and discovery keeps incomplete namespaces; golden V1 re-run.
- **Status:** fixed

## 2026-10-01 -- V-RPC1: vault access panel failed intermittently under public RPC rate limits
- **Symptom:** "Who can read it" showed "Something went wrong" in 2 of 3 e2e runs; the SDK logged `grants` UNEXPECTED `ContractFunctionExecutionError` after ~160 ms.
- **Root cause:** discovery plus `grants()` fire many parallel `eth_call`s; Monad's public RPC throttles bursts and viem surfaces the transport failure as `ContractFunctionExecutionError`.
- **Stage/module:** sdk (config.ts client setup) at the chain boundary
- **Regression case added:** `tests/e2e/vault.e2e.spec.ts` (run 3x after the fix). Reads on known Monad chains are now batched through Multicall3 with retry + backoff; unexpected SDK errors now log their class name.
- **Status:** fixed

## 2026-10-01 -- S1: agents trusted any wrap a source supplied (key injection / exfiltration)
- **Symptom:** a source that appended a wrap made with only the agent's public key made `agent.remember` encrypt the user's data under an attacker key, and `agent.recall` return attacker-written "memories".
- **Root cause:** X25519 wraps authenticate nothing about who made them; the agent accepted every wrap that decrypted.
- **Stage/module:** sdk (agent.ts) at the source boundary; indexer lacked txHash/logIndex for wraps
- **Regression case added:** `tests/golden/sdk/sdk.regressions.golden.test.ts` -- case 28; `tests/golden/indexer/indexer.regressions2.golden.test.ts` -- case 24
- **Status:** fixed

## 2026-10-01 -- S2: owner trusted the relayer's txHash without checking the effect
- **Symptom:** a relayer replaying an old grant txHash made `revoke` report success while the agent stayed active; replaying another owner's append made `remember` return that owner's seq.
- **Root cause:** receipts were not checked for emitter, owner, namespace, or the expected event.
- **Stage/module:** sdk (owner.ts relay path)
- **Regression case added:** `tests/golden/sdk/sdk.regressions.golden.test.ts` -- case 29
- **Status:** fixed

## 2026-10-01 -- S3: a grantee with an unwrappable key blocked all revocation in a namespace
- **Symptom:** after a grantee (still token holder) set a low-order or non-canonical X25519 key, `revoke`/`rotate` of any agent failed (re-wrap threw).
- **Root cause:** the keep set had to include every live grantee, and wrapping that grantee's key is impossible.
- **Stage/module:** sdk (owner.ts rotateWith)
- **Regression case added:** `tests/golden/sdk/sdk.regressions.golden.test.ts` -- case 30
- **Status:** fixed

## 2026-10-01 -- S4: forged-signature relay traffic exhausted a victim's per-owner rate limit
- **Symptom:** 30 requests with garbage signatures naming owner O made O's real call fail with 429.
- **Root cause:** the per-owner bucket was charged before signature verification.
- **Stage/module:** sdk (relay.ts handler)
- **Regression case added:** `tests/golden/sdk/sdk.regressions.golden.test.ts` -- case 31
- **Status:** fixed

## 2026-10-01 -- S5: session state and scoping holes
- **Symptom:** (a) a call in flight when `end()` ran still wrote, or recall decrypted with a zeroed PRF; (b) stepping the clock back extended the 60 s prompt-free grant window; (c) `JSON.stringify(session)` exposed the PRF and `inspect(agent)` the X25519 private key.
- **Root cause:** no liveness check after awaits; window used a signed difference; secrets were plain enumerable fields.
- **Stage/module:** sdk (owner.ts, agent.ts)
- **Regression case added:** `tests/golden/sdk/sdk.regressions.golden.test.ts` -- cases 32, 33, 42
- **Status:** fixed

## 2026-10-01 -- S6: keep-set and grantee-limit edge cases
- **Symptom:** (a) revoking while another grantee expired in the executing block failed twice; (b) a 17th grant failed even though one of 16 grantees had expired.
- **Root cause:** keep set computed with zero margin; no prune before adding a 17th grantee.
- **Stage/module:** sdk (owner.ts)
- **Regression case added:** `tests/golden/sdk/sdk.regressions.golden.test.ts` -- cases 34, 35
- **Status:** fixed

## 2026-10-01 -- S7: input validation, typed errors, and source robustness
- **Symptom:** raw errors or hangs instead of typed errors: agentId out of uint256 range, agent remember with invalid text or a non-operator wallet, relay handler throwing on array owner or RPC down, graphql partial data accepted, non-advancing page cursor looping, logs source reading a cached head, negative seq returned, malformed popup replies rejecting instead of being ignored, malformed agent card throwing, connectEngram throwing synchronously.
- **Root cause:** missing validation at each boundary.
- **Stage/module:** sdk (agent.ts, relay.ts, sources.ts, connect.ts, owner.ts)
- **Regression case added:** `tests/golden/sdk/sdk.regressions.golden.test.ts` -- cases 36-41
- **Status:** fixed

## 2026-10-01 -- V-UI3: agent app page crashed after the first chat message
- **Symptom:** after sending a message, Sage and Wayfarer showed "This page couldn't load" (found by the agent-app browser e2e); the server had already saved the memories.
- **Root cause:** `useEffect(() => el?.scrollIntoView(...))` returned the call's value; current Chromium returns a Promise from `scrollIntoView`, which React treated as a cleanup function ("destroy is not a function").
- **Stage/module:** agent app (apps/agent/app/page.tsx)
- **Regression case added:** `tests/e2e/agents.e2e.spec.ts` (chat after connect). UI flow, so the regression lives in the e2e suite.
- **Status:** fixed

## 2026-10-01 -- V-UI4: an agent could miss memories saved seconds earlier
- **Symptom:** right after Sage saved two facts, "What do you know about me?" answered without them (found by the agent-app browser e2e).
- **Root cause:** the agent read through the indexer while it trailed the chain; recall correctly reported `complete: false`, but agent-kit used the partial result.
- **Stage/module:** agent-kit (readMemory) at the SDK source boundary
- **Regression case added:** `tests/golden/agent-kit/agent-kit.lag.golden.test.ts` -- case A10
- **Status:** fixed

## 2026-10-01 -- G1: login CSRF on the agent apps' /api/session (high)
- **Symptom:** a cross-site `text/plain` form POST could set the victim's session cookie to an attacker's proof, so Sage would save the victim's statements into the attacker's namespace.
- **Root cause:** no Origin or content-type check; `req.json()` parses text bodies; cookie was SameSite=Lax; body cap relied on content-length.
- **Stage/module:** agent app routes (apps/agent/app/api/*)
- **Regression case added:** `tests/golden/agent-kit/agent-kit.regressions.golden.test.ts` -- A17 (request guard)
- **Status:** fixed

## 2026-10-01 -- G2..G8: agent server budget, access, and robustness gaps
- **Symptom:** (G2) one model message caused 12 onchain writes, 15 recalls/round caused 46 source reads; (G3) recall tool results reached the model outside `<user_memory>`; (G4) any self-signed identity with no grant could chat on the KIMI key, no rate limit; (G5) each chat scanned every owner's grants; (G6) a source outage threw a raw 500 and saves made before a model failure were not shown; (G7) `tool_calls: [null]` crashed the turn and 500-emoji text passed validation but could not be stored; (G8) cookies carried arbitrary proof padding (133 KB) and a non-exact APP_ORIGIN silently rejected every session.
- **Root cause:** missing caps, access precondition, scoped lookup, error contract, and input normalization.
- **Stage/module:** agent-kit (packages/agent-kit/src/index.ts), agent app client
- **Regression case added:** `tests/golden/agent-kit/agent-kit.regressions.golden.test.ts` -- A11-A16
- **Status:** fixed

## 2026-10-02 -- K1: register-agent funded the operator again on every rerun
- **Symptom:** rerunning `scripts/register-agent.ts --fund 0.05` logged `operator-funded` again (found by the real-testnet integration test).
- **Root cause:** the top-up threshold was a fixed 0.1 MON; any `--fund` below 0.1 leaves the balance under it forever. The contract specified the fixed threshold, so the spec was wrong too.
- **Stage/module:** scripts/register-agent.ts (funding step); contracts/integration.md case 2
- **Regression case added:** `tests/golden/integration/register-agent.golden.test.ts` -- case 9
- **Status:** fixed

## 2026-10-02 -- H1: one owner could exhaust the agent's global chat budget
- **Symptom:** with limits 5/owner and 20 global, owner A sending 30 chats made owner B's first chat return 429 (adversarial probe `global-budget-burn`).
- **Root cause:** the global bucket was charged before the per-owner check, so A's refused requests still consumed global slots.
- **Stage/module:** agent-kit `chat()` rate limiting
- **Regression case added:** `tests/golden/agent-kit/agent-kit.hardening.golden.test.ts` -- case A18
- **Status:** fixed

## 2026-10-02 -- H2: an incomplete namespace stalled every recall tool call
- **Symptom:** a source that never reports `complete` made one turn take ~9.3 s (initial read plus two recall tool calls, each waiting ~3 s).
- **Root cause:** the A10 lag retry ran on every read, not just the first of the turn.
- **Stage/module:** agent-kit `recallFresh`
- **Regression case added:** `tests/golden/agent-kit/agent-kit.hardening.golden.test.ts` -- case A19
- **Status:** fixed

## 2026-10-02 -- H3: guardRequest accepted content types that only start with application/json
- **Symptom:** `application/jsonp` and `application/json-seq` passed the JSON-only check.
- **Root cause:** prefix match instead of comparing the media type. (Origin check still blocked cross-site posts.)
- **Stage/module:** agent-kit `guardRequest`
- **Regression case added:** `tests/golden/agent-kit/agent-kit.hardening.golden.test.ts` -- case A20
- **Status:** fixed

## 2026-10-02 -- D-1: Disclosure reads could miss a memory saved a moment earlier
- **Symptom:** found while designing the Disclosure e2e: `disclose` read folders through the indexer, which trails the chain by ~1 s, so a proposal written just before the next message would be absent from the answer.
- **Root cause:** the A10 bounded re-read existed in the agent server (offline mode) but not in the vault's `disclose`.
- **Stage/module:** sdk `OwnerSession.disclose`
- **Regression case added:** `tests/golden/disclosure/disclosure.lag.golden.test.ts` -- D29
- **Status:** fixed

## 2026-10-02 -- D-2: selection tokenizer would split Devanagari words
- **Symptom:** the drafted rule split on characters outside `\p{L}\p{N}`, which cuts Hindi words at every vowel sign (combining marks), so "शाकाहारी" could never match itself.
- **Root cause:** spec defect (contracts/disclosure.md selection rule 1), caught before implementation.
- **Stage/module:** sdk `select.ts` / contract
- **Regression case added:** `tests/golden/disclosure/selection.golden.test.ts` -- "normalises with NFKC ... non-Latin scripts"
- **Status:** fixed

## 2026-10-02 -- D-3: a revoke could be undone by indexer lag
- **Symptom:** in the Disclosure e2e, after revoking Wayfarer in the bridge strip, the next message was still answered as approved (`revoked:false` in the agent log).
- **Root cause:** when the 3 s policy cache expired, `loadPolicies` replaced it wholesale with a fresh read from the indexer, which had not indexed the revoke yet, so the older active policy came back.
- **Stage/module:** sdk `OwnerSession.loadPolicies`
- **Regression case added:** `tests/golden/disclosure/disclosure.revoke-lag.golden.test.ts` -- D30
- **Status:** fixed

## 2026-10-02 -- DA-1..DA-9: Disclosure-mode adversarial review (commit 4871ef4)
Found by a separate adversarial pass (probes in tests/adversarial/disclosure/ and tests/adversarial/agent-kit/agent-kit.disclosure.adversarial.test.ts).
- **DA-1 (high):** an offline agent's v1 `appendAsAgent` entry was disclosed to other agents as `by: "owner"` (quarantine bypass, cross-agent poisoning). Root cause: v1 candidates ignored `byOwner`. Case D31.
- **DA-2 (high):** an agent-appended v2 entry could forge `src.agent`, impersonating another agent in disclosures and the ledger. Root cause: `src` trusted without `byOwner`. Case D32.
- **DA-3 (high):** the `propose` receipt and the disclosure connect reply carried a txHash whose `relay(owner, ...)` calldata names the real owner, defeating pairwise ids. Case D33.
- **DA-4 (high):** one log relay per read let an approved agent drain the owner's relay budget and block revoke. Case D34, D35.
- **DA-5 (medium):** `continue` was not rate-limited and continuations could be replayed for 120 s. Case A25.
- **DA-6 (medium):** concurrent approve/disapprove could leave the agent approved. Case D36.
- **DA-7 (medium):** 96 KB continuation cap made mid-length chats lose tools (413). Case A26.
- **DA-8 (medium):** a log write right after each read let a single agent link its pairwise id to the owner by timing. Mitigated (batched, delayed logs), not eliminated. Case D35.
- **DA-9 (low):** continuations were readable base64 (system prompt, state). Case A27.
- Gaps fixed alongside: unbounded log queue (D35), lost first bridge request before hydration (D38), reserved labels in grant and custom folders (D37).
- **Stage/module:** sdk owner/bridge/connect, crypto entry2, agent-kit disclosure engine, vault, agent app
- **Regression cases added:** `tests/golden/disclosure/disclosure.review.golden.test.ts`, `tests/golden/crypto/crypto.v2-logs.golden.test.ts`, `tests/golden/agent-kit/agent-kit.disclosure-review.golden.test.ts`
- **Status:** fixed (DA-8 mitigated: logs batched and delayed 10-20 s; timing linkability reduced, not eliminated)
