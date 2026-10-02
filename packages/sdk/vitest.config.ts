import { defineConfig } from "vitest/config";

// Golden tests live in tests/golden/sdk (frozen, AGENTS.md rule 3). They run against a local anvil chain with the
// real MemoryRegistry bytecode (chain/out), so run `forge build` in chain/ first.
export default defineConfig({
  test: {
    include: ["../../tests/golden/sdk/**/*.test.ts", "../../tests/golden/disclosure/**/*.test.ts", "../../tests/adversarial/sdk/**/*.test.ts", "../../tests/adversarial/disclosure/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
