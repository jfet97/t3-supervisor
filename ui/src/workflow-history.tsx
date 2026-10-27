import React from "react";
import type { WorkflowProgressWorkflow } from "../../src/workflow-progress.js";
import { EntityDetails } from "./disclosure.js";

const labels: Readonly<Record<string, string>> = {
  draft_created: "Workflow started", lineage_linked: "Child workflow linked", node_removed: "Step removed from the current plan", contribution_recorded: "External report recorded", contribution_assessed: "External report assessed", plan_updated: "Plan updated", status_changed: "Progress assessed", note: "Supervisor note",
  observation: "Work observed", not_applicable: "Recorded not applicable", agreement_imported: "Plan accepted",
  branch_selected: "Branch selected", branch_selection_invalidated: "Earlier decision retired", branch_changed: "Branch reconsidered",
  return_requested: "Return requested", return_applied: "Returned to an earlier step", return_dismissed: "Return no longer applies",
};
const status = {planned: "planned", underway: "in progress", completed: "completed", needs_attention: "needs attention"} as const;

export function WorkflowHistory({workflow}: {workflow: WorkflowProgressWorkflow | undefined}) {
  const events = workflow?.history ?? [];
  return <section className="stack workflow-history" aria-labelledby="workflow-history-title">
    <div className="text-group"><h2 id="workflow-history-title">History</h2><p className="muted">Recorded work moves forward here. Returning in the Plan starts a new attempt and keeps the earlier records.</p></div>
    {!workflow?.historyComplete && <p className="notice">Complete history is not available in this read. Refresh to check the current source.</p>}
    {workflow?.returns?.some(item => item.state === "applied" && item.retiredRuns.length) && <EntityDetails title="Earlier review attempts"><div className="stack">
      {workflow.returns.filter(item => item.state === "applied" && item.retiredRuns.length).map(item => <div className="text-group" key={item.returnId}>
        <h3>Attempt {item.attempt} · returned to {item.targetName ?? "an earlier step"}</h3>
        <ul>{item.retiredRuns.map((retired, index) => <li key={`${retired.threadId}:${index}`}>
          <a href={`t3-thread://v1/${retired.threadId}`}>Review conversation</a>: {retired.kind === "run" ? "earlier run kept in history"
            : retired.kind === "provider_turns" ? `${retired.providerTurnIds.length} earlier review ${retired.providerTurnIds.length === 1 ? "turn" : "turns"} kept in history; this reviewer can continue in the same conversation`
              : "a replacement reviewer is required; carry forward the earlier findings because separate rounds cannot be identified"}.
        </li>)}</ul>
      </div>)}
    </div></EntityDetails>}
    {events.length === 0 ? <p>No history records were returned.</p> : <ol className="workflow-history-list" role="list">{events.map(event => <li key={event.id}>
      <div className="text-group"><h3>{labels[event.kind] ?? "Workflow record"}{event.targetNodeName ? ` · ${event.targetNodeName}` : ""}</h3>
        <p className="small muted"><time dateTime={new Date(event.recordedAt).toISOString()}>{new Date(event.recordedAt).toLocaleString()}</time>{event.attempt !== null && <> · Attempt {event.attempt}</>}</p></div>
      {event.statusTo && <p>{event.statusFrom ? `${status[event.statusFrom]} → ` : ""}{status[event.statusTo]}</p>}
      <p>{event.note}</p>
      {(event.sourceThreadId || event.sourceMessageId || event.sourceItemId) && <EntityDetails title="Source record"><div className="text-group small">
        {event.sourceThreadId && <p><a href={`t3-thread://v1/${event.sourceThreadId}`}>Open evidence conversation</a></p>}
        {event.sourceMessageId && <p>Message: <code>{event.sourceMessageId}</code></p>}
        {event.sourceItemId && <p>Activity: <code>{event.sourceItemId}</code></p>}
      </div></EntityDetails>}
    </li>)}</ol>}
  </section>;
}
