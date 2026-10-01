import { defineConfig } from "vitest/config";

// Golden tests live in tests/golden/agent-kit (frozen, AGENTS.md rule 3). Local anvil + fake KIMI endpoint.
export default defineConfig({
  test: {
    include: ["../../tests/golden/agent-kit/**/*.test.ts", "../../tests/adversarial/agent-kit/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
