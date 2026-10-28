import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { parse } from "yaml";
import { environment, loadDataDirectory, SupervisorConfig } from "../src/config.js";

// the configuration as the process parses it: the SupervisorConfig layer over the current process environment
const loadConfig = Effect.suspend(() => SupervisorConfig.useSync((config) => config).pipe(
  Effect.provide(SupervisorConfig.layer), Effect.provide(ConfigProvider.layer(environment()))));

// every variable loadConfig reads, plus the two that locate the default data directory
const variables = [
  "DATA_DIRECTORY", "XDG_STATE_HOME", "HOME", "T3_URL", "T3_TOKEN_FILE", "EXCLUDED_THREAD_IDS", "HEALTH_PORT", "HEALTH_HOST",
  "SUPERVISOR_HELPER_PROVIDER_INSTANCE_ID", "UI_PORT", "UI_HOST", "WORKFLOW_MCP_HOSTS", "WORKFLOW_MCP_BIND_HOST",
  "WORKFLOW_MCP_PORT", "WORKFLOW_MCP_SERVER_ALIASES", "WORKFLOW_MCP_GATEWAY_TOOLS", "UI_ASSETS_DIRECTORY", "T3_GUIDANCE_TOKEN_FILE", "T3_PROJECT_WRITE_TOKEN_FILE",
  "T3_PROJECT_COMMIT_TOKEN_FILE", "T3_GIT_PROBE_TOKEN_FILE", "T3_MANAGED_SCRATCH_ROOT",
] as const;
type Variable = typeof variables[number];

// runs with exactly the given variables set and restores the previous process environment when it ends, however it ends
const withEnvironment = <A, E>(values: Partial<Record<Variable, string>>, run: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.scoped(Effect.andThen(Effect.acquireRelease(Effect.sync(() => {
    const saved = new Map(variables.map(name => [name, process.env[name]] as const));
    for (const name of variables) delete process.env[name];
    for (const [name, value] of Object.entries(values)) process.env[name] = value;
    return saved;
  }), (saved) => Effect.sync(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  })), run));

// the default assets directory is resolved next to src/, which is the repository root as seen from test/
const defaultAssets = fileURLToPath(new URL("../ui-dist", import.meta.url));

