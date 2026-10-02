// Spike (2026-10-02): WebAuthn create+get with PRF inside a CROSS-SITE iframe and in a popup, plus postMessage round
// trip, in Playwright Chromium with the CDP virtual authenticator. Run from the repo root: node docs/design/spikes/bridge-transport.mjs
// Uses https with a throwaway self-signed cert pinned via --ignore-certificate-errors-spki-list (WebAuthn is disabled on cert errors).
import { createServer } from "node:https";
import { chromium } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const D = mkdtempSync(join(tmpdir(), "bridge-spike-"));
const S_DIR = join(D, "profile");
execSync(`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout ${D}/key.pem -out ${D}/cert.pem -days 1 -subj /CN=spike -addext subjectAltName=DNS:vault.test,DNS:app.test`, { stdio: "ignore" });
const SPKI = execSync(`openssl x509 -in ${D}/cert.pem -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`).toString().trim();
const TLS = { key: readFileSync(`${D}/key.pem`), cert: readFileSync(`${D}/cert.pem`) };

const VAULT = "https://vault.test:4502", APP = "https://app.test:4501";
const vaultHtml = `<!doctype html><body><button id="go">unlock</button><pre id="out"></pre><script>
const salt = new Uint8Array(32).fill(7);
localStorage.setItem("probe-" + (window.top === window ? "top" : "frame"), "1");
document.getElementById("go").onclick = async () => {
  const r = {};
  try {
    const c = await navigator.credentials.create({ publicKey: {
      rp: { id: "vault.test", name: "v" }, user: { id: new Uint8Array(16), name: "u", displayName: "u" },
      challenge: new Uint8Array(32), pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: { prf: {} } } });
    r.createPrf = c.getClientExtensionResults().prf;
    const a = await navigator.credentials.get({ publicKey: { rpId: "vault.test", challenge: new Uint8Array(32),
      userVerification: "required", extensions: { prf: { eval: { first: salt } } } } });
    const f = a.getClientExtensionResults().prf?.results?.first;
    r.getPrfBytes = f ? new Uint8Array(f).length : 0;
  } catch (e) { r.error = e.name + ": " + e.message; }
  r.topProbeVisible = localStorage.getItem("probe-top");
  r.inFrame = window.top !== window;
  document.getElementById("out").textContent = JSON.stringify(r);
  (window.top !== window ? parent : opener)?.postMessage({ type: "spike", r }, "${APP}");
};
</script>`;
const appHtml = (mode) => `<!doctype html><body><script>
addEventListener("message", (e) => { if (e.origin === "${VAULT}") document.title = "DONE " + JSON.stringify(e.data.r); });
</script>${mode === "iframe" ? `<iframe id="v" src="${VAULT}/" allow="publickey-credentials-create *; publickey-credentials-get *" width=600 height=300></iframe>` : `<button id="open" onclick="window.w=open('${VAULT}/','v','popup')">open</button>`}`;

createServer(TLS, (q, s) => s.writeHead(200, { "content-type": "text/html" }).end(vaultHtml)).listen(4502);
createServer(TLS, (q, s) => s.writeHead(200, { "content-type": "text/html" }).end(appHtml(q.url.includes("popup") ? "popup" : "iframe"))).listen(4501);

const ctx = await chromium.launchPersistentContext(S_DIR, { args: [
  "--host-resolver-rules=MAP vault.test 127.0.0.1, MAP app.test 127.0.0.1",
  `--ignore-certificate-errors-spki-list=${SPKI}` ] });
const browser = ctx;
async function addAuth(page) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true } });
}
// top-level visit to the vault first (to test partitioning)
const top = await ctx.newPage(); await top.goto(VAULT + "/"); await top.close();

const page = await ctx.newPage(); await addAuth(page);
await page.goto(APP + "/iframe");
const frame = page.frameLocator("#v");
await frame.locator("#go").click();
await page.waitForFunction(() => document.title.startsWith("DONE"), null, { timeout: 15000 }).catch(() => {});
console.log("IFRAME:", await page.title(), "|", await frame.locator("#out").textContent());

const p2 = await ctx.newPage(); await addAuth(p2);
await p2.goto(APP + "/popup");
const [pop] = await Promise.all([p2.waitForEvent("popup"), p2.click("#open")]);
await addAuth(pop);
await pop.click("#go");
await p2.waitForFunction(() => document.title.startsWith("DONE"), null, { timeout: 15000 }).catch(() => {});
console.log("POPUP:", await p2.title());
await browser.close(); process.exit(0);
