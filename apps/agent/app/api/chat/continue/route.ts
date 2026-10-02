// POST /api/chat/continue { continuation, result } -> resumes a Disclosure-mode turn with the vault's answer.
import { guardRequest } from "@engram/agent-kit";
import { cookies } from "next/headers";
import { COOKIE, agentServer } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const g = await guardRequest(req, { origin: process.env.APP_ORIGIN ?? "", maxBytes: 256 * 1024 });
  if (!g.ok) return Response.json({ saved: [], accessRevoked: false, code: g.code }, { status: g.status });
  const cookie = (await cookies()).get(COOKIE)?.value;
  const body = (g.json ?? {}) as { continuation?: unknown; result?: unknown };
  try {
    const res = await agentServer().continue({ cookie, continuation: body.continuation as string, result: body.result as never });
    return Response.json(res.body, { status: res.status, headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ saved: [], accessRevoked: false, code: "UNEXPECTED", message: "something went wrong" }, { status: 500 });
  }
}
