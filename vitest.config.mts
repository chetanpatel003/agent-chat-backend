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
    // Checkpoint 2.4's guarded-transition tests do substantially more
    // DB round trips per test (several status reads per loop round,
    // plus a cancellation's own transaction) — Vitest's 10s default
    // hookTimeout was observed failing a `beforeEach`/`afterAll` even
    // though the test it was attributed to had already produced the
    // exact correct result (confirmed with timestamped diagnostics,
    // not assumed); 20s still wasn't enough under the full suite's
    // cumulative Neon connection load, so raised further.
    hookTimeout: 45000,
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
