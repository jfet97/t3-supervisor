import { createHash } from "node:crypto";
import { Exit, Schema } from "effect";
import { mainRunNodeReader } from "./domain.js";
import { canonicalJson } from "./canonical-json.js";
import type { Projection, RunInfo } from "./types.js";
import { providerTurnNode, readNativeProviderTurns } from "./workflow-native-turns.js";

export {canonicalJson};

export const workflowToolInputMaxBytes = 192 * 1024;
export const workflowTurnItemDetailMaxBytes = 256 * 1024;

export const workflowToolNames = {
  read: {
    direct: [
      "t3-supervisor-workflows.workflow_read",
      "mcp__t3-supervisor-workflows__workflow_read",
    ],
    mcpxTarget: "t3-supervisor-workflows__workflow_read",
  },
  write: {
    direct: [
      "t3-supervisor-workflows.workflow_write",
      "mcp__t3-supervisor-workflows__workflow_write",
    ],
    mcpxTarget: "t3-supervisor-workflows__workflow_write",
  },
  team: {
    direct: ["t3-supervisor-workflows.supervision_team", "mcp__t3-supervisor-workflows__supervision_team"],
    mcpxTarget: "t3-supervisor-workflows__supervision_team",
  },
  guide: {
    direct: ["t3-supervisor-workflows.supervision_guide", "mcp__t3-supervisor-workflows__supervision_guide"],
    mcpxTarget: "t3-supervisor-workflows__supervision_guide",
  },
  stop: {
    direct: ["t3-supervisor-workflows.supervision_stop", "mcp__t3-supervisor-workflows__supervision_stop"],
    mcpxTarget: "t3-supervisor-workflows__supervision_stop",
  },
  start: {
    direct: ["t3-supervisor-workflows.supervision_start", "mcp__t3-supervisor-workflows__supervision_start"],
    mcpxTarget: "t3-supervisor-workflows__supervision_start",
  },
  plan: {
    direct: ["t3-supervisor-workflows.supervision_plan", "mcp__t3-supervisor-workflows__supervision_plan"],
    mcpxTarget: "t3-supervisor-workflows__supervision_plan",
  },
  interpretation: {
    direct: ["t3-supervisor-workflows.supervision_interpretation_submit", "mcp__t3-supervisor-workflows__supervision_interpretation_submit"],
    mcpxTarget: "t3-supervisor-workflows__supervision_interpretation_submit",
  },
  planning: {
    direct: ["t3-supervisor-workflows.supervision_planning", "mcp__t3-supervisor-workflows__supervision_planning"],
    mcpxTarget: "t3-supervisor-workflows__supervision_planning",
  },
  mcpxCall: ["mcpx.mcpx_call_tool", "mcp__mcpx__mcpx_call_tool"],
} as const;

export type WorkflowEvidenceTool = "read" | "write" | "team" | "guide" | "stop" | "start" | "plan" | "interpretation" | "planning";

export type WorkflowEvidenceMatch = {
  itemId: string;
  runId: string;
  toolName: string;
  inputHash: string;
  nativeInputCanonical: string;
  providerThreadId: string;
  ordinal: number;
  status: "running" | "completed";
  nativeItemRef: {driver: string; nativeId: string; strength: "strong"};
};

export type WorkflowEvidenceCandidate = {
  itemId: string;
  snapshotSignature: string;
  appRunOrdinal: number;
  appRunTime: number;
  itemOrdinal: number;
};

export type WorkflowEvidenceCheck =
  | {status: "verified"; evidence: WorkflowEvidenceMatch}
  | {status: "pending"; reason: string}
  | {status: "denied"; reason: string; observedToolName?: string};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
};

export const workflowRequestHash = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

export const workflowToolInputSize = (value: unknown): number =>
  Buffer.byteLength(canonicalJson(value), "utf8");

