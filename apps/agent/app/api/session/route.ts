// POST /api/session { proof } -> verifies the vault-signed app-session proof and sets an httpOnly cookie.
import { cookies } from "next/headers";
import { COOKIE, agentServer } from "@/lib/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { proof?: unknown } | null;
  try {
    const value = await agentServer().session(body?.proof);
    const secure = new URL(req.url).protocol === "https:";
    (await cookies()).set(COOKIE, value, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 30 * 86400 });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false, code: "NOT_AUTHORIZED" }, { status: 401 });
  }
}

export async function DELETE() {
  (await cookies()).delete(COOKIE);
  return Response.json({ ok: true });
}
