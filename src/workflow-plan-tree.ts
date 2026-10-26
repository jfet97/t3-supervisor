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

export type OccurrenceStatus = PlanEntityInfo["status"];

/** The plan with the named step and workflow occurrences' statuses replaced, or the index of the first edit naming no occurrence. */
export const withOccurrenceStatuses = (plan: WorkflowPlanGroupInfo, edits: ReadonlyArray<{nodeId: string; status: OccurrenceStatus}>):
  {plan: WorkflowPlanGroupInfo} | {unknownIndex: number} => {
  const entities = new Set(planEntities(plan).map(node => node.nodeId));
  const unknownIndex = edits.findIndex(edit => !entities.has(edit.nodeId));
  if (unknownIndex >= 0) return {unknownIndex};
  const statuses = new Map(edits.map(edit => [edit.nodeId, edit.status] as const));
  const mapGroup = (group: WorkflowPlanGroupInfo): WorkflowPlanGroupInfo => ({...group, nodes: group.nodes.map(mapNode)});
  const mapNode = (node: WorkflowPlanNodeInfo): WorkflowPlanNodeInfo => {
    if (isPlanGroup(node)) return mapGroup(node);
    if (node.kind === "branch") return {...node, then: mapGroup(node.then), else: node.else ? mapGroup(node.else) : null};
    const status = statuses.get(node.nodeId) ?? node.status;
    return node.kind === "workflow" ? {...node, status, plan: node.plan ? mapGroup(node.plan) : null} : {...node, status};
  };
  return {plan: mapGroup(plan)};
};

export type OmissionEditProblem = "unknown" | "not_flexible_member" | "started" | "empties_group";

/**
 * The plan with the named members of flexible workflows replaced by visible not-applicable omissions whose provenance comes from the
 * occurrence itself, or the first edit that cannot be represented. Fixed workflows, members added outside the template and members with
 * recorded progress (their own or a nested occurrence's) are never omitted; an omission cannot empty a workflow or a branch path, directly
 * or through a nested group. Every other occurrence keeps its ID and status.
 */
export const withOmissions = (plan: WorkflowPlanGroupInfo, edits: ReadonlyArray<{nodeId: string; reason: string}>):
  {plan: WorkflowPlanGroupInfo} | {index: number; problem: OmissionEditProblem} => {
  const reasons = new Map(edits.map((edit, index) => [edit.nodeId, {reason: edit.reason, index}] as const));
  const found = new Set<string>();
  let failure: {index: number; problem: OmissionEditProblem} | null = null;
  const fail = (nodeId: string, problem: OmissionEditProblem) => {failure ??= {index: reasons.get(nodeId)!.index, problem};};
  // owner collects the omissions of its own direct template members; nested workflows own theirs
  type Owner = {node: WorkflowPlanWorkflowInfo; omissions: WorkflowPlanWorkflowInfo["omissions"][number][]};
  let lastRemoved: string | null = null;
  const mapGroup = (group: WorkflowPlanGroupInfo, owner: Owner | null, removable: boolean): WorkflowPlanGroupInfo | null => {
    const nodes: WorkflowPlanNodeInfo[] = [];
    for (const node of group.nodes) {
      if (isPlanEntity(node) && reasons.has(node.nodeId)) {
        found.add(node.nodeId);
        if (!owner || owner.node.fixed !== false || !node.templatePath) fail(node.nodeId, "not_flexible_member");
        else if (planEntities({kind: "sequence", templatePath: null, nodes: [node]}).some(item => item.status !== "planned")) fail(node.nodeId, "started");
        else owner.omissions.push({templatePath: node.templatePath, kind: node.kind,
          id: node.kind === "step" ? node.definitionId ?? node.localId ?? "" : node.definitionId, name: node.name, source: node.source,
          reason: reasons.get(node.nodeId)!.reason});
        lastRemoved = node.nodeId;
        continue;
      }
      const mapped = mapNode(node, owner);
      if (mapped) nodes.push(mapped);
    }
    if (nodes.length) return {...group, nodes};
    if (removable) return null;
    if (lastRemoved) fail(lastRemoved, "empties_group");
    return {...group, nodes};
  };
  const mapNode = (node: WorkflowPlanNodeInfo, owner: Owner | null): WorkflowPlanNodeInfo | null => {
    if (isPlanGroup(node)) return mapGroup(node, owner, true);
    if (node.kind === "branch") return {...node, then: mapGroup(node.then, owner, false)!, else: node.else ? mapGroup(node.else, owner, false) : null};
    if (node.kind === "step" || !node.plan) return node;
    const own: Owner = {node, omissions: []};
    const nested = mapGroup(node.plan, own, false);
    return {...node, plan: nested, omissions: [...node.omissions, ...own.omissions]};
  };
  const mapped = mapGroup(plan, null, false)!;
  const unknown = edits.findIndex(edit => !found.has(edit.nodeId));
  if (unknown >= 0) return {index: unknown, problem: "unknown"};
  return failure ?? {plan: mapped};
};

