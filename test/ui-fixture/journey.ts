import type { TaskInterpretationInfo, WorkflowAgreementInfo, WorkflowPlanGroupInfo, WorkflowPlanNodeInfo, WorkflowPlanStepInfo, WorkflowPlanWorkflowInfo, WorkflowProposalInfo, WorkflowRequirementInfo } from "../../src/project-supervisor-contract.js";
import type { WorkflowProgressBranchEvent, WorkflowProgressBranchSelection, WorkflowProgressObservation, WorkflowProgressSnapshot } from "../../src/workflow-progress.js";
import {emptyConversation} from "../../src/supervision-conversation-contract.js";

// A reconstructed example of a warehouse packing change: a GTIN scan selects an article and quantity-label scans add pieces.
// Every text is labelled; none of it records Supervisor work, native messages or a run. The plan follows a project's
// high-level change workflow; occurrence IDs stay the same across proposals and the live plan.
export const journeyCases = ["request", "following", "catching-up", "paused", "proposal", "agreed", "working", "attention", "revised", "reagreed", "verified", "nested", "nested-attention", "completed", "stale", "retained",
  "branch-proposal", "branch-pending", "branch-selected", "branch-changed"] as const;
export type JourneyCase = typeof journeyCases[number];

export const journeyTitle = "Packing quantity scans (reconstructed example)";
export const journeyObjective = "Reconstructed example: when packing, scanning an article’s GTIN selects it without counting a piece; each following quantity-label scan adds its amount, so 20 identical pieces take one GTIN scan plus five 4-piece label scans instead of 20 GTIN scans.";
const reconstructed = "A reconstructed example for the dashboard; not a record of Supervisor work.";

type Status = WorkflowPlanStepInfo["status"];
type Key = "scope" | "evidence" | "design" | "rollout" | "implement" | "recurrence" | "verify" | "review" | "correctness" | "fit" | "findings" | "deliver";
const source = (kind: "steps" | "workflows", id: string) => ({origin: "project" as const, path: `.t3-supervisor/${kind}/${id}.${kind === "steps" ? "md" : "yaml"}`, sourceId: id});
const definitions: Record<Key, {id: string; name: string; description: string}> = {
  scope: {id: "scope-and-authority", name: "Scope and authority", description: "State the goal, the limits of the change and the result the requester has authorized. Note any extra authority before relying on it."},
  evidence: {id: "gather-evidence", name: "Gather source evidence", description: "Collect the requirements and facts the result depends on. Write down conflicts and open questions instead of guessing."},
  design: {id: "design-approach", name: "Design the approach", description: "Choose an approach that fits the existing design, and explain any departure from it."},
  rollout: {id: "data-and-rollout", name: "Data and rollout plan", description: "Plan any data, migration or release work the change needs, or say why there is none."},
  implement: {id: "implement-in-scope", name: "Implement within scope", description: "Make the agreed change and nothing unrelated to it."},
  recurrence: {id: "prevent-recurrence", name: "Prevent recurrence", description: "When a defect or correction reveals a gap, keep the corrected rule in a lasting test or document; otherwise say why this does not apply."},
  verify: {id: "verify-behavior", name: "Verify behavior", description: "Show evidence for each acceptance criterion from a check that could actually fail."},
  review: {id: "review", name: "Review", description: "Reviewers other than the author assess the finished change. The main conversation responds to every finding."},
  correctness: {id: "review-correctness", name: "Correctness review", description: "A reviewer other than the author checks that the behavior is right and nothing else broke."},
  fit: {id: "review-fit", name: "Fit and simplicity review", description: "A reviewer other than the author checks that the change is simple, in scope and consistent."},
  findings: {id: "account-for-findings", name: "Account for findings", description: "Record each finding and how it was resolved."},
  deliver: {id: "deliver-and-close-out", name: "Deliver and close out", description: "Deliver the authorized result and stop there."},
};
// plan notes ("why this step") for this task; the revision refines only Verify behavior's note
const notes: Record<Key, string> = {
  scope: "Goal: one GTIN scan selects the article; quantity labels add pieces. Authorized result: a reviewed pull request. Merge and release are outside this task.",
  evidence: "The request decides the counting rules and which quantity labels exist.",
  design: "Extend the existing packing scan flow.",
  rollout: "Check whether stored data, imports, flags or release steps change.",
  implement: "Packing scan handling only.",
  recurrence: "Applies only if a defect or correction exposes a gap.",
  verify: "Required: a GTIN scan then quantity-label scans reach the ordered amount.",
  review: "Required for repository changes.",
  correctness: "Part of the project’s fixed Review workflow.",
  fit: "Part of the project’s fixed Review workflow.",
  findings: "Part of the project’s fixed Review workflow.",
  deliver: "The authorized result is a reviewed pull request.",
};
const refinedVerify = "Required: the GTIN selects without counting (0); quantity labels add (4 → 8 → 12 → 16 → 20); a label beyond the open amount is rejected and leaves the count unchanged; a quantity before an article is rejected.";

