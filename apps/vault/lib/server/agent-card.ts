// Server-side ERC-8004 agent card fetch (contracts/apps.md, case V2). The browser never fetches arbitrary
// agent-controlled URLs; this proxy fetches https only, with a timeout and size cap, and returns known fields only.
import type { AgentCard } from "@engram/sdk";

export type AgentCardResult = { ok: true; card: AgentCard } | { ok: false; status: number; code: string };

const failure = (status: number, code: string): AgentCardResult => ({ ok: false, status, code });
const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

async function readLimited(res: Response, maxBytes: number): Promise<string | undefined> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function sanitize(raw: Record<string, unknown>): AgentCard {
  const card: AgentCard = {};
  const name = str(raw.name, 100);
  const description = str(raw.description, 500);
  const image = str(raw.image, 500);
  if (name) card.name = name;
  if (description) card.description = description;
  if (image?.startsWith("https://")) card.image = image;
  if (Array.isArray(raw.endpoints)) {
    card.endpoints = raw.endpoints
      .slice(0, 20)
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && typeof (e as { endpoint?: unknown }).endpoint === "string")
      .map((e) => ({ ...(str(e.name, 60) ? { name: str(e.name, 60) } : {}), endpoint: String(e.endpoint).slice(0, 500) }));
  }
  return card;
}

export async function fetchAgentCard(
  uri: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {},
): Promise<AgentCardResult> {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return failure(400, "BAD_URI");
  }
  if (url.protocol !== "https:") return failure(400, "BAD_URI");

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 5000);
  try {
    let res: Response;
    try {
      res = await (opts.fetch ?? fetch)(url.toString(), { signal: ac.signal, redirect: "error", headers: { accept: "application/json" } });
    } catch (e) {
      return ac.signal.aborted ? failure(504, "TIMEOUT") : failure(502, "UPSTREAM_ERROR");
    }
    if (!res.ok) return failure(502, "UPSTREAM_STATUS");
    if (!(res.headers.get("content-type") ?? "").toLowerCase().includes("json")) return failure(415, "NOT_JSON");
    let text: string | undefined;
    try {
      text = await readLimited(res, opts.maxBytes ?? 64 * 1024);
    } catch {
      return ac.signal.aborted ? failure(504, "TIMEOUT") : failure(502, "UPSTREAM_ERROR");
    }
    if (text === undefined) return failure(413, "TOO_LARGE");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return failure(415, "NOT_JSON");
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return failure(422, "BAD_CARD");
    return { ok: true, card: sanitize(raw as Record<string, unknown>) };
  } finally {
    clearTimeout(timer);
  }
}
