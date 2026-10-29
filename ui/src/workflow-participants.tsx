import React from "react";
import type { WorkflowProgressParticipant, WorkflowProgressWorkflow } from "../../src/workflow-progress.js";
import { EntityDetails, HelpDisclosure } from "./disclosure.js";
import { GuideLink } from "./guide-link.js";

// each coverage value is one distinct fact; the label is what a first-time operator reads, the detail what the receipt disclosure explains
const coverageText: Record<WorkflowProgressParticipant["coverage"], {label: string; detail: string; tone: "green" | "blue" | "amber"}> = {
  native: {label: "Observed by the service", detail: "A verified native descendant the service reads itself.", tone: "green"},
  supervisor_observed: {label: "Read by the Supervisor", tone: "green",
    detail: "The Supervisor's own attributed read, backed by its completed native tool call. The service verified that call, not what the Supervisor concluded from it."},
  lifecycle_only: {label: "Lifecycle only", detail: "Only a wait, list or search call was cited; no transcript read is established.", tone: "blue"},
  reported: {label: "Reported by the main only", detail: "The main declared this participant; nothing was observed.", tone: "blue"},
  unsupported: {label: "No route stated", detail: "The Supervisor stated that no route to observe this participant exists.", tone: "amber"},
  unknown: {label: "Unknown", detail: "No declaration and no receipt.", tone: "amber"},
};
const kindText = {native_child: "Native child conversation", t3_conversation: "T3 conversation", external: "External participant", unknown: "Unknown participant"} as const;
const lifecycleText = {running: "Running", completed: "Completed", interrupted: "Interrupted", unknown: "Unknown", reported: "As reported by the main"} as const;
const completionText = {none: "Not completed", native_completed: "Conversation completed (not step completion)", result_reported: "Result reported, not assessed",
  accepted: "Result accepted by the Supervisor", needs_more: "Further work needed", withdrawn: "Withdrawn"} as const;
const ownerText = {root: "Supervisor root", helper: "A helper", unknown: "Unknown"} as const;
// settlement after task completion: a T3-managed conversation settles by its own command; anything else has no settlement to show
const settlementText: Record<WorkflowProgressParticipant["settlement"], string> = {not_evaluated: "Not evaluated (the task has not completed)",
  not_applicable: "Not applicable (not a T3 conversation; its completion is the reported result)", pending: "Settling", uncertain: "Settlement uncertain, retried",
  settled: "Settled", superseded: "Settlement superseded by new activity", unresolved: "Unresolved", skipped: "Not settled"};
const settlementReasonText: Record<string, string> = {unavailable: "the conversation could not be read", not_quiet: "the conversation still has work",
  settle_rejected: "T3 rejected the settle command: the conversation changed or its user chose", snapshot_unavailable: "its read carries no update time to settle on",
  environment_settle_unsupported: "no supported route settles a conversation in another environment", keep_active: "its user keeps it active"};
const settlementLine = (participant: WorkflowProgressParticipant) => `${settlementText[participant.settlement]}${participant.settlementReason
  ? ` (${settlementReasonText[participant.settlementReason] ?? participant.settlementReason})` : ""}`;
const threadHref = (threadId: string) => `t3-thread://v1/${threadId}`;
const time = (value: number) => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown time" : date.toLocaleString();
};

// a declared conversation in another environment is a different conversation: it gets its full identity and no local link, because this
// dashboard has no environment-qualified browser route; a local link would open the wrong conversation
const foreign = (participant: WorkflowProgressParticipant, localEnvironmentId: string | null | undefined): boolean =>
  participant.environmentId !== null && participant.environmentId !== localEnvironmentId;

