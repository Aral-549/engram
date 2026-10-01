// GET /api/agent-card?agentId=N -- reads the ERC-8004 tokenURI onchain and fetches the card server-side
// (contracts/apps.md, case V2).
import { deployments, identityRegistryAbi } from "@engram/sdk";
import { createPublicClient, http } from "viem";
import { monadTestnet } from "viem/chains";
import { fetchAgentCard } from "@/lib/server/agent-card";

export const runtime = "nodejs";

const client = createPublicClient({ chain: monadTestnet, transport: http(deployments.monadTestnet.rpcUrl) });

export async function GET(req: Request) {
  const agentId = new URL(req.url).searchParams.get("agentId") ?? "";
  if (!/^\d{1,78}$/.test(agentId)) return Response.json({ code: "BAD_AGENT_ID" }, { status: 400 });
  let uri: string;
  try {
    uri = (await client.readContract({
      address: deployments.monadTestnet.identityRegistry, abi: identityRegistryAbi, functionName: "tokenURI", args: [BigInt(agentId)],
    })) as string;
  } catch {
    return Response.json({ code: "UNKNOWN_AGENT" }, { status: 404 });
  }
  const r = await fetchAgentCard(uri);
  if (!r.ok) return Response.json({ code: r.code }, { status: r.status, headers: { "cache-control": "public, max-age=60" } });
  return Response.json({ agentId, card: r.card }, { headers: { "cache-control": "public, max-age=300" } });
}
