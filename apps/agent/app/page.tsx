"use client";
// Chat UI for a KIMI agent connected to the user's own memory vault (contracts/apps.md App 2 / App 3).
import { connectEngram } from "@engram/sdk";
import { useEffect, useRef, useState } from "react";
import { persona } from "@/lib/personas";

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
  useEffect(() => end.current?.scrollIntoView({ behavior: "smooth" }), [messages]);

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
        body: JSON.stringify({ messages: next.map(({ role, content }) => ({ role, content })) }),
      });
      const body = (await res.json()) as { reply?: string; saved?: { text: string; txHash: string }[]; accessRevoked?: boolean; message?: string };
      if (res.status === 401) {
        setFlag(false);
        setNotice("Connect your memory first.");
        setMessages(messages);
        return;
      }
      if (!res.ok) {
        setNotice(body.message ?? "Something went wrong.");
        return;
      }
      setRevoked(!!body.accessRevoked);
      setMessages([...next, { role: "assistant", content: body.reply ?? "", saved: body.saved }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col px-5 py-6 md:px-8 md:py-10">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-rule pb-5">
        <div>
          <h1 className="font-display text-4xl leading-none tracking-tight">{P.name}</h1>
          <p className="mt-1 text-sm text-ink-soft">{P.tagline}</p>
        </div>
        {connected ? (
          <span className="rounded-sm border border-rule bg-card px-3 py-1.5 font-mono text-xs text-seal">
            memory connected · {P.scope === "readwrite" ? "can read and add" : "read only"}
          </span>
        ) : (
          <button onClick={() => void connect()} className="btn btn-primary px-4 py-2.5">Connect your memory</button>
        )}
      </header>

      {revoked ? (
        <p className="mt-4 rounded-sm border border-rust/40 bg-rust-soft px-3 py-2 text-sm text-rust">
          Access revoked by you. I can no longer read your memory, so I&apos;ll ask what I need.
          <button className="ml-2 underline" onClick={() => void connect()}>Reconnect</button>
        </p>
      ) : null}

      <section className="flex-1 space-y-5 py-6">
        {messages.length === 0 ? (
          <div className="settle">
            <p className="max-w-xl font-display text-2xl leading-snug">{P.greeting}</p>
            <div className="mt-6 flex flex-wrap gap-2">
              {P.suggestions.map((s) => (
                <button key={s} onClick={() => void send(s)} className="rounded-sm border border-rule bg-card px-3 py-2 text-left text-sm hover:border-seal">
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {messages.map((m, i) => (
          <div key={i} className={`settle ${m.role === "user" ? "ml-auto max-w-[85%] text-right" : "max-w-[90%]"}`}>
            <div className={m.role === "user" ? "inline-block rounded-sm bg-ink px-4 py-2.5 text-left text-[#f7f3ea]" : "paper-card px-4 py-3"}>
              <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
            </div>
            {m.saved?.length ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {m.saved.map((s) => (
                  <a key={s.txHash} href={`${EXPLORER}${s.txHash}`} target="_blank" rel="noreferrer" className="rounded-sm bg-seal-soft px-2 py-1 font-mono text-[11px] text-seal hover:underline">
                    saved to your memory: {s.text}
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        {busy ? <p className="font-mono text-xs text-ink-soft">{P.name} is thinking…</p> : null}
        <div ref={end} />
      </section>

      {notice ? <p role="alert" className="mb-3 text-sm text-rust">{notice}</p> : null}
      <form onSubmit={(e) => { e.preventDefault(); void send(input); }} className="paper-card flex items-end gap-3 p-3">
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
        <button className="btn btn-primary px-4 py-2" disabled={busy || !input.trim()}>Send</button>
      </form>
      <p className="mt-3 text-center font-mono text-[11px] text-ink-soft">
        Powered by KIMI. {P.name} reads only what you share from your vault, and what it reads is sent to KIMI to answer you.
      </p>
    </main>
  );
}