/** Every participant of a workflow with its role, lifecycle, completion, coverage and receipt as distinct facts; settlement states what the service recorded after task completion. */
export function WorkflowParticipants({workflow, localEnvironmentId}: {workflow: WorkflowProgressWorkflow | undefined; localEnvironmentId?: string | null | undefined}) {
  const participants = workflow?.participants ?? [];
  return <section className="stack workflow-participants" aria-labelledby="workflow-participants-title">
    <h3 id="workflow-participants-title">Participants</h3>
    <HelpDisclosure title="About participants and coverage"><p><GuideLink topic="participants">Participants</GuideLink> are the conversations or agents that work an
      occurrence of this plan: native children attached to a step, children linked without a step, and participants the main reported for external work. Coverage
      names what is established for each one: a service read of a native child, the Supervisor's own attributed read, a lifecycle-only wait, a bare report, a stated
      missing route, or nothing. A completed conversation or an accepted result never completes a step by itself. Settlement is recorded only after the task completed: T3-managed conversations settle by their own command, a conversation kept active by its user or one the service could not settle is listed as such, and participants that are not T3 conversations have no settlement.</p></HelpDisclosure>
    {!workflow ? <p className="muted">No workflow data is available for participants.</p>
      : participants.length === 0 ? <p className="muted">No participants are recorded for this workflow.</p>
      : <ul className="workflow-participant-list">{participants.map(participant => {
        const coverage = coverageText[participant.coverage];
        return <li key={participant.id} className="workflow-participant">
          <div className="row between">
            <div className="text-group">
              <strong>{participant.threadId && !foreign(participant, localEnvironmentId) ? <a href={threadHref(participant.threadId)}>{participant.handle}</a>
                : participant.handle ? <span className="participant-identity">{participant.handle}</span> : "No handle reported"}</strong>
              <p className="muted small">{kindText[participant.kind]}
                {participant.environmentId ? foreign(participant, localEnvironmentId) ? <> · environment <code>{participant.environmentId}</code> (another environment; open it there, no local link)</> : ` · environment ${participant.environmentId}` : ""}
                {participant.contributionId ? ` · contribution ${participant.contributionId} revision ${participant.revision}` : ""}</p>
            </div>
            <span className={`pill ${coverage.tone}`}>Coverage: {coverage.label}</span>
          </div>
          <p className="small">{participant.roles.length
            ? <>Works: {participant.roles.map(role => `${role.nodeName ?? role.nodeId} · Attempt ${role.attempt}${role.retired ? " · replaced for this attempt" : ""}`).join("; ")}</>
            : "No attached occurrence: this linked child has no recorded role in the plan."}</p>
          <p className="small"><strong>Conversation:</strong> {lifecycleText[participant.lifecycle]}{participant.reportedState ? ` (${participant.reportedState})` : ""} ·{" "}
            <strong>Completion:</strong> {completionText[participant.completion]} · <strong>Followed by:</strong> {ownerText[participant.owner]} ·{" "}
            <strong>Settlement:</strong> {settlementLine(participant)}</p>
          <EntityDetails title="Coverage receipt"><div className="text-group small">
            <p>{coverage.detail}</p>
            {participant.currentReceipt
              ? <><p>Latest receipt: {participant.currentReceipt.kind} · {time(participant.currentReceipt.recordedAt)} · by{" "}
                <a href={threadHref(participant.currentReceipt.actorSupervisorThreadId)}>this Supervisor</a>
                {participant.currentReceipt.toolName ? <> · tool <code>{participant.currentReceipt.toolName}</code></> : null}
                {participant.currentReceipt.sourceItemId ? <> · item <code>{participant.currentReceipt.sourceItemId}</code></> : null}
                {participant.currentReceipt.repeats > 1 ? <> · repeated {participant.currentReceipt.repeats} times since {time(participant.currentReceipt.firstRecordedAt)}</> : null}</p>
              <p className="muted">A receipt records a read at its time. Whether the same route is available now is not verified.</p></>
              : <p>No receipt for the current declaration, revision and attempt.</p>}
            {participant.priorReceipts > 0 && <p className="muted">{participant.priorReceipts} earlier receipt{participant.priorReceipts === 1 ? "" : "s"} belong to a
              previous revision, declaration or attempt and stay in history.</p>}
          </div></EntityDetails>
        </li>;
      })}</ul>}
  </section>;
}
