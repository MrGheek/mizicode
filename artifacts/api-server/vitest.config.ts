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
  },
});
