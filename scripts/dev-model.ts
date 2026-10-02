// Free local stand-in for KIMI (OpenAI-compatible /v1/chat/completions) so the agent apps can be clicked through
// without an API key. Rule-based and deliberately obvious: every reply starts with "[dev model]".
// It exercises the real paths: tool calls -> agent.remember -> onchain write, memory block -> personalised reply.
//
//   npx tsx scripts/dev-model.ts            # listens on http://127.0.0.1:8787/v1
//   then set KIMI_BASE_URL=http://127.0.0.1:8787/v1 and KIMI_API_KEY=dev in apps/agent/.env.*
import { createServer } from "node:http";

const PORT = Number(process.env.DEV_MODEL_PORT ?? 8787);

type Msg = { role: string; content?: string | null; tool_calls?: unknown[] };
type Req = { messages: Msg[]; tools?: { function: { name: string } }[] };

/** Sentences that state something durable about the user. */
const STATEMENT = /\b(i am|i'm|im|i prefer|i like|i love|i hate|i don't|i do not|i never|i always|my [a-z]+ is|i'm allergic|i am allergic|allergic to|i live in|i work)\b/i;

function memoriesIn(messages: Msg[]): string[] {
  // Memory arrives as its own system message, or (Disclosure mode) as recall tool results; both start with the tag.
  const blocks = messages.filter((m) => (m.role === "system" || m.role === "tool") && typeof m.content === "string" && m.content.startsWith("<user_memory>"));
  return [...new Set(blocks.flatMap((b) => linesOf(String(b.content))))];
}

function linesOf(block: string): string[] {
  const inner = block.slice(block.indexOf("<user_memory>") + 13, block.lastIndexOf("</user_memory>"));
  return inner
    .split("\n")
    .map((l) => {
      try {
        return (JSON.parse(l.replaceAll("<\\/", "</")) as { text: string }).text;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

function respond(req: Req) {
  const msgs = req.messages ?? [];
  const lastUser = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
  const lastIsTool = msgs.at(-1)?.role === "tool";
  const lastToolWasRecall = lastIsTool && String(msgs.at(-1)?.content ?? "").startsWith("<user_memory>");
  const canRemember = (req.tools ?? []).some((t) => t.function.name === "remember");
  const canRecall = (req.tools ?? []).some((t) => t.function.name === "recall");
  const persona = String(msgs[0]?.content ?? "").startsWith("You are Wayfarer") ? "planner" : "assistant";
  const known = memoriesIn(msgs);
  const revoked = String(msgs[0]?.content ?? "").includes("revoked your access");

  if (canRemember && !lastIsTool && STATEMENT.test(lastUser)) {
    const facts = lastUser.split(/(?<=[.!?])\s+|\s+and\s+(?=i\b|i'm\b)/i).map((s) => s.trim().replace(/[.!?]+$/, "")).filter((s) => STATEMENT.test(s));
    const fresh = facts.filter((f) => !known.some((k) => k.toLowerCase() === f.toLowerCase())).slice(0, 3);
    if (fresh.length) {
      return { tool_calls: fresh.map((text, i) => ({ id: `dev_${Date.now()}_${i}`, type: "function", function: { name: "remember", arguments: JSON.stringify({ kind: "preference", text }) } })) };
    }
  }
  // Disclosure mode: nothing relevant was shared up front, so ask the vault for everything (it logs a full read).
  if (canRecall && !lastIsTool && known.length === 0 && /what do you know|about me/i.test(lastUser)) {
    return { tool_calls: [{ id: `dev_${Date.now()}_r`, type: "function", function: { name: "recall", arguments: JSON.stringify({ all: true }) } }] };
  }
  if (lastIsTool && !lastToolWasRecall) return { content: "[dev model] Got it. I saved that to your own memory; you can see it, and revoke me, in your vault." };
  if (revoked) return { content: "[dev model] You revoked my access to your memory, so I don't know your preferences anymore. What should I keep in mind?" };
  if (/what do you know|about me/i.test(lastUser)) {
    return { content: known.length ? `[dev model] From what you shared: ${known.join("; ")}.` : "[dev model] You haven't shared anything with me yet." };
  }
  const using = known.length ? ` Using what you shared (${known.join("; ")}).` : " I don't know your preferences yet; connect your memory or tell me.";
  return {
    content:
      persona === "planner"
        ? `[dev model] Here is a quick plan for "${lastUser.slice(0, 80)}":\n- Day 1: arrive by train, easy local dinner\n- Day 2: morning walk, market lunch, sunset viewpoint\n- Day 3: slow breakfast, head home${using}`
        : `[dev model] Happy to help with "${lastUser.slice(0, 80)}".${using}`,
  };
}

createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed: Req;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const out = respond(parsed);
    const message = "tool_calls" in out ? { role: "assistant", content: null, tool_calls: out.tool_calls } : { role: "assistant", content: out.content };
    console.log(JSON.stringify({ stage: "dev-model", tools: (parsed.tools ?? []).map((t) => t.function.name), reply: "tool_calls" in out ? "tool_calls" : "text" }));
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ id: "dev", object: "chat.completion", model: "dev-model", choices: [{ index: 0, message, finish_reason: "tool_calls" in out ? "tool_calls" : "stop" }] }),
    );
  });
}).listen(PORT, "127.0.0.1", () => console.log(`dev model listening on http://127.0.0.1:${PORT}/v1 (not KIMI)`));
