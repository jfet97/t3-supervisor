import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Config, ConfigProvider, Context, Effect, Layer, Option, Schema } from "effect";
import { InvalidConfiguration } from "./errors.js";
import type { SupervisorSettings } from "./types.js";

const dataDirectoryFrom = (explicit: string | undefined, stateHome: string | undefined): string =>
  explicit ?? join(stateHome ?? join(homedir(), ".local", "state"), "t3-supervisor");

// the data directory alone, for the cli (T-05): DATA_DIRECTORY, else t3-supervisor in the xdg state directory
export const loadDataDirectory = (): string => dataDirectoryFrom(process.env.DATA_DIRECTORY, process.env.XDG_STATE_HOME);

// the process environment, read when called; empty values stay values, as `??` keeps them today (D-06)
export const environment = (): ConfigProvider.ConfigProvider => ConfigProvider.fromEnv({ preserveEmptyStrings: true });

// trimmed, then at most 256 characters without whitespace
const HelperProviderInstanceId = Schema.Trim.check(Schema.makeFilter((id: string) => id.length <= 256 && !/\s/u.test(id)));

const defaultUiAssetsDirectory = fileURLToPath(new URL("../ui-dist", import.meta.url));

const optional = (name: string) => Config.String(name).pipe(Config.option, Config.map(Option.getOrUndefined));
const withDefault = (name: string, value: string) => Config.String(name).pipe(Config.withDefault(value));
// parsed with Number() as today: an empty value is 0 and a non-numeric one NaN (D-06)
const numeric = (name: string, value: string) => withDefault(name, value).pipe(Config.map(Number));
const list = (name: string, item: (value: string) => string) =>
  withDefault(name, "").pipe(Config.map((value) => value.split(",").map(item).filter(Boolean)));

const supervisorConfig = Config.all({
  dataDirectory: Config.all([optional("DATA_DIRECTORY"), optional("XDG_STATE_HOME")])
    .pipe(Config.map(([explicit, stateHome]) => dataDirectoryFrom(explicit, stateHome))),
  t3Url: withDefault("T3_URL", "http://127.0.0.1:3773"),
  t3TokenFile: withDefault("T3_TOKEN_FILE", "/run/secrets/t3-read-token"),
  excludedThreadIds: list("EXCLUDED_THREAD_IDS", (id) => id.trim()),
  healthPort: numeric("HEALTH_PORT", "9007"),
  healthHost: withDefault("HEALTH_HOST", "127.0.0.1"),
  helperProviderInstanceId: optional("SUPERVISOR_HELPER_PROVIDER_INSTANCE_ID"),
  uiPort: numeric("UI_PORT", "9008"),
  uiHost: withDefault("UI_HOST", "127.0.0.1"),
  workflowMcpHosts: list("WORKFLOW_MCP_HOSTS", (host) => host.trim().toLowerCase()),
  workflowMcpBindHost: optional("WORKFLOW_MCP_BIND_HOST"),
  workflowMcpPort: optional("WORKFLOW_MCP_PORT"),
  workflowMcpServerAliases: list("WORKFLOW_MCP_SERVER_ALIASES", (alias) => alias.trim()),
  workflowMcpGatewayTools: list("WORKFLOW_MCP_GATEWAY_TOOLS", (name) => name.trim()),
  uiAssetsDirectory: withDefault("UI_ASSETS_DIRECTORY", defaultUiAssetsDirectory),
  guidanceTokenFile: withDefault("T3_GUIDANCE_TOKEN_FILE", "/run/secrets/t3-guidance-token"),
  projectWriteTokenFile: withDefault("T3_PROJECT_WRITE_TOKEN_FILE", "/run/secrets/t3-project-write-token"),
  projectCommitTokenFile: withDefault("T3_PROJECT_COMMIT_TOKEN_FILE", "/run/secrets/t3-project-commit-token"),
  gitProbeTokenFile: withDefault("T3_GIT_PROBE_TOKEN_FILE", "/run/secrets/t3-git-probe-token"),
  managedScratchRoot: optional("T3_MANAGED_SCRATCH_ROOT"),
});

/**
 * An exact alias a client registers the workflow MCP server under: letters and digits joined by single "-" or "_", never "." or "__",
 * which delimit native tool names, so an alias names its routes exactly.
 */
export const validWorkflowMcpAlias = (alias: string): boolean => alias.length <= 64 && /^[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/u.test(alias);

/**
 * The exact fully-qualified native name of a gateway's call tool, as a provider records it: `<server>.<tool>` or `mcp__<server>__<tool>`,
 * the server and the tool each letters and digits joined by single "-" or "_", so the name is one server's one tool and nothing else.
 */
export const validWorkflowGatewayTool = (name: string): boolean => name.length <= 128 &&
  /^(?:[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*\.|mcp__[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*__)[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*$/u.test(name);

// parsed from the current ConfigProvider; a malformed helper instance id, server alias or gateway tool name fails with its reason code and no value
const settings: Effect.Effect<SupervisorSettings, InvalidConfiguration> = Effect.gen(function* () {
  const { helperProviderInstanceId: helperInput, workflowMcpBindHost, workflowMcpPort, managedScratchRoot, workflowMcpServerAliases,
    workflowMcpGatewayTools, ...parsed } =
    yield* supervisorConfig.pipe(Effect.mapError(() => new InvalidConfiguration({ reason: "invalid_configuration" })));
  if (!workflowMcpServerAliases.every(validWorkflowMcpAlias)) return yield* new InvalidConfiguration({ reason: "invalid_workflow_mcp_alias" });
  if (!workflowMcpGatewayTools.every(validWorkflowGatewayTool)) return yield* new InvalidConfiguration({ reason: "invalid_workflow_mcp_gateway_tool" });
  // a blank value leaves helper isolation unset
  const helperProviderInstanceId = helperInput === undefined ? "" : yield* Schema.decodeUnknownEffect(HelperProviderInstanceId)(helperInput)
    .pipe(Effect.mapError(() => new InvalidConfiguration({ reason: "invalid_helper_provider_instance_id" })));
  return {
    ...parsed,
    // optional settings are absent unless set to a non-empty value
    ...(helperProviderInstanceId ? { helperProviderInstanceId } : {}),
    ...(workflowMcpBindHost ? { workflowMcpBindHost } : {}),
    ...(workflowMcpPort ? { workflowMcpPort: Number(workflowMcpPort) } : {}),
    // unset or blank keeps the documented registrations; a list replaces them, matched exactly
    ...(workflowMcpServerAliases.length ? { workflowMcpServerAliases } : {}),
    ...(workflowMcpGatewayTools.length ? { workflowMcpGatewayTools } : {}),
    ...(managedScratchRoot ? { managedScratchRoot } : {}),
  };
});

// the process configuration, parsed once and immutable
export class SupervisorConfig extends Context.Service<SupervisorConfig, Readonly<SupervisorSettings>>()("t3-supervisor/SupervisorConfig") {
  // parsed from the current ConfigProvider; the process provides `environment`
  static readonly layer: Layer.Layer<SupervisorConfig, InvalidConfiguration> = Layer.effect(SupervisorConfig, settings);
}
