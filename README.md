# Engram

**Your AI memory, owned by you. Agents never hold your keys: they ask, and your personal vault answers with only what is relevant, auditing every read in real time. Passkey-secured, encrypted end-to-end, and powered by Monad.**

---

### The Problem

Every AI app today lives in an isolated silo. You find yourself constantly re-explaining your diet to the meal planner, your tech stack to the coding assistant, and your writing style to the editor. None of them communicate, and you have zero visibility into what any company actually stores about you.

When existing platforms try to build "shared memory", they almost always take a dangerous shortcut:
- They store your raw personal notes unencrypted on centralized servers, or
- They hand a full decryption key to every approved agent.

Once an agent has your key, it can read, copy, and cache your entire life story—and you'll never know what it inspected. If one third-party agent suffers a breach, your entire memory history leaks with it.

---

### The Engram Solution: Zero Key Sharing

Engram flips this model on its head. **Agents never receive your decryption keys.**

Instead, each agent communicates through a secure, lightweight vault bridge running locally on your device:

- 🎯 **Agents ask, your vault decides:** While you chat, the agent's page carries a small strip of your vault. For each prompt, your local vault inspects the query, selects *only* the specific memories relevant to that task from folders you approved, and hands over just those snippets. Asking Wayfarer *"Can you suggest a dinner spot?"* shares *"allergic to peanuts"*, never your financial notes or medical records.
- 🔍 **Every read is audited live:** The bridge strip shows reads as they happen. Your vault maintains a tamper-proof, encrypted audit log of every question asked and what memories were disclosed. An agent cannot covertly sweep your profile.
- ⚡ **Instant, one-tap revocation:** Revoking an agent takes a single click in the bridge strip. The vault immediately stops answering on the next message—no complex key rotation required for active sessions.
- 🛡️ **Anti-tracking across apps:** Each agent receives a distinct pseudonymous identity derived from your passkey. Two independent agents cannot cross-reference their logs to determine they are talking to the same user.
- 🧪 **Attributed, quarantined writes:** When an assistant like Sage learns something new (e.g., *"I'm vegetarian"*), it proposes the memory. Your vault encrypts and writes it to the chain, attributed to Sage. Other agents don't see unreviewed proposals, preventing malicious agents from poisoning your shared context.
- 🔑 **Passkey-native & completely gasless:** Everything is secured with WebAuthn PRF (Face ID, Touch ID, Windows Hello) via Mera. No seed phrases, no browser extensions. Monad stores only ciphertext, and sponsored relayers cover gas fees via EIP-712 meta-transactions.
- 🌙 **Optional scoped offline access:** For agents that genuinely need to perform background work while you are offline, you can grant scoped, time-expiring X25519 key wraps with explicit consent.

---

## Live Deployments

Engram is fully deployed and running live on **Monad Testnet** (Chain ID `10143`):

