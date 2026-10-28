import type { ProjectSupervisorInfo, TaskInterpretationInfo, WorkflowPlanGroupInfo } from "../../src/project-supervisor-contract.js";
import type { WorkflowProgressSnapshot, WorkflowProgressWorkflow } from "../../src/workflow-progress.js";
import { planEntities } from "../../src/workflow-plan-tree.js";

const childIds = ["fixture-reviewer-correctness", "fixture-reviewer-fit"] as const;
const region = ["packing-implement", "packing-recurrence", "packing-verify", "packing-review", "packing-correctness", "packing-fit", "packing-findings"];
const note = "Reconstructed example: the review found an overfill defect; implementation and its checks are reopened.";

const returnPlan = (plan: WorkflowPlanGroupInfo): WorkflowPlanGroupInfo => ({...plan, nodes: [
  ...plan.nodes.slice(0, -1),
  {kind: "branch", nodeId: "packing-redo-decision", templatePath: null, condition: "The review leaves a material implementation finding.", reason: "Reconstructed example: a failed review returns to the affected work.",
    then: {kind: "sequence", templatePath: null, nodes: [{kind: "back_to", nodeId: "packing-return", templatePath: null, target: "implement-in-scope", targetNodeId: "packing-implement", maximum: 5, budgetId: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", reason: note}]}, else: null},
  ...plan.nodes.slice(-1),
]});

/** Synthetic returned-work data, decoded by the same public API schemas as native progress. */
export function returnedJourney(input: {task: TaskInterpretationInfo; progress: WorkflowProgressSnapshot}, now: number): {task: TaskInterpretationInfo; progress: WorkflowProgressSnapshot} {
  const main = input.progress.workflows[0]!;
  const mainId = input.progress.mainThreadId;
  const mainPlan = returnPlan(main.plan!);
  const reset = (plan: WorkflowPlanGroupInfo): WorkflowPlanGroupInfo => ({...plan, nodes: plan.nodes.map(node => {
    if (node.kind === "sequence" || node.kind === "parallel") return reset(node);
    if (node.kind === "workflow") return {...node, status: "planned", plan: node.plan ? reset(node.plan) : null};
    return node.kind === "step" && region.includes(node.nodeId) ? {...node, status: node.nodeId === "packing-implement" ? "underway" : "planned"} : node;
  })});
  const history: NonNullable<WorkflowProgressWorkflow["history"]> = [
    {id: "fixture-history-1", sequence: 0, kind: "status_changed", recordedAt: now - 600_000, targetNodeId: "packing-implement", targetNodeName: "Implement within scope", attempt: 1,
      statusFrom: "underway", statusTo: "completed", sourceThreadId: mainId, sourceMessageId: "fixture-implementation-report", sourceItemId: null, note: "Reconstructed example: the first implementation was completed."},
    {id: "fixture-history-2", sequence: 1, kind: "observation", recordedAt: now - 180_000, targetNodeId: "packing-review", targetNodeName: "Review", attempt: 1,
      statusFrom: null, statusTo: null, sourceThreadId: childIds[0], sourceMessageId: "fixture-review-finding", sourceItemId: null, note},
    {id: "fixture-history-3", sequence: 2, kind: "return_applied", recordedAt: now - 60_000, targetNodeId: "packing-implement", targetNodeName: "Implement within scope", attempt: 2,
      statusFrom: "completed", statusTo: "planned", sourceThreadId: mainId, sourceMessageId: "fixture-return-ack", sourceItemId: null, note},
    {id: "fixture-history-4", sequence: 3, kind: "status_changed", recordedAt: now - 30_000, targetNodeId: "packing-implement", targetNodeName: "Implement within scope", attempt: 2,
      statusFrom: "planned", statusTo: "underway", sourceThreadId: mainId, sourceMessageId: "fixture-correction-started", sourceItemId: null, note: "Reconstructed example: correcting overfill in the existing implementation."},
  ];
  const workflow: WorkflowProgressWorkflow = {...main, status: "underway", plan: reset(mainPlan), updatedAt: now - 30_000,
    assessment: {taskId: input.task.id!, sourceHash: input.task.sourceHash!, status: "underway", summary: note, updatedAt: now - 30_000},
    observations: [], history, historyComplete: true, attempts: region.map(nodeId => ({nodeId, attempt: 2})),
    returns: [{returnId: "fixture-return-1", backToNodeId: "packing-return", targetNodeId: "packing-implement", targetName: "Implement within scope", regionNodeIds: region,
      attempt: 1, state: "applied", reason: note, sourceThreadId: mainId, sourceMessageId: "fixture-return-ack", requestedAt: now - 90_000, resolvedAt: now - 60_000,
      closed: region.map(nodeId => ({nodeId, status: "completed", contributorThreadIds: [...childIds]})),
      retiredRuns: [{kind: "provider_turns", threadId: childIds[0], providerThreadId: "fixture-provider-reviewer", providerTurnIds: ["fixture-first-review-turn"]},
        {kind: "thread", threadId: childIds[1], reason: "Separate native rounds are unavailable in this synthetic provider."}], note}]};
  const accepted = input.task.agreement?.workflow;
  const task = {...input.task, ...(input.task.workflow ? {workflow: {...input.task.workflow, plan: returnPlan(input.task.workflow.plan!)}} : {}),
    ...(accepted && input.task.agreement ? {agreement: {...input.task.agreement, workflow: {...accepted, plan: returnPlan(accepted.plan!)}}} : {})};
  const children: WorkflowProgressWorkflow[] = childIds.map((threadId, index) => {
    const parent = planEntities(main.plan).find(node => node.nodeId === (index === 0 ? "packing-correctness" : "packing-fit"))!;
    return {...main, workflowId: `fixture-review-workflow-${index}`, threadId, parentThreadId: mainId, status: "completed",
      assessment: {taskId: input.task.id!, sourceHash: input.task.sourceHash!, status: "completed", updatedAt: now - 180_000,
        summary: "Reconstructed example: the reviewer completed the first pass; its findings remain part of the earlier attempt."},
      objective: `Reconstructed example: ${parent.name}, first attempt.`,
      plan: {kind: "sequence", templatePath: null, nodes: [{...parent, nodeId: `fixture-review-pass-${index}`, status: "completed"}]},
      parentNodeReferences: [{parentWorkflowId: main.workflowId, parentThreadId: mainId, nodeId: parent.nodeId, nodeKind: parent.kind, nodeName: parent.name}],
      history: [], historyComplete: true, observations: [], contributions: [], returns: [], attempts: []};
  });
  return {task, progress: {...input.progress, workflows: [workflow, ...children],
    coverage: [...input.progress.coverage ?? [], ...childIds.map(threadId => ({threadId, state: "root" as const, assigneeThreadId: null, assigneeTitle: null, assignmentRootThreadId: null}))],
    scope: input.progress.scope ? {...input.progress.scope, lineageTotal: 3,
    threads: [...input.progress.scope.threads, ...childIds.map((threadId, index) => ({...input.progress.scope!.threads[0]!, threadId, parentThreadId: mainId,
      depth: 1, origin: "native_child" as const, title: `Reconstructed example: reviewer ${index + 1}`, lifecycle: "completed" as const, lifecycleDetail: "completed" as const,
      observedRunId: null, observedProviderTurnId: index === 0 ? "fixture-first-review-turn" : null}))]} : null}};
}

/** Synthetic per-actor awareness and pause records; no native message is sent. */
export function returnedSupervision(projectId: string, mainThreadId: string, ownerThreadId: string, now: number): Pick<ProjectSupervisorInfo, "planning" | "monitoringStatus"> {
  return {monitoringStatus: {state: "idle", message: "Reconstructed example: following active corrections; last read and assessment differ.", pendingItems: 2, nextReviewAt: null, lastNoticeAt: now - 20_000,
    awareness: {reads: [mainThreadId, ...childIds].map((targetThreadId, index) => ({actorThreadId: ownerThreadId, targetThreadId, callItemId: `fixture-read-${index}`, runId: "fixture-supervisor-run",
      at: now - 10_000, itemId: `fixture-read-last-${index}`, position: 20 + index, partial: index === 1, snapshotEndReached: index !== 1})),
      assessments: [mainThreadId, ...childIds].map(targetThreadId => ({actorThreadId: ownerThreadId, targetThreadId, at: now - 20_000, throughObservedAt: now - 30_000, itemIds: []}))}},
    planning: [{id: "fixture-planning-1", operationId: "fixture-pause-1", projectId, mainThreadId, ownerThreadId, bindingGeneration: 1, taskId: "fixture-task-packing", taskRevision: "fixture-task-revision",
      reason: "Reconstructed example: the earlier review round was paused before returning to implementation.", createdAt: now - 100_000, startedAt: now - 100_000,
      deadline: now + 200_000, state: "resolved", resolution: "continue", closedAt: now - 60_000,
      targets: [mainThreadId, ...childIds].map((threadId, index) => ({threadId, recipientThreadId: index === 2 ? mainThreadId : threadId,
        scope: index === 0 ? "Hold review dispatch while the return is applied." : "The earlier review attempt.", state: "released",
        hold: {messageId: `fixture-hold-${index}`, commandId: `fixture-hold-command-${index}`, state: "sent", attemptedAt: now - 100_000, runId: "fixture-hold-run"},
        release: {messageId: `fixture-release-${index}`, commandId: `fixture-release-command-${index}`, state: "sent", attemptedAt: now - 60_000, runId: "fixture-release-run"}})),
      draft: {threadId: "fixture-plan-writer", taskId: "fixture-writer-task", state: "closed", cleanupConfirmedAt: now - 60_000, resultMessageId: "fixture-writer-result", resultRunId: "fixture-writer-run"}}]};
}
