# Engram indexer (Envio HyperIndex)

Indexes the MemoryRegistry and the ERC-8004 IdentityRegistry on Monad testnet into a GraphQL API.
Spec: [`contracts/indexer.md`](../contracts/indexer.md).

## Data sources
- **HyperSync** (`https://10143.hypersync.xyz`) for historical sync. Needs `ENVIO_API_TOKEN` with HyperSync access
  in `indexer/.env` (see `.env.example`).
- **Monad public RPC** for head tracking (`for: realtime` in `config.yaml`), so the HyperSync rate limit is not spent
  polling 300 ms blocks.
- `config.rpc.yaml`: RPC-only variant (no token). Use with `ENVIO_CONFIG=config.rpc.yaml`.

## Run locally
```bash
npm install                      # from the repo root (npm workspaces)
cd indexer && npx envio codegen
npx envio dev                    # starts Postgres + Hasura in Docker and the indexer (interactive terminal)
# GraphQL: http://localhost:8080/v1/graphql  (Hasura admin secret: testing)
```
- Port 8080 taken? `HASURA_EXTERNAL_PORT=8090 HASURA_GRAPHQL_ENDPOINT=http://localhost:8090/v1/metadata npx envio dev`
- Non-interactive shells (CI, agents): start the services with `npx envio dev` once, then run the indexer with
  `ENVIO_TUI=false npx envio start`.
- Stop everything: `npx envio stop`.

## Tests
| Command | What |
|---|---|
| `npm test` | Golden cases (`tests/golden/indexer`), regressions, adversarial probes. Simulated events, no network. |
| `npm run test:integration` | Real testnet data via HyperSync: indexes the range seeded by `scripts/seed-testnet.ts` and decrypts the indexed entries as the owner and as agent 1961. |
| `npm run test:integration:rpc` | Same, RPC data source. |

## Measured (2026-10-01, Monad testnet, local indexer)
- Tx inclusion -> entry queryable over GraphQL: **4-824 ms** across 5 runs (`scripts/latency-probe.ts`), target < 3 s.

## Example queries
```graphql
# Memory log for one namespace (ciphertext only; decrypt client-side)
{ Entry(where: {namespace_id: {_eq: "<owner>-<nsId>"}}, order_by: {seq: asc}) { seq epoch byOwner agentId ciphertext txHash } }

# Agent inbox: active grants plus current wraps
{ Grant(where: {agent_id: {_eq: "1961"}, active: {_eq: true}}) { id owner scope expiry generation
    wrappedKeys { epoch generation wrap } } }

# Agents whose keys the registry accepts right now
{ Agent(where: {keysCurrent: {_eq: true}}) { id agentURI operator x25519Pub } }
```
