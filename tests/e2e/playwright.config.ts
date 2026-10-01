import { defineConfig } from "@playwright/test";

// Real browser, real passkey ceremonies (Chromium virtual authenticator with PRF), real Monad testnet.
// Prereqs: indexer running (indexer/README.md), apps/vault/.env.local, `npm run build -w @engram/vault`.
export default defineConfig({
  testDir: ".",
  timeout: 240_000,
  expect: { timeout: 60_000 },
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:3100", trace: "retain-on-failure" },
  webServer: { command: "npm run start -w @engram/vault", url: "http://localhost:3100", reuseExistingServer: true, timeout: 120_000 },
});
