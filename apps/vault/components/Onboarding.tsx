"use client";
import { Seal } from "./Seal";
import { LedgerSpecimen } from "./LedgerSpecimen";
import { useSession } from "./SessionProvider";
import { Words } from "./Words";

const REGISTRY = "0x733d1Bf4DC13B721a2Ce3DDCFb444795eFF59d31";
const REPO = "https://github.com/Aral-549/hippo";

const steps = [
  ["One passkey", "Face ID, Touch ID, or your phone. No seed phrase, no extension, no email code. The same passkey opens your vault on every device."],
  ["Agents ask, the vault answers", "An approved assistant never gets a key. For each message it asks your vault, which shares only what is relevant from the folders you chose, and logs every read."],
  ["Take it back", "Revoke any app in one tap. Your vault simply stops answering it, starting with the next message."],
] as const;

const snippet = [
  ["c", "// in your app: ask the user to approve one folder"],
  ["k", "const { sessionProof } = await connectEngram({"],
  ["v", '  vaultUrl, agentId, labels: ["preferences"], scope: "read",'],
  ["k", "});"],
  ["c", "// per message: the user's vault shares only what is relevant"],
  ["k", "const vault = openVaultBridge({ vaultUrl, agentId, mount });"],
  ["k", "const { entries } = await vault.disclose(userMessage);"],
] as const;

