"use client";
// Chat UI for a KIMI agent connected to the user's own memory vault (contracts/apps.md App 2 / App 3).
import { connectEngram } from "@engram/sdk";
import { useEffect, useRef, useState } from "react";
import { persona } from "@/lib/personas";
import { Monogram } from "@/components/Monogram";
import { Seal } from "@/components/Seal";
import { Words } from "@/components/Words";

type Msg = { role: "user" | "assistant"; content: string; saved?: { text: string; txHash: string }[] };
const P = persona(process.env.NEXT_PUBLIC_AGENT_PERSONA);
const VAULT = process.env.NEXT_PUBLIC_VAULT_URL ?? "http://localhost:3100";
const AGENT_ID = BigInt(process.env.NEXT_PUBLIC_AGENT_ID ?? "0");
const EXPLORER = "https://testnet.monadvision.com/tx/";
const FLAG = `engram-connected-${P.id}`; // UI convenience only; the httpOnly cookie is the real session

export default function Page() {
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      setConnected(localStorage.getItem(FLAG) === "1");
    } catch {
      /* storage blocked: start disconnected */
    }
  }, []);
  // Block body on purpose: newer Chromium returns a Promise from scrollIntoView, and React must not get it as cleanup.
  // Only once there is a conversation: scrolling on mount would hide the header on phones (contracts/apps.md V12).
  useEffect(() => {
    if (messages.length) end.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function setFlag(v: boolean) {
    setConnected(v);
    try {
      v ? localStorage.setItem(FLAG, "1") : localStorage.removeItem(FLAG);
    } catch {
      /* ignore */
    }
  }

  async function connect() {
    setNotice(null);
    try {
      const r = await connectEngram({ vaultUrl: VAULT, agentId: AGENT_ID, labels: P.labels, scope: P.scope, expiresInSec: 7 * 86400 });
      const res = await fetch("/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ proof: r.sessionProof }) });
      if (!res.ok) throw new Error("session");
      setFlag(true);
      setRevoked(false);
    } catch (e) {
      const code = (e as { code?: string }).code;
      setNotice(code === "USER_CANCELLED" ? "Connection cancelled. Nothing was shared." : code === "POPUP_BLOCKED" ? "Allow pop-ups for this site, then try again." : "Could not connect your memory. Try again.");
    }
  }

  async function send(text: string) {
    if (!text.trim() || busy) return;
    const next: Msg[] = [...messages, { role: "user", content: text.trim() }];
    setMessages(next);
    setInput("");
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The server only keeps the last 20 turns; never send more than that (long chats would hit the body cap).
        body: JSON.stringify({ messages: next.slice(-20).map(({ role, content }) => ({ role, content: content.slice(0, 4000) })) }),
      });
      const body = ((await res.json().catch(() => ({}))) ?? {}) as { reply?: string; saved?: { text: string; txHash: string }[]; accessRevoked?: boolean; message?: string; code?: string };
      if (res.status === 401) {
        setFlag(false);
        setNotice("Connect your memory first.");
        setMessages(messages);
        return;
      }
      if (!res.ok) {
        setNotice(body.code === "NO_GRANT" ? "Approve this agent in your vault first." : (body.message ?? "Something went wrong."));
        // Memories saved before a failure are real; show them (BUGLOG G6).
        if (body.saved?.length) setMessages([...next, { role: "assistant", content: "", saved: body.saved }]);
        return;
      }
      setRevoked(!!body.accessRevoked);
      setMessages([...next, { role: "assistant", content: body.reply ?? "", saved: body.saved }]);
    } catch {
      setNotice("Could not reach the agent. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const canWrite = P.scope === "readwrite";
  const promises = [
    ["Reads", `only your ${P.labels.join(", ")} folder, and only after you approve it in your vault.`],
    [canWrite ? "Writes" : "Never writes", canWrite ? "what you ask it to remember, sealed into your own memory with a public receipt." : "anything. It can read what you shared and nothing more."],
    ["Forgets", "when you revoke it. One tap in your vault, and the next reply starts from zero."],
  ] as const;

  return (
    <main className="mx-auto grid min-h-dvh max-w-6xl grid-cols-1 md:grid-cols-[19rem_1fr]">
      <aside className="flex flex-col gap-6 border-b border-rule px-5 py-6 md:sticky md:top-0 md:h-dvh md:border-b-0 md:border-r md:px-8 md:py-10">
        <div className="flex items-center gap-4">
          <Monogram letter={P.name[0]!} />
          <div className="min-w-0">
            <h1 className="font-display text-4xl leading-none tracking-tight">{P.name}</h1>
            <p className="mt-1 text-sm leading-snug text-ink-soft">{P.tagline}</p>
          </div>
        </div>
        <div>
          {connected ? (
            <span className="inline-flex items-center gap-2 rounded-sm border border-rule bg-card px-3 py-1.5 font-mono text-xs text-seal">
              <span className="live-dot" aria-hidden />
              memory connected · {canWrite ? "can read and add" : "read only"}
            </span>
          ) : (
            <button onClick={() => void connect()} className="btn btn-primary lift w-full justify-center px-4 py-3">Connect your memory</button>
          )}
        </div>
        <ul className="stagger hidden space-y-4 md:block">
          {promises.map(([k, v], i) => (
            <li key={k} className="border-l-2 border-rule pl-3 text-sm leading-relaxed text-ink-soft" style={{ ["--i" as string]: i, ["--d" as string]: "300ms" }}>
              <span className="font-medium text-ink">{k}</span> {v}
            </li>
          ))}
        </ul>
        <p className="mt-auto hidden font-mono text-[11px] leading-relaxed text-ink-soft md:block">
          ERC-8004 agent #{AGENT_ID.toString()} on Monad testnet. Your memory lives in your{" "}
          <a href={VAULT} target="_blank" rel="noreferrer" className="underline decoration-rule underline-offset-4 hover:text-ink">vault</a>, not here.
        </p>
      </aside>

      <section className="flex min-h-dvh flex-col px-5 py-6 md:px-12 md:py-10">
        {revoked ? (
          <p className="settle mb-4 rounded-sm border border-rust/40 bg-rust-soft px-3 py-2 text-sm text-rust">
            Access revoked by you. I can no longer read your memory, so I&apos;ll ask what I need.
            <button className="ml-2 underline" onClick={() => void connect()}>Reconnect</button>
          </p>
        ) : null}

        <div className="flex-1 space-y-6 pb-6">
          {messages.length === 0 ? (
            <div className="pt-4 md:pt-16">
              <p className="max-w-2xl font-display text-[clamp(2rem,4vw,3.25rem)] leading-[1.05] tracking-tight">
                <Words>{P.greeting}</Words>
              </p>
              <div className="stagger mt-8 flex flex-wrap gap-2.5">
                {P.suggestions.map((s, i) => (
                  <button
                    key={s}
                    onClick={() => void send(s)}
                    style={{ ["--i" as string]: i, ["--d" as string]: "700ms" }}
                    className="lift rounded-sm border border-rule bg-card px-3.5 py-2.5 text-left text-sm hover:border-seal"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="settle ml-auto max-w-[80%] text-right">
                <div className="inline-block rounded-sm bg-ink px-4 py-2.5 text-left leading-relaxed text-[#f7f3ea] whitespace-pre-wrap">{m.content}</div>
              </div>
            ) : (
              <div key={i} className="settle flex max-w-[92%] gap-3">
                <Monogram letter={P.name[0]!} size={30} />
                <div className="min-w-0 flex-1">
                  {m.content ? (
                    <div className="paper-card px-4 py-3">
                      <p className="ink-in whitespace-pre-wrap leading-relaxed">{m.content}</p>
                    </div>
                  ) : null}
                  {m.saved?.length ? (
                    <div className="stagger mt-2 flex flex-wrap gap-2">
                      {m.saved.map((s, k) => (
                        <a
                          key={s.txHash}
                          href={`${EXPLORER}${s.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ ["--i" as string]: k, ["--d" as string]: "500ms" }}
                          className="lift inline-flex items-center gap-1.5 rounded-sm border border-seal/25 bg-seal-soft px-2 py-1 font-mono text-[11px] text-seal hover:underline"
                        >
                          <Seal size={14} className="seal-stamp" />
                          saved to your memory: {s.text}
                        </a>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            ),
          )}
          {busy ? (
            <div className="settle flex items-center gap-3 font-mono text-xs text-ink-soft">
              <Monogram letter={P.name[0]!} size={30} />
              <span className="drops" aria-hidden><span /><span /><span /></span>
              <span>{connected ? "reading your memory and thinking" : "thinking"}</span>
            </div>
          ) : null}
          <div ref={end} />
        </div>

        {notice ? <p role="alert" className="settle mb-3 text-sm text-rust">{notice}</p> : null}
        <form
          onSubmit={(e) => { e.preventDefault(); void send(input); }}
          className="paper-card sticky bottom-4 flex items-end gap-3 p-3 transition-shadow focus-within:shadow-[0_0_0_1px_var(--color-seal),0_14px_30px_-18px_rgba(27,25,22,0.5)]"
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); } }}
            rows={2}
            maxLength={4000}
            placeholder={connected ? `Message ${P.name}` : "Connect your memory to start"}
            aria-label={`Message ${P.name}`}
            className="flex-1 resize-none bg-transparent px-1 leading-relaxed outline-none"
          />
          <button className="btn btn-primary px-4 py-2" disabled={busy || !input.trim()}>
            Send
          </button>
        </form>
        <p className="mt-3 text-center font-mono text-[11px] text-ink-soft">
          Powered by KIMI. {P.name} reads only what you share from your vault, and what it reads is sent to KIMI to answer you.
        </p>
      </section>
    </main>
  );
}
