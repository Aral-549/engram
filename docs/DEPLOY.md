# Deploying Engram

There are three web services to deploy, all built from this one repository:

| Service | Workspace | What it is |
|---|---|---|
| **vault** | `apps/vault` | The passkey vault, consent popup and bridge |
| **sage** | `apps/agent` with `AGENT_PERSONA=assistant` | The demo assistant (can propose memories) |
| **wayfarer** | `apps/agent` with `AGENT_PERSONA=planner` | The demo trip planner (read-only) |

The contracts are already on Monad testnet (addresses are in `packages/sdk/src/deployments.ts`), so you don't
deploy anything onchain. The Envio indexer is **optional**. Without one, the vault and agents read events directly
from Monad RPC. That is slower but it works.

Deploy the vault first. Both agents need its URL.

## Vercel

Create one Vercel project for each service, all pointing at this repository:

1. **New Project** → import the repo → set **Root Directory** to `apps/vault` (or `apps/agent` for each agent).
2. Leave the build settings alone. `apps/<app>/vercel.json` already installs from the monorepo root and builds the
   shared packages first.
3. Add the environment variables listed below, then deploy.

For Sage and Wayfarer you create two projects, both with Root Directory `apps/agent`. Only their env vars differ.

## Railway

Create one Railway service for each app, all pointing at this repository:

1. **New Service** → GitHub repo. Leave **Root Directory** at `/` (the repo root).
2. Under **Settings → Config-as-code**, set the config file path to `/apps/vault/railway.json` (or
   `/apps/agent/railway.json` for each agent).
3. Add the environment variables below, then **Settings → Networking → Generate Domain**.

Railway sets `PORT` itself and the start scripts bind to it. Railway runs each app as one long-lived process, so
the agent's in-memory rate limits and replay guard behave exactly as they do locally. On Vercel, that state is kept
per serverless instance.

## Environment variables

`NEXT_PUBLIC_*` values are baked in at **build time**, so you need to redeploy after you change them.

### vault
| Variable | Required | Value |
|---|---|---|
| `RELAYER_PRIVATE_KEY` | yes | A funded Monad testnet key (`0x…`) that pays gas for relayed owner actions. Server-only. |
| `NEXT_PUBLIC_INDEXER_URL` | no | Envio GraphQL endpoint. Without it, the vault reads from RPC. |

### sage / wayfarer
| Variable | Required | sage | wayfarer |
|---|---|---|---|
| `AGENT_PERSONA` | yes | `assistant` | `planner` |
| `NEXT_PUBLIC_AGENT_PERSONA` | yes | `assistant` | `planner` |
| `AGENT_ID` / `NEXT_PUBLIC_AGENT_ID` | yes | ERC-8004 id (`1965`) | ERC-8004 id (`1966`) |
| `APP_ORIGIN` | yes | This app's exact public origin, e.g. `https://sage.example.com` (no trailing slash) | same, for wayfarer |
| `NEXT_PUBLIC_VAULT_URL` | yes | The vault's public origin | same |
| `CONTINUATION_SECRET` | yes | 32+ random chars (`openssl rand -hex 32`), different per agent | |
| `KIMI_API_KEY` | yes | Moonshot API key | |
| `KIMI_BASE_URL` | no | default `https://api.moonshot.ai/v1` | |
| `KIMI_MODEL` | no | default `kimi-k2.6` | |
| `AGENT_MODE` / `NEXT_PUBLIC_AGENT_MODE` | no | default `disclosure`. Set both to the same value. | |
| `INDEXER_URL` | no | Envio GraphQL endpoint. Without it, the agent reads from RPC. | |
| `AGENT_X25519_PRIVATE_KEY`, `AGENT_OPERATOR_KEY` | offline mode only | | |

Leave `NEXT_DIST_DIR` unset in hosted deploys. It exists only so that both personas can build side by side on one
machine.

`npx tsx scripts/register-agents.ts` registers fresh agents and writes `apps/agent/.env.assistant` and
`.env.planner`. You can copy the values from those files. If you use the existing agents #1965 and #1966, their
registered card URLs must point at your deployed origins. If they don't, register new agents with your production
URLs.

## Things to know before going live

- **Passkeys are bound to the vault's domain.** The vault uses `window.location.hostname` as the WebAuthn RP ID,
  and your keys are derived from the passkey. A vault created on `xyz.vercel.app` cannot be opened on a different
  domain. Put the vault on its final domain before anyone creates a real vault.
- **`APP_ORIGIN` must match exactly.** App sessions and CSRF checks compare against it. Vercel preview URLs won't
  match it, so test agents on the production domain.
- **Indexer (optional):** deploy `indexer/` to Envio's hosted service (see `indexer/README.md`) and set
  `NEXT_PUBLIC_INDEXER_URL` (vault) and `INDEXER_URL` (agents) to its GraphQL URL.