const workflowToolIds: Readonly<Record<WorkflowEvidenceTool, string>> = {read: "workflow_read", write: "workflow_write", team: "supervision_team",
  guide: "supervision_guide", stop: "supervision_stop", start: "supervision_start", plan: "supervision_plan",
  interpretation: "supervision_interpretation_submit", planning: "supervision_planning"};
const workflowTools = Object.keys(workflowToolIds) as WorkflowEvidenceTool[];

/**
 * The documented registrations: the server alias clients register this MCP server under and the exact native names of the MCPX
 * gateway's call tool.
 */
export const defaultWorkflowServerAliases: readonly string[] = ["t3-supervisor-workflows"];
export const defaultWorkflowGatewayTools: readonly string[] = workflowToolNames.mcpxCall;

/**
 * The supported native routes of the workflow tools, exact names only: per tool, the provider-native direct names under each server alias
 * (`<alias>.<tool>`, `mcp__<alias>__<tool>`) and the `<alias>__<tool>` a gateway call names, and the exact native names of the gateway call
 * tools. A gateway call is recognised only in the standard MCP call envelope, exactly `{name, arguments}` with object arguments; any other
 * input fails closed. No name is ever matched by prefix, suffix or argument shape.
 */
export type WorkflowToolRoutes = {
  readonly direct: Readonly<Record<WorkflowEvidenceTool, readonly string[]>>;
  readonly targets: Readonly<Record<WorkflowEvidenceTool, readonly string[]>>;
  readonly gatewayCalls: readonly string[];
  readonly allDirect: ReadonlySet<string>;
  readonly allTargets: ReadonlySet<string>;
};

export const workflowToolRoutes = (serverAliases: readonly string[] = defaultWorkflowServerAliases,
  gatewayTools: readonly string[] = defaultWorkflowGatewayTools): WorkflowToolRoutes => {
  const direct = Object.fromEntries(workflowTools.map(tool => [tool,
    serverAliases.flatMap(alias => [`${alias}.${workflowToolIds[tool]}`, `mcp__${alias}__${workflowToolIds[tool]}`])])) as Record<WorkflowEvidenceTool, string[]>;
  const targets = Object.fromEntries(workflowTools.map(tool => [tool, serverAliases.map(alias => `${alias}__${workflowToolIds[tool]}`)])) as
    Record<WorkflowEvidenceTool, string[]>;
  return {direct, targets, gatewayCalls: [...gatewayTools],
    allDirect: new Set(workflowTools.flatMap(tool => direct[tool])), allTargets: new Set(workflowTools.flatMap(tool => targets[tool]))};
};

export const defaultWorkflowToolRoutes = workflowToolRoutes();

// the routes of a process's configured registrations, built once per configuration
const configuredRoutes = new WeakMap<object, WorkflowToolRoutes>();
/** The routes of the configured registrations (WORKFLOW_MCP_SERVER_ALIASES, WORKFLOW_MCP_GATEWAY_TOOLS), the documented ones when unset. */
export const configuredWorkflowToolRoutes = (config: {readonly workflowMcpServerAliases?: readonly string[];
  readonly workflowMcpGatewayTools?: readonly string[]}): WorkflowToolRoutes => {
  const known = configuredRoutes.get(config);
  if (known) return known;
  const routes = config.workflowMcpServerAliases === undefined && config.workflowMcpGatewayTools === undefined ? defaultWorkflowToolRoutes
    : workflowToolRoutes(config.workflowMcpServerAliases, config.workflowMcpGatewayTools);
  configuredRoutes.set(config, routes);
  return routes;
};
const maxObservedToolNameLength = 128;

const boundedObservedToolName = (toolName: string): string =>
  toolName.length <= maxObservedToolNameLength ? toolName : `${toolName.slice(0, maxObservedToolNameLength - 3)}...`;

type RecordedArguments = {
  arguments: Record<string, unknown>;
  recognized: boolean;
  observedToolName?: string;
};

