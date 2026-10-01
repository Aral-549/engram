// Runs the minimal agent on Node: `npx tsx examples/minimal-agent/server.ts` with the env written by
// scripts/register-agent.ts (AGENT_ID, AGENT_X25519_PRIVATE_KEY, APP_ORIGIN) plus PORT and optional INDEXER_URL.
import { createServer } from "node:http";
import { deployments, firstAvailable, graphqlSource, logsSource } from "@engram/sdk";
import { createMinimalAgent } from "./agent.js";

const need = (k: string) => process.env[k] ?? (console.error(`missing env ${k}`), process.exit(1));
const d = deployments.monadTestnet;
const logs = logsSource({ rpcUrl: d.rpcUrl, registry: d.registry, fromBlock: d.deployBlock, chainId: d.chainId, blockRange: 100n });
const app = createMinimalAgent({
  config: {
    chainId: d.chainId, registry: d.registry, identityRegistry: d.identityRegistry, rpcUrl: d.rpcUrl,
    source: process.env.INDEXER_URL ? firstAvailable([graphqlSource(process.env.INDEXER_URL), logs]) : logs,
    relayer: { submit: async () => { throw new Error("agents never use the owner relay"); } },
    logger: (line) => console.log(JSON.stringify(line)),
  },
  agentId: BigInt(need("AGENT_ID")),
  x25519PrivateKey: new Uint8Array(Buffer.from(need("AGENT_X25519_PRIVATE_KEY").replace(/^0x/, ""), "hex")),
  origin: need("APP_ORIGIN"),
  name: process.env.AGENT_NAME ?? "My agent",
  operatorKey: process.env.AGENT_OPERATOR_KEY as `0x${string}` | undefined,
});

const port = Number(process.env.PORT ?? 3300);
createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks);
  const r = await app.handle(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body }));
  res.writeHead(r.status, Object.fromEntries(r.headers)).end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log(JSON.stringify({ stage: "minimal-agent", op: "listen", port })));
