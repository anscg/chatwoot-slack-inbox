import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    clearMocks: true,
    setupFiles: ["tests/setup.ts"],
    // Each test spins up an in-process Postgres (PGlite, a WASM build). Running the files in
    // parallel starves them of CPU and they time out, so run one file at a time and allow
    // generously for the slowest (migrations on a fresh database).
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
