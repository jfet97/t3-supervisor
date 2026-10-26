import { EntityDetails } from "./disclosure.js";
import React from "react";
import {DefinitionReferences} from "./definition-references.js";
import type { TaskInterpretationInfo, WorkflowPlanGroupInfo, WorkflowPlanNodeInfo, WorkflowProposalInfo } from "../../src/project-supervisor-contract.js";
import type { WorkflowAssessmentInfo } from "../../src/workflow-assessment.js";
import type { WorkflowProgressBranchSelection, WorkflowProgressContribution, WorkflowProgressObservation, WorkflowProgressWorkflow } from "../../src/workflow-progress.js";
import { branchPathGroups, isPlanGroup, pendingBranchDecisions, planBranches, planEntities, planReach, type BranchPath, type PlanReach } from "../../src/workflow-plan-tree.js";
import { GuideLink } from "./guide-link.js";
import { acceptedAgreement, pendingProposal, statusRecord, type PlanChange, type PlanChangeField, type StepNotes } from "./task-record.js";

const states = {planned: "Planned", underway: "In progress", completed: "Completed", needs_attention: "Needs attention"} as const;
const recordStates = {planned: "planned", underway: "in progress", completed: "completed", needs_attention: "needs attention"} as const;
export type JourneyMode = "live" | "agreed" | "proposed" | "historical";
const modeLabels = {agreed: "Accepted", proposed: "Proposed", historical: "In earlier plan"} as const;

const formatTime = (value: number) => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown time" : date.toLocaleString();
};

export function StepMark({state}: {state: string}) {
  return <span className={`step-mark state-${state}`} aria-hidden="true"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {state === "completed" ? <path d="m5 10 3 3 7-7"/> : state === "needs_attention" ? <path d="M10 5v6m0 3h.01"/> : state === "underway" ? <circle cx="10" cy="10" r="3" fill="currentColor" stroke="none"/>
      : state === "decision" || state === "decision-pending" ? <path d="M10 15v-4m0 0-4-5m4 5 4-5"/> : null}
  </svg></span>;
}

export function planSteps(node: WorkflowPlanNodeInfo | null): Array<Extract<WorkflowPlanNodeInfo, {kind: "step"}>> {
  if (!node) return [];
  return planEntities(isPlanGroup(node) ? node : {kind: "sequence", templatePath: null, nodes: [node]})
    .filter((entity): entity is Extract<WorkflowPlanNodeInfo, {kind: "step"}> => entity.kind === "step");
}

export type CompletionReassessment = "pending" | "changed" | "undated";

/**
 * Why a workflow occurrence's recorded completion no longer stands as current, or null when it does: a decision it reaches is pending,
 * a selection inside it was recorded or invalidated after the completion record, or no completion time is available to show that the
 * completion followed the decisions inside it. The recorded status itself stays as history.
 */
export function completionReassessment(node: Extract<WorkflowPlanNodeInfo, {kind: "workflow"}>, selections: readonly WorkflowProgressBranchSelection[],
  completedAt: number | null | undefined): CompletionReassessment | null {
  if (node.status !== "completed" || !node.plan) return null;
  if (pendingBranchDecisions(node.plan, currentBranchPaths({branchSelections: [...selections]})).length > 0) return "pending";
  const inside = new Set(planBranches(node.plan).map(branch => branch.nodeId));
  const decisions = selections.filter(item => inside.has(item.nodeId));
  if (!decisions.length) return null;
  if (completedAt === null || completedAt === undefined) return "undated";
  return decisions.some(item => item.recordedAt > completedAt || (item.invalidatedAt ?? 0) > completedAt) ? "changed" : null;
}

/** Each completed workflow occurrence's latest completion time, read by the service from the whole record. */
export const completionTimes = (workflow: Pick<WorkflowProgressWorkflow, "completions">): ReadonlyMap<string, number | null> =>
  new Map((workflow.completions ?? []).map(item => [item.nodeId, item.completedAt] as const));

