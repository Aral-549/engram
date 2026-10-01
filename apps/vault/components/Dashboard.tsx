"use client";
import type { GrantView, RecalledEntry } from "@engram/sdk";
import { useCallback, useEffect, useMemo, useState } from "react";
import { addLabel, discoverLabels, isValidLabel, type DiscoveredNamespace } from "@/lib/discover";
import { addressUrl, expiresIn, relativeTime, shortAddr, txUrl, untilSettled } from "@/lib/engram";
import { Seal } from "./Seal";
import { useSession } from "./SessionProvider";
import { useAgentCards } from "./useAgentCards";

type Tab = "memory" | "access";
const KINDS = ["preference", "fact", "note"] as const;

export function Dashboard() {
  const { session, lock, error, clearError } = useSession();
  const [tab, setTab] = useState<Tab>("memory");
  if (!session) return null;
  return (
    <main className="mx-auto grid min-h-dvh max-w-7xl grid-cols-1 md:grid-cols-[17rem_1fr]">
      <aside className="flex flex-col gap-8 border-b border-rule px-6 py-6 md:border-b-0 md:border-r md:py-10">
        <div className="flex items-center gap-3">
          <Seal size={28} />
          <span className="font-display text-2xl">Engram</span>
        </div>
        <div>
          <p className="font-mono text-[11px] uppercase tracking-wider text-ink-soft">Your vault</p>
          <a href={addressUrl(session.owner)} target="_blank" rel="noreferrer" className="mt-1 block font-mono text-sm underline decoration-rule underline-offset-4 hover:decoration-seal">
            {shortAddr(session.owner)}
          </a>
          <p className="mt-1 text-xs text-ink-soft">Monad testnet. Unlocked with your passkey.</p>
        </div>
        <nav className="flex gap-2 md:flex-col">
          {(["memory", "access"] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`btn px-3 py-2 text-left ${tab === t ? "bg-card border border-rule" : "border border-transparent hover:bg-card"}`}>
              {t === "memory" ? "Memory" : "Who can read it"}
            </button>
          ))}
        </nav>
        <button className="btn btn-ghost mt-auto justify-center px-3 py-2 text-sm" onClick={lock}>
          Lock vault
        </button>
      </aside>
      <section className="px-6 py-8 md:px-12 md:py-12">
        {error ? (
          <div role="alert" className="mb-6 flex items-start justify-between gap-4 rounded-sm border border-rust/40 bg-rust-soft px-4 py-3 text-sm text-rust">
            <span>{error}</span>
            <button onClick={clearError} className="font-mono text-xs underline">dismiss</button>
          </div>
        ) : null}
        {tab === "memory" ? <MemoryView /> : <AccessView />}
      </section>
    </main>
  );
}