// read-only pointers carried by the project definitions themselves (not task evidence)
const guidance: Partial<Record<Key, {references?: string[]; skills?: string[]}>> = {scope: {references: ["AGENTS.md"]}, verify: {skills: ["browser-testing"]}};
const step = (key: Key, note: string, status: Status = "planned"): WorkflowPlanStepInfo => ({kind: "step", nodeId: `packing-${key}`, definitionId: definitions[key].id, localId: null,
  templatePath: null, name: definitions[key].name, description: definitions[key].description, ...guidance[key], source: source("steps", definitions[key].id), resolution: "resolved",
  reason: note, status, contributorThreadIds: []});

type Statuses = Partial<Record<Key, Status>>;
function plan(verifyNote: string, statuses: Statuses = {}, liveNotes: Partial<Record<Key, string>> = {}): WorkflowPlanGroupInfo {
  const node = (key: Key) => step(key, key === "verify" ? liveNotes.verify ?? verifyNote : liveNotes[key] ?? notes[key], statuses[key] ?? "planned");
  const review: WorkflowPlanWorkflowInfo = {kind: "workflow", nodeId: "packing-review", definitionId: "review", templatePath: null, name: definitions.review.name,
    description: definitions.review.description, fixed: true, source: source("workflows", "review"), resolution: "resolved", reason: notes.review,
    status: statuses.review ?? "planned", contributorThreadIds: [], omissions: [],
    plan: {kind: "sequence", templatePath: null, nodes: [{kind: "parallel", templatePath: null, nodes: [node("correctness"), node("fit")]}, node("findings")]}};
  const nodes: WorkflowPlanNodeInfo[] = [node("scope"), node("evidence"), node("design"), node("rollout"), node("implement"), node("recurrence"), node("verify"), review, node("deliver")];
  return {kind: "sequence", templatePath: null, nodes};
}

const requirements: WorkflowRequirementInfo[] = [
  {kind: "step", id: "verify-behavior", name: "Verify behavior", source: source("steps", "verify-behavior"), state: "included", reason: "Required for behavior changes."},
  {kind: "workflow", id: "review", name: "Review", source: source("workflows", "review"), state: "included", reason: "Required for repository changes."},
];
const proposal = (verifyNote: string, message: string): WorkflowProposalInfo => ({status: "proposed", message, workspaceRoot: "/fixture/project-a", revision: "fixture-definitions-packing",
  globalRevision: null, definitionsStatus: "ready", definitionsComplete: true, requirementsKnown: true, requirements, issues: [], plan: plan(verifyNote)});

