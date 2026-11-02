import tseslint from "typescript-eslint";

// src and ui/src start no raw timer (plan S8): no timer global, also through globalThis or window, and no timers module
const timerMessage = "src and ui/src start no raw timer; wait and repeat with Effect's Clock and Schedule (Effect.sleep, Schedule.spaced)";
const timerNames = ["setTimeout", "setInterval", "setImmediate", "clearTimeout", "clearInterval", "clearImmediate"];
const timerModules = ["timers", "node:timers", "timers/promises", "node:timers/promises"];
const loadExtension = { property: "loadExtension", message: "SQLite extension loading stays disabled (plan 3.2)" };
const timerRules = {
  "no-restricted-globals": ["error", ...timerNames.map((name) => ({ name, message: timerMessage }))],
  "no-restricted-properties": ["error", loadExtension,
    ...["globalThis", "window"].flatMap((object) => timerNames.map((property) => ({ object, property, message: timerMessage })))],
};

/*
 * The T3 integration boundary: production modules reach T3 only through the public surface src/t3-native/index.ts (T3Native).
 * They import none of the transport clients (the native envelope, the native and operate request clients and their shell reads,
 * the T3 client and its projection stream, the private T3Native modules) and write no native request tag or T3 API path. The
 * domain helpers of src/supervisor-native.ts (record, modelSelection, validModelSelection, sameModel) stay importable.
 */
const boundaryMessage = "production modules reach T3 only through src/t3-native/index.ts (T3Native); transport clients, native tags and T3 API paths stay behind it";
const boundaryPatterns = [
  { regex: "(^|/)(native-envelope|t3|t3-projection-stream)(\\.js)?$", message: boundaryMessage },
  { regex: "(^|/)supervisor-native(\\.js)?$", message: boundaryMessage, importNames: ["NativeRpc", "NativeOperateRpc", "NativeShell",
    "NativeRpcShape", "NativeRpcInFlight", "NativeShellShape", "SupervisorRpcError", "supervisorModels"] },
  { regex: "(^|/)t3-native/(?!index(\\.js)?$)", message: boundaryMessage },
];
// native request tags (orchestration.dispatchCommand, scheduledTasks.upsert, projects.readFile, ...) and T3's HTTP API paths
const boundarySyntax = [
  { selector: "Literal[value=/^(orchestration|scheduledTasks|projects|filesystem|terminal|git|vcs|server)\\.[A-Za-z]+$/]", message: boundaryMessage },
  { selector: "Literal[value='subscribeVcsStatus']", message: boundaryMessage },
  { selector: "Literal[value=/^\\/(api\\/(orchestration|hooks)|\\.well-known\\/t3)\\//]", message: boundaryMessage },
  { selector: "TemplateElement[value.raw=/^\\/(api\\/(orchestration|hooks)|\\.well-known\\/t3)\\//]", message: boundaryMessage },
];
/*
 * Outside the boundary: the integration itself and the legacy transport modules it wraps, the composition root that wires the
 * clients, and (transitional) the production modules not yet migrated onto T3Native; each migration removes its own entries and
 * the last one leaves the list empty. Tests, fixtures, support and scripts are outside src and never guarded.
 */
const t3Boundary = {
  adapter: ["src/t3-native/**/*.ts", "src/native-envelope.ts", "src/supervisor-native.ts", "src/t3.ts", "src/t3-projection-stream.ts"],
  composition: ["src/guidance-application.ts", "src/supervisor.ts"],
  // one module per line: each migration deletes exactly its own lines
  transitional: [
    "src/git-probe.ts",
    "src/guidance.ts",
    "src/project-definitions.ts",
    "src/project-files.ts",
    "src/project-supervisor.ts",
    "src/supervision-control.ts",
    "src/supervisor-compaction.ts",
    "src/supervisor-conversation.ts",
    "src/supervisor-helper-transport.ts",
    "src/supervisor-lifecycle.ts",
    "src/supervisor-planning-controller.ts",
    "src/supervisor-team-controller.ts",
    "src/supervisor-team-runtime.ts",
    "src/workflow-write-controller.ts",
  ],
};

// only src/db.ts and its database worker src/db-worker-serve.ts open SQLite clients (plan 3.2); src/db.ts, as the SQL layer
// and private files adapter, is the only module that imports node:sqlite in
// src and ui/src (plan section 11); only src/native-envelope.ts opens native T3 websockets in src (D-08); suites run on
// vitest; the package barrel and every subpath (for example @effect/sql-sqlite-node/SqliteClient)
const restrictedImports = ({ sqlite, ws, nodeSqlite = false, timers = false, boundary = false }) => ["error", {
  paths: [
    { name: "node:test", message: "the suites run on vitest" },
    ...(ws ? [{ name: "ws", message: "native T3 websockets go through src/native-envelope.ts (D-08)" }] : []),
    ...(nodeSqlite ? [{ name: "node:sqlite", message: "node:sqlite stays in the SQL layer and private files adapter src/db.ts (plan 3.2)" }] : []),
    ...(timers ? timerModules.map((name) => ({ name, message: timerMessage })) : []),
  ],
  patterns: [
    ...(sqlite ? [{ group: ["@effect/sql-sqlite-node", "@effect/sql-sqlite-node/*"], message: "only src/db.ts and its database worker open SQLite clients (plan 3.2)" }] : []),
    ...(boundary ? boundaryPatterns : []),
  ],
}];

