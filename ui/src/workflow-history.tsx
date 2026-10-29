import React from "react";
import type { WorkflowHistoryEvent, WorkflowProgressWorkflow } from "../../src/workflow-progress.js";
import { EntityDetails } from "./disclosure.js";

const labels: Readonly<Record<string, string>> = {
  draft_created: "Workflow started", lineage_linked: "Child workflow linked", node_removed: "Step removed from the current plan", contribution_recorded: "External report recorded", contribution_assessed: "External report assessed", plan_updated: "Plan updated", status_changed: "Status recorded",
  observation: "Work observed", not_applicable: "Recorded not applicable", agreement_imported: "Plan accepted",
  branch_selected: "Branch selected", branch_selection_invalidated: "Earlier decision retired", branch_changed: "Branch reconsidered",
  return_requested: "Return requested", return_applied: "Returned to an earlier step", return_dismissed: "Return no longer applies", return_budget_exhausted: "Return budget used up",
};
const status = {planned: "planned", underway: "in progress", completed: "completed", needs_attention: "needs attention"} as const;
const eventLabel = (event: WorkflowHistoryEvent) => `${event.repair ? "Status corrected" : event.coverage ? "Read coverage" : labels[event.kind] ?? "Workflow record"}${event.targetNodeName ? ` · ${event.targetNodeName}` : ""}`;
// a compacted receipt is a span: its first read dates it, its latest read and count are said beside it
const coverageSpan = (event: WorkflowHistoryEvent) => event.coverage
  ? event.coverage.repeats > 1
    ? <> · {event.coverage.repeats} reads, first to latest <time dateTime={new Date(event.coverage.latestRecordedAt).toISOString()}>{new Date(event.coverage.latestRecordedAt).toLocaleString()}</time></>
    : <> · 1 read</>
  : null;
// a status event that actually moved an occurrence or the task; a same-status record is kept, never a headline
const moved = (event: WorkflowHistoryEvent) => event.statusTo !== null && event.statusFrom !== event.statusTo;

/** Consecutive records of one write stay one operation; records are never merged, and equal timestamps keep their stored order. */
export const historyOperations = (events: readonly WorkflowHistoryEvent[]): WorkflowHistoryEvent[][] => {
  const operations: WorkflowHistoryEvent[][] = [];
  for (const event of events) {
    const last = operations.at(-1);
    if (last && event.operationId !== undefined && last[0]!.operationId === event.operationId) last.push(event);
    else operations.push([event]);
  }
  return operations;
};

/** What one operation did, from its records: a return names its target and attempt, status moves name each occurrence; same-status arrows stay details. */
export const operationHeadline = (events: readonly WorkflowHistoryEvent[]): string => {
  if (events.length === 1) return eventLabel(events[0]!);
  const returned = events.find(event => event.kind === "return_applied");
  if (returned) {
    const repeated = events.filter(event => event !== returned && event.targetNodeId && event.targetNodeName && event.statusTo === "planned").map(event => event.targetNodeName!);
    const attempt = returned.attempt ?? (events.find(event => event.attempt !== null)?.attempt ?? null);
    return `Returned to ${returned.targetNodeName ?? "an earlier step"}${attempt !== null ? `: attempt ${attempt} starts` : ""}${repeated.length ? `; ${repeated.join(", ")} repeat` : ""}`;
  }
  const moves = events.filter(event => moved(event) && event.targetNodeName);
  if (moves.length) return moves.map(event => `${event.targetNodeName} ${status[event.statusTo!]}`).join(", ");
  const kinds = [...new Set(events.map(event => event.repair ? "Status corrected" : labels[event.kind] ?? "Workflow record"))];
  return kinds.join(" · ");
};

