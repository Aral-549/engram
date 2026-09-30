# Engram -- specs index and architecture

Working name: **Engram** (placeholder, rename freely). A user-owned, passkey-encrypted AI memory layer on Monad.

> Note on folder names: per AGENTS.md, `contracts/` holds **specs**. Solidity lives in `chain/`.

## One-paragraph pitch
Every AI app today keeps its own copy of what it knows about you, locked in its own database. Engram
lets the user own that memory instead: memory entries are encrypted client-side with keys derived from
the user's passkey (Mera PRF), written to Monad as ciphertext, and shared with specific AI agents
(registered in ERC-8004) through per-namespace, expiring, revocable key grants. Any app can read what the
user allowed; no app, and no Engram server, can read anything else.

## Components and pipeline stages

```
 [passkey] --PRF--> (1) crypto ----> (2) sdk ----> (3) relayer ----> (4) MemoryRegistry (Monad)
                         ^             |                                     |
                         |             v                                     v events
                         |        (6) apps  <---- (2) sdk <---- (5) indexer (Envio HyperIndex)
                         |      vault / assistant / planner
                         +--- agents decrypt with their X25519 key, call KIMI
```

| # | Stage | Spec | Code location |
|---|---|---|---|
| 1 | Key derivation + encryption envelopes | [crypto.md](crypto.md) | `packages/crypto` |
| 2 | SDK (owner, app-client, agent) | [sdk.md](sdk.md) | `packages/sdk` |
| 3 | Gasless relayer | [apps.md](apps.md#relayer) | `apps/vault` API route |
| 4 | Onchain registry | [memory-registry.md](memory-registry.md) | `chain/` (Foundry) |
| 5 | Indexer | [indexer.md](indexer.md) | `indexer/` (Envio) |
| 6 | Vault app + two KIMI demo agents | [apps.md](apps.md) | `apps/*` |

Every stage boundary logs structured JSON (`stage`, `op`, `input`, `output`, `durationMs`, `traceId`),
never plaintext memory or key material. See each spec's "Logging" section.

## Trust model (what judges will probe)
- **Nobody but the owner and granted agents can read memory.** Chain, indexer, relayer and storage see
  only ciphertext and opaque namespace IDs.
- **Everything reconstructs from the passkey alone.** No secret is stored anywhere (stateless test).
- **Revocation is forward-only.** Revoking rotates the namespace key; the revoked agent cannot decrypt
  anything written afterwards and can no longer write. It keeps whatever it already decrypted. No
  system can un-share data, and we say so in the UI.
- **Read-expiry is enforced at the next rotation**, not instantly (the agent already holds the epoch key).
  Write-expiry is enforced by the contract immediately.
- **Granted agents send memory to their model provider.** The consent screen names the provider (Moonshot/KIMI).
- **The vault domain is the passkey rpId.** Passkeys are domain-bound, so all apps connect through one
  vault origin (static, no backend secrets, self-hostable). This is a real dependency and is documented.

## Networks
Monad testnet (chain 10143) is the primary target. Optional mainnet (143) deploy at the end.
ERC-8004 IdentityRegistry: testnet `0x8004A818BFB912233c491871b3d84c89A494BD9e` (verified: name() = "AgentIdentity"),
mainnet `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`.

## Bounties targeted
Trust, Identity & AI Infrastructure track; Mera "One Passkey, Many Keys"; Mera-Powered UX; KIMI; Envio.

## Open decisions (need human answer before implementation)
1. Project name.
2. Gasless relayer (recommended, needed for Mera UX "time to first tx") -- yes/no.
3. Hosting for the three apps (Vercel recommended; needs your account).
4. Which PRF-capable authenticator you will develop and demo with (1Password or iCloud Keychain are
   Mera's recommended first choices; Linux Chrome support must be checked on your machine).

## Status
- [x] Drafted
- [ ] Reviewed by a human
- [ ] Implementation matches these contracts
- [ ] Golden tests exist for every behavior case
