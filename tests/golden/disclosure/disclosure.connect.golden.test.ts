// Golden tests for the connect protocol's mode parameter (contracts/sdk.md cases 53, 54).
// Written from the spec before the implementation. FROZEN: add cases, never edit.
import { describe, expect, it } from "vitest";
import { connectEngram, parseConnectRequest } from "../../../packages/sdk/src/index.js";

const base = "https://vault.test/connect?v=1&agentId=7&labels=preferences&scope=read&expiresInSec=3600&origin=https%3A%2F%2Fapp.x";
async function code(f: () => unknown) {
  try {
    await f();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "NO_THROW";
}

describe("connect mode", () => {
  it("53 absent mode is offline (old links); disclosure and offline parse; anything else is rejected", async () => {
    expect(parseConnectRequest(base).mode).toBe("offline");
    expect(parseConnectRequest(`${base}&mode=disclosure`).mode).toBe("disclosure");
    expect(parseConnectRequest(`${base}&mode=offline`).mode).toBe("offline");
    expect(await code(() => parseConnectRequest(`${base}&mode=keys`))).toBe("INPUT_INVALID");
  });

  it("54 connectEngram asks for disclosure by default and returns the reply's mode", async () => {
    const listeners = new Set<(e: MessageEvent) => void>();
    const popup = { closed: false };
    let opened = "";
    const w = {
      open: (u: string) => ((opened = u), popup),
      addEventListener: (_t: string, f: (e: MessageEvent) => void) => listeners.add(f),
      removeEventListener: (_t: string, f: (e: MessageEvent) => void) => listeners.delete(f),
    };
    const p = connectEngram({ vaultUrl: "https://vault.test", agentId: 7n, labels: ["preferences"], scope: "read", expiresInSec: 3600, window: w as never, pollMs: 20 });
    expect(new URL(opened).searchParams.get("mode")).toBe("disclosure");
    const reply = { type: "engram:connect:result", v: 1, ok: true, owner: "0x" + "ab".repeat(20), granted: ["preferences"], txHash: "0x" + "cd".repeat(32), mode: "disclosure" };
    listeners.forEach((f) => f({ origin: "https://vault.test", data: reply, source: popup } as MessageEvent));
    await expect(p).resolves.toMatchObject({ mode: "disclosure", owner: reply.owner });
  });
});