const reassessmentNotice: Record<CompletionReassessment, string> = {
  pending: "This workflow was assessed completed, but a branch decision inside it is pending, so its completion needs reassessment.",
  changed: "This workflow was assessed completed, but a branch decision inside it changed afterwards, so its completion needs reassessment.",
  undated: "This workflow was assessed completed, but no completion time is available to show that it followed the branch decisions inside it, so its completion needs reassessment.",
};

/** The current selected path of each branch in a live workflow; an invalidated or removed selection is not current. */
export const currentBranchPaths = (workflow: Pick<WorkflowProgressWorkflow, "branchSelections"> | undefined): ReadonlyMap<string, BranchPath> =>
  new Map((workflow?.branchSelections ?? []).filter(item => item.current).map(item => [item.nodeId, item.path] as const));

/**
 * What currently applies in a live plan: the steps outside every branch or in selected paths, and the reached decisions still pending.
 * Steps in an undecided or not-selected path are alternatives, not outstanding work, and a pending decision is work of its own. Whatever a
 * current not-applicable assessment settles is neither an applicable step nor a pending decision.
 */
export function liveProgress(plan: WorkflowPlanGroupInfo | null, selected: ReadonlyMap<string, BranchPath>, notApplicable: ReadonlySet<string> = new Set()) {
  const steps = planReach(plan, selected).flatMap(({node, reach}) => node.kind === "step" && (reach === "unconditional" || reach === "selected") &&
    !notApplicable.has(node.nodeId) ? [node] : []);
  return {steps, pending: pendingBranchDecisions(plan, selected).filter(branch => !notApplicable.has(branch.nodeId))};
}

export const hasCurrentAgreement = (task: TaskInterpretationInfo | undefined) => Boolean(acceptedAgreement(task) && !pendingProposal(task));

/** The one-line agreement state for the task band. */
export const alignmentLabel = (task: TaskInterpretationInfo | undefined) => hasCurrentAgreement(task) ? "Plan accepted"
  : acceptedAgreement(task) ? "Update awaiting acceptance"
  : task?.agreement?.status === "stale" ? "Acceptance needs review"
  : task?.workflow?.status === "proposed" ? "Awaiting acceptance"
  : task?.workflow ? "Plan being prepared" : "No plan yet";

// active work opens its workflow: an underway or flagged step, or a reached branch decision still pending
const hasActiveNode = (node: WorkflowPlanNodeInfo, selected: ReadonlyMap<string, BranchPath>): boolean => isPlanGroup(node) ? node.nodes.some(child => hasActiveNode(child, selected))
  : node.kind === "branch" ? !selected.has(node.nodeId) || branchPathGroups(node).some(({path, group}) => selected.get(node.nodeId) === path && hasActiveNode(group, selected))
  : node.status === "underway" || node.status === "needs_attention" || node.kind === "workflow" && node.plan !== null && hasActiveNode(node.plan, selected);

const noNotes: StepNotes = {agreed: null, proposed: null, records: null, changed: new Set()};

// a planned member of a fixed workflow whose latest status record says it does not apply to this task
const notApplicableRecord = (records: readonly WorkflowProgressObservation[] | undefined) => {
  const latest = [...records ?? []].reverse().find(item => item.kind === "status_changed" || item.kind === "not_applicable");
  return latest?.kind === "not_applicable" ? latest : null;
};

