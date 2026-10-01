// A local stand-in for KIMI's OpenAI-compatible chat-completions endpoint. Returns scripted responses in order and
// records every request body, so tests can assert exactly what the agent sent to the model. Not a golden file.
import { createServer, type Server } from "node:http";

export type ScriptedReply =
  | { text: string }
  | { toolCalls: { name: string; args: unknown }[] }
  | { status: number }
  | { hangMs: number };

export class FakeKimi {
  readonly requests: Array<{ messages: Array<{ role: string; content?: string | null; tool_calls?: unknown; name?: string }>; tools?: Array<{ function: { name: string } }> }> = [];
  private script: ScriptedReply[] = [];
  private server: Server | undefined;
  baseUrl = "";

  async start() {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        if (req.headers.authorization !== "Bearer test-kimi-key") {
          res.writeHead(401).end();
          return;
        }
        this.requests.push(JSON.parse(body));
        const next = this.script.shift() ?? { text: "ok" };
        if ("hangMs" in next) {
          await new Promise((r) => setTimeout(r, next.hangMs));
          if (!res.writableEnded) res.writeHead(504).end();
          return;
        }
        if ("status" in next) {
          res.writeHead(next.status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "upstream" } }));
          return;
        }
        const message =
          "text" in next
            ? { role: "assistant", content: next.text }
            : {
                role: "assistant",
                content: null,
                tool_calls: next.toolCalls.map((t, i) => ({
                  id: `call_${this.requests.length}_${i}`,
                  type: "function",
                  function: { name: t.name, arguments: typeof t.args === "string" ? t.args : JSON.stringify(t.args) },
                })),
              };
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ id: "x", object: "chat.completion", choices: [{ index: 0, message, finish_reason: "text" in next ? "stop" : "tool_calls" }] }),
        );
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", () => r()));
    this.baseUrl = `http://127.0.0.1:${(this.server!.address() as { port: number }).port}/v1`;
    return this;
  }

  /** Queue the next responses. */
  reply(...r: ScriptedReply[]) {
    this.script.push(...r);
  }

  reset() {
    this.script = [];
    this.requests.length = 0;
  }

  stop() {
    this.server?.close();
  }
}