// a string snapshot input is decoded as JSON before its arguments are compared; malformed input matches no arguments
const decodeSnapshotJson = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const isTruncatedSnapshot = (item: Record<string, unknown>): boolean =>
  item.inputTruncated === true || item.truncated === true || isRecord(item.input) && item.input.truncated === true;

const appRunTime = (run: RunInfo): number => {
  for (const value of [run.startedAt, run.requestedAt]) {
    if (typeof value !== "string") continue;
    const time = Date.parse(value);
    if (Number.isFinite(time)) return time;
  }
  return -1;
};

export const workflowEvidenceCandidates = (
  projection: Projection,
  supervisorThreadId: string,
  tool: WorkflowEvidenceTool,
  expectedArguments: Record<string, unknown>,
  routes: WorkflowToolRoutes = defaultWorkflowToolRoutes,
): WorkflowEvidenceCandidate[] => {
  const names = routes.direct[tool];
  const runs = new Map(projection.runs.map(run => [run.id, run]));
  const expectedCanonical = canonicalJson(expectedArguments);
  return (projection.turnItems ?? []).flatMap(item => {
    if (item.type !== "dynamic_tool" || item.threadId !== supervisorThreadId ||
      typeof item.runId !== "string" || typeof item.id !== "string" || typeof item.toolName !== "string") return [];
    if (!names.includes(item.toolName) && !routes.gatewayCalls.includes(item.toolName) && routes.allDirect.has(item.toolName)) return [];
    const run = runs.get(item.runId);
    if (!run || run.threadId !== supervisorThreadId) return [];
    const snapshotInput = item.input;
    if (!plausibleSnapshot(item, tool, expectedCanonical, routes)) return [];
    let snapshotSignature: string;
    try {
      snapshotSignature = workflowRequestHash({id: item.id, runId: item.runId, providerThreadId: item.providerThreadId ?? null,
        updatedAt: item.updatedAt ?? null, status: item.status ?? null, toolName: item.toolName, input: snapshotInput});
    } catch {return [];}
    return [{itemId: item.id, snapshotSignature,
      appRunOrdinal: Number.isSafeInteger(run.ordinal) ? run.ordinal : -1,
      appRunTime: appRunTime(run),
      itemOrdinal: Number.isSafeInteger(item.ordinal) ? item.ordinal as number : -1}];
  }).sort((left, right) => right.appRunOrdinal - left.appRunOrdinal || right.appRunTime - left.appRunTime ||
    right.itemOrdinal - left.itemOrdinal || right.itemId.localeCompare(left.itemId));
};

// whether a turn item's snapshot input can be the expected call: equal arguments under a recognised tool name or wrapper, or an input
// only its detail read can settle (a truncated snapshot, or the string input of a recognised tool)
const plausibleSnapshot = (item: Record<string, unknown>, tool: WorkflowEvidenceTool, expectedCanonical: string, routes: WorkflowToolRoutes): boolean => {
  const names = routes.direct[tool];
  const toolName = item.toolName as string;
  const snapshotInput = item.input;
  const unknownToolName = !names.includes(toolName) && !routes.gatewayCalls.includes(toolName) && !routes.allDirect.has(toolName);
  let plausible = false;
  if (isRecord(snapshotInput)) {
    const snapshotArguments = recordedArguments(item, tool, routes);
    if (snapshotArguments) {
      try {plausible = canonicalJson(snapshotArguments.arguments) === expectedCanonical;}
      catch {plausible = false;}
    }
    if (!plausible && isTruncatedSnapshot(item)) plausible = true;
  } else if (typeof snapshotInput === "string" && snapshotInput.trim().length > 0) {
    if (!unknownToolName) {
      plausible = true;
    } else {
      const parsed = decodeSnapshotJson(snapshotInput);
      if (Exit.isSuccess(parsed) && isRecord(parsed.value)) {
        try {
          const snapshotArguments = recordedArguments({...item, input: parsed.value}, tool, routes);
          plausible = snapshotArguments !== null && canonicalJson(snapshotArguments.arguments) === expectedCanonical;
        } catch {plausible = false;}
      }
      if (!plausible && isTruncatedSnapshot(item)) plausible = true;
    }
  }
  return plausible;
};

