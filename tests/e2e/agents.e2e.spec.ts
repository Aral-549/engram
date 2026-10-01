// End-to-end: a brand-new user connects a KIMI agent app to a vault created inside the consent popup, then chats.
// Runs against Monad testnet with the local dev model standing in for KIMI (scripts/dev-model.ts).
// Covers contracts/apps.md cases 2, 4 (partly), V5 and the app-session flow.
// Prereqs: indexer, dev model, vault (3100), Sage (3201), Wayfarer (3202) running (see README).
import { expect, test, type Page } from "@playwright/test";

const AUTH = { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true } as const;

async function connectWithNewVault(page: Page) {
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect your memory" }).click();
  const popup = await popupPromise;
  const cdp = await popup.context().newCDPSession(popup);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: AUTH });
  await expect(popup.getByText("wants to read part of your memory")).toBeVisible();
  await popup.getByRole("button", { name: "New here? Create a vault and approve" }).click();
  await expect(popup.getByRole("heading", { name: "Access granted" })).toBeVisible({ timeout: 90_000 });
  await popup.waitForEvent("close", { timeout: 10_000 }).catch(() => undefined);
}

test("Sage: connect from the app with a new vault, then it saves what you tell it onchain", async ({ page }) => {
  await page.goto("http://localhost:3201/");
  await connectWithNewVault(page);
  await expect(page.getByText("memory connected · can read and add")).toBeVisible();

  await page.getByLabel("Message Sage").fill("I am vegetarian and I am allergic to peanuts.");
  await page.getByRole("button", { name: "Send" }).click();
  const chip = page.getByRole("link", { name: "saved to your memory: I am vegetarian" });
  await expect(chip).toBeVisible({ timeout: 90_000 });
  await expect(chip).toHaveAttribute("href", /monadvision\.com\/tx\/0x[0-9a-f]{64}/);
  await expect(page.getByRole("link", { name: "saved to your memory: I am allergic to peanuts" })).toBeVisible();

  await page.getByLabel("Message Sage").fill("What do you know about me?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/From what you shared: .*I am vegetarian.*peanuts/)).toBeVisible({ timeout: 60_000 });
});

test("Wayfarer: read-only connection, plans without a remember tool", async ({ page }) => {
  await page.goto("http://localhost:3202/");
  await connectWithNewVault(page);
  await expect(page.getByText("memory connected · read only")).toBeVisible();
  await page.getByLabel("Message Wayfarer").fill("Plan a weekend in Goa for me.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/\[dev model\] Here is a quick plan/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("link", { name: /saved to your memory/ })).toHaveCount(0);
});
