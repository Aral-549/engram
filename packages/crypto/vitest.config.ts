import { defineConfig } from "vitest/config";

// Golden tests live outside the package (tests/golden is frozen ground truth, see AGENTS.md rule 3).
export default defineConfig({
  test: {
    include: ["../../tests/golden/crypto/**/*.test.ts", "../../tests/adversarial/crypto/**/*.test.ts", "src/**/*.test.ts"],
  },
});