function MemoryView() {
  const { run } = useSession();
  const [spaces, setSpaces] = useState<DiscoveredNamespace[] | null>(null);
  const [active, setActive] = useState("preferences");
  const [text, setText] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("preference");
  const [saving, setSaving] = useState(false);
  const [sealedAt, setSealedAt] = useState<number | null>(null);
  const [newLabel, setNewLabel] = useState("");

  const load = useCallback(async () => {
    // Wait out indexer lag: every namespace must be complete against chain nextSeq.
    const found = await run((s) => untilSettled(() => discoverLabels(s), (all) => all.every((n) => n.complete)));
    if (!found) return;
    setSpaces(found);
    if (found.length && !found.some((f) => f.label === active)) setActive(found[0]!.label);
  }, [run, active]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = spaces?.find((s) => s.label === active);
  const entries = useMemo(() => [...(current?.entries ?? [])].reverse(), [current]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setSaving(true);
    const ok = await run((s) => s.remember(active, { kind, text: text.trim() }));
    setSaving(false);
    if (ok) {
      setText("");
      setSealedAt(Date.now());
      await load();
    }
  }

  async function createFolder(e: React.FormEvent) {
    e.preventDefault();
    const label = newLabel.trim();
    if (!isValidLabel(label)) return;
    await run((s) => addLabel(s, label));
    setNewLabel("");
    setActive(label);
    await load();
  }

  const tabs = [...new Set(["preferences", ...(spaces ?? []).map((s) => s.label)])];

  return (
    <div className="max-w-3xl">
      <h2 className="font-display text-4xl tracking-tight md:text-5xl">What your AI knows about you</h2>
      <p className="mt-2 text-ink-soft">Encrypted before it leaves this device. Only you, and apps you approve per folder, can read it.</p>

      <div className="mt-8 flex flex-wrap items-end gap-1 border-b border-rule">
        {tabs.map((label) => (
          <button key={label} data-active={label === active} onClick={() => setActive(label)} className="folder-tab px-4 py-2 font-mono text-sm">
            {label}
            <span className="ml-2 text-ink-soft">{spaces?.find((s) => s.label === label)?.entries.length ?? 0}</span>
          </button>
        ))}
        <form onSubmit={createFolder} className="ml-auto flex items-center gap-2 pb-1.5">
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value.toLowerCase())}
            placeholder="new folder"
            aria-label="New folder name"
            className="w-32 rounded-sm border border-rule bg-card px-2 py-1 font-mono text-sm"
          />
          <button className="btn btn-ghost px-2 py-1 text-sm" disabled={!isValidLabel(newLabel)}>Add</button>
        </form>
      </div>

      <form onSubmit={save} className="index-card mt-6 p-5 pl-12">
        <label htmlFor="memory" className="font-mono text-[11px] uppercase tracking-wider text-ink-soft">Add to {active}</label>
        <textarea
          id="memory"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          maxLength={1500}
          placeholder="I am vegetarian and allergic to peanuts."
          className="mt-2 w-full resize-none bg-transparent text-lg leading-[1.8rem] outline-none placeholder:text-ink-soft/60"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <div className="flex gap-1" role="radiogroup" aria-label="Kind">
            {KINDS.map((k) => (
              <button type="button" role="radio" aria-checked={kind === k} key={k} onClick={() => setKind(k)}
                className={`rounded-sm border px-2.5 py-1 font-mono text-xs ${kind === k ? "border-seal bg-seal-soft text-seal" : "border-rule text-ink-soft"}`}>
                {k}
              </button>
            ))}
          </div>
          <button className="btn btn-primary ml-auto px-4 py-2" disabled={saving || !text.trim()}>
            {saving ? "Sealing…" : "Remember"}
          </button>
          {sealedAt && !saving ? <Seal key={sealedAt} size={26} className="seal-stamp" title="Sealed and stored on Monad" /> : null}
        </div>
      </form>

      <ul className="mt-8 space-y-4">
        {spaces === null ? <li className="text-ink-soft">Opening your memory…</li> : null}
        {spaces && entries.length === 0 ? <li className="text-ink-soft">Nothing in {active} yet.</li> : null}
        {entries.map((e, i) => (
          <MemoryCard key={`${e.seq}`} entry={e} delay={i * 45} />
        ))}
      </ul>
      {current && !current.complete ? (
        <p className="mt-4 font-mono text-xs text-rust">Some entries could not be loaded from the indexer yet. They are safe onchain; refresh in a moment.</p>
      ) : null}
    </div>
  );
}