it.effect("CT-CONFIG-01: every default and list parsing equals the loadConfig golden", () => Effect.gen(function* () {
  const defaults = yield* withEnvironment({ HOME: "/home/characterization" },
    Effect.map(loadConfig, config => ({ config, directory: loadDataDirectory() })));
  assert.deepEqual(defaults.config, {
    dataDirectory: "/home/characterization/.local/state/t3-supervisor",
    t3Url: "http://127.0.0.1:3773",
    t3TokenFile: "/run/secrets/t3-read-token",
    excludedThreadIds: [],
    healthPort: 9007,
    healthHost: "127.0.0.1",
    uiPort: 9008,
    uiHost: "127.0.0.1",
    workflowMcpHosts: [],
    uiAssetsDirectory: defaultAssets,
    guidanceTokenFile: "/run/secrets/t3-guidance-token",
    projectWriteTokenFile: "/run/secrets/t3-project-write-token",
    projectCommitTokenFile: "/run/secrets/t3-project-commit-token",
    gitProbeTokenFile: "/run/secrets/t3-git-probe-token",
  });
  assert.equal(defaults.directory, defaults.config.dataDirectory);

  assert.equal((yield* withEnvironment({ HOME: "/home/characterization", XDG_STATE_HOME: "/state/home" }, loadConfig)).dataDirectory,
    "/state/home/t3-supervisor");
  assert.equal((yield* withEnvironment({ HOME: "/home/characterization", XDG_STATE_HOME: "/state/home", DATA_DIRECTORY: "/explicit/data" },
    loadConfig)).dataDirectory, "/explicit/data");

  const configured = yield* withEnvironment({
    HOME: "/home/characterization",
    DATA_DIRECTORY: "/data",
    T3_URL: "http://t3.internal:4000",
    T3_TOKEN_FILE: "/secrets/read",
    EXCLUDED_THREAD_IDS: " a, ,b ",
    HEALTH_PORT: "1234",
    HEALTH_HOST: "0.0.0.0",
    SUPERVISOR_HELPER_PROVIDER_INSTANCE_ID: " helpers-1 ",
    UI_PORT: "5678",
    UI_HOST: "0.0.0.0",
    WORKFLOW_MCP_HOSTS: " Supervisor.Example:9008, ,[::1]:9009 ",
    WORKFLOW_MCP_BIND_HOST: "10.0.0.5",
    WORKFLOW_MCP_PORT: "9010",
    UI_ASSETS_DIRECTORY: "/assets",
    T3_GUIDANCE_TOKEN_FILE: "/secrets/guidance",
    T3_PROJECT_WRITE_TOKEN_FILE: "/secrets/write",
    T3_PROJECT_COMMIT_TOKEN_FILE: "/secrets/commit",
    T3_GIT_PROBE_TOKEN_FILE: "/secrets/probe",
    T3_MANAGED_SCRATCH_ROOT: "/scratch",
  }, loadConfig);
  assert.deepEqual(configured, {
    dataDirectory: "/data",
    t3Url: "http://t3.internal:4000",
    t3TokenFile: "/secrets/read",
    excludedThreadIds: ["a", "b"],
    healthPort: 1234,
    healthHost: "0.0.0.0",
    helperProviderInstanceId: "helpers-1",
    uiPort: 5678,
    uiHost: "0.0.0.0",
    workflowMcpHosts: ["supervisor.example:9008", "[::1]:9009"],
    workflowMcpBindHost: "10.0.0.5",
    workflowMcpPort: 9010,
    uiAssetsDirectory: "/assets",
    guidanceTokenFile: "/secrets/guidance",
    projectWriteTokenFile: "/secrets/write",
    projectCommitTokenFile: "/secrets/commit",
    gitProbeTokenFile: "/secrets/probe",
    managedScratchRoot: "/scratch",
  });

  // thread ids are trimmed and filtered but keep their case; only MCP hosts are lowercased
  assert.deepEqual((yield* withEnvironment({ EXCLUDED_THREAD_IDS: "Thread-A,thread-a" }, loadConfig)).excludedThreadIds,
    ["Thread-A", "thread-a"]);
}), { timeout: 10_000 });

it.effect("CT-CONFIG-02: whitespace inside the helper id fails while a blank helper id is unset", () => Effect.gen(function* () {
  for (const invalid of ["a b", "a\tb", " a\nb "]) {
    const failure: unknown = yield* Effect.flip(withEnvironment({ SUPERVISOR_HELPER_PROVIDER_INSTANCE_ID: invalid }, loadConfig));
    assert.ok(failure instanceof Error && failure.message === "invalid_helper_provider_instance_id");
  }
  for (const blank of ["   ", "\t\n "]) {
    const config = yield* withEnvironment({ SUPERVISOR_HELPER_PROVIDER_INSTANCE_ID: blank }, loadConfig);
    assert.equal(config.helperProviderInstanceId, undefined);
    assert.equal(Object.hasOwn(config, "helperProviderInstanceId"), false);
  }
  assert.equal((yield* withEnvironment({ SUPERVISOR_HELPER_PROVIDER_INSTANCE_ID: "x".repeat(256) }, loadConfig)).helperProviderInstanceId,
    "x".repeat(256));
}), { timeout: 10_000 });

it.effect("CT-CONFIG-03: empty-string and non-numeric values keep their baseline results", () => Effect.gen(function* () {
  // nullish defaults keep an empty string, Number('') is 0, and truthiness-gated optional fields stay absent
  const empty = yield* withEnvironment(Object.fromEntries(variables.filter(name => name !== "XDG_STATE_HOME" && name !== "HOME")
    .map(name => [name, ""])), loadConfig);
  assert.deepEqual(empty, {
    dataDirectory: "",
    t3Url: "",
    t3TokenFile: "",
    excludedThreadIds: [],
    healthPort: 0,
    healthHost: "",
    uiPort: 0,
    uiHost: "",
    workflowMcpHosts: [],
    uiAssetsDirectory: "",
    guidanceTokenFile: "",
    projectWriteTokenFile: "",
    projectCommitTokenFile: "",
    gitProbeTokenFile: "",
  });
  assert.equal(yield* withEnvironment({ DATA_DIRECTORY: "" }, Effect.sync(loadDataDirectory)), "");

  const nonNumeric = yield* withEnvironment({ HEALTH_PORT: "abc", UI_PORT: "abc", WORKFLOW_MCP_PORT: "abc" }, loadConfig);
  assert.ok(Number.isNaN(nonNumeric.healthPort));
  assert.ok(Number.isNaN(nonNumeric.uiPort));
  assert.equal(Object.hasOwn(nonNumeric, "workflowMcpPort"), true);
  assert.ok(Number.isNaN(nonNumeric.workflowMcpPort));
}), { timeout: 10_000 });

