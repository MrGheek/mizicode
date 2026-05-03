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
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: [
        "src/routes/coordination.ts",
        "src/services/lane-policy.ts",
      ],
      thresholds: {
        lines: 80,
        branches: 68,
        functions: 80,
        statements: 77,
      },
    },
  },
});
