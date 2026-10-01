// GET /agent-card.json -- the ERC-8004 agent card (the agent's tokenURI points here once deployed over https).
import { agentServer } from "@/lib/server";

export const runtime = "nodejs";

export function GET() {
  return Response.json(agentServer().cardJson(), { headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } });
}
