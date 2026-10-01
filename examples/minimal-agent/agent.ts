// Minimal Engram-connected agent (contracts/integration.md E1-E6). No LLM: it verifies the vault-signed app
// session and returns the memory the user granted. Plug `entries` into any model you like.
// Fetch-style handler, so it runs on Node, Bun, Deno, Next route handlers or Cloudflare Workers.
import { guardRequest } from "@engram/agent-kit";
import { EngramAgent, EngramError, verifyAppSession, type EngramConfig } from "@engram/sdk";
import { createWalletClient, http, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const COOKIE = "engram_session";

export function createMinimalAgent(opts: {
  config: EngramConfig;
  agentId: bigint;
  x25519PrivateKey: Uint8Array;
  origin: string;
  name: string;
  description?: string;
  /** Only needed to write memories (appendAsAgent); a read-only agent can omit it. */
  operatorKey?: Hex;
}) {
  const operator = createWalletClient({ transport: http(opts.config.rpcUrl), account: privateKeyToAccount(opts.operatorKey ?? generatePrivateKey()) });
  const agent = new EngramAgent({ config: opts.config, agentId: opts.agentId, x25519PrivateKey: opts.x25519PrivateKey, operator });
  const verify = (proof: unknown) => verifyAppSession(proof, { config: opts.config, agentId: opts.agentId, origin: opts.origin });

  async function ownerFrom(req: Request): Promise<Hex | undefined> {
    const raw = (req.headers.get("cookie") ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!raw || raw.length > 2048) return undefined;
    try {
      return await verify(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    } catch {
      return undefined;
    }
  }

  async function handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;

    if (path === "/agent-card.json") {
      return Response.json({ name: opts.name, description: opts.description ?? "", endpoints: [{ name: "web", endpoint: opts.origin }] });
    }

    // Step 1: the browser got a proof from connectEngram() and posts it here; we keep it in an httpOnly cookie.
    if (path === "/session" && req.method === "POST") {
      const g = await guardRequest(req, { origin: opts.origin, maxBytes: 4096 });
      if (!g.ok) return Response.json({ code: g.code }, { status: g.status });
      const proof = (g.json as { proof?: Record<string, unknown> } | null)?.proof;
      try {
        await verify(proof);
      } catch {
        return Response.json({ code: "NOT_AUTHORIZED" }, { status: 401 });
      }
      const { owner, agentId, origin, issuedAt, expiresAt, signature } = proof!;
      const value = Buffer.from(JSON.stringify({ owner, agentId, origin, issuedAt, expiresAt, signature })).toString("base64url");
      const secure = opts.origin.startsWith("https://") ? "; Secure" : "";
      return Response.json({ ok: true }, { headers: { "set-cookie": `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}` } });
    }

    // Step 2: on every request, read what this user granted us -- fresh, nothing cached.
    if (path === "/memory" && req.method === "GET") {
      const owner = await ownerFrom(req);
      if (!owner) return Response.json({ code: "NOT_AUTHORIZED" }, { status: 401 });
      const mine = (await opts.config.source.grantsForAgent(opts.agentId)).filter((g) => g.active && g.owner.toLowerCase() === owner.toLowerCase());
      const entries: { kind: string; text: string }[] = [];
      let complete = true;
      let granted = false;
      for (const g of mine) {
        try {
          const r = await agent.recall(owner, g.nsId);
          granted = true;
          entries.push(...r.entries.map((e) => ({ kind: e.kind, text: e.text })));
          complete &&= r.complete;
        } catch (e) {
          if (!(e instanceof EngramError && e.code === "ACCESS_REVOKED")) throw e;
        }
      }
      return Response.json({ entries, complete, revoked: !granted }, { headers: { "cache-control": "no-store" } });
    }

    return new Response("not found", { status: 404 });
  }

  return { handle };
}