function MemoryCard({ entry, delay }: { entry: RecalledEntry; delay: number }) {
  const cards = useAgentCards(entry.byOwner ? [] : [entry.agentId.toString()]);
  const author = entry.byOwner ? "You" : (cards[entry.agentId.toString()]?.name ?? `Agent #${entry.agentId}`);
  return (
    <li className="index-card settle px-5 py-4 pl-12" style={{ animationDelay: `${delay}ms` }}>
      <p className="text-lg leading-[1.8rem]">{entry.text}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-ink-soft">
        <span className={entry.byOwner ? "" : "text-seal"}>{entry.byOwner ? "Written by you" : `Written by ${author}`}</span>
        <span>{entry.kind}</span>
        <span>{relativeTime(entry.t)}</span>
        <a href={txUrl(entry.txHash)} target="_blank" rel="noreferrer" className="underline decoration-rule underline-offset-2 hover:text-ink">
          sealed #{entry.seq.toString()} on Monad
        </a>
      </div>
    </li>
  );
}

function AccessView() {
  const { run } = useSession();
  const [grants, setGrants] = useState<GrantView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (expect?: (g: GrantView[]) => boolean) => {
    // Discovery first so every namespace id maps back to its label in this session.
    await run((s) => discoverLabels(s));
    const g = await run((s) => untilSettled(() => s.grants(), expect ?? (() => true)));
    if (g) setGrants(g);
  }, [run]);

  useEffect(() => {
    void load();
  }, [load]);

  const cards = useAgentCards((grants ?? []).map((g) => g.agentId.toString()));
  const active = (grants ?? []).filter((g) => g.active);
  const past = (grants ?? []).filter((g) => !g.active);

  async function revoke(g: GrantView) {
    if (!g.label) return;
    const id = `${g.nsId}-${g.agentId}`;
    setBusy(id);
    await run((s) => s.revoke(g.label!, [g.agentId]));
    setBusy(null);
    await load((all) => !all.some((x) => x.nsId === g.nsId && x.agentId === g.agentId && x.active));
  }

  return (
    <div className="max-w-3xl">
      <h2 className="font-display text-4xl tracking-tight md:text-5xl">Who can read your memory</h2>
      <p className="mt-2 text-ink-soft">
        Revoking changes the folder&apos;s key. The app keeps nothing new; what it already read cannot be un-shared, by anyone.
      </p>
      <ul className="mt-8 space-y-4">
        {grants === null ? <li className="text-ink-soft">Checking access…</li> : null}
        {grants && active.length === 0 ? <li className="text-ink-soft">No app can read your memory right now.</li> : null}
        {active.map((g) => {
          const card = cards[g.agentId.toString()];
          const id = `${g.nsId}-${g.agentId}`;
          return (
            <li key={id} className="paper-card settle grid grid-cols-[1fr_auto] items-center gap-4 px-5 py-4">
              <div>
                <p className="font-medium">{card?.name ?? `Agent #${g.agentId}`}</p>
                <p className="mt-0.5 text-sm text-ink-soft">{card?.description ?? "ERC-8004 registered agent"}</p>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-ink-soft">
                  <span>folder: {g.label ?? "unknown"}</span>
                  <span className={g.scope === "readwrite" ? "text-rust" : "text-seal"}>{g.scope === "readwrite" ? "can read and add" : "can read"}</span>
                  <span>{expiresIn(g.expiry)}</span>
                  {!g.keysCurrent ? <span className="text-rust">agent identity changed hands</span> : null}
                </div>
              </div>
              <button className="btn btn-danger px-3 py-2 text-sm" disabled={busy === id || !g.label} onClick={() => void revoke(g)}>
                {busy === id ? "Revoking…" : "Revoke"}
              </button>
            </li>
          );
        })}
      </ul>
      {past.length ? (
        <details className="mt-10">
          <summary className="cursor-pointer font-mono text-xs uppercase tracking-wider text-ink-soft">History ({past.length})</summary>
          <ul className="mt-3 space-y-2">
            {past.map((g) => (
              <li key={`${g.nsId}-${g.agentId}`} className="flex justify-between border-b border-rule py-2 text-sm text-ink-soft">
                <span>{cards[g.agentId.toString()]?.name ?? `Agent #${g.agentId}`} · {g.label ?? "folder"}</span>
                <span className="font-mono text-xs">revoked or expired</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
