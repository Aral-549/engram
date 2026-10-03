"use client";
// A live specimen of a vault ledger for the landing page (contracts/apps.md V8, V9): rows are written one by one,
// sealed, read, then revoked, and the loop starts again. Static with prefers-reduced-motion.
import { useEffect, useState } from "react";
import { Seal } from "./Seal";

type Row = { who: string; what: string; meta: string; tone: "you" | "agent" | "read" | "revoke" };
const ROWS: Row[] = [
  { who: "You", what: "Vegetarian, no eggs either", meta: "#41 · sealed on Monad", tone: "you" },
  { who: "Sage", what: "Allergic to peanuts", meta: "#42 · proposed by Sage", tone: "agent" },
  { who: "Wayfarer", what: 'asked about dinner, got 1 memory', meta: "1 of 2 shared · logged", tone: "read" },
  { who: "You", what: "revoked Wayfarer", meta: "the vault stops answering", tone: "revoke" },
];
const STEP_MS = 1700;

export function LedgerSpecimen() {
  const [shown, setShown] = useState(ROWS.length);
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setShown(0);
    let n = 0;
    const t = setInterval(() => {
      n += 1;
      if (n > ROWS.length + 2) {
        n = 0;
        setCycle((c) => c + 1);
      }
      setShown(Math.min(n, ROWS.length));
    }, STEP_MS);
    return () => clearInterval(t);
  }, []);

  return (
    <figure className="paper-card relative overflow-hidden p-6 pl-12 md:p-8 md:pl-14" aria-label="Example of a vault ledger">
      <span aria-hidden className="absolute inset-y-0 left-7 w-px bg-rust/25 md:left-9" />
      <figcaption className="flex items-center justify-between gap-3 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-soft">
        <span>Specimen · your vault</span>
        <span className="flex shrink-0 items-center gap-2 whitespace-nowrap normal-case tracking-normal">
          <span className="live-dot" aria-hidden /> live on Monad
        </span>
      </figcaption>
      <p className="mt-4 font-display text-3xl leading-none">preferences</p>
      <ol key={cycle} className="mt-5 space-y-0">
        {ROWS.map((r, i) => (
          <li
            key={r.what}
            className={`grid min-h-[3.6rem] grid-cols-[1fr_auto] items-center gap-3 border-b border-rule/70 py-2 transition-opacity duration-500 ${i < shown ? "opacity-100" : "opacity-0"}`}
          >
            <div className={i < shown ? "ink-in" : ""}>
              <p className="font-mono text-[11px] text-ink-soft">
                <span className={r.tone === "agent" ? "text-seal" : r.tone === "revoke" ? "text-rust" : r.tone === "read" ? "text-ink" : ""}>{r.who}</span>
                <span className="mx-1.5 text-rule">/</span>
                {r.meta}
              </p>
              <p className={`text-lg leading-snug ${r.tone === "revoke" && i < shown ? "strike inline-block" : ""}`}>{r.what}</p>
            </div>
            {i < shown && (r.tone === "you" || r.tone === "agent") ? <Seal size={22} className="seal-stamp" /> : <span className="w-[22px]" />}
          </li>
        ))}
      </ol>
      <p className="mt-5 font-mono text-[11px] leading-relaxed text-ink-soft">
        Only ciphertext goes onchain. Agents don&apos;t get a key; they ask, and your vault answers with what fits and keeps a note of it.
      </p>
    </figure>
  );
}
