"use client";
// Consent popup (contracts/apps.md "Connect flow", cases V3, V4; sdk.md cases 12-14).
import { parseConnectRequest, replyToOpener, type AgentCard, type ConnectRequest } from "@engram/sdk";
import { useEffect, useRef, useState } from "react";
import { KNOWN_LABELS, addLabel } from "@/lib/discover";
import { explain } from "@/lib/engram";
import { Seal } from "@/components/Seal";
import { SessionProvider, useSession } from "@/components/SessionProvider";
import { agentCard } from "@/components/useAgentCards";

function duration(sec: number) {
  if (sec < 3600) return `${Math.round(sec / 60)} minutes`;
  if (sec < 86400 * 2) return `${Math.round(sec / 3600)} hours`;
  return `${Math.round(sec / 86400)} days`;
}

function claimedOrigin(): string | null {
  const o = new URL(window.location.href).searchParams.get("origin");
  try {
    return o && new URL(o).origin === o ? o : null;
  } catch {
    return null;
  }
}

function Consent() {
  const { session, status, signIn, run, error } = useSession();
  const [req, setReq] = useState<ConnectRequest | null>(null);
  const [card, setCard] = useState<AgentCard | null>(null);
  const [bad, setBad] = useState<string | null>(null);
  const [phase, setPhase] = useState<"review" | "granting" | "done">("review");
  const replied = useRef(false);

  const reply = (msg: Parameters<typeof replyToOpener>[2]) => {
    if (replied.current || !req) return;
    replied.current = true;
    replyToOpener(window.opener, req.origin, msg);
  };

  useEffect(() => {
    let parsed: ConnectRequest;
    try {
      parsed = parseConnectRequest(window.location.href);
    } catch (e) {
      setBad(explain(e));
      const origin = claimedOrigin();
      if (origin && window.opener) replyToOpener(window.opener, origin, { ok: false, code: "INPUT_INVALID" });
      replied.current = true;
      return;
    }
    setReq(parsed);
    void agentCard(parsed.agentId.toString()).then((c) => {
      setCard(c);
      if (c) setReq(parseConnectRequest(window.location.href, { agentCard: c }));
    });
  }, []);

  async function approve() {
    if (!req) return;
    const s = session ?? (await signIn());
    if (!s) return;
    setPhase("granting");
    let txHash: `0x${string}` | undefined;
    for (const label of req.labels) {
      if (!(KNOWN_LABELS as readonly string[]).includes(label)) await run((x) => addLabel(x, label));
      const r = await run((x) => x.grant(label, req.agentId, { scope: req.scope, expiresInSec: req.expiresInSec, includeHistory: true }));
      if (!r) {
        setPhase("review");
        return;
      }
      txHash = r.txHash;
    }
    reply({ ok: true, owner: s.owner, granted: req.labels, txHash: txHash! });
    setPhase("done");
    setTimeout(() => window.close(), 1400);
  }

  function deny() {
    reply({ ok: false, code: "USER_CANCELLED" });
    window.close();
  }

  if (bad) {
    return (
      <Shell>
        <h1 className="font-display text-3xl">This request is not valid</h1>
        <p className="mt-3 text-ink-soft">{bad}</p>
        <p className="mt-2 text-sm text-ink-soft">Nothing was shared. You can close this window.</p>
      </Shell>
    );
  }
  if (!req) return <Shell><p className="text-ink-soft">Reading the request…</p></Shell>;

  const name = card?.name ?? `Agent #${req.agentId}`;
  return (
    <Shell>
      {phase === "done" ? (
        <div className="settle text-center">
          <Seal size={44} className="seal-stamp mx-auto" />
          <h1 className="mt-4 font-display text-3xl">Access granted</h1>
          <p className="mt-2 text-ink-soft">{name} can now read {req.labels.join(", ")}. Revoke it any time in your vault.</p>
        </div>
      ) : (
        <>
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-seal">Access request</p>
          <h1 className="mt-2 font-display text-[2.1rem] leading-tight">
            <span className="text-seal">{name}</span> wants to read part of your memory
          </h1>
          {card?.description ? <p className="mt-2 text-sm text-ink-soft">{card.description}</p> : null}

          <div className="paper-card mt-6 space-y-3 p-5 text-sm">
            <Row k="Requested by">
              <span className="font-mono">{req.origin}</span>{" "}
              {req.originVerified ? (
                <span className="ml-1 rounded-sm bg-seal-soft px-1.5 py-0.5 font-mono text-[11px] text-seal">verified by agent card</span>
              ) : (
                <span className="ml-1 rounded-sm bg-rust-soft px-1.5 py-0.5 font-mono text-[11px] text-rust">not listed by this agent</span>
              )}
            </Row>
            <Row k="Folders">{req.labels.map((l) => <span key={l} className="mr-2 font-mono">{l}</span>)}</Row>
            <Row k="Permission">{req.scope === "readwrite" ? "Read, and add new memories" : "Read only"}</Row>
            <Row k="For">{duration(req.expiresInSec)}, or until you revoke it</Row>
          </div>

          {!req.originVerified ? (
            <p className="mt-4 rounded-sm border border-rust/40 bg-rust-soft px-3 py-2 text-sm text-rust">
              The agent&apos;s public card does not list {req.origin}. Only continue if you opened this from an app you trust.
            </p>
          ) : null}
          <p className="mt-4 text-xs leading-relaxed text-ink-soft">
            Approved apps send what they read to their AI model provider to answer you. Revoking stops access to anything you add later;
            what was already read cannot be un-shared.
          </p>

          <div className="mt-6 flex flex-col gap-2">
            <button className="btn btn-primary justify-center px-5 py-3" onClick={() => void approve()} disabled={phase === "granting" || status === "working"}>
              <Seal size={18} />
              {phase === "granting" ? "Sealing access onchain…" : status === "working" ? "Waiting for your passkey…" : session ? "Approve with passkey" : "Unlock and approve"}
            </button>
            <button className="btn btn-ghost justify-center px-5 py-2.5" onClick={deny} disabled={phase === "granting"}>
              Deny
            </button>
          </div>
          {error ? <p role="alert" className="mt-4 text-sm text-rust">{error}</p> : null}
        </>
      )}
    </Shell>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-3">
      <span className="font-mono text-[11px] uppercase tracking-wider text-ink-soft">{k}</span>
      <span>{children}</span>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col px-6 py-8">
      <header className="mb-8 flex items-center gap-2">
        <Seal size={22} />
        <span className="font-display text-xl">Engram</span>
      </header>
      {children}
    </main>
  );
}

export default function ConnectPage() {
  return (
    <SessionProvider>
      <Consent />
    </SessionProvider>
  );
}