/** The step's records: the status record that explains its current state, then any other notes about it. */
function StepRecords({status, records}: {status: keyof typeof states; records: readonly WorkflowProgressObservation[] | undefined}) {
  const current = status === "planned" ? notApplicableRecord(records) : statusRecord(records, status);
  const others = (records ?? []).filter(item => item !== current).reverse();
  return <>
    {current
      ? <div className="step-assessment"><strong>Supervisor assessment</strong><p>{current.note}</p>
        <p className="small muted">{current.kind === "not_applicable" ? "Recorded not applicable" : <>Recorded {current.statusFrom ? `${recordStates[current.statusFrom]} → ` : ""}{recordStates[status]}</>} · {formatTime(current.recordedAt)}</p></div>
      : status !== "planned" && <p className="small muted">No status record for this step was read.</p>}
    {others.length > 0 && <EntityDetails title={<>Earlier step records ({others.length})</>} className="step-history"><ol className="stack">{others.map(item => <li key={item.id}>
      <p>{item.note}</p><p className="small muted">{item.kind === "status_changed" ? `Status ${item.statusFrom ? recordStates[item.statusFrom] : "new"} → ${item.statusTo ? recordStates[item.statusTo] : "removed"}` : item.kind === "not_applicable" ? "Not applicable" : "Note"} · {formatTime(item.recordedAt)}</p>
    </li>)}</ol></EntityDetails>}
  </>;
}

export function StepContributions({items}: {items: readonly WorkflowProgressContribution[] | undefined}) {
  if (!items?.length) return null;
  return <div className="stack step-contributions"><strong>External contributions</strong><ul className="stack">{items.map(item => <li key={item.contributionId} className="workflow-progress-observation">
    <p>{item.state === "awaiting_result" ? "Awaiting external result" : item.state === "withdrawn" ? "External contribution withdrawn"
      : item.assessment?.resultRevision !== item.revision ? "External result received – awaiting assessment" : item.assessment.decision === "accepted" ? "External result accepted" : "Further work requested"}{!item.inCurrentPlan && <> · No longer in the current plan</>} · revision {item.revision} · <code>{item.contributionId}</code></p>
    {item.summary && <p className="definition-copy">{item.summary}</p>}
    {item.references.length > 0 && <ul className="small">{item.references.map((reference, index) => <li key={`${index}:${reference.kind}`}>{({file: "File", url: "URL", source: "Source", text: "Text"})[reference.kind]}: <code>{reference.value}</code></li>)}</ul>}
    {item.externalRef && <p className="small">External reference: <code>{item.externalRef}</code></p>}
    {item.assessment && item.assessment.resultRevision === item.revision && <p className="definition-copy"><strong>Supervisor assessment of the result:</strong> {item.assessment.note}</p>}
    <p className="small muted">Reported by the main · <a href={`t3-thread://v1/${item.sourceThreadId}`}>Open conversation {item.sourceThreadId}</a> · Message <code>{item.sourceMessageId}</code> · {formatTime(item.recordedAt)}</p>
    <p className="small muted">The external work itself was not observed. Summaries and references are the main’s report, not evidence of execution; an accepted result does not complete the step.</p>
  </li>)}</ul></div>;
}

type JourneyProps = {
  node: WorkflowPlanNodeInfo;
  mode?: JourneyMode;
  notes?: StepNotes;
  contributions?: ReadonlyMap<string, readonly WorkflowProgressContribution[]>;
  /** The selections recorded on this same live workflow; accepted, proposed and historical plans show agreed alternatives only. */
  selections?: readonly WorkflowProgressBranchSelection[] | undefined;
  /** Where this node sits relative to the branch decisions above it. */
  reach?: PlanReach;
  /** The completion time of each completed workflow occurrence in this same live workflow; a missing time cannot show a completion current. */
  completions?: ReadonlyMap<string, number | null> | undefined;
  /** Occurrences of this live workflow settled by a current not-applicable assessment, with everything inside an assessed workflow. */
  notApplicable?: ReadonlySet<string> | undefined;
};

const pathLabel = {then: "Then path", else: "Else path"} as const;
const pathCondition = {then: "when the condition holds", else: "when the condition does not hold"} as const;
const deeper = (outer: PlanReach, inner: PlanReach): PlanReach => {
  const rank = {unconditional: 0, selected: 1, undecided: 2, not_selected: 3} as const;
  return rank[inner] > rank[outer] ? inner : outer;
};

