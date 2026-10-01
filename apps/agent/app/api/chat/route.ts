// POST /api/chat { messages } -> KIMI reply using only the memory the user granted to this agent.
import { cookies } from "next/headers";
import { COOKIE, agentServer } from "@/lib/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > 64 * 1024) return Response.json({ code: "BODY_TOO_LARGE" }, { status: 413 });
  const body = (await req.json().catch(() => null)) as { messages?: unknown } | null;
  const cookie = (await cookies()).get(COOKIE)?.value;
  const res = await agentServer().chat({ cookie, messages: (body?.messages ?? []) as never });
  return Response.json(res.body, { status: res.status, headers: { "cache-control": "no-store" } });
}