/**
 * A native child's own calls that no AppRun carries: each names a provider turn instead. Only the child's plan read inspects them;
 * every write and the interpretation submission keep their AppRun proof.
 */
export const providerTurnEvidenceCandidates = (
  projection: Projection,
  threadId: string,
  tool: WorkflowEvidenceTool,
  expectedArguments: Record<string, unknown>,
  routes: WorkflowToolRoutes = defaultWorkflowToolRoutes,
): WorkflowEvidenceCandidate[] => {
  const names = routes.direct[tool];
  const expectedCanonical = canonicalJson(expectedArguments);
  return (projection.turnItems ?? []).flatMap(item => {
    if (item.type !== "dynamic_tool" || item.threadId !== threadId || item.runId != null || typeof item.providerTurnId !== "string" ||
      typeof item.id !== "string" || typeof item.toolName !== "string") return [];
    if (!names.includes(item.toolName) && !routes.gatewayCalls.includes(item.toolName) && routes.allDirect.has(item.toolName)) return [];
    if (!plausibleSnapshot(item, tool, expectedCanonical, routes)) return [];
    let snapshotSignature: string;
    try {
      snapshotSignature = workflowRequestHash({id: item.id, providerTurnId: item.providerTurnId, providerThreadId: item.providerThreadId ?? null,
        updatedAt: item.updatedAt ?? null, status: item.status ?? null, toolName: item.toolName, input: item.input});
    } catch {return [];}
    return [{itemId: item.id, snapshotSignature, appRunOrdinal: -1, appRunTime: -1,
      itemOrdinal: Number.isSafeInteger(item.ordinal) ? item.ordinal as number : -1}];
  }).sort((left, right) => right.itemOrdinal - left.itemOrdinal || right.itemId.localeCompare(left.itemId));
};

export type ProviderTurnEvidenceCheck =
  | {status: "verified"; providerTurnId: string}
  | {status: "pending"; reason: string}
  | {status: "denied"; reason: string; observedToolName?: string};

/**
 * A native child's own executed call that no AppRun carries: the exact arguments under a recognised tool name in its own strongly
 * identified item, inside the graph of a provider turn the child's projection publishes with strong native provenance. It proves only
 * the caller's own plan read, never a write or a submission.
 */