/** A branch shows its condition, both labelled paths and, on a live workflow, the operative's decision; the next item follows it. */
function BranchJourney({node, mode, notes, contributions, selections, completions, notApplicable, reach}: JourneyProps & {node: Extract<WorkflowPlanNodeInfo, {kind: "branch"}>; mode: JourneyMode; notes: StepNotes; reach: PlanReach}) {
  const live = mode === "live";
  const current = live ? selections?.find(item => item.nodeId === node.nodeId && item.current) : undefined;
  const earlier = live && !current ? selections?.find(item => item.nodeId === node.nodeId) : undefined;
  const pending = live && !current && reach !== "not_selected" && reach !== "undecided" && !notApplicable?.has(node.nodeId);
  const decision = !live ? mode === "proposed" ? "Proposed alternatives" : "Agreed alternatives"
    : reach === "not_selected" ? "In a path not selected" : current ? `${pathLabel[current.path]} selected` : reach === "undecided" ? "Waits for an earlier decision"
    : earlier ? "Decision pending again" : "Decision pending";
  const pathState = (path: BranchPath): PlanReach => !live ? "unconditional" : reach === "not_selected" ? "not_selected" : !current ? "undecided" : current.path === path ? "selected" : "not_selected";
  const pathText: Record<PlanReach, string | null> = {unconditional: null, selected: "Selected", undecided: "Awaiting decision", not_selected: "Not selected"};
  const childProps = {mode, notes, ...(contributions ? {contributions} : {}), ...(selections ? {selections} : {}), ...(completions ? {completions} : {}),
    ...(notApplicable ? {notApplicable} : {})};
  // the condition, the decision and its short reason stay primary; provenance, history and the plan note are inspectable details
  return <div className={`journey-branch${pending ? " decision-pending" : ""}`} role="group" aria-label={`Branch: if ${node.condition}`}>
    <div className="branch-head">
      <StepMark state={pending ? "decision-pending" : "decision"}/>
      <p className="branch-condition"><span className="branch-label">Branch</span> <span>If {node.condition}</span></p>
      <span className="step-state">{decision}</span>
    </div>
    <div className="branch-explanation small">
      {current && <p>Reason: {current.reason}</p>}
      <p className="branch-help"><GuideLink topic="branches">How branches work</GuideLink></p>
      {(current || earlier || node.reason) && <EntityDetails title={<>Decision details</>} className="branch-details"><div className="stack">
        {current && <p>Recorded by the agent as revision {current.revision} · {formatTime(current.recordedAt)} · <a href={`t3-thread://v1/${current.sourceThreadId}`}>Open conversation</a> · message <code>{current.sourceMessageId}</code>. A selection records the decision, not completed work.</p>}
        {earlier && <p>An earlier selection ({pathLabel[earlier.path].toLowerCase()}, revision {earlier.revision}) no longer applies because the branch changed{earlier.inCurrentPlan ? "" : " or left the plan"}.</p>}
        {node.reason && <p>Plan note: {node.reason}</p>}
      </div></EntityDetails>}
    </div>
    <div className="branch-paths">{(["then", "else"] as const).map(path => {
      const group = path === "then" ? node.then : node.else;
      const state = pathState(path);
      return <section key={path} className={`branch-path path-${state}`} aria-label={`${pathLabel[path]}, ${pathCondition[path]}${pathText[state] ? `: ${pathText[state]!.toLowerCase()}` : ""}`}>
        <p className="branch-path-label">{pathLabel[path]} <span>{pathCondition[path]}</span>{pathText[state] && <span className={`pill ${state === "selected" ? "blue" : state === "undecided" ? "amber" : ""}`}>{pathText[state]}</span>}</p>
        {group ? <PlanJourney node={group} {...childProps} reach={deeper(reach, state)}/> : <p className="small">No else path: if the condition does not hold, work continues with the next item.</p>}
      </section>;
    })}</div>
  </div>;
}

