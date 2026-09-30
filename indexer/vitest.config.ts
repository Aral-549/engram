import { defineConfig } from "vitest/config";

// Golden tests live in tests/golden/indexer (frozen ground truth, AGENTS.md rule 3). Run from indexer/
// because createTestIndexer loads ./config.yaml from the working directory.
// Integration tests hit real Monad testnet data through HyperSync: `npm run test:integration`.
const integration = process.env.INTEGRATION === "1";

export default defineConfig({
  test: {
    include: integration
      ? ["../tests/integration/indexer*.test.ts", "../tests/integration/hypersync*.test.ts"]
      : ["../tests/golden/indexer/**/*.test.ts", "../tests/adversarial/indexer/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: integration ? 300_000 : 20_000,
  },
});