export const verifyProviderTurnToolEvidence = (input: {
  projection: Projection;
  callerThreadId: string;
  itemId: string;
  detail: unknown;
  tool: WorkflowEvidenceTool;
  arguments: Record<string, unknown>;
  routes?: WorkflowToolRoutes;
}): ProviderTurnEvidenceCheck => {
  if (!isRecord(input.detail)) return {status: "pending", reason: "native_item_unavailable"};
  const item = input.detail;
  // an item an AppRun carries is proven through that AppRun only
  if (item.runId !== null && item.runId !== undefined) return {status: "denied", reason: "native_item_run_bound"};
  if (typeof item.providerTurnId !== "string" || typeof item.toolName !== "string" || !isRecord(item.input))
    return {status: "pending", reason: "native_input_incomplete"};
  const recorded = recordedArguments(item, input.tool, input.routes ?? defaultWorkflowToolRoutes);
  if (!recorded) return {status: "pending", reason: "native_tool_name_or_wrapper_mismatch"};
  let expectedCanonical: string;
  let actualCanonical: string;
  try {
    expectedCanonical = canonicalJson(input.arguments);
    actualCanonical = canonicalJson(recorded.arguments);
    canonicalJson(item.input);
  } catch {
    return {status: "pending", reason: "native_input_not_json"};
  }
  if (Buffer.byteLength(actualCanonical, "utf8") > workflowToolInputMaxBytes) return {status: "pending", reason: "native_input_too_large"};
  if (Object.keys(recorded.arguments).length === 0) return {status: "pending", reason: "native_input_empty"};
  if (actualCanonical !== expectedCanonical) return {status: "pending", reason: "native_input_does_not_match_request"};
  if (item.id !== input.itemId || item.type !== "dynamic_tool" || item.threadId !== input.callerThreadId || typeof item.nodeId !== "string")
    return {status: "denied", reason: "native_item_identity_mismatch"};
  if (input.projection.thread.id !== input.callerThreadId) return {status: "denied", reason: "caller_projection_mismatch"};
  if (item.parentItemId !== null || !isRecord(item.nativeItemRef) || item.nativeItemRef.strength !== "strong")
    return {status: "denied", reason: "native_item_not_turn_strong"};
  const providerDriver = item.nativeItemRef.driver;
  if (typeof providerDriver !== "string" || !providerDriver || providerDriver.length > 128 || providerDriver.trim() !== providerDriver ||
    typeof item.nativeItemRef.nativeId !== "string" || !item.nativeItemRef.nativeId ||
    typeof item.ordinal !== "number" || !Number.isSafeInteger(item.ordinal) || item.ordinal < 0)
    return {status: "denied", reason: "native_item_identity_incomplete"};
  if (item.toolNonExecutionKind !== undefined && item.toolNonExecutionKind !== null)
    return {status: "denied", reason: "native_item_not_executed"};
  if (item.status === "rolled_back") return {status: "denied", reason: "native_tool_item_rolled_back"};
  if (item.status !== "running" && item.status !== "completed")
    return {status: "denied", reason: "native_item_not_running_or_completed"};
  const turns = readNativeProviderTurns(input.projection);
  if (turns === null) return {status: "pending", reason: "native_provider_turns_unreadable"};
  const turn = turns.find(candidate => candidate.id === item.providerTurnId);
  // a published turn without strong native provenance identifies nothing; an unpublished one may still appear
  if (!turn) return Array.isArray(input.projection.providerTurns) &&
    input.projection.providerTurns.some(candidate => isRecord(candidate) && candidate.id === item.providerTurnId)
    ? {status: "denied", reason: "native_provider_turn_not_strong"} : {status: "pending", reason: "native_provider_turn_not_visible"};
  if (turn.providerThreadId !== item.providerThreadId) return {status: "denied", reason: "native_provider_turn_mismatch"};
  if (!providerTurnNode(input.projection, turn, item.nodeId)) return {status: "denied", reason: "native_item_outside_provider_turn"};
  if (!recorded.recognized) return {status: "denied", reason: "native_tool_name_unrecognized",
    ...(recorded.observedToolName ? {observedToolName: boundedObservedToolName(recorded.observedToolName)} : {})};
  return {status: "verified", providerTurnId: turn.id};
};

/** One tool's recognised native routes: its direct names, the names a recognised MCP call tool gives it in `{name, arguments}`, and those call tools. */
type NativeToolRoutes = {readonly direct: readonly string[]; readonly targets: readonly string[]; readonly gatewayCalls: readonly string[]};

// the one reading of a native call's tool route, shared by evidence, re-validated receipts and read coverage: a direct name of the tool,
// or a recognised MCP call naming it, is recognised; a route of another known tool is no candidate; anything else is unrecognised
const routedArguments = (item: Record<string, unknown>, routes: NativeToolRoutes, otherDirect: ReadonlySet<string>,
  otherTargets: ReadonlySet<string>): RecordedArguments | null => {
  if (!isRecord(item.input)) return null;
  const toolName = item.toolName;
  if (typeof toolName !== "string") return null;
  if (routes.direct.includes(toolName)) return {arguments: item.input, recognized: true};
  if (otherDirect.has(toolName)) return null;
  if (routes.gatewayCalls.includes(toolName)) {
    if (!exactKeys(item.input, ["name", "arguments"]) || typeof item.input.name !== "string" ||
      !isRecord(item.input.arguments)) return null;
    if (routes.targets.includes(item.input.name))
      return {arguments: item.input.arguments, recognized: true};
    if (otherTargets.has(item.input.name)) return null;
    return {arguments: item.input.arguments, recognized: false, observedToolName: item.input.name};
  }
  if (exactKeys(item.input, ["name", "arguments"]) && typeof item.input.name === "string" && routes.targets.includes(item.input.name) &&
    isRecord(item.input.arguments))
    return {arguments: item.input.arguments, recognized: false, observedToolName: toolName};
  return {arguments: item.input, recognized: false, observedToolName: toolName};
};

