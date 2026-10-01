# Contract: integration kit (third-party agents)

## Purpose
Lets another team connect their own AI agent to Engram in about 15 minutes: register an ERC-8004 identity,
publish the agent's encryption key and operator, and wire the connect popup plus server-side memory reads into
their app. Hands off all cryptography and chain access to `@engram/sdk` (contracts/sdk.md) and the optional KIMI
tool loop to `@engram/agent-kit` (contracts/apps.md).

The kit is: `scripts/register-agent.ts` (generic, any name/origin), `docs/INTEGRATE.md`, and
`examples/minimal-agent/` (a dependency-light server that verifies sessions and reads memory, no LLM).

## Inputs (`scripts/register-agent.ts`)
- `--name <string>`: 1..64 chars, required on first run
- `--description <string>`: 0..280 chars
- `--origin <url>`: exact origin of the agent's web app (`https://app.example`, no path/slash), required
- `--out <path>`: env file to write/reuse, default `.env.engram-agent`
- `--card-url <url>`: tokenURI to register, default `<origin>/agent-card.json`
- `--fund <MON>`: amount to send the operator when its balance is under half of it, default `0.2`, `0` disables
- env `HOLDER_PRIVATE_KEY`: wallet that owns (or will own) the ERC-8004 token; pays gas
- env `RPC_URL`, `REGISTRY`, `IDENTITY_REGISTRY` (optional): override the Monad testnet deployment

## Outputs
- the env file (mode 0600) with `AGENT_ID`, `AGENT_X25519_PRIVATE_KEY`, `AGENT_OPERATOR_KEY`, `APP_ORIGIN`,
  `ENGRAM_REGISTRY`, `ENGRAM_CHAIN_ID`
- `agent-card.json` content printed to stdout (to serve at `--card-url`); it lists `origin` as an endpoint so the
  vault shows the app as verified
- one structured JSON log line per step on stderr: `{stage:"register-agent", op, ok, ...}`; never a private key

## Behavior cases
| # | Input | Expected output | Notes |
|---|-------|------------------|-------|
| 1 | fresh run, valid name/origin, funded holder | registers identity with tokenURI = card URL; generates X25519 key + operator; `publishKeys`; funds operator; writes env file 0600; prints card JSON | |
| 2 | rerun with the same `--out` | reuses AGENT_ID and keys; no new registration; no publishKeys if onchain keys match; no funding if operator balance >= half of `--fund` | idempotent (BUGLOG K1) |
| 3 | `--origin https://app.example/` or with a path, or `ftp://` | exit 1 before any transaction, message names the problem | |
| 4 | `HOLDER_PRIVATE_KEY` missing or malformed | exit 1 before any transaction | |
| 5 | env file names an AGENT_ID the holder does not own | exit 1 before any transaction ("holder does not own agent N") | |
| 6 | env file was written for a different registry or chain | exit 1 before any transaction | stale file |
| 7 | holder has insufficient MON for gas | exit 1 with the RPC error class, env file not written if registration failed | |
| 9 | env file names an agent the holder owns, keys not yet published, `--fund 0.05`, run twice | first run publishes keys and funds 0.05; second run neither | resume + K1 |
| 8 | any run | stdout and stderr never contain `AGENT_X25519_PRIVATE_KEY`, `AGENT_OPERATOR_KEY` or the holder key | secrets |

## Behavior cases (`examples/minimal-agent`)
| # | Input | Expected output | Notes |
|---|-------|------------------|-------|
| E1 | `POST /session` with a vault-signed proof for this agent and origin | 200, httpOnly SameSite=Strict cookie | uses `verifyAppSession` |
| E2 | `GET /memory` with that cookie, owner granted this agent | 200 `{entries:[{kind,text}], complete}` | uses `EngramAgent.recall` |
| E3 | `GET /memory` with no or bad cookie | 401 | |
| E4 | owner revoked | 200 `{entries:[], revoked:true}` | |
| E5 | `POST /session` cross-origin or non-JSON | 403 / 415 | uses `guardRequest` |
| E6 | `GET /agent-card.json` | the card JSON with `endpoints[0].endpoint == APP_ORIGIN` | |

## Edge cases that must be covered
- an origin with uppercase host or default port (`https://App.example:443`) is rejected rather than normalized,
  since the vault signs exact origins only
- reruns after a partially failed first run (registered but keys not published) finish the remaining steps
- the card URL may differ from the origin (static hosting), but the card must still list the origin

## Explicitly out of scope
- hosting the agent app or the card (team's own infra); setting `setAgentURI` after a domain change is a manual
  step documented in INTEGRATE.md
- the LLM loop: teams either call `@engram/agent-kit` or their own model with memories from `recall`
- publishing the packages to npm (until then INTEGRATE.md uses `npm pack` tarballs)

## Status
- [x] Drafted
- [ ] Reviewed by a human
- [x] Implementation matches this contract
- [x] Golden tests exist for every behavior case above (cases 1, 2, 7 via the testnet integration test)
