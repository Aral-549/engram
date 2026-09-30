# Engram

User-owned, passkey-encrypted AI memory on Monad. Memory is encrypted client-side with keys derived
from your passkey (Mera PRF), written to Monad as ciphertext, and shared with specific AI agents
(ERC-8004) through per-namespace, expiring, revocable key grants.

Status: in development for the Monad Metropolis hackathon (Trust, Identity & AI Infrastructure track).
Specs live in [`contracts/`](contracts/README.md). Full README (architecture, setup, deployment, demo) lands before submission.

## Repository layout
| Path | What |
|---|---|
| `contracts/` | Specs (input -> expected output), written before code |
| `packages/crypto` | Key derivation and encryption envelopes (TypeScript) |
| `chain/` | `MemoryRegistry` Solidity contract (Foundry) |
| `tests/golden/` | Frozen ground-truth tests (crypto vectors from an independent Python implementation, registry cases) |
| `tests/adversarial/` | Probes written by a separate adversarial review pass |

## Quick start (current state)
```bash
npm install
npm test                                    # crypto golden tests (vitest)
cd chain && forge install && forge test     # registry golden tests (Foundry)
npm run golden:crypto                       # re-derive crypto vectors with the Python reference (needs uv)
```

## Built during the hackathon
All code in this repository was written during the Metropolis build window (from 2026-10-01). No pre-existing code.

## Third-party code
- [@category-labs/mera](https://github.com/category-labs/mera) (MIT OR Apache-2.0): passkey PRF ceremonies, EVM address derivation
- [@noble/curves, @noble/hashes](https://github.com/paulmillr) (MIT): secp256k1, X25519, HKDF, SHA-256
- [OpenZeppelin Contracts 5.6.1](https://github.com/OpenZeppelin/openzeppelin-contracts) (MIT): EIP712, ECDSA, IERC721
- [forge-std](https://github.com/foundry-rs/forge-std) (MIT OR Apache-2.0): Foundry test utilities
- Python reference only: [pyca/cryptography](https://github.com/pyca/cryptography), [pycryptodome](https://github.com/Legrandin/pycryptodome)

## AI tool disclosure
This project is built with AI coding assistance, as permitted by the hackathon rules (section 4.1):
- **Claude Code (Anthropic, Claude Opus 5.5)** was used for spec drafting, implementation, and test
  authoring, and a separate Claude agent ran an adversarial review pass against each module.
- Workflow safeguards: specs are written and reviewed before code; golden vectors come from an independent
  implementation; tests are written from specs, not from code.
- The product itself uses **KIMI (Moonshot AI)** as the model behind its demo agents.

## License
MIT, see [LICENSE](LICENSE).
