import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/testSetup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/**/*.test.ts", "src/testSetup.ts"],
      // Regression floor, set just below the current numbers (lines ~99.2%,
      // statements ~98.5%, functions ~98.7%, branches ~95.1%). Vitest 5's v8
      // provider counts statements and functions per AST node rather than per
      // line, which is why those two sit below lines. Keep new code at or above.
      thresholds: {
        lines: 99,
        statements: 98,
        functions: 98,
        branches: 95,
      },
    },
  },
});