/** Preserves sequence, parallel, branch and nested workflow boundaries without deriving parent completion from children. */
export function PlanJourney({node, mode = "proposed", notes = noNotes, contributions, selections, completions, notApplicable, reach = "unconditional"}: JourneyProps) {
  const live = mode === "live";
  const passed = {mode, notes, reach, ...(contributions ? {contributions} : {}), ...(selections ? {selections} : {}), ...(completions ? {completions} : {}),
    ...(notApplicable ? {notApplicable} : {})};
  if (isPlanGroup(node)) {
    const List = node.kind === "parallel" ? "ul" : "ol";
    return <div className={`journey-group group-${node.kind}`}>
      {node.kind === "parallel" && <p className="parallel-label">In parallel <span>These parts have no declared order</span></p>}
      <List role="list" className="journey-track" aria-label={node.kind === "parallel" ? "Parallel work" : "Plan sequence"}>{node.nodes.map((child, index) =>
        <li key={"nodeId" in child ? child.nodeId : `${child.kind}:${index}`}><PlanJourney node={child} {...passed}/></li>)}</List>
    </div>;
  }
  if (node.kind === "branch") return <BranchJourney node={node} {...passed}/>;
  const alternative = live && node.status === "planned" && (reach === "not_selected" || reach === "undecided");
  // the completion time comes from the whole record; the retained observations can no longer hold an older completion
  const reassess = live && reach !== "not_selected" && node.kind === "workflow" ? completionReassessment(node, selections ?? [], completions?.get(node.nodeId)) : null;
  const state = !live ? mode === "proposed" ? "proposed" : "planned" : alternative ? reach : reassess ? "needs_attention" : node.status;
  const assessedNotApplicable = live && !alternative && node.status === "planned" && notApplicable?.has(node.nodeId) === true;
  const label = !live ? modeLabels[mode] : alternative ? reach === "not_selected" ? "Not selected" : "Awaiting decision"
    : reassess ? "Completed earlier · needs reassessment" : reach === "not_selected" ? `${states[node.status]} · path not selected`
    : assessedNotApplicable ? "Not applicable" : states[node.status];
  const accepted = notes.agreed?.get(node.nodeId)?.node;
  const proposed = notes.proposed?.get(node.nodeId)?.node;
  const acceptedNote = accepted && accepted.reason !== node.reason ? accepted.reason : null;
  const proposedNote = proposed && proposed.reason !== node.reason && proposed.reason !== accepted?.reason ? proposed.reason : null;
  const outsideAccepted = live && notes.agreed !== null && !accepted;
  const changeProposed = notes.changed.has(node.nodeId);
  return <div className={`journey-stop state-${state}`}>
    <EntityDetails title={<>
        <StepMark state={state}/><span className="step-name">{node.name}{node.kind === "workflow" && <small>Workflow</small>}
          {(changeProposed || outsideAccepted) && <span className="step-flags">{changeProposed && <span className="pill blue">Update proposed</span>}{outsideAccepted && <span className="pill">Not in the accepted plan</span>}</span>}</span>
        <span className="step-state">{label}</span>
      </>} className="journey-step" open={live && reach !== "not_selected" && hasActiveNode(node, currentBranchPaths({branchSelections: selections ?? []})) || undefined}
      summaryProps={{"aria-current":live && node.status === "underway" && reach !== "not_selected" ? "step" : undefined}}>

      <div className="step-explanation">
        {node.description && <p>{node.description}</p>}
        <DefinitionReferences references={node.references} skills={node.skills}/>
        {node.reason && <div className="step-note"><strong>Plan note</strong><p>{node.reason}</p></div>}
        {acceptedNote && <div className="step-note"><strong>Accepted plan note</strong><p>{acceptedNote}</p></div>}
        {proposedNote && <div className="step-note proposed"><strong>Proposed plan note · awaiting acceptance</strong><p>{proposedNote}</p></div>}
        {reassess && <p className="notice">{reassessmentNotice[reassess]} The recorded status stays as history.</p>}
        {live && <StepRecords status={node.status} records={notes.records?.get(node.nodeId)}/>}
        {node.kind === "workflow" && node.omissions.length > 0 && <div className="step-note"><strong>Not applicable in this plan</strong><ul className="stack">{node.omissions.map((omission, index) =>
          <li key={`${omission.templatePath}:${omission.id}:${index}`}><strong>{omission.name}</strong> <span className="muted">({omission.kind} {omission.id})</span> — {omission.reason}</li>)}</ul></div>}
        {node.resolution !== "resolved" && <p className="notice">Definition {node.resolution}. Some commitments still need clarification.</p>}
        {live && <StepContributions items={contributions?.get(node.nodeId)}/>}
        {node.contributorThreadIds.length > 0 && <p className="small">Contributors: {node.contributorThreadIds.map((id, index) => <React.Fragment key={id}>{index > 0 && ", "}<a href={`t3-thread://v1/${id}`}>Conversation {index + 1}</a></React.Fragment>)}</p>}
        <p className="small muted step-source">{node.definitionId ? <>Definition <code>{node.definitionId}</code></> : node.kind === "step" && node.localId ? <>Task-local step <code>{node.localId}</code></> : "Definition not recorded"}
          {node.source?.path && <> · <code>{node.source.path}</code></>}{node.kind === "workflow" && node.fixed && <> · fixed workflow</>}</p>
      </div>
      {node.kind === "workflow" && node.plan && <div className="nested-journey"><PlanJourney node={node.plan} {...passed}/></div>}
      {node.kind === "workflow" && !node.plan && <p className="small muted">No expanded plan is recorded for this workflow.</p>}
    </EntityDetails>
  </div>;
}

