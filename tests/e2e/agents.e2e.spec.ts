// End-to-end, Disclosure mode (contracts/disclosure.md): a new user connects Sage and Wayfarer, unlocks the vault
// bridge inside each app, and chats. The agents never hold a key: every answer comes from the vault, through the
// bridge iframe, and every read is logged. Monad testnet, with the local dev model standing in for KIMI.
// Prereqs: indexer, dev model, vault (3100), Sage (3201), Wayfarer (3202) running, AGENT_MODE=disclosure.
// Uses a synced-passkey stand-in (tests/support/fake-passkey.ts) so popup and iframe share one passkey.
import { expect, test, type Page } from "@playwright/test";
import { fakePasskeyScript } from "../support/fake-passkey.js";

test.beforeEach(async ({ context }, info) => {
  await context.addInitScript({ content: fakePasskeyScript(`e2e-${info.title}-${Date.now()}`) });
});

async function connectAndUnlock(page: Page) {
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect your memory" }).click();
  const popup = await popupPromise;
  await expect(popup.getByText("wants to read part of your memory")).toBeVisible();
  await expect(popup.getByText("It never gets a key.")).toBeVisible();
  await popup.getByRole("button", { name: "New here? Create a vault and approve" }).click();
  await expect(popup.getByRole("heading", { name: "Access granted" })).toBeVisible({ timeout: 90_000 });
  await popup.waitForEvent("close", { timeout: 10_000 }).catch(() => undefined);
  const strip = page.frameLocator("iframe.engram-bridge");
  await strip.getByRole("button", { name: "Unlock memory" }).click();
  await expect(strip.getByText("sharing only what is relevant")).toBeVisible({ timeout: 60_000 });
  return strip;
}

test("Sage: proposals are saved by the vault, and a full read is logged", async ({ page }) => {
  await page.goto("http://localhost:3201/");
  const strip = await connectAndUnlock(page);
  await expect(page.getByText("memory connected · can read and add")).toBeVisible();

  await page.getByLabel("Message Sage").fill("I am vegetarian and I am allergic to peanuts.");
  await page.getByRole("button", { name: "Send" }).click();
  const chip = page.getByRole("link", { name: "saved to your memory: I am vegetarian" });
  await expect(chip).toBeVisible({ timeout: 90_000 });
  await expect(chip).toHaveAttribute("href", /monadvision\.com\/tx\/0x[0-9a-f]{64}/);
  await expect(page.getByRole("link", { name: "saved to your memory: I am allergic to peanuts" })).toBeVisible();
  await expect(strip.getByText(/Saved for you: I am/)).toBeVisible();

  await page.getByLabel("Message Sage").fill("What do you know about me?");
  await page.getByRole("button", { name: "Send" }).click();
  // A full read returns newest first (contracts/disclosure.md, full mode), so either order is correct here.
  await expect(page.getByText(/From what you shared: .*(I am vegetarian.*peanuts|peanuts.*I am vegetarian)/)).toBeVisible({ timeout: 60_000 });
  await expect(strip.getByText(/Full read 2: /)).toBeVisible();

  // The owner's vault shows the proposals credited to Sage and the reads log.
  const vault = await page.context().newPage();
  await vault.goto("http://localhost:3100/");
  await vault.getByRole("button", { name: "I already have one, unlock it" }).click();
  await expect(vault.getByRole("heading", { name: "What your AI knows about you" })).toBeVisible({ timeout: 60_000 });
  // Locally the card proxy is https-only, so the name falls back to the agent id; deployed it reads "Sage".
  await expect(vault.getByText(/Proposed by (Sage|Agent #\d+)/).first()).toBeVisible({ timeout: 60_000 });
  await vault.getByRole("button", { name: "Reads" }).click();
  await expect(vault.getByText("asked for everything").first()).toBeVisible({ timeout: 60_000 });
});

test("Wayfarer: read-only, plans without writing; revoke in the strip and it forgets at once", async ({ page }) => {
  await page.goto("http://localhost:3202/");
  const strip = await connectAndUnlock(page);
  await expect(page.getByText("memory connected · read only")).toBeVisible();
  await page.getByLabel("Message Wayfarer").fill("Plan a weekend in Goa for me.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/\[dev model\] Here is a quick plan/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("link", { name: /saved to your memory/ })).toHaveCount(0);
  await expect(strip.getByText(/Asked, nothing relevant shared/)).toBeVisible();

  await strip.getByRole("button", { name: "Revoke" }).click();
  await expect(strip.getByText("Not approved for this site")).toBeVisible({ timeout: 60_000 });
  await page.getByLabel("Message Wayfarer").fill("Plan three dinners for this week.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/You revoked my access/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/Access revoked by you/)).toBeVisible();
});
