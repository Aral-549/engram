import { defineConfig } from "vitest/config";

// Golden tests live in tests/golden/agent-kit (frozen, AGENTS.md rule 3). Local anvil + fake KIMI endpoint.
export default defineConfig({
  test: {
    // INTEGRATION=1 runs the real-testnet integration tests instead (needs local vault relay + indexer).
    include: process.env.INTEGRATION === "1"
      ? ["../../tests/integration/register-agent*.test.ts"]
      : ["../../tests/golden/agent-kit/**/*.test.ts", "../../tests/adversarial/agent-kit/**/*.test.ts", "../../tests/golden/integration/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