// Supervisor assessments recorded for each step as the work moves; each status change carries its own record
type Moment = {at: number; statuses: Statuses; notes: Partial<Record<Key, string>>; task?: {status: Status; note: string}};
const moments: Record<"working" | "attention" | "reagreed" | "verified" | "nested" | "nested-attention" | "completed", Moment> = {
  working: {at: 40, statuses: {scope: "completed", evidence: "completed", design: "underway"}, notes: {
    scope: "Reconstructed example: goal and authorized result confirmed with the agent.",
    evidence: "Reconstructed example: the GTIN scan must not count a piece; 20 pieces are one GTIN plus five 4-piece labels; labels exist for 1, 2, 3 and 4 pieces.",
    design: "Reconstructed example: reusing the existing packing scan planner; no parallel scan path."},
    task: {status: "underway", note: "Reconstructed example: requirements are clear. The design is underway."}},
  attention: {at: 28, statuses: {scope: "completed", evidence: "completed", design: "completed", rollout: "completed", implement: "completed", verify: "needs_attention"}, notes: {
    design: "Reconstructed example: the GTIN scan selects the article; quantity scans add to the selected line.",
    rollout: "Reconstructed example: not applicable — no persisted data, import, flag or migration change; release timing stays with the requester.",
    implement: "Reconstructed example: article selection and quantity scans are implemented in the packing scan flow.",
    verify: "Reconstructed example: evidence shows GTIN → 0, then 4 → 8 → 12 → 16 → 20. Nothing yet shows what happens when a label exceeds the open amount."},
    task: {status: "needs_attention", note: "Reconstructed example: the happy path is shown; a label beyond the open amount is not yet evidenced."}},
  reagreed: {at: 18, statuses: {scope: "completed", evidence: "completed", design: "completed", rollout: "completed", implement: "completed", verify: "underway"}, notes: {
    verify: "Reconstructed example: checking the refined criterion, including a label larger than the open amount."},
    task: {status: "underway", note: "Reconstructed example: the refined check is accepted; verification is running."}},
  verified: {at: 11, statuses: {scope: "completed", evidence: "completed", design: "completed", rollout: "completed", implement: "completed", recurrence: "completed", verify: "completed"}, notes: {
    recurrence: "Reconstructed example: applies — the corrected rule (a GTIN does not count a piece; overfill is rejected) is kept in the unit and packing browser tests.",
    verify: "Reconstructed example: GTIN → 0; labels 4 → 8 → 12 → 16 → 20; a 4-label at 18 of 20 is rejected and the count stays 18; a quantity before an article is rejected."},
    task: {status: "underway", note: "Reconstructed example: the refined criterion is verified. Independent review is next."}},
  nested: {at: 7, statuses: {scope: "completed", evidence: "completed", design: "completed", rollout: "completed", implement: "completed", recurrence: "completed", verify: "completed", review: "underway", correctness: "underway", fit: "underway"}, notes: {
    review: "Reconstructed example: two independent reviewers are assessing the frozen change.",
    correctness: "Reconstructed example: checking counting, overfill and article switching against the base.",
    fit: "Reconstructed example: checking reuse of the existing scan flow and scope."},
    task: {status: "underway", note: "Reconstructed example: verified; independent review is underway."}},
  "nested-attention": {at: 6, statuses: {scope: "completed", evidence: "completed", design: "completed", rollout: "completed", implement: "completed", recurrence: "completed", verify: "completed", review: "underway", correctness: "completed", fit: "needs_attention"}, notes: {
    correctness: "Reconstructed example: counting, overfill rejection and article switching are correct.",
    fit: "Reconstructed example: the reviewer asks for the partial-carton labels 1, 2 and 3 to use the same scan path."},
    task: {status: "needs_attention", note: "Reconstructed example: a review finding needs a response."}},
  completed: {at: 2, statuses: {scope: "completed", evidence: "completed", design: "completed", rollout: "completed", implement: "completed", recurrence: "completed", verify: "completed", review: "completed", correctness: "completed", fit: "completed", findings: "completed", deliver: "completed"}, notes: {
    review: "Reconstructed example: two independent reviews completed with no unresolved findings.",
    correctness: "Reconstructed example: counting, overfill rejection and article switching are correct; no findings.",
    fit: "Reconstructed example: reuses the existing scan flow and stays in scope; no findings.",
    findings: "Reconstructed example: both reviews returned no findings; recorded with the change.",
    deliver: "Reconstructed example: reviewed pull request ready for the requester’s handoff. Not merged or released by this task."},
    task: {status: "completed", note: "Reconstructed example: one GTIN scan selects; quantity labels add to 20 in six scans; overfill is rejected unchanged. Reviewed pull request ready for handoff; not released."}},
};
const order = ["working", "attention", "reagreed", "verified", "nested", "nested-attention", "completed"] as const;
const keys = Object.keys(definitions) as Key[];

