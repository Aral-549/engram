// Browser-side stand-in for a SYNCED passkey provider, for Playwright only. Not a golden file.
//
// Why: Chromium's CDP virtual authenticator is per tab, so a vault created in the connect popup cannot be unlocked
// from the bridge iframe on the agent page, though real users have one platform passkey everywhere. This init script
// replaces navigator.credentials in every page and frame of a browser context with one deterministic credential:
// PRF(rpId, salt) = HMAC-SHA256(sha256(seed + "/secret"), rpId || salt), the same in every realm, like a synced
// passkey. Mera only reads rawId and the PRF extension result, so its real ceremony code runs unchanged.
// Production code never loads this.
export function fakePasskeyScript(seed: string): string {
  return `(() => {
  const SEED = ${JSON.stringify(seed)};
  const enc = new TextEncoder();
  const sha = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  const bytes = (b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
  async function credential(rpId, salt) {
    const id = await sha(SEED + "/id");
    const secret = await sha(SEED + "/secret");
    const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const prf = new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array([...enc.encode(rpId), ...bytes(salt)])));
    window.__fakePasskeyCalls = (window.__fakePasskeyCalls || 0) + 1;
    return {
      type: "public-key",
      id: btoa(String.fromCharCode(...id)).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""),
      rawId: id.buffer,
      authenticatorAttachment: "platform",
      response: { getTransports: () => ["internal"] },
      getClientExtensionResults: () => ({ prf: { enabled: true, results: { first: prf.buffer } } }),
    };
  }
  const fake = {
    create: async (o) => credential(o.publicKey.rp.id || location.hostname, o.publicKey.extensions.prf.eval.first),
    get: async (o) => credential(o.publicKey.rpId || location.hostname, o.publicKey.extensions.prf.eval.first),
  };
  Object.defineProperty(navigator, "credentials", { value: fake, configurable: true });
})();`;
}