/**
 * Each recorded omission keyed by its owning workflow occurrence and template member, comparable between a proposal and the live plan:
 * the owner's definition, its template position and its ordinal among occurrences at that position.
 */
export const planOmissionKeys = (plan: WorkflowPlanGroupInfo | null): Set<string> => {
  const seen = new Map<string, number>();
  return new Set(planEntities(plan).flatMap(node => {
    if (node.kind !== "workflow") return [];
    const owner = JSON.stringify([node.definitionId, node.templatePath]);
    const ordinal = seen.get(owner) ?? 0;
    seen.set(owner, ordinal + 1);
    return node.omissions.map(item => JSON.stringify([node.definitionId, node.templatePath, ordinal, item.templatePath]));
  }));
};

/** A compact current outline: each occurrence's identity, nesting, status and reach, without descriptions or history. */
export type PlanStatusOutlineRow = {
  nodeId: string; kind: "step" | "workflow" | "branch"; depth: number; group: "sequence" | "parallel" | "then" | "else";
  name: string; ref: string | null; status: OccurrenceStatus | null; reach: PlanReach; fixed?: boolean;
  omitted?: Array<{id: string; name: string; reason: string}>; condition?: string; selected?: BranchPath | null;
  /** a planned fixed member recorded not applicable in the current scope; it is not completed */
  notApplicable?: true;
};
export const planStatusOutline = (plan: WorkflowPlanGroupInfo | null, selected: ReadonlyMap<string, BranchPath>,
  notApplicable: ReadonlySet<string> = new Set()): PlanStatusOutlineRow[] => {
  const rows: PlanStatusOutlineRow[] = [];
  const walk = (group: WorkflowPlanGroupInfo, depth: number, label: PlanStatusOutlineRow["group"], reach: PlanReach) => {
    for (const node of group.nodes) {
      if (isPlanGroup(node)) {walk(node, depth, node.kind, reach);continue;}
      if (node.kind === "branch") {
        const choice = selected.get(node.nodeId) ?? null;
        rows.push({nodeId: node.nodeId, kind: "branch", depth, group: label, name: "branch", ref: null, status: null, reach, condition: node.condition, selected: choice});
        for (const {path, group: child} of branchPathGroups(node))
          walk(child, depth + 1, path, combineReach(reach, choice === null ? "undecided" : choice === path ? "selected" : "not_selected"));
        continue;
      }
      rows.push({nodeId: node.nodeId, kind: node.kind, depth, group: label, name: node.name,
        ref: node.kind === "step" ? node.definitionId ? `step:${node.definitionId}` : `local:${node.localId ?? ""}` : `workflow:${node.definitionId}`,
        status: node.status, reach, ...(node.kind === "workflow" ? {fixed: node.fixed === true} : {}),
        ...(node.status === "planned" && notApplicable.has(node.nodeId) ? {notApplicable: true as const} : {}),
        ...(node.kind === "workflow" && node.omissions.length ? {omitted: node.omissions.map(item => ({id: item.id, name: item.name, reason: item.reason}))} : {})});
      if (node.kind === "workflow" && node.plan) walk(node.plan, depth + 1, node.plan.kind, reach);
    }
  };
  if (plan) walk(plan, 0, plan.kind, "unconditional");
  return rows;
};

/** The node a store plan pointer such as /plan/nodes/1/plan/nodes/0/status addresses, or null. */
export const planNodeAtPointer = (plan: WorkflowPlanGroupInfo | null, pointer: string): WorkflowPlanNodeInfo | null => {
  const segments = pointer.split("/").slice(1);
  if (segments[0] !== "plan" || !plan) return null;
  let node: WorkflowPlanNodeInfo = plan;
  for (let index = 1; index < segments.length; index++) {
    const segment = segments[index]!;
    if (segment === "status") break;
    const next: WorkflowPlanNodeInfo | null | undefined = segment === "nodes" ? (isPlanGroup(node) ? node.nodes[Number(segments[++index])] : undefined)
      : segment === "plan" ? (node.kind === "workflow" ? node.plan : undefined)
      : segment === "then" || segment === "else" ? (node.kind === "branch" ? node[segment] : undefined) : undefined;
    if (!next) return null;
    node = next;
  }
  return node;
};

/**
 * Each step and workflow occurrence with its reach and whether its nearest enclosing workflow occurrence is fixed. Occurrences in `opaque`
 * are listed but their contents are not: a workflow recorded not applicable settles its whole subtree.
 */
