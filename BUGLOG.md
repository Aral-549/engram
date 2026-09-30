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
