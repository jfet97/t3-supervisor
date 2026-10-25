import type { DefinitionNode } from "./project-definitions-contract.js";
import type {
  WorkflowPlanBranchInfo,
  WorkflowPlanGroupInfo,
  WorkflowPlanNodeInfo,
  WorkflowPlanStepInfo,
  WorkflowPlanWorkflowInfo,
} from "./project-supervisor-contract.js";

// pure plan and definition tree walks shared by the service and the browser bundle; it imports only types

export const branchPaths = ["then", "else"] as const;
export type BranchPath = typeof branchPaths[number];
export type PlanEntityInfo = WorkflowPlanStepInfo | WorkflowPlanWorkflowInfo;

/** The definition nodes a definition node directly contains: group members, or a branch's then path followed by its else path. */
export const definitionNodeChildren = (node: DefinitionNode): readonly DefinitionNode[] =>
  "sequence" in node ? node.sequence : "parallel" in node ? node.parallel
    : "branch" in node ? [...node.branch.then, ...(node.branch.else ?? [])] : [];

export const isPlanGroup = (node: WorkflowPlanNodeInfo): node is WorkflowPlanGroupInfo => node.kind === "sequence" || node.kind === "parallel";
export const isPlanEntity = (node: WorkflowPlanNodeInfo): node is PlanEntityInfo => node.kind === "step" || node.kind === "workflow";

/** A branch's paths that exist, then before else. */
export const branchPathGroups = (branch: WorkflowPlanBranchInfo): Array<{path: BranchPath; group: WorkflowPlanGroupInfo}> =>
  [{path: "then" as const, group: branch.then}, ...(branch.else ? [{path: "else" as const, group: branch.else}] : [])];

/** The groups a node directly contains: a group itself, a workflow's expanded plan, or a branch's then and else paths. */
export const planChildGroups = (node: WorkflowPlanNodeInfo): WorkflowPlanGroupInfo[] =>
  isPlanGroup(node) ? [node] : node.kind === "workflow" ? node.plan ? [node.plan] : []
    : node.kind === "branch" ? branchPathGroups(node).map(item => item.group) : [];

/** Every node below a group in document order, groups and branches included; branch paths themselves are not listed. */
export const planNodes = (group: WorkflowPlanGroupInfo | null): WorkflowPlanNodeInfo[] => {
  const result: WorkflowPlanNodeInfo[] = [];
  const walk = (current: WorkflowPlanGroupInfo) => {
    for (const node of current.nodes) {
      result.push(node);
      for (const child of planChildGroups(node)) walk(child);
    }
  };
  if (group) walk(group);
  return result;
};

/** The step and workflow occurrences below a group, in document order. */
export const planEntities = (group: WorkflowPlanGroupInfo | null): PlanEntityInfo[] => planNodes(group).filter(isPlanEntity);
/** The branch occurrences below a group, in document order. */
export const planBranches = (group: WorkflowPlanGroupInfo | null): WorkflowPlanBranchInfo[] =>
  planNodes(group).filter((node): node is WorkflowPlanBranchInfo => node.kind === "branch");

/**
 * Whether a match is included on every possible selection: outside any branch, inside a workflow included that way, or in both
 * paths of a branch. A match in only one alternative is conditional.
 */
export const unconditionallyIncludes = (group: WorkflowPlanGroupInfo | null, matches: (node: WorkflowPlanNodeInfo) => boolean): boolean => {
  const nodeIncludes = (node: WorkflowPlanNodeInfo): boolean => {
    if (matches(node)) return true;
    if (node.kind === "branch") return node.else !== null && groupIncludes(node.then) && groupIncludes(node.else);
    return planChildGroups(node).some(groupIncludes);
  };
  const groupIncludes = (current: WorkflowPlanGroupInfo): boolean => current.nodes.some(nodeIncludes);
  return group !== null && groupIncludes(group);
};

/** The facts of a recorded selection that decide whether it still answers its branch. */
export type BranchSelectionFact = {readonly nodeId: string; readonly path: BranchPath; readonly state: "current" | "invalidated"; readonly condition: string};