// business code in src and ui/src runs no effect outside its caller's fiber (AGENTS.md "Effect v4 throughout", plan 3.9):
// no Effect.run*, no runtime capture and no ManagedRuntime. The residual adapters keep exactly their own allowance: the
// process entries src/main.ts and src/cli.ts their NodeRuntime.runMain, and the workflow MCP route src/workflow-mcp.ts the
// FiberSet runtimes through which the sdk's promise tool callbacks run their effects (plan 3.7, o-06)
const runMessage = "effects in src run in their caller's fiber; Effect.run* stays in the entries and the workflow MCP adapter (plan 3.9)";
const runSyntax = ({ runMain, fiberRuntimes, boundary = false }) => ["error",
  { selector: "MemberExpression[property.name=/^run(Promise|Sync|Fork|Callback)/]", message: runMessage },
  { selector: "ImportSpecifier[imported.name=/^run(Promise|Sync|Fork|Callback)/]", message: runMessage },
  { selector: "ImportDeclaration[source.value=/ManagedRuntime$/]", message: runMessage },
  { selector: "MemberExpression[object.name='ManagedRuntime']", message: runMessage },
  ...(runMain ? [] : [{ selector: "MemberExpression[property.name='runMain']", message: runMessage }]),
  ...(fiberRuntimes ? [] : [{ selector: "MemberExpression[object.name=/^Fiber(Set|Map|Handle)$/][property.name=/^runtime/]", message: runMessage }]),
  ...(boundary ? boundarySyntax : []),
];

// the suites run their effects in the test's own fiber (it.effect, it.live; plan S8): no Effect.run*, no runtime capture and no
// ManagedRuntime in test files. The child, worker and fixture-server entries run one program each, and the runner harness
// checks plain vitest behaviour, so they keep their allowance
const testRunMessage = "suites run effects in the test's fiber (it.effect, it.live); Effect.run* stays in the child, worker and fixture-server entries and the runner harness";
const testRunSyntax = ["error",
  { selector: "MemberExpression[property.name=/^run(Promise|Sync|Fork|Callback)/]", message: testRunMessage },
  { selector: "ImportSpecifier[imported.name=/^run(Promise|Sync|Fork|Callback)/]", message: testRunMessage },
  { selector: "ImportDeclaration[source.value=/ManagedRuntime$/]", message: testRunMessage },
  { selector: "MemberExpression[object.name='ManagedRuntime']", message: testRunMessage },
  { selector: "MemberExpression[property.name='runMain']", message: testRunMessage },
];
const testEntries = ["test/support/access-sql-child.ts", "test/support/access-sql-worker.ts", "test/support/db-worker-fault.ts", "test/support/db-seam-worker.ts", "test/support/sql-semantics-child.ts", "test/support/g8-auth-child.ts",
  "test/support/g8-auth-worker.ts", "test/support/g8-mcp-inflight-close.ts", "test/ui-fixture/run.ts"];

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "vendor/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
      "no-restricted-imports": restrictedImports({ sqlite: true, ws: false }),
      "no-restricted-properties": ["error", loadExtension],
    },
  },
  { files: ["src/**/*.ts", "src/**/*.tsx"], rules: { "no-restricted-imports": restrictedImports({ sqlite: true, ws: true, nodeSqlite: true, timers: true, boundary: true }),
    "no-restricted-syntax": runSyntax({ runMain: false, fiberRuntimes: false, boundary: true }), ...timerRules } },
  { files: [...t3Boundary.adapter, ...t3Boundary.composition, ...t3Boundary.transitional], rules: {
    "no-restricted-imports": restrictedImports({ sqlite: true, ws: true, nodeSqlite: true, timers: true }),
    "no-restricted-syntax": runSyntax({ runMain: false, fiberRuntimes: false }) } },
  { files: ["ui/src/**/*.ts", "ui/src/**/*.tsx"], rules: { "no-restricted-imports": restrictedImports({ sqlite: true, ws: false, nodeSqlite: true, timers: true }),
    "no-restricted-syntax": runSyntax({ runMain: false, fiberRuntimes: false }), ...timerRules } },
  { files: ["src/main.ts", "src/cli.ts", "src/db-worker.ts"], rules: { "no-restricted-syntax": runSyntax({ runMain: true, fiberRuntimes: false, boundary: true }) } },
  { files: ["src/workflow-mcp.ts"], rules: { "no-restricted-syntax": runSyntax({ runMain: false, fiberRuntimes: true, boundary: true }) } },
  { files: ["src/db.ts"], rules: { "no-restricted-imports": restrictedImports({ sqlite: false, ws: true, timers: true, boundary: true }) } },
  { files: ["src/db-worker-serve.ts"], rules: { "no-restricted-imports": restrictedImports({ sqlite: false, ws: true, nodeSqlite: true, timers: true, boundary: true }) } },
  { files: ["src/native-envelope.ts"], rules: { "no-restricted-imports": restrictedImports({ sqlite: true, ws: false, nodeSqlite: true, timers: true }) } },
  { files: ["test/**/*.ts", "test/**/*.tsx"], ignores: ["test/harness/**", ...testEntries], rules: { "no-restricted-syntax": testRunSyntax } },
);
