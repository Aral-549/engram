# Metropolis Hackathon (Monad) -- Brief

Source: https://hackathon.monad.xyz/tracks and the Terms (v3.0, 3 Sep 2026). Captured 2026-09-30.

## Deadline
- Oct 13, 2026 11:59 PM ET = **Oct 14, 2026 09:29 IST**. Editable until then; version at deadline is judged.
- One project, one primary track, **unlimited sponsor bounties stacked on top**.
- Bounties marked with a specific track are only open to projects in that track.

## Deliverables (every track)
- Project logo (JPG/PNG/WEBP, max 3MB)
- Public GitHub repo, accessible by metropolis@hackathon.monad.xyz; OSI license; README with setup,
  attribution, pre-existing code disclosed, **AI tool use disclosed**; commit history across the build window
- Technical demo video, max 3 min, live product only (no slides, no code walkthrough)
- Pitch video, max 2 min: team, problem, why you
- Live product link on Monad mainnet or testnet + access instructions + test credentials for judges
- Contract addresses / tx hashes; explain why Monad
- Optional: 30s product ad (not judged)
- Never include private keys, credentials, or third-party personal data (submissions are non-confidential)

## Track judging rubric (from track pages; overrides the generic 5x20% in the Terms)
| Criterion | Weight |
|---|---|
| Technical Execution | 20% |
| Design & Craft | 20% |
| Originality & Track Insight | 15% |
| Founder & Market Readiness | 25% |
| Traction & Path Forward | 20% |

45% is market/traction: a named first user, real testing (even 5 users or a handful of test trades), a concrete next step.

## Primary tracks ($30k each, 3 x $10k)
1. **Onchain Finance & Trading** -- instruments, markets, asset primitives, trading UX. User: trader/protocol/fin-product builder.
   Hot themes: compute markets (CLOB for GPU-hours, compute yield, SLA bonds), programmable tokenized equities
   (lock/stream/condition, mock ERC-20 allowed), yield stripping, options on non-traditional underlyings,
   execution-aware UIs (no "pending" states), new order types, embedded trading.
   Look-for: real settlement + pricing/matching onchain, UI a trader trusts, clear risk disclosure.
2. **Consumer Products & Payments** -- non-crypto user, financial experience, blockchain invisible.
   Ideas: payments as social gestures, commitment contracts, accountability pools, ISAs, conditional gifts,
   salary streaming, per-minute micro-insurance, behaviour-gated savings.
   Look-for: any crypto friction judged harshly; named consumer segment; distribution plan for next 100 users.
3. **Social, Attention & Culture** -- social/cultural value, participation -> verifiable economic stake.
   Ideas: feed-algorithm marketplace, community-governed recsys, attention futures, early-supporter registries,
   TCG order books/AMMs/rentals, evolving generative art, style-as-asset licensing.
4. **Trust, Identity & AI Infrastructure** -- protocols/primitives others build on, not consumer apps.
   Monad building blocks called out: native P256 precompile (WebAuthn), ERC-8004 agent registry, BTX encrypted mempools.
   Ideas: WebAuthn proof of personhood, content passports, paid personal data locker, cross-app AI memory,
   skill attestations, data-labelling micropayments. Design = developer experience.