| Service | Live Link | Description |
|---|---|---|
| 🔐 **Engram Vault** | [hippo-plum.vercel.app](https://hippo-plum.vercel.app) | Your personal memory manager: create your vault, view encrypted records, inspect live reads, and manage agent permissions. |
| 🤖 **Sage** (Everyday Assistant) | [hippo-foio.vercel.app](https://hippo-foio.vercel.app) | Personal assistant that can recall your context and propose new memories. Registered as **ERC-8004 Agent #1965**. |
| 🧭 **Wayfarer** (Trip & Meal Planner) | [hippo-ntj5.vercel.app](https://hippo-ntj5.vercel.app) | Specialized travel agent with read-only access. Only receives context-relevant notes on demand. Registered as **ERC-8004 Agent #1966**. |
| ⚡ **Envio Hosted Indexer** | [HyperIndex GraphQL Playground](https://indexer.dev.hyperindex.xyz/e2892b1/v1/graphql) | Cloud-hosted indexer syncing Monad testnet blocks in real time with sub-second query performance. |
| 📜 **MemoryRegistry Contract** | [`0x733d1Bf4...59d31`](https://testnet.monadvision.com/address/0x733d1Bf4DC13B721a2Ce3DDCFb444795eFF59d31) | Monad testnet registry contract (block 67062103, verified on MonadVision). |
| 🪪 **IdentityRegistry** | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | Canonical ERC-8004 agent identity registry on Monad testnet. |

---

## Try It in 2 Minutes

Experience seamless, user-controlled memory across two independent agents:

1. **Open Sage** at [hippo-foio.vercel.app](https://hippo-foio.vercel.app) and click **Connect your memory**.
2. **Create your vault** using your device passkey (Touch ID, Face ID, or Windows Hello). You are onchain in seconds—no wallet setup or faucet tokens needed.
3. **Unlock the vault strip** that docks inside Sage.
4. **Teach Sage:** Type *"I'm vegetarian and allergic to peanuts."* The vault encrypts the memories and records them on Monad testnet. The live bridge strip shows each save in real time.
5. **Inspect transparency:** Ask *"What do you know about me?"* Sage requests an explicit full read, and the exact query appears in your vault's **Reads** log tab.
6. **Open Wayfarer** at [hippo-ntj5.vercel.app](https://hippo-ntj5.vercel.app) and connect your vault with read-only permissions.
7. **Notice selective disclosure:** Ask Wayfarer *"Plan dinner for tonight."* Wayfarer receives only the dietary restrictions—never your broader profile or other unrelated notes.
8. **Revoke access:** Click **Revoke** in the bridge strip. On the very next message, Wayfarer has zero access to your memories.

---

## Architecture & How It Works

```
 agent app page (Wayfarer)                              your vault (isolated origin)
 +-------------------------------------+                +-------------------------------------+
 | chat UI                             |  postMessage   | /bridge strip (passkey session)     |
 |  "plan dinner"  -- disclose(msg) -->|--------------->|  approved folders only              |
 |               <-- ["allergic to.."]-|<---------------|  select relevant, log the read      |
 |  POST /api/chat {messages, shown}   |                |  propose -> owner-signed write      |
 +----------------|--------------------+                +-----------------|-------------------+
                  v                                                         v
  agent server (agent-kit, no keys)                        MemoryRegistry on Monad (Chain 10143)
  KIMI tool loop; recall/remember                          - AES-256-GCM ciphertext entries
  come back to page as HMAC-sealed                         - Gasless EIP-712 relayer
  continuation tokens (120s TTL)                                            |
                                                                            v
                                                           Envio HyperIndex (GraphQL API)
                                                           - Real-time indexing (4-824 ms)
```

### Core Components

- **Cryptographic Engine (`@engram/crypto`):**
  - Passkey PRF generates high-entropy master seeds directly from WebAuthn hardware authenticators.
  - HKDF-SHA256 derives account keys, epoch-scoped folder keys, and pairwise agent identifiers.
  - AES-256-GCM encryption with Additional Authenticated Data (AAD) binds every ciphertext to chain ID, registry address, owner address, folder name, and key epoch.
- **Onchain Registry (`MemoryRegistry.sol`):**
  - Namespaced, append-only memory entries on Monad.
  - Gasless EIP-712 relay support for zero-friction user onboarding.
  - Native ERC-8004 integration, X25519 key wraps for offline delegation, and automatic epoch rotation on revoke.
- **Envio HyperIndex (`indexer/`):**
  - Cloud-hosted HyperIndex using HyperSync for historical blocks and RPC for real-time transactions.
  - Enables sub-second memory reads without hammering RPC providers.
- **Developer SDK (`@engram/sdk`):**
  - Vault tools: `EngramOwner`, `approve`, `disclose`, `propose`, `disclosures`, and `startBridge`.
  - Client application tools: `connectEngram`, `openVaultBridge`, and `verifyAppSession`.
- **Agent Framework (`@engram/agent-kit`):**
  - Robust agent backend supporting OpenAI/KIMI tool loops, HMAC-sealed continuation tokens, rate limiting, and the selective disclosure bridge.

---

## Why Monad?

AI memory writes happen in the middle of active user conversations. Waiting 15–30 seconds for standard blockchain block confirmations destroys conversational flow.

Monad's **10,000 TPS**, **300 ms block times**, and **~600 ms finality** make decentralized AI memory practical for the first time:
- **Fast confirmations:** From sending *"I'm vegetarian"* to an onchain confirmed transaction takes roughly **1.5 to 2.5 seconds**—completing well within an LLM's natural streaming reply window.
- **Micro-transaction affordability:** Extremely low gas fees mean that encrypting individual memories, writing attributed entries, and rotating keys upon revocation are completely feasible for everyday users.
- **Full EVM compatibility:** Leverages established standards including EIP-712, ERC-8004, and Multicall3 without compromises.

---

## Integrate Your Agent in 15 Minutes

Integrating Engram into any existing AI agent requires just a few lines of code.

### 1. Install Dependencies
```bash
npm install @engram/sdk @engram/agent-kit
```

### 2. Client Side: Add the Memory Connect Button
```typescript
import { connectEngram, openVaultBridge } from '@engram/sdk';

// Prompt the user to link their memory vault
const session = await connectEngram({
  vaultUrl: 'https://hippo-plum.vercel.app',
  agentId: 'my-agent',
  scope: 'read',
  folders: ['preferences', 'dietary']
});

// Dock the lightweight bridge strip on your chat page
openVaultBridge({
  vaultUrl: 'https://hippo-plum.vercel.app',
  containerId: 'engram-bridge-container'
});
```

### 3. Server Side: Query Context Selectively
```typescript
import { verifyAppSession, recall } from '@engram/agent-kit';

export async function handleChatMessage(req, res) {
  // Verify the active session token
  const userSession = verifyAppSession(req.headers['x-engram-session']);

  // Retrieve only what is relevant to the user's latest message
  const relevantMemories = await recall({
    session: userSession,
    query: req.body.message
  });

  // Inject memories into your prompt context
  const reply = await callLLM({
    systemPrompt: `User context:\n${relevantMemories.join('\n')}`,
    userMessage: req.body.message
  });

  res.json({ reply });
}
```

For complete step-by-step instructions, see the [Integration Guide](docs/INTEGRATE.md) and explore the working standalone [Minimal Agent Example](examples/minimal-agent/agent.ts).

---

## Repository Structure

```
├── apps/
│   ├── vault/               # Next.js passkey vault, consent dialog, and bridge strip
│   └── agent/               # Sage & Wayfarer demo agents (Next.js)
├── chain/                   # MemoryRegistry Solidity contracts (Foundry)
├── contracts/               # Formal behavioral specifications and test cases
├── docs/                    # Integration and deployment guides
├── examples/
│   └── minimal-agent/       # Clean, 90-line integration example
├── indexer/                 # Envio HyperIndex configuration, schema, and event handlers
├── packages/
│   ├── crypto/              # Passkey PRF derivation, AES-256-GCM, and envelopes
│   ├── sdk/                 # Client and owner SDKs for web and Node.js
│   └── agent-kit/           # Agent runtime, session guards, and KIMI tool loop
├── scripts/                 # Registration scripts, latency probes, and dev model
└── tests/                   # Comprehensive unit, golden, adversarial, and E2E suites
```

---

## Local Development

### Prerequisites
- Node.js 22+
- [Foundry](https://getfoundry.sh) (`forge`)
- Docker (optional, for local Envio indexing)

### Setup & Build
```bash
# 1. Install dependencies and compile contracts
npm install
cd chain && forge install && forge build && cd ..

# 2. Build local packages
npm run -s build -w @engram/crypto -w @engram/sdk -w @engram/agent-kit

# 3. Start the Vault application
# (Copy apps/vault/.env.example to apps/vault/.env.local and add RELAYER_PRIVATE_KEY)
npm run dev -w @engram/vault                       # http://localhost:3100

# 4. Start the Demo Agents
# (Run agent registration to configure .env files, then provide your KIMI_API_KEY)
npx tsx scripts/register-agents.ts
npm run dev:assistant -w @engram/agent             # http://localhost:3201 (Sage)
npm run dev:planner -w @engram/agent               # http://localhost:3202 (Wayfarer)
```

> **Tip:** Don't have a KIMI API key yet? Run `npx tsx scripts/dev-model.ts` to spin up a lightweight, zero-dependency local mock model on `http://127.0.0.1:8787/v1`.

---

## Testing & Verification

Engram maintains high testing standards across cryptographic primitives, smart contract safety, indexer reliability, and end-to-end user flows:

```bash
# Run all unit and golden test suites against a local Anvil instance
npm test

# Run Foundry contract tests (unit, fuzzing, and regression tests)
npm run test:chain

# Run Envio indexer tests against real Monad testnet blocks
cd indexer && npm run test:integration

# Run Playwright end-to-end browser tests with virtual WebAuthn authenticators
npm run test:e2e
```

- **Spec-driven development:** All contracts and protocols were specified in `contracts/` before implementation.
- **Cryptographic test vectors:** Golden test vectors in `tests/golden` are verified against independent reference implementations.
- **Security audits & fuzzing:** Automated fuzz testing and simulated adversarial scenarios ensure that quarantined writes and unverified delegations cannot bypass authorization.
- **Regression tracker:** Documented in [BUGLOG.md](BUGLOG.md), containing root causes and permanent regression tests for every bug encountered during development.

---

## Built With Open Standards

- **[Mera](https://github.com/category-labs/mera)** — WebAuthn PRF ceremony handling and deterministic key derivation.
- **[@noble/curves & @noble/hashes](https://github.com/paulmillr)** — Audited cryptographic primitives (secp256k1, X25519, HKDF, SHA-256).
- **[Envio HyperIndex](https://envio.dev)** — High-throughput blockchain data indexing with HyperSync.
- **[Foundry](https://getfoundry.sh)** — Fast, modular Ethereum development framework.
- **[OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts)** — Battle-tested ERC standards and EIP-712 implementations.
- **[Viem](https://viem.sh)** — Type-safe TypeScript interface for Ethereum.
- **[Next.js](https://nextjs.org)** & **React** — Fast, modern web applications.
- **[Playwright](https://playwright.dev)** & **Vitest** — Robust testing frameworks with WebAuthn virtual authenticator support.
- **[Moonshot AI (KIMI)](https://platform.moonshot.ai)** — Language model backing the Sage and Wayfarer conversational agents.
- **[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004)** — Onchain identity registration for autonomous AI agents.

---

## License

This project is open-source under the [MIT License](LICENSE).
