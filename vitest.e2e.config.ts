import { defineConfig } from "vitest/config";
import { leakGate } from "./test/support/leak-gate.js";

// the browser journeys (docs/testing.md): each test starts the production Supervisor over the scripted T3 peer, its own
// Chromium and its own temporary state on ephemeral loopback ports, so the files run one at a time, under the same leak
// detector and gate as every other phase. A journey bounds itself; 120 s covers a start, a restart and a browser
const journeyBound = 120_000;

export default defineConfig({
  plugins: [leakGate()],
  test: {
    include: ["test/e2e/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    isolate: true,
    fileParallelism: false,
    testTimeout: journeyBound,
    hookTimeout: 30_000,
    teardownTimeout: 30_000,
    detectAsyncLeaks: true,
    execArgv: ["--expose-gc"],
    setupFiles: ["test/support/leak-collect.ts"],
    reporters: ["default"],
  },
});