// audit F2: a bare process keeps health on loopback, so the image opens it on the container's own interface, where only its published
// port reaches it; the template publishes that port on host loopback, and a container listener on loopback alone is unreachable
it("CT-CONFIG-04: the image opens health inside its container and the template publishes it on host loopback only", () => {
  const runtime = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8").split(/^FROM /mu).at(-1)!;
  assert.match(runtime, /^ENV .*\bHEALTH_HOST=0\.0\.0\.0\b/mu);
  const service = (parse(readFileSync(new URL("../compose.yaml", import.meta.url), "utf8")) as
    {services: Record<string, {environment: Record<string, string>; ports: string[]}>}).services["t3-supervisor"]!;
  assert.deepEqual({health: service.environment.HEALTH_HOST, ui: service.environment.UI_HOST}, {health: "0.0.0.0", ui: "0.0.0.0"});
  assert.deepEqual(service.ports, ["127.0.0.1:9007:9007", "127.0.0.1:9008:9008"]);
});

// audit F7: the registrations a deployment configures replace the documented ones; each is an exact name, never a pattern
it.effect("CT-CONFIG-05: server aliases and gateway call tools are exact names, trimmed, and an unset or blank list keeps the documented ones", () => Effect.gen(function* () {
  const configured = yield* withEnvironment({ WORKFLOW_MCP_SERVER_ALIASES: " supervisor , t3_supervisor ",
    WORKFLOW_MCP_GATEWAY_TOOLS: " mcp__other_gateway__call_tool , gateway.invoke " }, loadConfig);
  assert.deepEqual({ server: configured.workflowMcpServerAliases, gateway: configured.workflowMcpGatewayTools },
    { server: ["supervisor", "t3_supervisor"], gateway: ["mcp__other_gateway__call_tool", "gateway.invoke"] });
  const documented = yield* withEnvironment({ WORKFLOW_MCP_GATEWAY_TOOLS: "mcpx.mcpx_call_tool,mcp__mcpx__mcpx_call_tool" }, loadConfig);
  assert.deepEqual(documented.workflowMcpGatewayTools, ["mcpx.mcpx_call_tool", "mcp__mcpx__mcpx_call_tool"]);
  for (const values of [{}, { WORKFLOW_MCP_SERVER_ALIASES: " , ", WORKFLOW_MCP_GATEWAY_TOOLS: "" }]) {
    const unset = yield* withEnvironment(values, loadConfig);
    assert.equal(Object.hasOwn(unset, "workflowMcpServerAliases") || Object.hasOwn(unset, "workflowMcpGatewayTools"), false);
  }
  for (const invalid of ["server.alias", "server__alias", "-server", "server-", "server alias", "*", "x".repeat(65)]) {
    const failure: unknown = yield* Effect.flip(withEnvironment({ WORKFLOW_MCP_SERVER_ALIASES: invalid }, loadConfig));
    assert.ok(failure instanceof Error && failure.message === "invalid_workflow_mcp_alias", invalid);
  }
  // a gateway call tool is one server's one tool: a bare tool, a pattern or a name with another delimiter is no exact name
  for (const invalid of ["call_tool", "mcpx", "gateway.", ".call_tool", "gateway.call.tool", "mcp__gateway", "mcp__gateway__", "mcp____call_tool",
    "mcp__other__gateway__call_tool", "mcp__gateway__call__tool", "gateway.call tool", "gateway.*", "mcp__*__call_tool", "gateway.call_tool;",
    `gateway.${"x".repeat(121)}`]) {
    const failure: unknown = yield* Effect.flip(withEnvironment({ WORKFLOW_MCP_GATEWAY_TOOLS: invalid }, loadConfig));
    assert.ok(failure instanceof Error && failure.message === "invalid_workflow_mcp_gateway_tool", invalid);
  }
}), { timeout: 10_000 });
