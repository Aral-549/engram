# Engram

**Your AI memory, owned by you: encrypted with your passkey, stored on Monad, shared with each AI agent one
folder at a time, and revocable in one tap.**

Every AI app today keeps its own private copy of you. You re-explain your diet to the travel planner, your stack to
the coding assistant, and you cannot see, move or delete what any of them stored. Engram turns that around:

- **One memory, many agents.** Tell one agent you are vegetarian; every agent you approve already knows it.
- **Encrypted end to end.** Keys come from your passkey (WebAuthn PRF via Mera). Monad stores only ciphertext.
  No seed phrase, no extension, no server that can read your memory.
- **Per-folder, expiring grants to verified agents.** Agents are ERC-8004 identities. You grant one folder
  (`preferences`, `work`, ...), read or read-write, for a fixed time.
- **Revocation that actually works.** Revoking rotates the folder key onchain, so a revoked agent cannot read
  anything written afterwards, and the app gets `ACCESS_REVOKED` on its next request.
- **Gasless for users.** Your vault signs EIP-712 requests; a relayer pays gas. Agents pay for their own writes.

Built solo for the Monad Metropolis hackathon, Trust, Identity & AI Infrastructure track.

## Try it
| | |
|---|---|
| Vault | `<vault URL after deployment>` (locally: http://localhost:3100) |
| Sage (assistant, can save memories) | `<sage URL>` (locally: http://localhost:3201) |
| Wayfarer (trip planner, read-only) | `<wayfarer URL>` (locally: http://localhost:3202) |
| Demo video | `<link>` |

The demo flow: open Sage, click **Connect memory**, create a vault with your passkey and approve. Tell Sage
"I'm vegetarian and allergic to peanuts". It saves both onchain (you see the transactions). Open Wayfarer, connect
read-only: it plans a trip that already avoids peanuts. Revoke Wayfarer in the vault and it immediately forgets.

## How it works
```
 passkey (WebAuthn PRF)
        |  HKDF-SHA256
        v
 vault account key ---- folder keys (per label, per epoch)
        |                      |  AES-256-GCM, AAD binds chain/registry/owner/folder/epoch
        |                      v
        |              ciphertext entries  ---------->  MemoryRegistry on Monad  <---- agent writes (operator)
        |                      |                              |    ^
        | X25519 ECIES wrap of the folder key                 |    | grants, wraps, epochs
        v                      v                              v    |
  grant to ERC-8004 agent  (expiry, read | readwrite)   Envio HyperIndex -> GraphQL -> SDK (chain-verified)
```
- **`MemoryRegistry`** (Solidity): namespaces, append-only entries, grants with expiry and scope, key wraps, epoch
  rotation on revoke, a gasless EIP-712 relay, and ERC-8004-aware agent keys (a key set by a previous token holder is
  never trusted).
- **SDK** (`@engram/sdk`): `EngramOwner` (vault side: remember, recall, grant, revoke), `EngramAgent` (agent side:
  inbox, recall, remember), `connectEngram` (app-to-vault consent popup) and `verifyAppSession`. Every key wrap the
  indexer reports is checked against the transaction receipt before use, so a lying indexer cannot hand an agent a
  wrong key.
- **Indexer** (Envio HyperIndex): HyperSync for history and RPC for realtime. A transaction is queryable in 4-824 ms.
- **Vault app** (Next.js): passkey onboarding, a ledger of your memories with which agent wrote each one, grants,
  revoke, and the consent popup.
- **Agent kit** (`@engram/agent-kit`): the server side of an Engram-connected agent, with KIMI tool calling
  (`recall`, `remember`), app sessions, CSRF-safe routes, per-turn write caps and rate limits.
- **Demo agents** Sage and Wayfarer: one Next.js app, two personas, registered as ERC-8004 agents #1965 and #1966.

## Why Monad
Memory writes happen mid-conversation, and with 300 ms blocks and about 600 ms finality, saving a memory onchain
fits inside a chat reply: about 1.5-2.5 s from "I'm vegetarian" to a confirmed transaction (measured in the agent logs). Low fees make per-memory
writes and key rotation on every revoke affordable. Monad's EVM compatibility gives us ERC-8004, EIP-712 and
Multicall3 unchanged.

## Integrate your agent
Read [docs/INTEGRATE.md](docs/INTEGRATE.md): register with one script, add a connect button, verify the session
and call `recall`. That takes about 15 minutes. A ~90-line example with no LLM is in
[`examples/minimal-agent`](examples/minimal-agent/agent.ts).

## Deployments (Monad testnet, chain 10143)
| Contract | Address |
|---|---|
| MemoryRegistry | [`0x733d1Bf4DC13B721a2Ce3DDCFb444795eFF59d31`](https://testnet.monadvision.com/address/0x733d1Bf4DC13B721a2Ce3DDCFb444795eFF59d31) (block 67062103, Sourcify exact match) |
| ERC-8004 IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| Sage / Wayfarer | ERC-8004 agents #1965 / #1966 |

## Repository layout
| Path | What |
|---|---|
| `contracts/` | Specs: input to expected-output cases, written before code |
| `packages/crypto` | Key derivation, envelopes, entry encoding |
| `packages/sdk` | Owner, agent, connect, app sessions, data sources, relay |
| `packages/agent-kit` | Agent server: sessions, KIMI tool loop, request guard |
| `chain/` | `MemoryRegistry` (Foundry), deploy script, deployments |
| `indexer/` | Envio HyperIndex config, schema, handlers |
| `apps/vault` | Passkey vault and consent popup |
| `apps/agent` | Sage and Wayfarer demo agents |
| `examples/minimal-agent` | Smallest third-party integration |
| `scripts/` | Seed, latency probe, agent registration, local dev model |
| `tests/golden` | Frozen ground truth (crypto vectors from an independent Python implementation, spec cases) |
| `tests/adversarial` | Probes from separate adversarial review passes |
| `tests/integration`, `tests/e2e` | Real Monad testnet data; Playwright with a virtual passkey authenticator |
| `BUGLOG.md` | Every bug found, its root cause, and its permanent regression case |

## Run it locally
Requirements: Node 22+, Docker (for the indexer), [Foundry](https://getfoundry.sh), Chromium for e2e tests.
```bash
npm install
cd chain && forge install && forge build && cd ..
npm run -s build -w @engram/crypto -w @engram/sdk -w @engram/agent-kit

# 1. indexer (needs ENVIO_API_TOKEN in indexer/.env; see indexer/README.md)
cd indexer && npx envio codegen && npx envio dev && cd ..

# 2. vault: copy apps/vault/.env.example to .env.local, set RELAYER_PRIVATE_KEY (a funded testnet key)
npm run dev -w @engram/vault                      # http://localhost:3100

# 3. demo agents: register them (writes apps/agent/.env.assistant and .env.planner), then add KIMI_API_KEY
npx tsx scripts/register-agents.ts
npm run dev:assistant -w @engram/agent            # http://localhost:3201
npm run dev:planner -w @engram/agent              # http://localhost:3202
```
No KIMI key yet? `npx tsx scripts/dev-model.ts` starts a free, rule-based stand-in. Point `KIMI_BASE_URL` at
`http://127.0.0.1:8787/v1`. Its replies start with `[dev model]`.

## Tests
| Command | What |
|---|---|
| `npm test` | All unit, golden and adversarial suites (crypto, SDK, indexer, vault, agent kit) on a local anvil chain running the real bytecode |
| `npm run test:chain` | Registry golden, regression and adversarial tests (Foundry) |
| `cd indexer && npm run test:integration` | Indexer against real testnet data via HyperSync |
| `cd packages/agent-kit && INTEGRATION=1 npx vitest run` | Registers a real agent on testnet and reads granted memory through the example |
| `npm run test:e2e` | Browser end to end on testnet: passkey vault, consent popup, Sage and Wayfarer |

How the code was built: specs first (`contracts/`). Golden tests are written from the spec before the code and
are then frozen. A separate adversarial pass tries to break each module. Every bug it finds goes into `BUGLOG.md`
with a permanent regression test.

## Built during the hackathon
All code in this repository was written during the Metropolis build window (from 2026-10-01). No pre-existing code.

## Third-party code and services
- [@category-labs/mera](https://github.com/category-labs/mera) (MIT OR Apache-2.0): passkey PRF ceremonies, EVM address derivation
- [@noble/curves, @noble/hashes](https://github.com/paulmillr) (MIT): secp256k1, X25519, HKDF, SHA-256
- [viem](https://viem.sh) (MIT): Ethereum client
- [OpenZeppelin Contracts 5.6.1](https://github.com/OpenZeppelin/openzeppelin-contracts) (MIT): EIP712, ECDSA, IERC721
- [forge-std](https://github.com/foundry-rs/forge-std) (MIT OR Apache-2.0): Foundry test utilities
- [Envio HyperIndex](https://envio.dev) 3.12.1: indexer framework and HyperSync
- [Next.js](https://nextjs.org) and React (MIT): vault and agent apps
- [Playwright](https://playwright.dev) (Apache-2.0) and [Vitest](https://vitest.dev) (MIT): tests
- [KIMI by Moonshot AI](https://platform.moonshot.ai): the model behind the demo agents (OpenAI-compatible API)
- [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) IdentityRegistry deployment on Monad testnet
- Python reference for crypto vectors only: [pyca/cryptography](https://github.com/pyca/cryptography), [pycryptodome](https://github.com/Legrandin/pycryptodome)
- Fonts: Instrument Serif and IBM Plex (SIL Open Font License) via Google Fonts

## AI tool disclosure
This project was built with AI coding assistance, which the hackathon rules allow (section 4.1):
- **Claude Code (Anthropic, Claude Opus 5.5)** drafted the specs and wrote the implementation and tests. Separate
  Claude agent passes ran adversarial reviews of each module.
- Safeguards in the workflow:
  - Specs were written and reviewed before code.
  - Crypto golden vectors come from an independent implementation.
  - Tests are written from specs, not from code, and golden tests are frozen.
  - Every bug found has a regression test (`BUGLOG.md`).
- The product itself uses **KIMI (Moonshot AI)** as the model behind its demo agents.

## License
MIT, see [LICENSE](LICENSE).