const proposalStatusDescription: Record<WorkflowProposalInfo["status"], string> = {
  pending: "The plan is still being prepared; no acceptance is recorded for it.",
  proposed: "Proposed for acceptance. No acceptance is recorded for this proposal.",
  provisional: "A finite working plan is available while unresolved requirements or definition issues remain visible.",
  unavailable: "A usable plan could not be prepared from the available definitions.",
  stale: "The source revision changed. Review the definitions and negotiate the plan again.",
  invalid: "The proposal could not be accepted as a valid plan.",
};
const proposalProgress: Record<WorkflowProposalInfo["status"], string> = {pending: "Preparing the plan", proposed: "Proposed the plan", provisional: "Provisional plan with open issues",
  unavailable: "Plan unavailable", invalid: "Plan needs correction", stale: "Plan needs review"};

/** The actual proposal and acceptance records for the task, each stated once. */
export function TaskAlignment({task, supervisorThreadId}: {task: TaskInterpretationInfo | undefined; supervisorThreadId?: string}) {
  const accepted = acceptedAgreement(task);
  const pending = pendingProposal(task);
  const current = Boolean(accepted && !pending);
  const stale = task?.agreement?.status === "stale";
  const historical = Boolean(task && ["expired", "not_supervised"].includes(task.status));
  const proposal = pending ?? task?.workflow ?? task?.agreement?.workflow;
  const update = Boolean(accepted && pending);
  const supervisorLine = task?.engagement?.mode === "following" ? "Understanding and draft duties retained" : !proposal ? "No plan recorded yet" : update ? proposal.status === "pending" ? "Preparing an updated plan" : "Proposed an updated plan" : proposalProgress[proposal.status];
  // the proposal's own message is shown only while it is the open question; an accepted plan is described by its acceptance
  const proposalMessage = proposal && (pending || !accepted) && !(stale && !pending) ? proposal.message : null;
  const agentLine = historical && task?.agreement ? "Earlier acceptance retained"
    : current ? "Accepted this plan"
    : update ? "Earlier plan accepted; update awaiting acceptance"
    : stale ? "Earlier acceptance is out of date"
    : "Acceptance has not been recorded";
  const agreement = task?.agreement;
  const agreedAt = agreement ? formatTime(agreement.agreedAt) : null;
  const shown = accepted?.workflow ?? proposal;
  return <section className={`task-alignment ${current ? "is-agreed" : ""}`} aria-labelledby="task-alignment-title">
    <h3 id="task-alignment-title">Agent and Supervisor</h3>
    <ol className="alignment-exchange" role="list">
      <li><StepMark state={proposal?.status === "proposed" ? "completed" : "planned"}/><div><strong>Supervisor</strong><p>{supervisorLine}</p>{proposalMessage && <p className="alignment-note">{proposalMessage}</p>}</div></li>
      <li><StepMark state={current ? "completed" : stale || update ? "needs_attention" : "planned"}/><div><strong>Agent</strong><p>{agentLine}{agreedAt && (current || update) ? <span className="small muted"> · {agreedAt}</span> : null}</p>
        {agreement && (current || historical) && <p className="alignment-note">{agreement.message}</p>}</div></li>
    </ol>
    <div className="alignment-links">{supervisorThreadId && <a href={`t3-thread://v1/${supervisorThreadId}`}>Open Supervisor</a>}{task && <a href={`t3-thread://v1/${task.threadId}`}>Open agent conversation</a>}</div>
    {agreement && <EntityDetails title={<>{current ? "Acceptance record" : "Earlier acceptance record"}</>} className="small"><div className="stack">
      {!current && <p>{agreement.message}</p>}
      <p>Accepted <time dateTime={new Date(agreement.agreedAt).toISOString()}>{agreedAt}</time> · proposal <code>{agreement.proposalId}</code></p>
      <p>Agent message <code>{agreement.agentMessageId}</code> · {agreement.evidence.kind === "supervisor_message" ? <>Supervisor message <code>{agreement.evidence.messageId}</code></>
        : <>Interpretation submission: attempt <code>{agreement.evidence.attemptId}</code>, item <code>{agreement.evidence.itemId}</code></>}</p>
      <p className="muted">Acceptance records an agreed plan; it does not show that any step was performed.</p>
    </div></EntityDetails>}
    {shown && <EntityDetails title={<>Plan provenance</>} className="small"><div className="stack">
      {proposal && (pending || !accepted) && <p>{proposalStatusDescription[proposal.status]}{task?.workflowProposalId && <> Proposal <code>{task.workflowProposalId}</code>.</>}</p>}
      <p>Definitions {shown.definitionsStatus === "ready" ? "valid" : shown.definitionsStatus.replaceAll("_", " ")}{shown.definitionsComplete ? "" : " · read incomplete"}{shown.requirementsKnown ? "" : " · requirements unknown"}</p>
      {shown.workspaceRoot && <p>Checkout <code>{shown.workspaceRoot}</code>{shown.revision && <> · revision <code>{shown.revision}</code></>}</p>}
      {shown.requirements.length > 0
        ? <ul className="stack">{shown.requirements.map((requirement, index) => <li key={`${requirement.kind}:${requirement.id}:${index}`}>Required {requirement.kind} <strong>{requirement.name}</strong> · {({included: "included", not_applicable: "not applicable", unresolved: "unresolved", unknown: "unknown"})[requirement.state]}{requirement.reason ? ` — ${requirement.reason}` : ""}</li>)}</ul>
        : <p className="muted">{shown.requirementsKnown && shown.definitionsComplete && shown.definitionsStatus === "ready" ? "No required definitions are configured." : "Requirements may be unknown because the definitions are missing, invalid or incompletely read."}</p>}
      {shown.issues.length > 0 && <ul className="definition-issues">{shown.issues.map((issue, index) => <li key={`${issue.path}:${issue.code}:${index}`}><code>{issue.path}</code><p>{issue.message}</p></li>)}</ul>}
      <p className="muted">A plan or its acceptance does not prove that work was performed.</p>
    </div></EntityDetails>}
    {task && <EntityDetails title={<>Task interpretation</>} className="small"><p>{task.status === "inferred" ? "Interpreted from the request." : task.status.replaceAll("_", " ")}{task.reason ? ` ${task.reason}` : ""}</p></EntityDetails>}
  </section>;
}

