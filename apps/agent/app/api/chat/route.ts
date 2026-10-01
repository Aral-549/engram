// POST /api/chat { messages } -> KIMI reply using only the memory the user granted to this agent.
import { guardRequest } from "@engram/agent-kit";
import { cookies } from "next/headers";
import { COOKIE, agentServer } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await guardRequest(req, { origin: process.env.APP_ORIGIN ?? "", maxBytes: 64 * 1024 });
  if (!g.ok) return Response.json({ saved: [], accessRevoked: false, code: g.code }, { status: g.status });
  const cookie = (await cookies()).get(COOKIE)?.value;
  try {
    const res = await agentServer().chat({ cookie, messages: ((g.json as { messages?: unknown } | null)?.messages ?? []) as never });
    return Response.json(res.body, { status: res.status, headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ saved: [], accessRevoked: false, code: "UNEXPECTED", message: "something went wrong" }, { status: 500 });
  }
}
