# Engram

Personal AI memory that you actually own. AI agents never hold your decryption keys. Instead, they ask questions and your local vault answers with only what is relevant, auditing every read in real time. Everything is encrypted with your passkey, anchored on Monad, and revocable in one tap.

---

## Live Deployments

You can test the full system live on Monad Testnet right now.

* **Engram Vault** ([hippo-plum.vercel.app](https://hippo-plum.vercel.app))
  Your personal memory manager. Create your vault using Face ID or Touch ID, view encrypted records, inspect live read logs, and manage connected agents.

* **Sage Everyday Assistant** ([hippo-foio.vercel.app](https://hippo-foio.vercel.app))
  A general assistant that remembers your preferences, recalls context, and proposes new memories. Registered as ERC-8004 Agent 1965.

* **Wayfarer Trip and Meal Planner** ([hippo-ntj5.vercel.app](https://hippo-ntj5.vercel.app))
  A specialized travel assistant with read only access. It receives only context relevant notes on demand. Registered as ERC-8004 Agent 1966.

* **Envio Hosted Indexer** ([HyperIndex GraphQL Playground](https://indexer.dev.hyperindex.xyz/e2892b1/v1/graphql))
  A cloud hosted indexer syncing Monad testnet blocks in real time with sub second query speeds.

* **MemoryRegistry Contract** ([0x733d1Bf4...59d31](https://testnet.monadvision.com/address/0x733d1Bf4DC13B721a2Ce3DDCFb444795eFF59d31))
  The core registry contract deployed on Monad testnet at block 67062103, verified on MonadVision.

* **IdentityRegistry Contract**
  The canonical ERC-8004 agent registry at `0x8004A818BFB912233c491871b3d84c89A494BD9e` on Monad testnet.

---

## PS 32

> The evolution of the internet is creating new possibilities around ownership, identity, trust, value, and how people interact with digital systems. Identify a real world problem, emerging challenge, or unexplored opportunity within the Web3 ecosystem and develop an innovative technology driven solution. Participants are encouraged to challenge existing assumptions, rethink how digital ownership and trust work, and explore ideas that can create meaningful value for users, businesses, or communities. The problem, approach, technology, and solution are entirely open ended. Think beyond existing Web3 applications. Innovation is the priority. Reimagine what is possible.

### Rethinking Digital Ownership and Trust for AI

As AI agents become our daily assistants, researchers, and copilots, our relationship with digital identity and personal data changes completely. Right now, every AI service operates as an isolated walled garden. You spend your day re-explaining your dietary needs to the food planner, your preferred coding patterns to the IDE, and your personal tone to the writing assistant. They do not talk to each other, and you have zero visibility into what they store.

When existing platforms try to solve this with shared memory, they usually take a dangerous shortcut. They either dump your private notes onto centralized servers in plain text, or hand full decryption keys to every third party bot. Once an agent gets your key, it can copy your entire history, and you have no way to know what it looked at. If one agent gets compromised, your entire digital life leaks with it.

Engram challenges the fundamental assumption that an agent needs to possess your data to be useful. By combining passkey hardware security with Monad high speed execution and selective disclosure, Engram makes personal data sovereign, transparent, and private by default.

---

## How Engram Works and Why Selective Disclosure Matters

Engram flips the traditional model on its head. Agents never receive your decryption keys.

Instead, each agent communicates through a secure, lightweight vault bridge running locally on your device.

* **Agents ask, your vault decides**
  When you chat with an agent, its page embeds a small bridge from your vault. For every prompt you send, your local vault examines the query on your device, selects only the specific facts relevant to that task, and shares just those snippets. When you ask Wayfarer for dinner recommendations, it only gets your peanut allergy, not your financial notes or medical records.

* **Every read is visible in real time**
  The bridge strip displays reads as they happen. Your vault maintains an encrypted audit log of every question asked and what memories were disclosed. An agent cannot quietly scan your profile in the background.

* **Instant one tap revocation**
  Revoking an agent takes a single click in the bridge. Your vault immediately stops answering on the next message, with no awkward key rotations or cleanups required.

* **Anti tracking across applications**
  Every agent sees a unique pseudonymous identity derived from your passkey. Two independent agents cannot cross reference their databases to figure out they are talking to the same person.

* **Attributed and quarantined writes**
  When an assistant like Sage learns something new, such as a vegetarian diet, it proposes the memory. Your vault encrypts and writes it to the chain, attributed to Sage. Other agents cannot see unreviewed proposals, preventing malicious agents from poisoning your shared context.

* **Passkey native and gasless**
  Authentication uses WebAuthn PRF through Touch ID, Face ID, or Windows Hello via Mera. You never need seed phrases or browser extensions. Monad stores only ciphertext, and sponsored relayers cover gas costs using EIP-712 signatures.

* **Scoped offline access when you want it**
  If you have an autonomous agent that needs to run while you are offline, you can grant it a scoped, time limited X25519 key wrap with your explicit consent.

---

## Try It in 2 Minutes

Experience seamless, user controlled memory across two independent agents.

1. Open Sage at [hippo-foio.vercel.app](https://hippo-foio.vercel.app) and click Connect your memory.
2. Create your vault using your device passkey with Touch ID, Face ID, or Windows Hello. You are onchain in seconds with no wallet setup or faucet tokens needed.
3. Unlock the vault strip docked inside Sage.
4. Teach Sage by saying "I am vegetarian and allergic to peanuts." The vault encrypts the memories and records them on Monad testnet. The live bridge strip shows each save in real time.
5. Inspect transparency by asking "What do you know about me?" Sage requests an explicit full read, and the exact query appears in your vault Reads log tab.
6. Open Wayfarer at [hippo-ntj5.vercel.app](https://hippo-ntj5.vercel.app) and connect your vault with read only permissions.
7. Test selective disclosure by asking Wayfarer "Plan dinner for tonight." Wayfarer receives only the dietary restrictions, never your broader profile or other unrelated notes.
8. Click Revoke in the bridge strip. On the very next message, Wayfarer has zero access to your memories.

---

## Architecture and Data Flow

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

* **Cryptographic Engine (`@engram/crypto`)**
  Generates high entropy master seeds directly from WebAuthn hardware authenticators. HKDF-SHA256 derives account keys, epoch scoped folder keys, and pairwise agent identifiers. AES-256-GCM authenticated encryption binds every ciphertext to chain ID, registry address, owner address, folder name, and key epoch.

* **Onchain Registry (`MemoryRegistry.sol`)**
  Stores namespaced, append only memory entries on Monad. Includes gasless EIP-712 relay support, native ERC-8004 agent key support, X25519 key wraps for offline delegation, and automatic epoch rotation upon revocation.

* **Envio HyperIndex (`indexer/`)**
  Cloud hosted HyperIndex using HyperSync for historical blocks and RPC for real time transactions. It enables sub second memory reads without rate limiting.

* **Developer SDK (`@engram/sdk`)**
  Provides clean interfaces for vault operations such as approve, disclose, propose, and startBridge, alongside client application utilities like connectEngram and verifyAppSession.

* **Agent Framework (`@engram/agent-kit`)**
  A lightweight backend framework supporting OpenAI and KIMI tool loops, HMAC-sealed continuation tokens, rate limiting, and the selective disclosure bridge.

---

## Why Monad?

AI memory writes happen in the middle of active user conversations. Waiting fifteen to thirty seconds for a standard blockchain block confirmation destroys conversational flow.

Monad offers 10,000 TPS, 300 ms block times, and roughly 600 ms finality. That makes decentralized AI memory practical for everyday use.

* **Fast confirmations**
  From sending "I am vegetarian" to a confirmed onchain transaction takes roughly 1.5 to 2.5 seconds, which completes comfortably within an LLM streaming response window.

* **Micro-transaction affordability**
  Extremely low gas fees mean that encrypting individual memories, writing attributed entries, and rotating keys upon revocation cost negligible amounts.

* **Full EVM compatibility**
  Takes advantage of established standards including EIP-712, ERC-8004, and Multicall3 without requiring specialized adapters.

---

## Integrate Your Agent in 15 Minutes

Integrating Engram into any existing AI agent requires just a few lines of code.

### 1. Install Dependencies
```bash
npm install @engram/sdk @engram/agent-kit
```

### 2. Client Side, Add the Memory Connect Button
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

### 3. Server Side, Query Context Selectively
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

For complete step by step instructions, see the [Integration Guide](docs/INTEGRATE.md) and check out the standalone [Minimal Agent Example](examples/minimal-agent/agent.ts).

---

## Repository Structure

```
├── apps/
│   ├── vault/               # Next.js passkey vault, consent dialog, and bridge strip
│   └── agent/               # Sage and Wayfarer demo agents (Next.js)
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
* Node.js 22+
* [Foundry](https://getfoundry.sh) (`forge`)
* Docker (optional, for local Envio indexing)

### Setup and Build
```bash
# 1. Install dependencies and compile contracts
npm install
cd chain && forge install && forge build && cd ..

# 2. Build local packages
npm run -s build -w @engram/crypto -w @engram/sdk -w @engram/agent-kit

# 3. Start the Vault application
# Copy apps/vault/.env.example to apps/vault/.env.local and add RELAYER_PRIVATE_KEY
npm run dev -w @engram/vault                       # http://localhost:3100

# 4. Start the Demo Agents
# Run agent registration to configure env files, then provide your KIMI_API_KEY
npx tsx scripts/register-agents.ts
npm run dev:assistant -w @engram/agent             # http://localhost:3201 (Sage)
npm run dev:planner -w @engram/agent               # http://localhost:3202 (Wayfarer)
```

If you do not have a KIMI API key yet, run `npx tsx scripts/dev-model.ts` to spin up a local mock model on `http://127.0.0.1:8787/v1`.

---

## Testing and Verification

Engram maintains high testing standards across cryptographic primitives, smart contract safety, indexer reliability, and end-to-end browser flows.

```bash
# Run all unit and golden test suites against a local Anvil instance
npm test

# Run Foundry contract tests including fuzzing and regression tests
npm run test:chain

# Run Envio indexer tests against real Monad testnet blocks
cd indexer && npm run test:integration

# Run Playwright browser tests with virtual WebAuthn authenticators
npm run test:e2e
```

* **Spec driven development**
  All contracts and protocols were specified in `contracts/` before implementation.
* **Cryptographic test vectors**
  Golden test vectors in `tests/golden` are verified against independent reference implementations.
* **Security audits and fuzzing**
  Automated fuzz testing and simulated adversarial scenarios ensure that quarantined writes and unverified delegations cannot bypass authorization.
* **Regression tracker**
  Documented in [BUGLOG.md](BUGLOG.md), containing root causes and permanent regression tests for every bug encountered during development.

---

## Built With Open Standards

* [Mera](https://github.com/category-labs/mera) for WebAuthn PRF ceremonies and deterministic key derivation
* [@noble/curves and @noble/hashes](https://github.com/paulmillr) for audited cryptographic primitives
* [Envio HyperIndex](https://envio.dev) for high throughput blockchain data indexing with HyperSync
* [Foundry](https://getfoundry.sh) for smart contract development and testing
* [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) for battle tested ERC standards and EIP-712 implementations
* [Viem](https://viem.sh) for type safe Ethereum interactions
* [Next.js](https://nextjs.org) and React for web applications
* [Playwright](https://playwright.dev) and [Vitest](https://vitest.dev) for testing with virtual authenticators
* [Moonshot AI KIMI](https://platform.moonshot.ai) for the conversational demo agent models
* [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) for onchain agent identity registration

---

## License

This project is open source under the [MIT License](LICENSE).
