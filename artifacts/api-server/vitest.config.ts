import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    hookTimeout: 30000,
    testTimeout: 15000,
    sequence: {
      concurrent: false,
    },
    setupFiles: ["src/tests/setup.ts"],
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: [
        "src/routes/coordination.ts",
        "src/routes/orchestrate.ts",
        "src/services/lane-policy.ts",
      ],
      thresholds: {
        lines: 74.5,
        branches: 62,
        functions: 78,
        statements: 70.8,
      },
    },
  },
});