const recordedArguments = (item: Record<string, unknown>, tool: WorkflowEvidenceTool, routes: WorkflowToolRoutes): RecordedArguments | null =>
  routedArguments(item, {direct: routes.direct[tool], targets: routes.targets[tool], gatewayCalls: routes.gatewayCalls}, routes.allDirect, routes.allTargets);

/** The arguments of a recognised native call of a workflow tool, or null; re-validated receipts read their calls this way. */
export const recognisedWorkflowCallArguments = (item: Record<string, unknown>, tool: WorkflowEvidenceTool,
  routes: WorkflowToolRoutes = defaultWorkflowToolRoutes): Record<string, unknown> | null => {
  const recorded = recordedArguments(item, tool, routes);
  return recorded?.recognized ? recorded.arguments : null;
};

// this environment's own T3 server's thread read: its direct names and the name a recognised gateway call gives it
const threadReadDirect: readonly string[] = ["t3_thread_read", "mcp__t3_code__t3_thread_read", "mcp__t3-code__t3_thread_read", "t3-code.t3_thread_read"];
const threadReadTargets: readonly string[] = ["t3-code__t3_thread_read"];

/** The arguments of a recognised native T3 thread read, or null; read coverage counts only these, through the same gateway call tools. */
export const recognisedThreadReadArguments = (item: Record<string, unknown>,
  routes: WorkflowToolRoutes = defaultWorkflowToolRoutes): Record<string, unknown> | null => {
  const recorded = routedArguments(item, {direct: threadReadDirect, targets: threadReadTargets, gatewayCalls: routes.gatewayCalls}, new Set(), new Set());
  return recorded?.recognized ? recorded.arguments : null;
};

/**
 * The call a native item records, as the configured routes read it: a configured gateway call tool naming exactly `{name, arguments}`
 * stands for that target, any other item stands for itself; no other wrapper is unwrapped.
 */
export const nativeCallRoute = (item: Record<string, unknown>, routes: WorkflowToolRoutes = defaultWorkflowToolRoutes): {toolName: string; input: unknown} | null => {
  if (typeof item.toolName !== "string") return null;
  if (routes.gatewayCalls.includes(item.toolName) && isRecord(item.input) && exactKeys(item.input, ["name", "arguments"]) &&
    typeof item.input.name === "string" && isRecord(item.input.arguments))
    return {toolName: item.input.name, input: item.input.arguments};
  return {toolName: item.toolName, input: item.input};
};

const getRun = (projection: Projection, runId: string): RunInfo | undefined =>
  projection.runs.find(run => run.id === runId);