function history(phase: typeof order[number], now: number) {
  const records: WorkflowProgressObservation[] = [];
  let previous: Statuses = {};
  let previousTask: Status = "planned";
  const notesSoFar: Partial<Record<Key, string>> = {};
  for (const name of order.slice(0, order.indexOf(phase) + 1)) {
    if (name === "nested-attention" && phase === "completed") continue;
    const moment = moments[name];
    const at = now - moment.at * 60_000;
    for (const key of keys) {
      const from = previous[key] ?? "planned", to = moment.statuses[key] ?? "planned";
      if (moment.notes[key]) notesSoFar[key] = moment.notes[key];
      if (from === to) continue;
      records.push({id: `packing-record-${name}-${key}`, kind: "status_changed", recordedAt: at, targetNodeId: `packing-${key}`, targetNodeName: definitions[key].name,
        statusFrom: from, statusTo: to, sourceThreadId: null, sourceRunId: null, sourceMessageId: null, sourceItemId: null, note: moment.notes[key] ?? notesSoFar[key] ?? "Reconstructed example: status recorded."});
    }
    if (moment.task && moment.task.status !== previousTask) records.push({id: `packing-record-${name}-task`, kind: "status_changed", recordedAt: at, targetNodeId: null, targetNodeName: null,
      statusFrom: previousTask, statusTo: moment.task.status, sourceThreadId: null, sourceRunId: null, sourceMessageId: null, sourceItemId: null, note: moment.task.note});
    if (name === "attention") records.push({id: "packing-record-attention-question", kind: "note", recordedAt: at + 30_000, targetNodeId: "packing-verify", targetNodeName: definitions.verify.name,
      statusFrom: null, statusTo: null, sourceThreadId: null, sourceRunId: null, sourceMessageId: null, sourceItemId: null,
      note: "Reconstructed example: asked the agent what shows that a quantity label beyond the open amount is rejected and leaves the count unchanged."});
    previous = moment.statuses;
    previousTask = moment.task?.status ?? previousTask;
  }
  return {records, statuses: previous, notes: notesSoFar, task: moments[phase].task!};
}