export const occurrenceFacts = (plan: WorkflowPlanGroupInfo | null, selected: ReadonlyMap<string, BranchPath>, fixedOwner = false,
  opaque: ReadonlySet<string> = new Set()): Array<{node: PlanEntityInfo; reach: PlanReach; fixedMember: boolean}> => {
  const result: Array<{node: PlanEntityInfo; reach: PlanReach; fixedMember: boolean}> = [];
  const walk = (group: WorkflowPlanGroupInfo, reach: PlanReach, fixedMember: boolean) => {
    for (const node of group.nodes) {
      if (isPlanGroup(node)) walk(node, reach, fixedMember);
      else if (node.kind === "branch") {
        const choice = selected.get(node.nodeId);
        for (const {path, group: child} of branchPathGroups(node))
          walk(child, combineReach(reach, choice === undefined ? "undecided" : choice === path ? "selected" : "not_selected"), fixedMember);
      } else {
        result.push({node, reach, fixedMember});
        if (node.kind === "workflow" && node.plan && !opaque.has(node.nodeId)) walk(node.plan, reach, node.fixed === true);
      }
    }
  };
  if (plan) walk(plan, "unconditional", fixedOwner);
  return result;
};

/** The planned not-applicable occurrences that settle themselves and, for a workflow, everything inside it. */
const settledByAssessment = (plan: WorkflowPlanGroupInfo | null, selected: ReadonlyMap<string, BranchPath>, notApplicable: ReadonlySet<string>,
  fixedOwner: boolean): Set<string> => new Set(occurrenceFacts(plan, selected, fixedOwner, notApplicable)
  .filter(({node, fixedMember}) => fixedMember && node.status === "planned" && notApplicable.has(node.nodeId)).map(({node}) => node.nodeId));

/**
 * The applicable occurrences inside a plan group that are not settled. Settled means completed, or a planned member of a fixed workflow
 * recorded as not applicable together with everything inside it: fixed members are never omitted, so that record keeps them visible
 * without blocking what follows.
 */
export const unsettledOccurrences = (group: WorkflowPlanGroupInfo | null, selected: ReadonlyMap<string, BranchPath>,
  notApplicable: ReadonlySet<string>, fixedOwner = false): PlanEntityInfo[] => {
  const assessed = settledByAssessment(group, selected, notApplicable, fixedOwner);
  return occurrenceFacts(group, selected, fixedOwner, assessed).filter(({node, reach}) => (reach === "unconditional" || reach === "selected") &&
    node.status !== "completed" && !assessed.has(node.nodeId)).map(item => item.node);
};

/** The reached decisions still pending outside the subtrees of occurrences recorded not applicable. */
export const pendingDecisionsOutside = (group: WorkflowPlanGroupInfo | null, selected: ReadonlyMap<string, BranchPath>,
  notApplicable: ReadonlySet<string>, fixedOwner = false): WorkflowPlanBranchInfo[] => {
  const assessed = settledByAssessment(group, selected, notApplicable, fixedOwner);
  const inside = new Set(planEntities(group).filter(node => node.kind === "workflow" && assessed.has(node.nodeId))
    .flatMap(node => planBranches(node.kind === "workflow" ? node.plan : null).map(branch => branch.nodeId)));
  return pendingBranchDecisions(group, selected).filter(branch => !inside.has(branch.nodeId));
};

/** Every occurrence settled by a not-applicable record: the assessed occurrences and everything inside assessed workflows. */
export const notApplicableSubtrees = (plan: WorkflowPlanGroupInfo | null, selected: ReadonlyMap<string, BranchPath>, notApplicable: ReadonlySet<string>): Set<string> => {
  const assessed = settledByAssessment(plan, selected, notApplicable, false);
  return new Set(planEntities(plan).flatMap(node => !assessed.has(node.nodeId) ? []
    : [node.nodeId, ...(node.kind === "workflow" ? planNodes(node.plan).flatMap(inner => "nodeId" in inner ? [inner.nodeId] : []) : [])]));
};

/**
 * The occurrences whose latest status record is a not-applicable assessment made in the current task scope; an assessment from an earlier
 * scope, or one followed by a status change, no longer counts. Pending entries of the apply being validated belong to the current scope.
 */
export const notApplicableNodeIds = (stored: ReadonlyArray<{kind: string; targetNodeId: string | null; scopeRevision?: string}>, scope: string | null,
  pending: ReadonlyArray<{kind: string; targetNodeId?: string | null}> = []): Set<string> => {
  const latest = new Map<string, boolean>();
  for (const item of stored)
    if (item.targetNodeId && (item.kind === "status_changed" || item.kind === "not_applicable"))
      latest.set(item.targetNodeId, item.kind === "not_applicable" && scope !== null && item.scopeRevision === scope);
  for (const item of pending)
    if (item.targetNodeId && (item.kind === "status_changed" || item.kind === "not_applicable")) latest.set(item.targetNodeId, item.kind === "not_applicable");
  return new Set([...latest].flatMap(([nodeId, current]) => current ? [nodeId] : []));
};
