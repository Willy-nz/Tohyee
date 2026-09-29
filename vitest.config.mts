import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Each file gets its own process, core database and organisation databases.
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