/** The reconstructed packing journey through the production API contracts, with no native work or conversation messages. */
export function fixtureJourney(phase: JourneyCase, projectId: string, threadId: string, supervisorThreadId: string, now: number) {
  const revisedOrLater = ["revised", "reagreed", "verified", "nested", "nested-attention", "completed"].includes(phase);
  const v2Accepted = revisedOrLater && phase !== "revised";
  const proposalV1 = proposal(notes.verify, "Reconstructed example: the Supervisor proposed the project’s change workflow for this task.");
  const proposalV2 = proposal(refinedVerify, "Reconstructed example: the Supervisor proposed a sharper Verify behavior criterion after the attention record.");
  const agreement = (accepted: WorkflowProposalInfo, proposalId: string, agreedAt: number, stale = false): WorkflowAgreementInfo => ({status: stale ? "stale" : "agreed",
    message: "Reconstructed example: the agent accepted this exact proposal; acceptance is not execution evidence.", proposalId, agreedAt,
    evidence: {kind: "supervisor_message", messageId: `fixture-packing-supervisor-${proposalId}`}, agentMessageId: `fixture-packing-agent-${proposalId}`, workflow: accepted});
  const base = {id: "fixture-task-packing", sourceHash: "fixture-source-packing", threadId, projectId, sourceRunId: "fixture-run-packing", sourceMessageId: "fixture-message-packing",
    objective: journeyObjective, reason: reconstructed, updatedAt: now - 50 * 60_000};
  let task: TaskInterpretationInfo = phase === "request" ? {...base, status: "waiting", objective: null, reason: "Reconstructed example: the request is being interpreted."}
    : phase === "proposal" ? {...base, status: "inferred", workflow: proposalV1, workflowProposalId: "packing-proposal-1"}
    : phase === "revised" ? {...base, status: "inferred", workflow: proposalV2, workflowProposalId: "packing-proposal-2", agreement: agreement(proposalV1, "packing-proposal-1", now - 45 * 60_000)}
    : v2Accepted ? {...base, status: "inferred", workflow: proposalV2, workflowProposalId: "packing-proposal-2", agreement: agreement(proposalV2, "packing-proposal-2", now - 22 * 60_000)}
    : phase === "stale" ? {...base, status: "inferred", workflow: proposalV1, workflowProposalId: "packing-proposal-1", agreement: agreement(proposalV1, "packing-proposal-1", now - 45 * 60_000, true)}
    : {...base, status: "inferred", workflow: proposalV1, workflowProposalId: "packing-proposal-1", agreement: agreement(proposalV1, "packing-proposal-1", now - 45 * 60_000)};
  task = {...task, engagement: {mode: ["following", "paused", "catching-up"].includes(phase) ? "following" : "engaged",
    availability: phase === "catching-up" || phase === "request" ? "catching_up" : phase === "stale" ? "stale" : "current", consideredAt: now}};
  if (phase.startsWith("branch-")) return branchJourney(phase as BranchCase, task, base, agreement, projectId, threadId, supervisorThreadId, now);
  if (["following", "paused", "catching-up"].includes(phase)) {
    task = {...task, ...(phase !== "paused" ? {workflow: null, agreement: null} : {}), conversation: {...emptyConversation(now), draft: {objective: "Reconstructed example: discuss the quantity scan behavior before deciding on implementation.",
      constraints: ["No deployment is authorized."], questions: ["Should a quantity scan replace or add to the current amount?"],
      findings: [{text: "The existing packing flow distinguishes article and quantity scans; this finding remains to be assessed.", messageIds: []}],
      duties: ["Clarify scan behavior and the verification needed for it."]}}};
  }
  const livePhase = phase === "revised" ? "attention" : phase === "stale" || phase === "paused" ? "working" : phase;
  const live = (order as readonly string[]).includes(livePhase) ? history(livePhase as typeof order[number], now) : null;
  const liveVerifyNote = v2Accepted ? refinedVerify : notes.verify;
  const workflows: WorkflowProgressSnapshot["workflows"] = live ? [{workflowId: "fixture-workflow-packing", projectId, mainThreadId: threadId, threadId, parentThreadId: null,
    revision: order.indexOf(livePhase as typeof order[number]) + 2, status: live.task.status, objective: journeyObjective, plan: plan(liveVerifyNote, live.statuses),
    assessment: {taskId: base.id, sourceHash: base.sourceHash, status: live.task.status, summary: live.task.note, updatedAt: now - moments[livePhase as typeof order[number]].at * 60_000},
    updatedAt: now - moments[livePhase as typeof order[number]].at * 60_000, parentNodeReferences: [], observations: live.records, contributions: []}]
    : phase === "retained" ? [{workflowId: "fixture-workflow-earlier", projectId, mainThreadId: threadId, threadId, parentThreadId: null, revision: 4, status: "completed",
      objective: "Reconstructed example: an earlier task in this conversation (packing label layout)", plan: {kind: "sequence", templatePath: null, nodes: [step("scope", notes.scope, "completed"), step("deliver", notes.deliver, "completed")]},
      assessment: {taskId: "fixture-task-earlier", sourceHash: "fixture-source-earlier", status: "completed", summary: "Reconstructed example: the earlier task was assessed complete.", updatedAt: now - 3 * 86_400_000},
      updatedAt: now - 3 * 86_400_000, parentNodeReferences: [], observations: [], contributions: []}] : [];
  const progress: WorkflowProgressSnapshot = {status: "ok", message: null, projectId, mainThreadId: threadId, observedAt: now,
    scope: {projectId, mainThreadId: threadId, supervisorThreadId, bindingGeneration: 1, observedAt: now, complete: true, lineageTotal: 1, lineageOffset: 0, lineageHasMore: false, issues: [], threads: [
      {threadId, parentThreadId: null, depth: 0, origin: "main", title: journeyTitle, lifecycle: phase === "completed" ? "completed" : "running", lifecycleDetail: phase === "completed" ? "completed" : "running",
        archivedAt: null, deletedAt: null, activityRefs: [], contactLimit: "Reconstructed example: no messages are sent."},
    ]}, coverage: [{threadId, state: "root", assigneeThreadId: null, assigneeTitle: null, assignmentRootThreadId: null}], incompatibleWorkflows: [], workflows,
    workflowOffset: 0, workflowHasMore: false, lineageOffset: 0, lineageHasMore: false};
  return {task, progress};
}