export const verifyWorkflowToolEvidence = (input: {
  projection: Projection;
  supervisorThreadId: string;
  itemId: string;
  detail: unknown;
  tool: WorkflowEvidenceTool;
  arguments: Record<string, unknown>;
  routes?: WorkflowToolRoutes;
}): WorkflowEvidenceCheck => {
  if (!isRecord(input.detail)) return {status: "pending", reason: "native_item_unavailable"};
  const item = input.detail;
  if (typeof item.runId !== "string" || typeof item.toolName !== "string" || !isRecord(item.input))
    return {status: "pending", reason: "native_input_incomplete"};
  const recorded = recordedArguments(item, input.tool, input.routes ?? defaultWorkflowToolRoutes);
  if (!recorded) return {status: "pending", reason: "native_tool_name_or_wrapper_mismatch"};
  let expectedCanonical: string;
  let actualCanonical: string;
  let nativeInputCanonical: string;
  try {
    expectedCanonical = canonicalJson(input.arguments);
    actualCanonical = canonicalJson(recorded.arguments);
    nativeInputCanonical = canonicalJson(item.input);
  } catch {
    return {status: "pending", reason: "native_input_not_json"};
  }
  if (Buffer.byteLength(actualCanonical, "utf8") > workflowToolInputMaxBytes)
    return {status: "pending", reason: "native_input_too_large"};
  if (Object.keys(recorded.arguments).length === 0) return {status: "pending", reason: "native_input_empty"};
  if (actualCanonical !== expectedCanonical) return {status: "pending", reason: "native_input_does_not_match_request"};
  if (item.id !== input.itemId || item.type !== "dynamic_tool" || item.threadId !== input.supervisorThreadId ||
    typeof item.nodeId !== "string") return {status: "denied", reason: "native_item_identity_mismatch"};
  if (input.projection.thread.id !== input.supervisorThreadId) return {status: "denied", reason: "supervisor_projection_mismatch"};
  if (item.parentItemId !== null) return {status: "denied", reason: "native_item_not_main_strong"};
  if (!isRecord(item.nativeItemRef) || item.nativeItemRef.strength !== "strong")
    return {status: "denied", reason: "native_item_not_main_strong"};
  const providerDriver = item.nativeItemRef.driver;
  if (typeof providerDriver !== "string" || !providerDriver || providerDriver.length > 128 || providerDriver.trim() !== providerDriver ||
    typeof item.nativeItemRef.nativeId !== "string" || !item.nativeItemRef.nativeId ||
    typeof item.ordinal !== "number" || !Number.isSafeInteger(item.ordinal) || item.ordinal < 0)
    return {status: "denied", reason: "native_item_identity_incomplete"};
  if (item.toolNonExecutionKind !== undefined && item.toolNonExecutionKind !== null)
    return {status: "denied", reason: "native_item_not_executed"};
  if (item.status === "rolled_back") return {status: "denied", reason: "native_tool_item_rolled_back"};
  if (item.status !== "running" && item.status !== "completed")
    return {status: "denied", reason: "native_item_not_running_or_completed"};
  const run = getRun(input.projection, item.runId);
  if (!run || run.threadId !== input.supervisorThreadId || typeof run.providerThreadId !== "string" ||
    item.providerThreadId !== run.providerThreadId)
    return {status: "denied", reason: "native_run_identity_mismatch"};
  if (run.status === "rolled_back") return {status: "denied", reason: "native_run_rolled_back"};
  const root = Array.isArray(input.projection.nodes)
    ? input.projection.nodes.find(node => isRecord(node) && node.id === run.rootNodeId)
    : undefined;
  if (isRecord(root) && root.status === "rolled_back") return {status: "denied", reason: "native_root_node_rolled_back"};
  const node = mainRunNodeReader(input.projection, run)(item.nodeId);
  if (!node) return {status: "denied", reason: "native_item_outside_main_run"};
  if (node.status === "rolled_back") return {status: "denied", reason: "native_tool_node_rolled_back"};
  if (!recorded.recognized) return {status: "denied", reason: "native_tool_name_unrecognized",
    ...(recorded.observedToolName ? {observedToolName: boundedObservedToolName(recorded.observedToolName)} : {})};
  return {
    status: "verified",
    evidence: {
      itemId: input.itemId,
      runId: item.runId,
      toolName: item.toolName,
      inputHash: workflowRequestHash(input.arguments),
      nativeInputCanonical,
      providerThreadId: item.providerThreadId as string,
      ordinal: item.ordinal as number,
      status: item.status,
      nativeItemRef: {
        driver: providerDriver,
        nativeId: item.nativeItemRef.nativeId as string,
        strength: "strong",
      },
    },
  };
};