/**
 * The selected path of each branch in the plan with a current selection for its present condition. A plan edit that changes a branch's
 * condition, else path or position invalidates its selection durably, so a current selection always answers the branch as it stands.
 */
export const effectiveBranchSelections = (plan: WorkflowPlanGroupInfo | null, selections: readonly BranchSelectionFact[]): Map<string, BranchPath> => {
  const branches = new Map(planBranches(plan).map(branch => [branch.nodeId, branch]));
  const result = new Map<string, BranchPath>();
  for (const selection of selections) {
    const branch = branches.get(selection.nodeId);
    if (selection.state === "current" && branch && branch.condition === selection.condition && (selection.path === "then" || selection.path === "else"))
      result.set(selection.nodeId, selection.path);
  }
  return result;
};

/**
 * Where a node sits relative to the recorded selections: outside every branch, inside selected paths only, inside a path of a branch
 * still undecided, or inside a path that was not selected. A not-selected ancestor path decides first.
 */
export type PlanReach = "unconditional" | "selected" | "undecided" | "not_selected";
const reachRank: Record<PlanReach, number> = {unconditional: 0, selected: 1, undecided: 2, not_selected: 3};
const combineReach = (outer: PlanReach, inner: PlanReach): PlanReach => reachRank[inner] > reachRank[outer] ? inner : outer;

/** Each node with its reach, in document order; a branch carries the reach of its own position, not of its paths. */
export const planReach = (plan: WorkflowPlanGroupInfo | null, selected: ReadonlyMap<string, BranchPath>): Array<{node: WorkflowPlanNodeInfo; reach: PlanReach}> => {
  const result: Array<{node: WorkflowPlanNodeInfo; reach: PlanReach}> = [];
  const walk = (group: WorkflowPlanGroupInfo, reach: PlanReach) => {
    for (const node of group.nodes) {
      result.push({node, reach});
      if (node.kind === "branch") {
        const choice = selected.get(node.nodeId);
        for (const {path, group: child} of branchPathGroups(node))
          walk(child, combineReach(reach, choice === undefined ? "undecided" : choice === path ? "selected" : "not_selected"));
      } else for (const child of planChildGroups(node)) walk(child, reach);
    }
  };
  if (plan) walk(plan, "unconditional");
  return result;
};

/** The step and workflow occurrences that currently apply: outside every branch or inside selected paths only. */
export const activePlanEntities = (plan: WorkflowPlanGroupInfo | null, selected: ReadonlyMap<string, BranchPath>): PlanEntityInfo[] =>
  planReach(plan, selected).flatMap(({node, reach}) => isPlanEntity(node) && (reach === "unconditional" || reach === "selected") ? [node] : []);

/** The branches whose decision is still pending at a position that currently applies; their paths do not apply until one is selected. */
export const pendingBranchDecisions = (plan: WorkflowPlanGroupInfo | null, selected: ReadonlyMap<string, BranchPath>): WorkflowPlanBranchInfo[] =>
  planReach(plan, selected).flatMap(({node, reach}) => node.kind === "branch" && (reach === "unconditional" || reach === "selected") &&
    !selected.has(node.nodeId) ? [node] : []);

/**
 * The identity each branch occurrence's selection answers: its condition, whether it has an else path, and its enclosing workflow
 * occurrences and branch paths. Status changes and supporting work inside or around a path leave it unchanged.
 */
export const branchIdentityKeys = (plan: WorkflowPlanGroupInfo | null): Map<string, string> => {
  const result = new Map<string, string>();
  const walk = (group: WorkflowPlanGroupInfo, ancestors: readonly string[]) => {
    for (const node of group.nodes) {
      if (node.kind === "branch") {
        result.set(node.nodeId, JSON.stringify({condition: node.condition, else: node.else !== null, ancestors}));
        for (const {path, group: child} of branchPathGroups(node)) walk(child, [...ancestors, `branch:${node.nodeId}:${path}`]);
      } else if (node.kind === "workflow") {
        if (node.plan) walk(node.plan, [...ancestors, `workflow:${node.nodeId}`]);
      } else if (isPlanGroup(node)) walk(node, ancestors);
    }
  };
  if (plan) walk(plan, []);
  return result;
};