// the same packing change with a Review that chooses its depth: one independent review for a contained change, or two paired reviews;
// the choice belongs to the agent, the dashboard only reads it, and a selection is not evidence that the selected review happened
type BranchCase = "branch-proposal" | "branch-pending" | "branch-selected" | "branch-changed";
const reviewCondition = "The change is contained, well understood and low risk.";
const singleReview: WorkflowPlanStepInfo = {kind: "step", nodeId: "packing-review-single", definitionId: null, localId: "single-review", templatePath: null,
  name: "Single independent review", description: "One reviewer other than the author assesses the contained change; small straightforward findings are fixed and checked without another round.",
  source: null, resolution: "resolved", reason: "Part of the project’s fixed Review workflow.", status: "planned", contributorThreadIds: []};
function branchPlan(statuses: Statuses & {single?: Status} = {}): WorkflowPlanGroupInfo {
  const base = plan(notes.verify, statuses);
  const node = (key: "correctness" | "fit" | "findings") => step(key, notes[key], statuses[key] ?? "planned");
  return {...base, nodes: base.nodes.map(item => item.kind !== "workflow" ? item : {...item, plan: {kind: "sequence", templatePath: null, nodes: [
    {kind: "branch", nodeId: "packing-review-depth", templatePath: null, condition: reviewCondition, reason: "Review depth follows the change’s scope and risk.",
      then: {kind: "sequence", templatePath: null, nodes: [{...singleReview, status: statuses.single ?? "planned"}]},
      else: {kind: "sequence", templatePath: null, nodes: [{kind: "parallel", templatePath: null, nodes: [node("correctness"), node("fit")]}]}},
    node("findings")]}})};
}
function branchJourney(phase: BranchCase, base: TaskInterpretationInfo, taskBase: {id: string; sourceHash: string}, agreement: (accepted: WorkflowProposalInfo, proposalId: string, agreedAt: number) => WorkflowAgreementInfo,
  projectId: string, threadId: string, supervisorThreadId: string, now: number) {
  const proposed: WorkflowProposalInfo = {...proposal(notes.verify, "Reconstructed example: the Supervisor proposed the change workflow, whose Review chooses its depth."), plan: branchPlan()};
  const task: TaskInterpretationInfo = phase === "branch-proposal" ? {...base, workflow: proposed, workflowProposalId: "packing-proposal-branch", agreement: null}
    : {...base, workflow: proposed, workflowProposalId: "packing-proposal-branch", agreement: agreement(proposed, "packing-proposal-branch", now - 45 * 60_000)};
  const done: Statuses = {scope: "completed", evidence: "completed", design: "completed", rollout: "completed", implement: "completed", recurrence: "completed", verify: "completed"};
  const selection = (path: "then" | "else", revision: number, reason: string, at: number, current = true): WorkflowProgressBranchSelection => ({nodeId: "packing-review-depth",
    inCurrentPlan: true, current, path, revision, reason, condition: reviewCondition, sourceThreadId: threadId, sourceMessageId: `fixture-packing-selection-${revision}`,
    recordedAt: at, invalidatedAt: null});
  const event = (path: "then" | "else", revision: number, note: string, at: number): WorkflowProgressBranchEvent => ({id: `fixture-branch-event-${revision}`, kind: "selected",
    nodeId: "packing-review-depth", revision, path, note, sourceThreadId: threadId, sourceMessageId: `fixture-packing-selection-${revision}`, recordedAt: at});
  const thenReason = "Reconstructed example: one scan module changes and its behavior is covered by focused tests.";
  const elseReason = "Reconstructed example: the overfill rule turned out to touch shared carton accounting, so two paired reviews fit.";
  const live = phase === "branch-pending" ? {statuses: {...done, review: "underway"} as Statuses, selections: [] as WorkflowProgressBranchSelection[], events: [] as WorkflowProgressBranchEvent[],
    task: {status: "underway" as Status, note: "Reconstructed example: verified; the review depth is not decided yet."}, reassessment: null}
    : phase === "branch-selected" ? {statuses: {...done, review: "underway", single: "underway"} as Statuses & {single?: Status}, selections: [selection("then", 1, thenReason, now - 9 * 60_000)],
      events: [event("then", 1, thenReason, now - 9 * 60_000)], task: {status: "underway" as Status, note: "Reconstructed example: one independent review is underway."}, reassessment: null}
    : phase === "branch-changed" ? {statuses: {...done, review: "completed", single: "completed", findings: "completed", deliver: "completed"} as Statuses & {single?: Status},
      selections: [selection("else", 2, elseReason, now - 3 * 60_000)], events: [event("else", 2, elseReason, now - 3 * 60_000), event("then", 1, thenReason, now - 30 * 60_000)],
      task: {status: "completed" as Status, note: "Reconstructed example: the single review found nothing; reviewed pull request ready for handoff."},
      reassessment: "A branch decision changed after this completion was assessed, so it needs reassessment."}
    : null;
  const childId = "fixture-branch-reviewer";
  const workflows: WorkflowProgressSnapshot["workflows"] = live ? [{workflowId: "fixture-workflow-packing", projectId, mainThreadId: threadId, threadId, parentThreadId: null, revision: 6,
    status: live.task.status, objective: journeyObjective, plan: branchPlan(live.statuses), assessment: {taskId: taskBase.id, sourceHash: taskBase.sourceHash, status: live.task.status,
      summary: live.task.note, updatedAt: now - 10 * 60_000, ...(live.reassessment ? {reassessment: live.reassessment} : {})}, updatedAt: now - 3 * 60_000, parentNodeReferences: [],
    observations: [], contributions: [], branchSelections: live.selections, branchEvents: live.events},
  ...(phase === "branch-selected" ? [{workflowId: "fixture-workflow-branch-reviewer", projectId, mainThreadId: threadId, threadId: childId, parentThreadId: threadId, revision: 3,
    status: "underway" as Status, objective: "Reconstructed example: the delegated reviewer’s own plan.", plan: {kind: "sequence" as const, templatePath: null, nodes: [{kind: "branch" as const,
      nodeId: "fixture-child-branch", templatePath: null, condition: "The diff stays within the packing scan module.", reason: "The reviewer decides whether one pass is enough.",
      then: {kind: "sequence" as const, templatePath: null, nodes: [{...singleReview, nodeId: "fixture-child-one-pass", localId: "one-pass", name: "One review pass", status: "underway" as Status}]},
      else: null}]}, assessment: {taskId: taskBase.id, sourceHash: taskBase.sourceHash, status: "underway", summary: "Reconstructed example: the reviewer’s pass is underway.",
      updatedAt: now - 5 * 60_000}, updatedAt: now - 5 * 60_000,
    parentNodeReferences: [{parentWorkflowId: "fixture-workflow-packing", parentThreadId: threadId, nodeId: "packing-review-single", nodeKind: "step" as const, nodeName: singleReview.name}],
    observations: [], contributions: [], branchSelections: [{nodeId: "fixture-child-branch", inCurrentPlan: true, current: true, path: "then" as const, revision: 1,
      reason: "Reconstructed example: the reviewer confirmed the diff stays inside the scan module.", condition: "The diff stays within the packing scan module.", sourceThreadId: childId,
      sourceMessageId: "fixture-child-selection-1", recordedAt: now - 6 * 60_000, invalidatedAt: null}],
    branchEvents: []}] : [])] : [];
  type ScopeThread = NonNullable<WorkflowProgressSnapshot["scope"]>["threads"][number];
  const mainThread: ScopeThread = {threadId, parentThreadId: null, depth: 0, origin: "main", title: journeyTitle, lifecycle: "running", lifecycleDetail: "running",
    archivedAt: null, deletedAt: null, activityRefs: [], contactLimit: "Reconstructed example: no messages are sent."};
  const threads: ScopeThread[] = phase === "branch-selected" ? [mainThread, {...mainThread, threadId: childId, parentThreadId: threadId, depth: 1, origin: "native_child", title: "Reconstructed reviewer"}] : [mainThread];
  const progress: WorkflowProgressSnapshot = {status: "ok", message: null, projectId, mainThreadId: threadId, observedAt: now,
    scope: {projectId, mainThreadId: threadId, supervisorThreadId, bindingGeneration: 1, observedAt: now, complete: true, lineageTotal: threads.length, lineageOffset: 0, lineageHasMore: false, issues: [], threads},
    coverage: threads.map(thread => ({threadId: thread.threadId, state: "root" as const, assigneeThreadId: null, assigneeTitle: null, assignmentRootThreadId: null})), incompatibleWorkflows: [], workflows,
    workflowOffset: 0, workflowHasMore: false, lineageOffset: 0, lineageHasMore: false};
  return {task, progress};
}
