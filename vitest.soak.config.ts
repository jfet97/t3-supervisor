import { defineConfig } from "vitest/config";
import { leakGate } from "./test/support/leak-gate.js";

/* The scripted soaks (docs/testing.md, execution type 4): each runs the production Supervisor process against a loopback fake
 * T3 on the wall clock with its own temporary state and ports, so the files run one at a time under the same leak detector and
 * gate as every other phase. A soak sets its own timeout from the window it observes; they run only when invoked (`./dev soak`
 * or the manually dispatched extended workflow), never in the ordinary suites or on a schedule.
 */
export default defineConfig({
  plugins: [leakGate()],
  test: {
    include: ["test/soak/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    isolate: true,
    fileParallelism: false,
    hookTimeout: 30_000,
    teardownTimeout: 30_000,
    detectAsyncLeaks: true,
    execArgv: ["--expose-gc"],
    setupFiles: ["test/support/leak-collect.ts"],
    reporters: ["default"],
  },
});
