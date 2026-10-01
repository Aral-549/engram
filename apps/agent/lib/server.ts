// Server-only: one agent server per process, configured from env (see .env.example).
import "server-only";
import { createAgentServer, type AgentServer } from "@engram/agent-kit";
import { deployments, graphqlSource, firstAvailable, logsSource, httpRelayer, type EngramConfig } from "@engram/sdk";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { persona } from "./personas";

let server: AgentServer | null = null;

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

export function agentServer(): AgentServer {
  if (server) return server;
  const d = deployments.monadTestnet;
  const p = persona(process.env.AGENT_PERSONA);
  const config: EngramConfig = {
    chainId: d.chainId, registry: d.registry, identityRegistry: d.identityRegistry, rpcUrl: d.rpcUrl,
    source: firstAvailable([
      graphqlSource(need("INDEXER_URL")),
      logsSource({ rpcUrl: d.rpcUrl, registry: d.registry, fromBlock: d.deployBlock, chainId: d.chainId, blockRange: 100n }),
    ]),
    relayer: httpRelayer("http://127.0.0.1:0/unused"), // agents write directly as their operator, never via the owner relay
    logger: (line) => console.log(JSON.stringify(line)),
  };
  const operator = createWalletClient({ chain: monadTestnet, transport: http(d.rpcUrl), account: privateKeyToAccount(need("AGENT_OPERATOR_KEY") as Hex) });
  server = createAgentServer({
    config,
    agentId: BigInt(need("AGENT_ID")),
    x25519PrivateKey: new Uint8Array(Buffer.from(need("AGENT_X25519_PRIVATE_KEY").replace(/^0x/, ""), "hex")),
    operator,
    kimi: { baseUrl: process.env.KIMI_BASE_URL ?? "https://api.moonshot.ai/v1", apiKey: need("KIMI_API_KEY"), model: process.env.KIMI_MODEL ?? "kimi-k2.6" },
    origin: need("APP_ORIGIN"),
    persona: { name: p.name, description: p.description, systemPrompt: p.systemPrompt, canWrite: p.scope === "readwrite", labels: p.labels },
  });
  return server;
}

export const COOKIE = "engram_app_session";
