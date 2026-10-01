// POST /api/session { proof } -> verifies the vault-signed app-session proof and sets an httpOnly cookie.
// Same-origin JSON only (blocks login CSRF, BUGLOG G1).
import { guardRequest } from "@engram/agent-kit";
import { cookies } from "next/headers";
import { COOKIE, agentServer } from "@/lib/server";

export const runtime = "nodejs";

const origin = () => process.env.APP_ORIGIN ?? "";

export async function POST(req: Request) {
  const g = await guardRequest(req, { origin: origin(), maxBytes: 4 * 1024 });
  if (!g.ok) return Response.json({ ok: false, code: g.code }, { status: g.status });
  try {
    const value = await agentServer().session((g.json as { proof?: unknown } | null)?.proof);
    (await cookies()).set(COOKIE, value, {
      httpOnly: true,
      sameSite: "strict",
      secure: origin().startsWith("https://"),
      path: "/",
      maxAge: 30 * 86400,
    });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false, code: "NOT_AUTHORIZED" }, { status: 401 });
  }
}

export async function DELETE(req: Request) {
  if (req.headers.get("origin") !== origin()) return Response.json({ ok: false, code: "BAD_ORIGIN" }, { status: 403 });
  (await cookies()).delete(COOKIE);
  return Response.json({ ok: true });
}
