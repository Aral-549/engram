"use client";
// Vault bridge strip, framed by an approved agent app (contracts/disclosure.md, contracts/apps.md V6, V7).
// It holds its own vault session (one passkey tap), answers the app's questions from approved folders only, and
// shows every read live. No approve or confirm controls live here (clickjacking): approvals happen in /connect.
import { startBridge, type BridgeEvent, type OwnerSession, type PolicyView } from "@engram/sdk";
import { useEffect, useRef, useState } from "react";
import { Seal } from "@/components/Seal";
import { SessionProvider, useSession } from "@/components/SessionProvider";

type Line = { key: number; text: string; tone: "read" | "write" | "empty" | "error" };

function embedder(): string | null {
  const ao = (window.location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  if (ao && ao.length) return ao[0] ?? null;
  try {
    return document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    return null;
  }
}

function Strip() {
  const { session, status, signIn, run, error } = useSession();
  // Read the URL and the framing context after mount (window does not exist while prerendering).
  const [agentId, setAgentId] = useState<bigint | null | undefined>(undefined);
  const [framed, setFramed] = useState(false);
  useEffect(() => {
    const raw = new URL(window.location.href).searchParams.get("agentId") ?? "";
    setAgentId(/^(0|[1-9]\d{0,77})$/.test(raw) ? BigInt(raw) : null);
    setFramed(window.parent !== window);
  }, []);
  const [policy, setPolicy] = useState<PolicyView | null | undefined>(undefined);
  const [lines, setLines] = useState<Line[]>([]);
  const sessionRef = useRef<OwnerSession | null>(null);
  const bridge = useRef<ReturnType<typeof startBridge> | null>(null);
  const seq = useRef(0);
  sessionRef.current = session;
  const parentOrigin = useRef<string | null>(null);

  useEffect(() => {
    parentOrigin.current = embedder();
    if (agentId === null || agentId === undefined || window.parent === window) return;
    const push = (text: string, tone: Line["tone"]) => setLines((l) => [{ key: seq.current++, text, tone }, ...l].slice(0, 3));
    const onEvent = (e: BridgeEvent) => {
      if (!e.ok) return push(e.code === "RATE_LIMITED" ? "Too many reads, paused" : `Refused: ${e.code.toLowerCase().replaceAll("_", " ")}`, "error");
      if (e.op === "propose") return push(`Saved for you: ${e.text}`, "write");
      if (!e.entries.length) return push(e.mode === "full" ? "Asked for everything: nothing to share" : "Asked, nothing relevant shared", "empty");
      push(`${e.mode === "full" ? "Full read" : "Shared"} ${e.entries.length}: ${e.entries.map((x) => x.text).join("; ")}`, "read");
    };
    bridge.current = startBridge({ session: () => sessionRef.current ?? undefined, agentId, window: window as never, onEvent });
    return () => bridge.current?.stop();
  }, [agentId]);

  useEffect(() => {
    if (!session || agentId === null || agentId === undefined) {
      setPolicy(undefined);
      return;
    }
    void run((s) => s.approvalFor(agentId)).then((p) => {
      setPolicy(p ?? null);
      void bridge.current?.refresh();
    });
  }, [session, agentId, run]);

  if (agentId === undefined) return <Frame><span className="text-ink-soft">Opening your vault…</span></Frame>;
  if (agentId === null || !framed) {
    return <Frame><span className="text-ink-soft">This page only works inside an approved agent app.</span></Frame>;
  }

  const here = parentOrigin.current;
  const approvedHere = !!policy && policy.active && (!here || policy.origin === here);
  const busy = status === "working";

  return (
    <Frame>
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <p className="flex items-center gap-2 font-mono text-[11px] text-ink-soft">
          <Seal size={16} />
          <span className="text-ink">Engram vault</span>
          <span className="text-rule">/</span>
          {status !== "ready" ? (
            <span>locked</span>
          ) : policy === undefined ? (
            <span>checking approval…</span>
          ) : approvedHere ? (
            <span className="flex items-center gap-1.5 text-seal"><span className="live-dot" aria-hidden /> sharing only what is relevant</span>
          ) : (
            <span className="text-rust">Not approved for this site</span>
          )}
        </p>
        <p className="mt-1 truncate text-[13px] leading-snug" aria-live="polite">
          {lines[0] ? (
            <span key={lines[0].key} className={`ink-in inline-block max-w-full truncate ${lines[0].tone === "error" ? "text-rust" : lines[0].tone === "write" ? "text-seal" : ""}`}>
              {lines[0].text}
            </span>
          ) : status === "ready" ? (
            <span className="text-ink-soft">No reads yet. Every read appears here and in your vault.</span>
          ) : (
            <span className="text-ink-soft">{error ?? "Unlock to let this app ask your memory. It never gets a key."}</span>
          )}
        </p>
      </div>
      {status !== "ready" ? (
        <button className="btn btn-primary shrink-0 px-3 py-1.5 text-sm" onClick={() => void signIn()} disabled={busy}>
          {busy ? "Waiting…" : "Unlock memory"}
        </button>
      ) : approvedHere ? (
        <button
          className="btn btn-danger shrink-0 px-3 py-1.5 text-sm"
          onClick={() => void run((s) => s.disapprove(agentId)).then((r) => r && setPolicy((p) => (p ? { ...p, active: false } : p)))}
        >
          Revoke
        </button>
      ) : null}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return <main className="flex h-dvh items-center gap-3 overflow-hidden border border-rule bg-card px-3">{children}</main>;
}

export default function BridgePage() {
  return (
    <SessionProvider>
      <Strip />
    </SessionProvider>
  );
}
