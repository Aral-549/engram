// End-to-end: onboarding -> first memory -> stateless unlock -> consent grant -> revoke, against Monad testnet.
// Covers contracts/apps.md cases 1, 5, 7 and the Mera UX bounty checks (one ceremony, time to first tx, stateless test).
import { expect, test, type Page } from "@playwright/test";

async function addPasskeyProvider(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true },
  });
  return cdp;
}

test("passkey vault end to end on Monad testnet", async ({ page }) => {
  const memory = `vegetarian and allergic to peanuts (e2e ${Date.now()})`;
  const logs: string[] = [];
  page.on("console", (m) => { if (m.text().includes("[engram]")) logs.push(m.text()); });

  await page.goto("/");
  const cdp = await addPasskeyProvider(page);
  const failed = () => logs.filter((l) => l.includes('"ok":false')).slice(-8).join("\n");
  try {

  // 1. One-prompt onboarding and the first confirmed Monad transaction.
  const t0 = Date.now();
  await page.getByRole("button", { name: "Create my memory vault" }).click();
  await expect(page.getByRole("heading", { name: "What your AI knows about you" })).toBeVisible();
  const owner = (await page.locator("aside a").first().textContent())!.trim();
  await page.getByLabel(/Add to preferences/).fill(memory);
  await page.getByRole("button", { name: "Remember" }).click();
  // The saved index card (not the textarea) appears only after the Monad tx is confirmed and indexed.
  await expect(page.locator("ul li", { hasText: memory })).toBeVisible({ timeout: 90_000 });
  const firstTxMs = Date.now() - t0;
  test.info().annotations.push({ type: "time-to-first-tx-ms", description: String(firstTxMs) });
  console.log(JSON.stringify({ stage: "e2e", op: "first-tx", ms: firstTxMs, owner }));
  await expect(page.getByRole("link", { name: /sealed #\d+ on Monad/ }).first()).toHaveAttribute("href", /monadvision\.com\/tx\/0x/);

  // 2. Stateless test: wipe every kind of site data, reload, unlock with the same passkey.
  await cdp.send("Storage.clearDataForOrigin", { origin: new URL(page.url()).origin, storageTypes: "all" });
  await page.reload();
  await expect(page.getByRole("button", { name: "Create my memory vault" })).toBeVisible();
  await page.getByRole("button", { name: "I already have one, unlock it" }).click();
  await expect(page.locator("aside a").first()).toHaveText(owner);
  await expect(page.locator("ul li", { hasText: memory })).toBeVisible();

  // 3. Consent: an app asks agent 1961 for read access to "preferences".
  await page.goto(`/connect?v=1&agentId=1961&labels=preferences&scope=read&expiresInSec=3600&origin=${encodeURIComponent("http://127.0.0.1:3100")}`);
  await expect(page.getByText("wants to read part of your memory")).toBeVisible();
  await expect(page.getByText("not listed by this agent")).toBeVisible();
  await expect(page.getByText("Read only")).toBeVisible();
  await page.getByRole("button", { name: "Unlock and approve" }).click();
  await expect(page.getByRole("heading", { name: "Access granted" })).toBeVisible({ timeout: 90_000 });

  // 4. Revoke from the vault.
  await page.goto("/");
  await page.getByRole("button", { name: "I already have one, unlock it" }).click();
  await page.getByRole("button", { name: "Who can read it" }).click();
  const row = page.locator("li", { hasText: "Agent #1961" });
  await expect(row).toBeVisible();
  await expect(row.getByText("can read")).toBeVisible();
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("No app can read your memory right now.")).toBeVisible({ timeout: 90_000 });

  } catch (e) {
    console.log("failed SDK lines:\n" + failed());
    throw e;
  }

  // No secrets in the browser console.
  expect(logs.join("\n")).not.toMatch(/prfOutput|accountKey|privateKey/i);
});