const changeLabels: Record<PlanChangeField, string> = {name: "name", description: "description", note: "plan note", definition: "definition", references: "references",
  skills: "skills", fixed: "fixed workflow", omissions: "not-applicable items", condition: "branch condition", paths: "branch paths", grouping: "grouping or branch path", order: "order"};

/** The actual differences between the accepted plan and the proposal awaiting acceptance. */
export function PlanChanges({changes, proposal, proposalId}: {changes: readonly PlanChange[]; proposal: WorkflowProposalInfo; proposalId?: string | undefined}) {
  return <section className="plan-changes" aria-labelledby="plan-changes-title">
    <h3 id="plan-changes-title">Proposed update awaiting acceptance</h3>
    <p className="small muted">{proposalStatusDescription[proposal.status]}{proposalId && <> Proposal <code>{proposalId}</code>.</>} {proposal.plan ? "Compared with the accepted plan; step statuses below are unchanged until the Supervisor records new assessments." : ""}</p>
    {!proposal.plan ? <p>The update’s plan is not recorded yet.</p> : changes.length === 0 ? <p>No changes to the plan’s steps were found; inspect the proposal details.</p> : <ul className="stack">{changes.map(change => <li key={`${change.kind}:${change.nodeId}`}>
      {change.kind === "added" ? <><strong>Adds {change.name}</strong>{change.note && <p className="small">{change.note}</p>}</>
        : change.kind === "removed" ? <strong>Removes {change.name}</strong>
        : <><strong>{change.previousName === change.name ? change.name : `${change.previousName} → ${change.name}`}</strong>
          <span className="small muted"> · changes {change.fields.map(field => changeLabels[field]).join(", ")}</span>
          {change.fields.includes("note") && <EntityDetails title={<>Compare plan notes</>} className="note-compare-toggle"><dl className="note-compare"><div><dt>Accepted</dt><dd>{change.previousNote}</dd></div><div><dt>Proposed</dt><dd>{change.note}</dd></div></dl></EntityDetails>}</>}
    </li>)}</ul>}
  </section>;
}

export function TaskOutcome({assessment, fallback, stopped, currentStep}: {assessment: WorkflowAssessmentInfo | null; fallback: string; stopped: boolean; currentStep?: string}) {
  // a recorded completion stays visible, but it is not presented as current while a branch decision is pending or changed after it
  const reassessment = assessment?.status === "completed" ? assessment.reassessment ?? null : null;
  const state = stopped ? "paused" : reassessment ? "needs_attention" : assessment?.status ?? "planned";
  const title = stopped ? "Supervision stopped" : reassessment ? "Completion needs reassessment" : assessment?.status === "completed" ? "Task completed" : assessment?.status === "underway" ? "Work in progress" : assessment?.status === "needs_attention" ? "Needs attention" : fallback;
  return <div className={`task-outcome state-${state}`}><StepMark state={state}/><div><strong>{title}</strong>{currentStep && !stopped && <p className="outcome-current">Now: {currentStep}</p>}{reassessment && <p>{reassessment}</p>}{assessment && <p>{reassessment ? "Recorded assessment: " : ""}{assessment.summary}</p>}{!assessment && <p>Progress appears when the Supervisor records an assessment for this task.</p>}</div></div>;
}