## Sponsor bounties
| Bounty | Sponsor | Track | Prize | Hard requirements |
|---|---|---|---|---|
| Best Community Team Project | Monad Fdn | All | $5,000 | Team belongs to an onboarded campus/community group (set in profile) |
| Cross-Border Payments App | Agora | Consumer | $10,000 | **Mobile app**; Mera passkey onboarding; AUSD balance; send/receive via Instant Settlement contract (testnet, mock funds); 2-min demo |
| Mobile Trading App | Agora | Finance | $10,000 | **Mobile app**; Mera login; AUSD balance; at least one trade on **Perpl**; 2-min demo |
| Bring Any-Chain Liquidity | Aurora Intents (NEAR Intents) | All | $5,000 | Live Swap API / Intents Deposits / Intents Connect flow; funds arrive from another chain and are used in the app |
| Best Use of Dynamic | Dynamic | All | $5,000 | Dynamic SDK for auth/embedded or agent wallets/signing; bonus for combining primitives |
| Privy | Privy | All | $5,000 | Privy **beyond login** (wallets, signing, etc.) |
| Best Use of Perpl's API | Perpl | All | $5,000 | Production trading bot/automation on Perpl with real onchain activity; judged on reliability, risk mgmt, profitability |
| Best Analytics / Risk Tool | Perpl | Finance | $3,000 | Real-time dark-mode dashboard, protocol + wallet drill-down (long spec on page) |
| Consumer Trading App on Kuru | Kuru | Finance | $5,000 | Spot trading product routed through Kuru CLOB; target user, demand evidence, acquisition/retention plan |
| New Assets & Markets on Kuru | Kuru | Finance | $5,000 | New asset class on Kuru + issuance/redemption, legal/ops plan, liquidity strategy |
| Nansen | Nansen | All | $5,000 pool | Nansen API/MCP/CLI as a core feature, not raw data display |
| Chainlink CRE Workflow | Chainlink | All | $3,000 | CRE workflow as orchestration layer; CLI simulation or live deploy; 2-min demo |
| Mera-Powered UX | Monad Fdn | All | $2,500 | Mera is the **entire** account layer; one passkey ceremony; scoped signing sessions; **stateless test** (clear storage / fresh device mid-demo) |
| Mera: One Passkey, Many Keys | Monad Fdn | All | $2,500 | PRF-derived keys doing non-wallet work (encryption, identities); cross-device test live |
| MetaMask Agent Wallet Plugin | MetaMask | Finance | $2,500 | Installable plugin (Agent Wallet >= v6.2.0), all tx through Agent Wallet, skills/<name>/SKILL.md, demo <= 5 min |
| Cleanverse CVI/CVA | Cleanverse | Trust | $2,000 | Identity check gates every CVA transfer; compliance use case; demo <= 5 min |
| Envio | Envio | All | $1,000 | HyperIndex/HyperSync/HyperRPC driving a core feature; config.yaml, schema.graphql, handlers in repo |
| Alchemy | Alchemy | All | $1,000 credits | Meaningful use of any Alchemy service supporting Monad |
| Qwen 3.8 Max | Alibaba Cloud | Trust | $5,000 credits | Agentic use (planning, tools, multi-step) + published article |
| KIMI | Moonshot | All | $3,000 credits | KIMI drives a core feature + published article |
| Hunyuan | Tencent | Social | $2,000 vouchers | Deep multimodal use + published article |

Conflicts to watch: the Mera-Powered UX bounty requires Mera as the *entire* account layer, which rules out Privy/Dynamic
as the account layer in the same app.

## Verified Monad facts (docs.monad.xyz, 2026-10-01)
- Mainnet chain 143, RPC https://rpc.monad.xyz; testnet chain 10143, RPC https://testnet-rpc.monad.xyz, faucet.monad.xyz
- 300ms blocks, 300ms speculative finality, 600ms finality (track pages still say 400/800ms; docs are canonical)
- P256 verify precompile at `0x0100` (EIP-7951, same interface as RIP-7212): 160-byte input hash|r|s|qx|qy
- ERC-8004 registries on mainnet: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`
  (identity + reputation; validation registry "coming soon"). Guide: docs.monad.xyz/guides/erc-8004
- Mera: PRF(credential, rpId, 32-byte salt) -> 32 deterministic bytes, same on every synced device; salt = namespace.
  API: createPasskeyWithPrfOutput, getPasskeyPrfOutput, createSecp256k1SigningSession, toViemAccount,
  createSecretVaultWithNewPasskey / WithExistingPasskey, decryptSecretVaultWithPasskey, parseSecretVault, getEvmAddress.
  Every ceremony requires user verification. PRF key is bound to rpId (domain).

## Key docs
- Monad: docs.monad.xyz, developers.monad.xyz, faucet.monad.xyz (mainnet chain ID 143)
- Mera: mera.category.xyz (getting-started, React Native recipe, passkeys-and-prf, secret-vaults), github.com/category-labs/mera
- Agora: docs.agora.finance (contract-overview, API)
- Perpl: docs.perpl.xyz/resources/for-developers, github.com/PerplFoundation/dex-sdk, github.com/PerplFoundation/api-docs
- Kuru: kuru-testnet-docs.mintlify.site
- Aurora Intents: docs.intents.aurora.dev
- Envio: docs.envio.dev
- Chainlink CRE: docs.chain.link
- Cleanverse: docs.cleanverse.com (sponsor API credentials are on the bounty page; never commit them)
