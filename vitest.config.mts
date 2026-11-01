import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.{test,spec}.ts"],
    // Several test files open their own connection to Neon; a cold
    // compute can take longer than Vitest's 5s default to wake (same
    // finding as checkpoint 1.1 — see project-docs/decisions/0006).
    testTimeout: 20000,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