export function WorkflowHistory({workflow}: {workflow: WorkflowProgressWorkflow | undefined}) {
  const events = workflow?.history ?? [];
  const operations = historyOperations(events);
  return <section className="stack workflow-history" aria-labelledby="workflow-history-title">
    <div className="text-group"><h2 id="workflow-history-title">History</h2><p className="muted">Recorded work moves forward here, one record per event in the order it was stored. Returning in the Plan starts a new attempt and keeps the earlier records.</p></div>
    {!workflow?.historyComplete && <p className="notice">Complete history is not available in this read. Refresh to check the current source.</p>}
    {/* each applied return is dated, not numbered: a return's own count is not the target occurrence's attempt, which the Plan states */}
    {workflow?.returns?.some(item => item.state === "applied" && item.retiredRuns.length) && <EntityDetails title="Earlier review attempts"><div className="stack">
      {workflow.returns.filter(item => item.state === "applied" && item.retiredRuns.length).map(item => <div className="text-group" key={item.returnId}>
        <h3>Returned to {item.targetName ?? "an earlier step"} · <time dateTime={new Date(item.resolvedAt ?? item.requestedAt).toISOString()}>{new Date(item.resolvedAt ?? item.requestedAt).toLocaleString()}</time></h3>
        <ul>{item.retiredRuns.map((retired, index) => <li key={`${retired.threadId}:${index}`}>
          <a href={`t3-thread://v1/${retired.threadId}`}>Review conversation</a>: {retired.kind === "run" ? "earlier run kept in history"
            : retired.kind === "provider_turns" ? `${retired.providerTurnIds.length} earlier review ${retired.providerTurnIds.length === 1 ? "turn" : "turns"} kept in history; this reviewer can continue in the same conversation`
              : "a replacement reviewer is required; carry forward the earlier findings because separate rounds cannot be identified"}.
        </li>)}</ul>
      </div>)}
    </div></EntityDetails>}
    {events.length === 0 ? <p>No history records were returned.</p> : <ol className="workflow-history-list" role="list">{operations.map(operation => {
      const first = operation[0]!;
      const grouped = operation.length > 1;
      return <li key={first.id} className={grouped ? "history-operation" : undefined}>
        <div className="text-group"><h3>{operationHeadline(operation)}</h3>
          <p className="small muted"><time dateTime={new Date(first.recordedAt).toISOString()}>{new Date(first.recordedAt).toLocaleString()}</time>
            {!grouped && coverageSpan(first)}
            {!grouped && first.attempt !== null && <> · Attempt {first.attempt}</>}{grouped && <> · {operation.length} records of one write</>}</p></div>
        {grouped
          ? <ol className="history-operation-records" role="list">{operation.map(event => <li key={event.id}>
            <p><strong>{eventLabel(event)}</strong>{event.attempt !== null && <span className="small muted"> · Attempt {event.attempt}</span>}{event.coverage && <span className="small muted">{coverageSpan(event)}</span>}
              {event.statusTo && <span className={`small${moved(event) ? "" : " muted"}`}> · {event.statusFrom ? `${status[event.statusFrom]} → ` : ""}{status[event.statusTo]}{moved(event) ? "" : " (unchanged)"}</span>}</p>
            <p>{event.note}</p>
            <HistorySource event={event}/>
          </li>)}</ol>
          : <>
            {first.statusTo && <p className={moved(first) ? undefined : "muted"}>{first.statusFrom ? `${status[first.statusFrom]} → ` : ""}{status[first.statusTo]}{moved(first) ? "" : " (unchanged)"}</p>}
            <p>{first.note}</p>
            <HistorySource event={first}/>
          </>}
      </li>;
    })}</ol>}
  </section>;
}

function HistorySource({event}: {event: WorkflowHistoryEvent}) {
  if (!(event.sourceThreadId || event.sourceMessageId || event.sourceItemId)) return null;
  return <EntityDetails title="Source record"><div className="text-group small">
    {event.sourceThreadId && <p><a href={`t3-thread://v1/${event.sourceThreadId}`}>Open evidence conversation</a></p>}
    {event.sourceMessageId && <p>Message: <code>{event.sourceMessageId}</code></p>}
    {event.sourceItemId && <p>Activity: <code>{event.sourceItemId}</code></p>}
  </div></EntityDetails>;
}
