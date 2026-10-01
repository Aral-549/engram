import { defineConfig } from "vitest/config";

// Golden tests live in tests/golden/vault (frozen, AGENTS.md rule 3). They need chain/out (forge build).
export default defineConfig({
  test: {
    include: ["../../tests/golden/vault/**/*.test.ts", "../../tests/adversarial/vault/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
