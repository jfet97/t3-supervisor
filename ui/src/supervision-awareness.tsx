import React from "react";
import type { ProjectSupervisorInfo, SupervisorMonitoringStatus } from "../../src/project-supervisor-contract.js";
import { EntityDetails, HelpDisclosure } from "./disclosure.js";

const time = (value: number) => new Date(value).toLocaleString();
const threadLink = (id: string) => `t3-thread://v1/${id}`;
type Awareness = SupervisorMonitoringStatus["awareness"];

export function ActivityAwareness({awareness, threadId}: {awareness: Awareness; threadId: string}) {
  const read = awareness?.reads.find(item => item.targetThreadId === threadId);
  const assessment = awareness?.assessments.find(item => item.targetThreadId === threadId);
  return <div className="activity-awareness text-group small">
    <p><strong>Last native read:</strong> {read ? <>{time(read.at)}{read.partial ? " · text cut off" : ""}</> : "Not reported"}</p>
    <p><strong>Last recorded assessment:</strong> {assessment ? time(assessment.at) : "Not reported"}</p>
    {read && (!assessment || assessment.throughObservedAt !== null && read.at > assessment.throughObservedAt) && <p className="muted">The latest read goes beyond the last recorded assessment. Reading alone does not assess the work.</p>}
    {read && <EntityDetails title="Read coverage"><div className="text-group">
      <p>Read by <a href={threadLink(read.actorThreadId)}>this Supervisor</a>{read.itemId && <> · latest returned item <code>{read.itemId}</code></>}.</p>
      <p>{read.partial ? "This read contains cut-off text. It does not establish complete coverage." : read.snapshotEndReached
        ? "This activity page reached the end of its snapshot. Earlier gaps and later activity are not established by that fact." : "This is an item or partial-page read. Complete transcript coverage is not established."}</p>
      {assessment && <p>{assessment.throughObservedAt === null ? "The helper recorded an assessment; its exact activity coverage is not established by that report." :
        `The recorded assessment covers the check-in activity collected through ${time(assessment.throughObservedAt)}.`}</p>}
    </div></EntityDetails>}
  </div>;
}

const targetStates = {requested: "Pause requested · unconfirmed", acknowledged: "Pause acknowledged", quiescent: "Verified quiet",
  release_pending: "Release awaiting delivery", closed: "Planning wait closed", released: "Release delivered"} as const;
const attemptStates = {open: "Planning in progress", releasing: "Releasing planning waits", resolved: "Planning resolved",
  expired: "Planning timed out", superseded: "Planning superseded"} as const;

export function PlanningStatus({snapshot}: {snapshot: ProjectSupervisorInfo}) {
  const attempts = snapshot.planning ?? [];
  if (!attempts.length) return null;
  const open = attempts.filter(attempt => attempt.state === "open" || attempt.state === "releasing" || attempt.targets.some(target => target.state === "release_pending"));
  const visible = open.length ? open : [attempts.at(-1)!];
  const earlier = attempts.filter(attempt => !visible.includes(attempt));
  return <section className="stack planning-status" aria-labelledby="planning-status-title">
    <h3 id="planning-status-title">Planning and pauses</h3>
    <ul className="stack">{visible.map(attempt => <li className="stack" key={attempt.id}>
      <div className="text-group"><h4>{attemptStates[attempt.state]}</h4><p>{attempt.reason}</p></div>
      <p className="small">Owner: <a href={threadLink(attempt.ownerThreadId)}>Open Supervisor</a>. {attempt.startedAt === null
        ? "Delivery has not started; no pause is confirmed." : <>Fixed deadline {time(attempt.deadline)}. Progress does not renew it.</>}</p>
      <ul className="stack">{attempt.targets.map((target, index) => <li key={target.threadId} className="text-group">
        <p><a href={threadLink(target.threadId)}>{target.threadId === attempt.mainThreadId ? "Main conversation" : `Affected child ${index + 1}`}</a> · <strong>{targetStates[target.state]}</strong></p>
        <p className="small muted">{target.scope}{target.recipientThreadId !== target.threadId ? " · reached through its parent" : ""}</p>
      </li>)}</ul>
      {attempt.draft && <p className="small">Draft writer: <a href={threadLink(attempt.draft.threadId)}>Open content-only task</a> · {attempt.draft.state}.
        {attempt.draft.state === "closed" && attempt.draft.cleanupConfirmedAt === undefined && " Native task cleanup is not yet confirmed."}</p>}
    </li>)}</ul>
    <HelpDisclosure title="What a planning pause means"><p>Each affected actor must acknowledge its own pause or be verified quiet. A parent acknowledgement confirms dispatch is held; it does not confirm an active child is paused. Other work continues.</p><p>The service releases unfinished planning waits at the fixed deadline. A delivered release removes this planning wait. Human Stops, pauses and approvals still apply.</p></HelpDisclosure>
    {earlier.length > 0 && <EntityDetails title={`Earlier planning attempts (${earlier.length})`}><ol className="stack">{earlier.map(attempt => <li key={attempt.id}>{attemptStates[attempt.state]} · {time(attempt.createdAt)} · {attempt.reason}</li>)}</ol></EntityDetails>}
  </section>;
}
