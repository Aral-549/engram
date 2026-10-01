// POST /api/relay -- gasless owner actions (contracts/apps.md "Relayer"). Thin wrapper over the SDK handler,
// which checks shape, rate limit, selector, deadline, signature, and simulates before spending gas.
import { createRelayHandler, deployments, type RelayHandler } from "@engram/sdk";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024; // largest relayed call (16 re-wraps) is well under this
let handler: RelayHandler | null = null;

function getHandler(): RelayHandler | null {
  if (handler) return handler;
  const key = process.env.RELAYER_PRIVATE_KEY as Hex | undefined;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
  const d = deployments.monadTestnet;
  const wallet = createWalletClient({ chain: monadTestnet, transport: http(d.rpcUrl), account: privateKeyToAccount(key) });
  handler = createRelayHandler({
    config: { chainId: d.chainId, registry: d.registry, identityRegistry: d.identityRegistry, rpcUrl: d.rpcUrl },
    wallet,
  });
  return handler;
}

export async function POST(req: Request) {
  const h = getHandler();
  if (!h) return Response.json({ code: "RELAYER_NOT_CONFIGURED", message: "set RELAYER_PRIVATE_KEY on the server" }, { status: 503 });
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) return Response.json({ code: "BODY_TOO_LARGE" }, { status: 413 });
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return Response.json({ code: "BODY_TOO_LARGE" }, { status: 413 });
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* handler answers BAD_REQUEST */
  }
  const res = await h(body);
  return Response.json(res.body, { status: res.status, headers: { "cache-control": "no-store" } });
}
