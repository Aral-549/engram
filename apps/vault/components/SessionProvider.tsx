"use client";
// In-memory session only (nothing written to storage: the vault must pass the stateless test).
import { EngramOwner, type OwnerSession } from "@engram/sdk";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { explain, rpId, vaultConfig } from "@/lib/engram";

type Status = "signed-out" | "working" | "ready" | "locked";
type Ctx = {
  status: Status;
  session: OwnerSession | null;
  error: string | null;
  signUp: () => Promise<OwnerSession | null>;
  signIn: () => Promise<OwnerSession | null>;
  lock: () => void;
  /** Runs an action; an expired/ended session flips the UI to the unlock screen. */
  run: <T>(fn: (s: OwnerSession) => Promise<T>) => Promise<T | undefined>;
  clearError: () => void;
};

const SessionContext = createContext<Ctx | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("signed-out");
  const [session, setSession] = useState<OwnerSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hadSession = useRef(false);
  // The live session, readable from callbacks created before sign-in finished (e.g. "Unlock and approve").
  const current = useRef<OwnerSession | null>(null);

  const open = useCallback(async (how: "up" | "in") => {
    setError(null);
    setStatus("working");
    try {
      const config = vaultConfig();
      const s =
        how === "up"
          ? await EngramOwner.signUp({ config, rpId: rpId(), rpName: "Engram", userName: `Engram vault ${new Date().toLocaleDateString()}` })
          : await EngramOwner.signIn({ config, rpId: rpId() });
      hadSession.current = true;
      current.current = s;
      setSession(s);
      setStatus("ready");
      return s;
    } catch (e) {
      setError(explain(e));
      setStatus(hadSession.current ? "locked" : "signed-out");
      return null;
    }
  }, []);

  const lock = useCallback(() => {
    current.current?.end();
    current.current = null;
    setSession(null);
    setStatus("locked");
  }, []);

  const run = useCallback(
    async <T,>(fn: (s: OwnerSession) => Promise<T>) => {
      const s = current.current;
      if (!s) return undefined;
      try {
        setError(null);
        return await fn(s);
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === "SESSION_EXPIRED" || code === "SESSION_ENDED") {
          s.end();
          current.current = null;
          setSession(null);
          setStatus("locked");
        }
        setError(explain(e));
        return undefined;
      }
    },
    [],
  );

  const value = useMemo<Ctx>(
    () => ({ status, session, error, signUp: () => open("up"), signIn: () => open("in"), lock, run, clearError: () => setError(null) }),
    [status, session, error, open, lock, run],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Ctx {
  const c = useContext(SessionContext);
  if (!c) throw new Error("useSession outside SessionProvider");
  return c;
}