export function Onboarding({ locked = false }: { locked?: boolean }) {
  const { signUp, signIn, status, error } = useSession();
  const busy = status === "working";

  const actions = (
    <div className="flex flex-col gap-3 sm:flex-row">
      {locked ? null : (
        <button className="btn btn-primary lift justify-center px-6 py-3.5 text-base" onClick={() => void signUp()} disabled={busy}>
          <Seal size={18} /> {busy ? "Waiting for your passkey…" : "Create my memory vault"}
        </button>
      )}
      <button className={`btn lift justify-center px-6 py-3.5 ${locked ? "btn-primary text-base" : "btn-ghost"}`} onClick={() => void signIn()} disabled={busy}>
        {locked ? (busy ? "Waiting for your passkey…" : "Unlock vault") : "I already have one, unlock it"}
      </button>
    </div>
  );

  return (
    <main className="mx-auto max-w-6xl px-6 md:px-10">
      <header className="flex items-center gap-3 py-7 md:py-9">
        <Seal size={30} />
        <span className="font-display text-2xl tracking-tight">Engram</span>
        <span className="ml-2 rounded-sm border border-rule px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-ink-soft">Monad testnet</span>
        {locked ? null : (
          <nav className="ml-auto hidden gap-6 font-mono text-xs text-ink-soft sm:flex">
            <a href="#how" className="hover:text-ink">How it works</a>
            <a href="#builders" className="hover:text-ink">For builders</a>
            <a href={REPO} target="_blank" rel="noreferrer" className="hover:text-ink">GitHub</a>
          </nav>
        )}
      </header>

      <section className="grid grid-cols-1 items-center gap-12 pb-16 pt-4 md:min-h-[calc(100dvh-7rem)] md:grid-cols-[1.2fr_1fr] md:gap-16 md:pb-24">
        <div>
          <p className="settle mb-5 font-mono text-xs uppercase tracking-[0.2em] text-seal">{locked ? "Vault locked" : "Your AI memory, owned by you"}</p>
          <h1 className="font-display text-[clamp(2.7rem,6vw,5.4rem)] leading-[0.95] tracking-tight">
            {locked ? (
              <>
                <Words>Unlock with the passkey you</Words>{" "}
                <em className="ink-mark text-seal">
                  <Words start={5}>sealed it</Words>
                </em>{" "}
                <Words start={7}>with.</Words>
              </>
            ) : (
              <>
                <Words>One memory for every AI you use,</Words>{" "}
                <em className="ink-mark text-seal">
                  <Words start={7}>sealed</Words>
                </em>{" "}
                <Words start={8}>with your passkey.</Words>
              </>
            )}
          </h1>
          <p className="settle mt-7 max-w-xl text-lg leading-relaxed text-ink-soft" style={{ animationDelay: "650ms" }}>
            Your assistant learns you once. Other AI apps ask your vault and get only what is relevant to the question, never a key,
            and every read is logged. Memory is encrypted on your device before it is stored on Monad, so no company, including us,
            can read it.
          </p>
          <div className="settle mt-9" style={{ animationDelay: "800ms" }}>
            {actions}
          </div>
          {error ? (
            <p role="alert" className="mt-5 max-w-xl rounded-sm border border-rust/40 bg-rust-soft px-3 py-2.5 text-sm text-rust">
              {error}
            </p>
          ) : null}
          <p className="settle mt-6 font-mono text-xs text-ink-soft" style={{ animationDelay: "950ms" }}>
            Keys come from your passkey on every sign-in. Nothing is stored in this browser.
          </p>
        </div>
        <div className="settle" style={{ animationDelay: "300ms" }}>
          <LedgerSpecimen />
        </div>
      </section>

      {locked ? null : (
        <>
          <section id="how" className="grid gap-10 border-t border-rule py-16 md:grid-cols-[14rem_1fr] md:py-24">
            <h2 className="font-display text-4xl leading-none tracking-tight">How it works</h2>
            <ol className="stagger divide-y divide-rule">
              {steps.map(([title, body], i) => (
                <li key={title} className="grid grid-cols-[3.5rem_1fr] gap-4 py-6 first:pt-0 md:grid-cols-[5rem_1fr_1.3fr] md:items-baseline" style={{ ["--i" as string]: i }}>
                  <span className="font-display text-5xl leading-none text-rust md:text-6xl">{i + 1}</span>
                  <p className="font-display text-2xl leading-tight md:text-3xl">{title}</p>
                  <p className="col-start-2 leading-relaxed text-ink-soft md:col-start-auto">{body}</p>
                </li>
              ))}
            </ol>
          </section>

          <section id="builders" className="grid gap-10 border-t border-rule py-16 md:grid-cols-[1fr_1.2fr] md:items-center md:py-24">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-seal">For builders</p>
              <h2 className="mt-4 font-display text-4xl leading-[1.02] tracking-tight md:text-5xl">
                Give your agent a memory your users <em className="text-seal">trust</em>.
              </h2>
              <p className="mt-5 max-w-md leading-relaxed text-ink-soft">
                Your agent is an ERC-8004 identity. Users approve it per folder; it asks their vault for what is relevant, so you hold no
                keys, no user database, and no plaintext. Your server never touches the chain.
              </p>
              <a href={`${REPO}/blob/main/docs/INTEGRATE.md`} target="_blank" rel="noreferrer" className="btn btn-ghost lift mt-7 px-5 py-3">
                Read the integration guide
              </a>
            </div>
            <pre className="lift overflow-x-auto rounded-sm bg-ink p-6 font-mono text-[13px] leading-7 text-[#e9e3d6] shadow-[0_18px_40px_-24px_rgba(27,25,22,0.8)]">
              <code className="stagger block">
                {snippet.map(([t, line], i) => (
                  <span key={i} className={`block ${t === "c" ? "text-[#9c958a]" : t === "v" ? "text-[#c9e0d4]" : ""}`} style={{ ["--i" as string]: i, ["--d" as string]: "200ms" }}>
                    {line}
                  </span>
                ))}
              </code>
            </pre>
          </section>

          <footer className="flex flex-col gap-3 border-t border-rule py-8 font-mono text-[11px] text-ink-soft sm:flex-row sm:items-center sm:justify-between">
            <span>Built on Monad · ERC-8004 agent identities · Mera passkeys · Envio</span>
            <a href={`https://testnet.monadvision.com/address/${REGISTRY}`} target="_blank" rel="noreferrer" className="underline decoration-rule underline-offset-4 hover:text-ink">
              MemoryRegistry {REGISTRY.slice(0, 6)}…{REGISTRY.slice(-4)}
            </a>
          </footer>
        </>
      )}
    </main>
  );
}
