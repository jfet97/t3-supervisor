import { SUPERVISOR_SETTLE_QUIET_MS } from "../src/supervisor-lifecycle.js";
import { SUPERVISOR_MONITOR_AGE_MS, SUPERVISOR_MONITOR_COOLDOWN_MS } from "../src/supervisor-monitor.js";
import { normalizeLifecycle } from "../src/supervisor-observation.js";

/*
  The oracles of the provider trials that share a substantive workload (scripts/provider-trial.ts): negotiation, message volume,
  active children, sustained monitoring, compaction, idle parking, the uncoached No Project Start, and helpers, guides and a root's
  workflow_write when they occur. Each is pure over what one trial observed for its whole budget, read only from what Supervisor records
  and exposes through its dashboard API and from T3's own projections: a message is judged by the identity it was given, the thread it
  reached, its run, its native creation time and a hash of its text, never by its body. An oracle passes only on its required observed
  sequence, fails only when one of Supervisor's own rules, cited at the rule, is contradicted, and is inconclusive when the awaited event
  did not happen within the budget. Native times are T3's and Supervisor's, which run on the trial's host.
*/

export interface OracleVerdict {
  readonly outcome: "pass" | "fail" | "inconclusive";
  readonly reason: string;
}
const pass = (reason: string): OracleVerdict => ({outcome: "pass", reason});
const fail = (reason: string): OracleVerdict => ({outcome: "fail", reason});
const inconclusive = (reason: string): OracleVerdict => ({outcome: "inconclusive", reason});

/** A native time in milliseconds, null when T3 gave none or an unreadable one. */
export const nativeTime = (value: string | null | undefined): number | null => {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
};

/** One run as T3's projection shows it. */
export interface NativeRun {
  readonly id: string;
  readonly status: string;
  readonly requestedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly userMessageId: string | null;
}
/** A timed item of a thread's own work (a command, a reply, a file change or a tool call), as its own projection showed it. */
export interface NativeExecution {
  readonly itemId: string;
  readonly type: string;
  readonly status: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
}
/**
 * A child's lifecycle as its direct parent's projection records it, through Supervisor's own reconciliation of the parent's subagent
 * record and subagent turn item (src/supervisor-observation.ts, directParentChildLifecycle: one status, the turn item preferred).
 */
export interface ChildLifecycle {
  readonly status: string;
  readonly source: "parent_subagents" | "parent_turn_item";
  readonly recordId: string | null;
  readonly parentRunId: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}
// a run's open statuses as Supervisor reads them (src/supervisor-lifecycle.ts, activeDetachedChildWork; src/supervisor-conversation.ts,
// reconcile ends a request only on completed, failed, interrupted, cancelled or rolled_back)
const openRunStatuses: ReadonlySet<string> = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const runOpen = (run: NativeRun): boolean => openRunStatuses.has(run.status);
/** Whether a run was open at a time: started by then and not ended before it; a run without a start time is not judged. */
const openAt = (run: NativeRun, time: number): boolean => {
  const started = nativeTime(run.startedAt);
  if (started === null || started > time) return false;
  const ended = nativeTime(run.completedAt);
  return ended === null ? runOpen(run) : ended > time;
};
const latest = (times: ReadonlyArray<number | null>): number | null =>
  times.reduce<number | null>((found, time) => time !== null && (found === null || time > found) ? time : found, null);
const earliest = (times: ReadonlyArray<number | null>): number | null =>
  times.reduce<number | null>((found, time) => time !== null && (found === null || time < found) ? time : found, null);

/**
 * What a Supervisor message is, from the identity Supervisor gives it or, for a message a Supervisor model sent, from its sender and
 * the thread it reached: contact with the operative or a child, or coordination between Supervisor's own root and helpers.
 */
export type TrafficKind = "proposal" | "stop" | "compaction" | "check-in" | "interpretation" | "planning" | "team-notice" | "guide" | "service"
  | "contact" | "coordination";
// src/supervisor-team-controller.ts, sendGuideAttempt: `${requestId}:message:${attemptIndex}` with requestId `guide:${hash}`
const guideMessage = /^guide:([^:]+):message:\d+$/u;
// src/supervisor-team-runtime.ts: `supervisor-team-notice:${notification.id}:attempt:${notification.deliveryAttempt}`
const teamNotice = /^supervisor-team-notice:(.+):attempt:\d+$/u;

export const trafficKind = (id: string, fromSupervisor: boolean, toSupervisor = false): TrafficKind | null =>
  // src/supervisor-conversation.ts, the introduction's scopeNoticeId and its queued and retried identities
  id.startsWith("supervisor-notice:workflow:") ? "proposal"
  // src/project-supervisor-store.ts, prepareStopNotice
  : id.startsWith("supervisor-notice:stop:") ? "stop"
  // src/supervisor-compaction.ts, steer
  : id.startsWith("supervisor-notice:compaction:") ? "compaction"
  // src/supervisor-conversation-store.ts, conversationRequestMessageId: a root's or helper's check-in
  : id.startsWith("supervisor-review:") ? "check-in"
  // src/project-supervisor.ts and src/supervisor-conversation.ts: the task message an interpretation request carries
  : /^supervisor-(?:objective|task-renewal|task-revision):/u.test(id) ? "interpretation"
  // src/supervisor-planning.ts: a planning hold or release
  : id.startsWith("supervisor-planning:") ? "planning"
  : teamNotice.test(id) ? "team-notice"
  : guideMessage.test(id) ? "guide"
  : id.startsWith("supervisor-") ? "service"
  : fromSupervisor ? toSupervisor ? "coordination" : "contact" : null;

/** A Supervisor message as T3 recorded it, without its body. */
export interface TrafficMessage {
  readonly id: string;
  readonly threadId: string;
  readonly kind: TrafficKind;
  readonly runId: string | null;
  readonly createdAt: string | null;
  // a digest of the text T3 showed, null when it showed none: an unknown text never matches another
  readonly textHash: string | null;
}

/** The Supervisor traffic a trial observed, counted by kind and by the thread it reached. */
export const trafficTotals = (messages: ReadonlyArray<TrafficMessage>) => {
  const count = (key: (message: TrafficMessage) => string) => messages.reduce<Record<string, number>>((counts, message) =>
    ({...counts, [key(message)]: (counts[key(message)] ?? 0) + 1}), {});
  return {total: messages.length, byKind: count((message) => message.kind), byThread: count((message) => message.threadId)};
};

/** What the traffic rules read beside the messages. */
export interface TrafficContext {
  readonly operativeThreadId: string;
  readonly supervisorThreadIds: ReadonlyArray<string>;
  readonly runs: Readonly<Record<string, ReadonlyArray<NativeRun>>>;
  readonly stopPresses: number;
}

/** Each contradiction of Supervisor's own traffic rules the observed messages show, worded with the identities involved. */
export const trafficContradictions = (messages: ReadonlyArray<TrafficMessage>, context: TrafficContext): ReadonlyArray<string> => {
  const found: string[] = [];
  const repeated = (kind: TrafficKind, key: (message: TrafficMessage) => string | null, what: string) => {
    const groups = new Map<string, TrafficMessage[]>();
    for (const message of messages) {
      const identity = message.kind === kind ? key(message) : null;
      if (identity !== null) groups.set(identity, [...(groups.get(identity) ?? []), message]);
    }
    for (const group of groups.values()) if (group.length > 1)
      found.push(`${what} reached ${group[0]!.threadId} ${group.length} times (${group.map((message) => message.id).join(", ")})`);
  };
  // a proposal reaches the operative once; a later proposal names its own proposal in its text (src/supervisor-conversation.ts,
  // workflowIntroductionText), so the same text twice is one proposal delivered twice
  repeated("proposal", (message) => message.textHash === null ? null : `${message.threadId}\u0000${message.textHash}`, "the same proposal notice");
  // a guide is steered once; another attempt follows only a definite rejection, which T3 never shows (src/supervisor-team-controller.ts)
  repeated("guide", (message) => guideMessage.exec(message.id)?.[1] ?? message.id, "one guide request");
  // a team notification gets another delivery identity only after a confirmed native rejection (src/supervisor-conversation.ts, teamRules)
  repeated("team-notice", (message) => teamNotice.exec(message.id)?.[1] ?? message.id, "one team notification");
  // one Stop notice per Stop (src/project-supervisor-store.ts, prepareStopNotice; src/supervisor-conversation.ts, reconcileStopNotice)
  const stops = messages.filter((message) => message.kind === "stop");
  if (stops.length > context.stopPresses) found.push(context.stopPresses === 0
    ? `a Stop notice reached the chat although nobody stopped it (${stops.map((message) => message.id).join(", ")})`
    : `${stops.length} Stop notices reached the chat for ${context.stopPresses} Stop (${stops.map((message) => message.id).join(", ")})`);
  // a compaction reminder is steered into the Supervisor's own running root, once per root run (src/supervisor-compaction.ts, steer)
  const reminders = messages.filter((message) => message.kind === "compaction");
  const misplaced = reminders.filter((message) => !context.supervisorThreadIds.includes(message.threadId));
  if (misplaced.length > 0) found.push(`a compaction reminder reached a thread other than the Supervisor's root (${misplaced.map((message) =>
    `${message.id} in ${message.threadId}`).join(", ")})`);
  repeated("compaction", (message) => message.runId === null ? message.id : `${message.threadId}\u0000${message.runId}`, "one root run's compaction reminder");
  // one durable service request per Supervisor: a check-in is prepared only while none is pending, and a pending one ends only when its
  // own run ended (src/supervisor-conversation-store.ts, prepare and pendingStates; src/supervisor-conversation.ts, reconcile)
  for (const root of context.supervisorThreadIds) {
    const runs = context.runs[root] ?? [];
    const checkIns = messages.flatMap((message) => {
      const created = nativeTime(message.createdAt);
      return message.kind === "check-in" && message.threadId === root && created !== null ? [{message, created}] : [];
    }).sort((left, right) => left.created - right.created);
    checkIns.forEach((later, index) => {
      const earlier = checkIns[index - 1];
      if (earlier === undefined) return;
      const run = runs.find((candidate) => candidate.userMessageId === earlier.message.id || candidate.id === earlier.message.runId);
      if (run === undefined) return;
      const ended = nativeTime(run.completedAt);
      if (ended === null ? runOpen(run) : ended > later.created)
        found.push(`check-in ${later.message.id} reached the Supervisor's root while the run of check-in ${earlier.message.id} was still open`);
    });
  }
  return found;
};

/*
  Plain contact a Supervisor model sent the same thread twice with the same text: a diagnostic, not a contradiction. A model's retry
  identity is its request and target (src/supervisor-conversation.ts, contactRule and contactRouting), which T3's message does not
  carry, so two equal texts under two message identities may be a deliberate repeat; a text T3 did not show is never matched.
*/
export const repeatedContent = (messages: ReadonlyArray<TrafficMessage>): ReadonlyArray<{readonly threadId: string; readonly ids: ReadonlyArray<string>}> => {
  const groups = new Map<string, {readonly threadId: string; readonly ids: ReadonlyArray<string>}>();
  for (const message of messages) if (message.kind === "contact" && message.textHash !== null) {
    const key = `${message.threadId}\u0000${message.textHash}`;
    groups.set(key, {threadId: message.threadId, ids: [...(groups.get(key)?.ids ?? []), message.id]});
  }
  return [...groups.values()].filter((group) => group.ids.length > 1);
};

/** A recognised workflow_write call of a Supervisor root and its receipt. */
export interface WriteCall {
  readonly threadId: string;
  readonly itemId: string;
  readonly runId: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly operationId: string | null;
  /** Its successful receipt (applied, created, exists or recorded) as its status and a hash of its canonical form; null otherwise. */
  readonly receipt: {readonly status: string; readonly hash: string} | null;
  /** Where the receipt was read: the thread projection's tool item, or T3's full record of the call when the projection omitted it. */
  readonly receiptSource?: "projection" | "detail";
}

/** Idle parking as the trial saw it: Supervisor's own settlement record, then the hold and the follow-up the trial sent. */
export interface ParkingFacts {
  readonly threadId: string;
  readonly generation: number;
  /** The readable look before the one that first showed the settlement, and that look, in milliseconds. */
  readonly after: number;
  readonly seenAt: number;
  /** T3's native settlement time of the root at that look. */
  readonly settledAt: string;
  /** The follow-up message, sent once when the hold ended; createdAt is T3's, null until a look showed it. */
  readonly followUp: {readonly sentAt: number; readonly messageId: string; readonly answer: string; readonly createdAt: string | null} | null;
}

/** The dashboard Start of a No Project chat, pressed once while the request's own run was open. */
export interface StartFacts {
  readonly pressed: {readonly answer: string; readonly status: string | null} | null;
  /** Whether the request's run had already ended when the trial could first press. */
  readonly runEndedFirst: boolean;
}

/** Everything a workload trial observed for its whole budget. */
export interface WorkloadObservation {
  readonly operativeThreadId: string;
  /** Every Supervisor root the binding named for the operative chat, with its generation, in the order first seen. */
  readonly supervisors: ReadonlyArray<{readonly threadId: string; readonly generation: number; readonly firstSeenAt: number}>;
  /** Supervisor's team: every helper seen, those seen ready, those seen with an active assignment, the most at once, its limit. */
  readonly helpers: {readonly threadIds: ReadonlyArray<string>; readonly ready: ReadonlyArray<string>; readonly assigned: ReadonlyArray<string>;
    readonly mostAtOnce: number; readonly limit: number | null};
  /** The original request's task and Supervisor's decision, as last seen while it was the chat's task. */
  readonly task: {readonly id: string | null; readonly supervision: "needed" | "not_needed" | null} | null;
  readonly traffic: ReadonlyArray<TrafficMessage>;
  readonly runs: Readonly<Record<string, ReadonlyArray<NativeRun>>>;
  /**
   * Each descendant's own timed work, kept apart from its runs: a provider-native child can work while T3 records no run of it, and
   * these items show that it ran, never when it worked or rested.
   */
  readonly executions: Readonly<Record<string, ReadonlyArray<NativeExecution>>>;
  /**
   * Each descendant's lifecycle as its direct parent's last read recorded it, kept apart from its runs; null where that parent showed
   * none, or conflicting statuses.
   */
  readonly childLifecycles: Readonly<Record<string, ChildLifecycle | null>>;
  readonly stopPresses: number;
  /** The first agreement Supervisor recorded for the task, and its message as T3 showed it in the operative chat. */
  readonly agreement: {readonly proposalId: string; readonly agentMessageId: string;
    readonly message: {readonly role: string | null; readonly createdAt: string | null; readonly senderThreadId: string | null} | null} | null;
  /**
   * The operative's descendants found. lineageVerified: its own projection showed it a subagent of the operative or of a verified child.
   * lineageKnown: its own projection was read and decided that either way; a descendant never read, or whose parent is still
   * undecided, is unknown, not outside.
   */
  readonly children: ReadonlyArray<{readonly threadId: string; readonly lineageVerified: boolean; readonly lineageKnown: boolean}>;
  /** Supervisor's reads and assessments of a thread by a root or helper, every distinct one seen, at Supervisor's recorded time. */
  readonly monitoring: ReadonlyArray<{readonly actorThreadId: string; readonly targetThreadId: string; readonly at: number;
    readonly kind: "read" | "assessment"}>;
  readonly monitor: {readonly state: string; readonly pendingItems: number} | null;
  /** Each settlement of a Supervisor root seen while Supervisor recorded its root settled, at T3's native settlement time. */
  readonly settlements: ReadonlyArray<{readonly threadId: string; readonly settledAt: string}>;
  readonly compactions: ReadonlyArray<{readonly threadId: string; readonly itemId: string; readonly runId: string | null;
    readonly status: string; readonly completedAt: string | null}>;
  /** Each Supervisor root's latest native start of a run or turn item. */
  readonly rootLatestStart: Readonly<Record<string, string | null>>;
  /** Each root's recognised workflow_read calls for its instructions, which a compaction reminder asks for. */
  readonly instructionReads: ReadonlyArray<{readonly threadId: string; readonly startedAt: string | null; readonly status: string}>;
  readonly writes: ReadonlyArray<WriteCall>;
  /** The workflow history events that name the operation that wrote them, at Supervisor's recorded time. */
  readonly history: ReadonlyArray<{readonly operationId: string; readonly recordedAt: number}>;
  readonly parking: ParkingFacts | null;
  readonly start: StartFacts | null;
  /** The last readable look, in milliseconds. */
  readonly endedAt: number | null;
}

export const workloadScenarios = ["negotiation", "message-volume", "active-children", "sustained-monitoring", "compaction", "idle-parking",
  "helpers", "guides", "workflow-write", "no-project-start"] as const;
export type WorkloadScenario = typeof workloadScenarios[number];
export const isWorkloadScenario = (value: string): value is WorkloadScenario => (workloadScenarios as ReadonlyArray<string>).includes(value);

const supervisorIds = (seen: WorkloadObservation): ReadonlySet<string> => new Set(seen.supervisors.map((supervisor) => supervisor.threadId));
const verifiedChildren = (seen: WorkloadObservation): ReadonlyArray<string> =>
  seen.children.filter((child) => child.lineageVerified).map((child) => child.threadId);
const reached = (seen: WorkloadObservation, kind: TrafficKind, threadId = seen.operativeThreadId) =>
  seen.traffic.filter((message) => message.kind === kind && message.threadId === threadId)
    .sort((left, right) => (nativeTime(left.createdAt) ?? 0) - (nativeTime(right.createdAt) ?? 0));
const undecided = (seen: WorkloadObservation): OracleVerdict | null =>
  seen.task?.supervision === "not_needed" ? inconclusive("Supervisor judged the request not needed, so no supervised work followed")
  : reached(seen, "proposal").length === 0 ? inconclusive(seen.task?.supervision === "needed" ? "no proposal reached the operative within the budget"
    : "Supervisor decided nothing within the budget")
  : null;
/**
 * A child's lifecycle bounded by its direct parent's record: running since its native start, or ended with both native times, and no
 * item of the child's own work outside it. An unknown status, a missing time, or an own item outside it, which shows the record stale
 * or contradicted, bounds nothing; an item of the child's own work never shows that the whole child ended.
 */
export const boundedLifecycle = (seen: Pick<WorkloadObservation, "childLifecycles" | "executions">, threadId: string):
  {readonly startedAt: number; readonly completedAt: number | null} | null => {
  const record = seen.childLifecycles[threadId] ?? null;
  const startedAt = nativeTime(record?.startedAt);
  if (record === null || startedAt === null) return null;
  const lifecycle = normalizeLifecycle(record.status).lifecycle;
  const completedAt = lifecycle === "running" ? null : nativeTime(record.completedAt);
  if (lifecycle === "unknown" || lifecycle !== "running" && completedAt === null) return null;
  const outside = (seen.executions[threadId] ?? []).some((item) => (nativeTime(item.startedAt) ?? -Infinity) < startedAt ||
    completedAt !== null && (nativeTime(item.completedAt) ?? nativeTime(item.startedAt) ?? Infinity) > completedAt);
  return outside ? null : {startedAt, completedAt};
};
/** A thread's activity: each of T3's runs of it or, for a child T3 recorded no run of, its parent's bounded record of it. */
interface Activity {readonly startedAt: number | null; readonly completedAt: number | null; readonly open: boolean; readonly runId: string | null}
const activityOf = (seen: WorkloadObservation, threadId: string): ReadonlyArray<Activity> => {
  const runs = seen.runs[threadId] ?? [];
  if (runs.length > 0) return runs.map((run) => ({startedAt: nativeTime(run.startedAt), completedAt: nativeTime(run.completedAt), open: runOpen(run), runId: run.id}));
  const lifecycle = boundedLifecycle(seen, threadId);
  return lifecycle === null ? [] : [{startedAt: lifecycle.startedAt, completedAt: lifecycle.completedAt, open: lifecycle.completedAt === null, runId: null}];
};
const activeAt = (activity: Activity, time: number): boolean => activity.startedAt !== null && activity.startedAt <= time &&
  (activity.completedAt === null ? activity.open : activity.completedAt > time);
const stillWorking = (seen: WorkloadObservation, threadIds: ReadonlyArray<string>): string | null =>
  threadIds.find((threadId) => activityOf(seen, threadId).some((activity) => activity.open)) ?? null;
/**
 * The verified children whose lifecycle nothing bounds: T3 recorded no run of them and their direct parent no bounded record. A
 * provider-native child can work with no run in T3's history, so its own items may show that it ran but not when it worked or
 * rested: a verdict that needs it quiet, or running at a moment, is not given.
 */
export const unboundedChildren = (seen: Pick<WorkloadObservation, "children" | "runs" | "childLifecycles" | "executions">): ReadonlyArray<string> =>
  seen.children.filter((child) => child.lineageVerified && (seen.runs[child.threadId] ?? []).length === 0 && boundedLifecycle(seen, child.threadId) === null)
    .map((child) => child.threadId);
const unboundedGap = (threadIds: ReadonlyArray<string>, what: string): OracleVerdict =>
  inconclusive(`neither T3's runs nor a bounded record of its parent show when the operative's ${threadIds.length === 1 ? "child" : "children"} `
    + `${threadIds.join(", ")} worked, so ${what} cannot be told`);

/** The first contradiction a workload trial shows of the rules every one of them shares, or null. */
export const workloadContradiction = (seen: WorkloadObservation): string | null => {
  const traffic = trafficContradictions(seen.traffic, {operativeThreadId: seen.operativeThreadId, supervisorThreadIds: [...supervisorIds(seen)],
    runs: seen.runs, stopPresses: seen.stopPresses});
  if (traffic.length > 0) return traffic.join("; ");
  // settlement waits until the whole scope is quiet: the main's latest run completed, the main not busy and every child quiet
  // (src/supervisor-lifecycle.ts, mainAttention and relatedChildren); a human Stop settles at once, so only an unstopped chat is judged
  if (seen.stopPresses === 0) for (const settlement of seen.settlements) {
    const settledAt = nativeTime(settlement.settledAt);
    if (settledAt === null) continue;
    for (const threadId of [seen.operativeThreadId, ...verifiedChildren(seen)]) {
      const open = activityOf(seen, threadId).find((activity) => activeAt(activity, settledAt));
      if (open !== undefined) return `Supervisor parked its root ${settlement.threadId} at ${settlement.settledAt} while ${open.runId === null
        ? `${threadId}, by its parent's record,` : `run ${open.runId} of ${threadId}`} was open`;
    }
  }
  return null;
};

// negotiation: an agreement actually recorded, apart from the introduction
const negotiation = (seen: WorkloadObservation): OracleVerdict => {
  const open = undecided(seen);
  if (open !== null) return open;
  const agreement = seen.agreement;
  if (agreement === null) return inconclusive("the proposal reached the operative, but no agreement was recorded within the budget");
  const message = agreement.message;
  if (message === null) return inconclusive(`Supervisor recorded agreement to proposal ${agreement.proposalId}, but T3 never showed its message `
    + `${agreement.agentMessageId} in the operative chat`);
  // agreement exists only in the operative's own completed reply after the introduction (src/supervisor-conversation.ts,
  // acceptanceEvidenceCurrent and afterIntroduction)
  if (message.role !== "assistant" || message.senderThreadId !== null)
    return fail(`Supervisor recorded agreement to proposal ${agreement.proposalId} from message ${agreement.agentMessageId}, which is not the operative's own reply`);
  const agreedAt = nativeTime(message.createdAt);
  const introducedAt = nativeTime(reached(seen, "proposal")[0]?.createdAt);
  if (agreedAt === null || introducedAt === null) return inconclusive("T3 did not record the creation times that order the agreement after the proposal");
  if (agreedAt <= introducedAt) return fail(`the agreement Supervisor recorded (message ${agreement.agentMessageId}) predates the first proposal notice`);
  return pass(`the proposal reached the operative and its own later reply ${agreement.agentMessageId} agreed to proposal ${agreement.proposalId}`);
};

// message volume: the whole supervised work observed, judged by the shared traffic rules, with its totals reported
const messageVolume = (seen: WorkloadObservation): OracleVerdict => {
  const open = undecided(seen);
  if (open !== null) return open;
  const working = stillWorking(seen, [seen.operativeThreadId, ...verifiedChildren(seen)]);
  if (working !== null) return inconclusive(`${working} was still working when the budget ended, so the whole traffic was not observed`);
  const unbounded = unboundedChildren(seen);
  if (unbounded.length > 0) return unboundedGap(unbounded, "whether the supervised work had ended when the budget ended");
  const busy = stillWorking(seen, [...supervisorIds(seen), ...seen.helpers.threadIds]);
  if (busy !== null || seen.monitor?.state !== "idle")
    return inconclusive(`Supervisor was still working when the budget ended (${busy ?? `monitor ${seen.monitor?.state ?? "unread"}`}), so its whole traffic was not observed`);
  const repeats = repeatedContent(seen.traffic);
  if (repeats.length > 0) return inconclusive(`Supervisor's model sent the same text more than once to one thread (${repeats.map((group) =>
    `${group.ids.join(", ")} in ${group.threadId}`).join("; ")}), which its messages cannot tell from deliberate repeats`);
  const totals = trafficTotals(seen.traffic);
  return pass(`the supervised work ended with ${totals.total} Supervisor messages (${Object.entries(totals.byKind).map(([kind, count]) =>
    `${count} ${kind}`).join(", ")}) and its check-ins one at a time`);
};

// active children: a delegated child observed natively, and Supervisor's read or assessment of it while or after it ran
const activeChildren = (seen: WorkloadObservation): OracleVerdict => {
  const children = verifiedChildren(seen);
  if (children.length === 0) return inconclusive(seen.children.length > 0 ? "no child's own projection verified it as a subagent of the operative within the budget"
    : "the operative delegated no child within the budget");
  /* A child ran when T3 shows a run of it started, or an item of its own work with its native start (NativeExecution): a provider-native
   * child can have such items while T3 records no run of it. Supervisor's read or assessment must come at or after that first start.
   */
  const ran = children.flatMap((threadId) => {
    const runStart = earliest((seen.runs[threadId] ?? []).map((run) => nativeTime(run.startedAt)));
    const parentStart = (seen.runs[threadId] ?? []).length > 0 ? null : boundedLifecycle(seen, threadId)?.startedAt ?? null;
    const firstItem = [...(seen.executions[threadId] ?? [])].sort((left, right) => (nativeTime(left.startedAt) ?? Infinity) - (nativeTime(right.startedAt) ?? Infinity))[0];
    const itemStart = nativeTime(firstItem?.startedAt);
    const startedAt = earliest([runStart, parentStart, itemStart]);
    if (startedAt === null) return [];
    return [{threadId, startedAt, shown: runStart === startedAt ? "a run" : parentStart === startedAt || firstItem === undefined ? "its parent's record of it"
      : `its own ${firstItem.type} ${firstItem.itemId}`}];
  });
  if (ran.length === 0) return inconclusive(`the operative's children (${children.join(", ")}) showed neither a run nor a timed item of their own work within the budget`);
  const watchers = new Set([...supervisorIds(seen), ...seen.helpers.threadIds]);
  for (const child of ran) {
    const watched = seen.monitoring.find((item) => item.targetThreadId === child.threadId && watchers.has(item.actorThreadId) && item.at >= child.startedAt);
    if (watched !== undefined) return pass(`the operative's child ${child.threadId} ran (${child.shown}) and Supervisor's ${watched.actorThreadId} `
      + `${watched.kind === "read" ? "read" : "assessed"} it afterwards`);
  }
  return inconclusive(`the operative's children ${ran.map((child) => child.threadId).join(", ")} ran, but Supervisor recorded no read or assessment of them within the budget`);
};

// the quiet a parked Supervisor keeps: the monitor's age bound and cooldown, after which any pending activity would have become due
// (src/supervisor-monitor.ts)
export const quietTailMs = SUPERVISOR_MONITOR_AGE_MS + SUPERVISOR_MONITOR_COOLDOWN_MS;
// a parked Supervisor sends nothing until a new human message: a resting scope is dormant and an introduction waits while settled or
// resting (src/supervisor-conversation.ts, run)
const supervisorActivityBetween = (seen: WorkloadObservation, from: number, until: number | null): ReadonlyArray<string> => [
  ...seen.traffic.filter((message) => {const created = nativeTime(message.createdAt); return created !== null && created > from && (until === null || created < until);})
    .map((message) => message.id),
  ...[...supervisorIds(seen)].flatMap((threadId) => (seen.runs[threadId] ?? []).filter((run) => {
    const requested = nativeTime(run.requestedAt) ?? nativeTime(run.startedAt);
    return requested !== null && requested > from && (until === null || requested < until);
  }).map((run) => `run ${run.id}`)),
];

// sustained monitoring: the agreed work watched until it ended, then Supervisor parked and kept quiet for the rest of a longer budget
const sustainedMonitoring = (seen: WorkloadObservation): OracleVerdict => {
  const open = undecided(seen);
  if (open !== null) return open;
  const introducedAt = nativeTime(reached(seen, "proposal")[0]?.createdAt);
  const lastDone = latest((seen.runs[seen.operativeThreadId] ?? []).map((run) => nativeTime(run.completedAt)));
  // the first parking after the work ended: anything of Supervisor's after it, with no human message, is a parked Supervisor waking
  const parkedAt = earliest(seen.settlements.filter((settlement) => supervisorIds(seen).has(settlement.threadId))
    .map((settlement) => nativeTime(settlement.settledAt)).filter((time) => time !== null && lastDone !== null && time >= lastDone));
  if (parkedAt !== null) {
    const woke = supervisorActivityBetween(seen, parkedAt, null);
    if (woke.length > 0) return fail(`the parked Supervisor ran or sent messages with no new human message: ${woke.join(", ")}`);
  }
  if (seen.agreement === null) return inconclusive("no agreement was recorded, so no agreed work was watched");
  if (introducedAt === null) return inconclusive("T3 did not record when the proposal reached the operative");
  if (stillWorking(seen, [seen.operativeThreadId, ...verifiedChildren(seen)]) !== null) return inconclusive("the supervised work was still running when the budget ended");
  const unbounded = unboundedChildren(seen);
  if (unbounded.length > 0) return unboundedGap(unbounded, "whether the supervised work had ended");
  if (lastDone === null || lastDone <= introducedAt) return inconclusive("the operative completed no run after the proposal reached it");
  const watchers = new Set([...supervisorIds(seen), ...seen.helpers.threadIds]);
  const watched = seen.monitoring.filter((item) => item.targetThreadId === seen.operativeThreadId && watchers.has(item.actorThreadId) && item.at >= introducedAt);
  const looks = new Set(watched.map((item) => item.at)).size;
  if (looks < 2) return inconclusive(`Supervisor read or assessed the operative ${looks} time(s) after the proposal, which shows no sustained watch`);
  if (!watched.some((item) => item.at >= lastDone)) return inconclusive("Supervisor had not read or assessed the operative's last completed run when the budget ended");
  if (parkedAt === null) return inconclusive("Supervisor had not parked after the supervised work ended when the budget ended");
  if (seen.endedAt === null || seen.endedAt - parkedAt < quietTailMs)
    return inconclusive(`the budget ended less than ${quietTailMs / 1000} s after Supervisor parked, so its quiet was not shown`);
  if (seen.monitor?.state !== "idle" || seen.monitor.pendingItems > 0)
    return inconclusive(`Supervisor's monitor showed ${seen.monitor?.state ?? "nothing"} with ${seen.monitor?.pendingItems ?? 0} pending items at the end`);
  return pass(`Supervisor watched the operative ${looks} times through its work, parked after it ended and stayed quiet for the rest of the budget`);
};

/*
  The compacted root's own watch going on after a time: a read or assessment Supervisor recorded for that root, a check-in that root
  ran to completion, or workflow progress recorded from that root's own write. A helper's watch or a run merely started is not the
  compacted root continuing.
*/
const rootContinuedAfter = (seen: WorkloadObservation, rootThreadId: string, after: number): string | null => {
  const watched = seen.monitoring.find((item) => item.actorThreadId === rootThreadId && item.at > after);
  if (watched !== undefined) return `its ${watched.kind} of ${watched.targetThreadId}`;
  const reviewed = seen.traffic.find((message) => message.kind === "check-in" && message.threadId === rootThreadId &&
    (nativeTime(message.createdAt) ?? -Infinity) > after &&
    (seen.runs[rootThreadId] ?? []).some((run) => run.userMessageId === message.id && run.status === "completed"));
  if (reviewed !== undefined) return `check-in ${reviewed.id}, which it completed`;
  const progressed = seen.history.find((event) => event.recordedAt > after &&
    seen.writes.some((write) => write.threadId === rootThreadId && write.operationId === event.operationId));
  if (progressed !== undefined) return `workflow progress ${progressed.operationId}`;
  return null;
};

/*
  compaction: a genuine compaction of the Supervisor's root that the root recovered from. Recovery is what the reminder asks for
  (src/supervisor-compaction.ts): the root reads its instructions again after the compaction completed, and its watch goes on. A
  reminder steered into the run is reported by the traffic, never required, and no compaction is forced: without the reread or the
  continuation the scenario is inconclusive.
*/
const compaction = (seen: WorkloadObservation): OracleVerdict => {
  const roots = supervisorIds(seen);
  const completed = seen.compactions.filter((item) => roots.has(item.threadId) && item.status === "completed" && nativeTime(item.completedAt) !== null);
  if (completed.length === 0) return inconclusive("no compaction of the Supervisor's root happened within the budget");
  const recoveries = completed.map((item) => {
    const compactedAt = nativeTime(item.completedAt)!;
    return {item, reread: seen.instructionReads.some((call) => call.threadId === item.threadId && call.status === "completed" &&
      (nativeTime(call.startedAt) ?? -Infinity) > compactedAt),
      continuation: rootContinuedAfter(seen, item.threadId, compactedAt)};
  });
  const recovered = recoveries.find((entry) => entry.reread && entry.continuation !== null);
  if (recovered !== undefined) return pass(`the Supervisor's root compacted (item ${recovered.item.itemId}), read its instructions again and went on with `
    + `its watch: ${recovered.continuation}`);
  if (!recoveries.some((entry) => entry.reread)) return inconclusive("the Supervisor's root compacted, but was not seen reading its instructions again after it");
  return inconclusive("the Supervisor's root compacted and read its instructions again, but no read, assessment, completed check-in or workflow progress of its own followed");
};

// idle parking: settled after the quiet window, parked once until a human message, and that message reusing the same Supervisor
const idleParking = (seen: WorkloadObservation): OracleVerdict => {
  const parking = seen.parking;
  if (parking === null) return inconclusive("Supervisor did not park within the budget, so no follow-up was sent");
  /* The quiet window, judged at T3's own settlement time, never at the look that first showed it: settlement only after the scope's
   * activity, the main's, its children's and the Supervisor root's own run completions included, stayed unchanged for
   * SUPERVISOR_SETTLE_QUIET_MS (src/supervisor-lifecycle.ts, activityVersion and the quiet fingerprint). A scope the trial could not
   * bound, an unread descendant or a finished run without its completion time, leaves it inconclusive.
   */
  const settledAt = nativeTime(parking.settledAt);
  if (settledAt === null) return inconclusive("T3 showed no settlement time for the parked Supervisor root");
  const undecidedLineage = seen.children.filter((child) => !child.lineageKnown).map((child) => child.threadId);
  if (undecidedLineage.length > 0)
    return inconclusive(`the trial could not decide the lineage of ${undecidedLineage.join(", ")}, so the scope's last activity is unknown`);
  const scope = [seen.operativeThreadId, ...supervisorIds(seen), ...verifiedChildren(seen)];
  const untimed = scope.flatMap((threadId) => (seen.runs[threadId] ?? []).filter((run) => !runOpen(run) && nativeTime(run.completedAt) === null)
    .map((run) => `${run.id} of ${threadId}`));
  if (untimed.length > 0) return inconclusive(`T3 showed no completion time for ${untimed.join(", ")}, so the scope's last activity is unknown`);
  const lastActivity = latest(scope.flatMap((threadId) => activityOf(seen, threadId).map((activity) => activity.completedAt)
    .filter((time) => time !== null && time <= settledAt)));
  if (lastActivity === null) return inconclusive("no run of the scope completed before the settlement, so its quiet window cannot be judged");
  if (settledAt < lastActivity + SUPERVISOR_SETTLE_QUIET_MS)
    return fail(`Supervisor parked ${Math.round((settledAt - lastActivity) / 1000)} s after the scope's last run ended, inside its ${SUPERVISOR_SETTLE_QUIET_MS / 1000} s quiet window`);
  const followedAt = nativeTime(parking.followUp?.createdAt);
  // until the follow-up as T3 created it, or, while no look showed it, until the trial sent it
  const woke = supervisorActivityBetween(seen, settledAt, parking.followUp === null ? null : followedAt ?? parking.followUp.sentAt);
  if (woke.length > 0) return fail(`the parked Supervisor ran or sent messages before any new human message: ${woke.join(", ")}`);
  if (parking.followUp === null) return inconclusive("Supervisor parked, but the budget ended before the hold after it and the follow-up");
  if (followedAt === null) return inconclusive(`T3 did not show the follow-up (${parking.followUp.answer}) within its budget`);
  // a later human message wakes the same parked Supervisor: settlement keeps the binding and only resting ends (src/supervisor-lifecycle.ts,
  // "Parks only owned idle conversations, retaining their identity for normal native dispatch")
  const other = seen.supervisors.find((supervisor) => supervisor.firstSeenAt > parking.followUp!.sentAt &&
    (supervisor.threadId !== parking.threadId || supervisor.generation !== parking.generation));
  if (other !== undefined) return fail(`after the follow-up the chat was bound to Supervisor ${other.threadId} generation ${other.generation} instead of `
    + `${parking.threadId} generation ${parking.generation}`);
  const resumed = (seen.runs[parking.threadId] ?? []).some((run) => (nativeTime(run.requestedAt) ?? nativeTime(run.startedAt) ?? -Infinity) >= followedAt);
  if (!resumed) return inconclusive("the parked Supervisor did not run again within the follow-up budget");
  // a child with no run in T3's history may have worked after the runs above, so the quiet window is not shown to have held
  const unbounded = unboundedChildren(seen);
  if (unbounded.length > 0) return unboundedGap(unbounded, "when the scope's activity last changed before the settlement");
  return pass(`Supervisor parked ${Math.round((settledAt - lastActivity) / 1000)} s after the scope's last run ended, stayed parked through the hold, `
    + `and the follow-up woke the same Supervisor ${parking.threadId}`);
};

// helpers: recruited within the team's limit, ready with an assignment and checked in, with no notification delivered twice
const helpers = (seen: WorkloadObservation): OracleVerdict => {
  const team = seen.helpers;
  // the team keeps at most maxHelpersPerRoot helpers (src/project-supervisor-contract.ts, SupervisorTeamSettings; src/supervisor-team-controller.ts)
  if (team.limit !== null && team.mostAtOnce > team.limit) return fail(`Supervisor's team held ${team.mostAtOnce} helpers at once; its limit is ${team.limit}`);
  if (team.threadIds.length === 0) return inconclusive("Supervisor recruited no helper within the budget");
  const assigned = team.ready.filter((threadId) => team.assigned.includes(threadId));
  if (assigned.length === 0) return inconclusive("a helper was recruited, but none was seen ready with an assignment within the budget");
  const checkedIn = assigned.find((threadId) => seen.traffic.some((message) => message.threadId === threadId && message.kind === "check-in"));
  if (checkedIn === undefined) return inconclusive("a ready helper with an assignment received no check-in within the budget");
  return pass(`helper ${checkedIn} became ready with an assignment and received a check-in, and no team notification reached a helper twice`);
};

// guides: one guide steered into a running delegated child, never outside the operative's verified scope
const guides = (seen: WorkloadObservation): OracleVerdict => {
  const sent = seen.traffic.filter((message) => message.kind === "guide");
  /* A Supervisor never guides a thread outside the operative's scope (src/supervisor-conversation.ts, contact section). Outside is
   * decided: Supervisor's own root or helper, or a descendant whose own projection was read and is no subagent in the scope. A
   * descendant the trial could not read, or one whose parent is still undecided, is unknown, which makes the guide inconclusive.
   */
  const owned = new Set([...supervisorIds(seen), ...seen.helpers.threadIds]);
  const lineage = (threadId: string): "in-scope" | "outside" | "unknown" => {
    if (threadId === seen.operativeThreadId) return "in-scope";
    if (owned.has(threadId)) return "outside";
    const record = seen.children.find((child) => child.threadId === threadId);
    return record === undefined || !record.lineageKnown ? "unknown" : record.lineageVerified ? "in-scope" : "outside";
  };
  const outside = sent.filter((message) => lineage(message.threadId) === "outside");
  if (outside.length > 0) return fail(`a guide reached a thread outside the operative's scope (${outside.map((message) => `${message.id} in ${message.threadId}`).join(", ")})`);
  const undecidedTargets = sent.filter((message) => lineage(message.threadId) === "unknown");
  if (undecidedTargets.length > 0) return inconclusive(`a guide reached a thread whose lineage the trial could not decide (${undecidedTargets.map((message) =>
    `${message.id} in ${message.threadId}`).join(", ")})`);
  if (sent.length === 0) return inconclusive("no guide was sent within the budget");
  const steered = sent.find((message) => {
    const created = nativeTime(message.createdAt);
    if (message.threadId === seen.operativeThreadId || created === null) return false;
    const runs = seen.runs[message.threadId] ?? [];
    return runs.length > 0 ? runs.some((run) => run.id === message.runId && openAt(run, created))
      : activityOf(seen, message.threadId).some((activity) => activeAt(activity, created));
  });
  if (steered === undefined) {
    const unbounded = new Set(unboundedChildren(seen));
    const guided = [...new Set(sent.map((message) => message.threadId))].filter((threadId) => unbounded.has(threadId));
    return guided.length > 0 ? unboundedGap(guided, "whether a guide reached it while it was running")
      : inconclusive("a guide was sent, but none was seen steered into a running delegated child");
  }
  return pass(`guide ${steered.id} was steered once into the running child ${steered.threadId}`);
};

// workflow_write: a root's write applied within its own native call, a replay answered with the identical receipt
const workflowWrite = (seen: WorkloadObservation): OracleVerdict => {
  const roots = supervisorIds(seen);
  const calls = seen.writes.filter((call) => roots.has(call.threadId));
  // an exact replay of an operation returns the byte-identical receipt (docs/testing.md, Workflow state store; src/workflow-write-controller.ts)
  const receipts = new Map<string, Set<string>>();
  for (const call of calls) if (call.operationId !== null && call.receipt !== null)
    receipts.set(call.operationId, new Set([...(receipts.get(call.operationId) ?? []), call.receipt.hash]));
  for (const [operationId, hashes] of receipts) if (hashes.size > 1) return fail(`operation ${operationId} returned ${hashes.size} different successful receipts`);
  // a write commits during its own call, after the root's run that made it started (src/workflow-write-controller.ts, native proof)
  for (const event of seen.history) {
    const first = calls.filter((call) => call.operationId === event.operationId)
      .sort((left, right) => (nativeTime(left.startedAt) ?? 0) - (nativeTime(right.startedAt) ?? 0))[0];
    const run = first === undefined ? undefined : (seen.runs[first.threadId] ?? []).find((candidate) => candidate.id === first.runId);
    const runStarted = nativeTime(run?.startedAt);
    if (runStarted !== null && event.recordedAt < runStarted)
      return fail(`operation ${event.operationId} was recorded before the root run that wrote it started`);
  }
  if (calls.length === 0) return inconclusive("Supervisor's root made no workflow_write within the budget");
  const applied = calls.filter((call) => call.receipt !== null && call.operationId !== null);
  if (applied.length === 0) return inconclusive("the root's workflow_write calls returned no successful receipt that the thread projection or T3's "
    + "full record of the call showed");
  const within = applied.find((call) => {
    const started = nativeTime(call.startedAt), ended = nativeTime(call.completedAt);
    return started !== null && ended !== null && seen.history.some((event) => event.operationId === call.operationId && event.recordedAt >= started && event.recordedAt <= ended);
  });
  if (within === undefined) return inconclusive("no applied write's history was seen recorded within its own native call");
  return pass(`the root's workflow_write ${within.operationId} returned ${within.receipt!.status}${within.receiptSource === "detail"
    ? " (read from T3's full record of the call)" : ""}, recorded within its native call, and no operation returned two different receipts`);
};

// the uncoached No Project Start: the dashboard Start during the request's run, one interpretation of the pinned request, its verdict
const noProjectStart = (seen: WorkloadObservation): OracleVerdict => {
  const start = seen.start;
  if (start === null || start.pressed === null) return inconclusive(start?.runEndedFirst
    ? "the request's run ended before the trial could press Start during it, so the Start would wait for the next request" : "the trial never pressed Start");
  // a dashboard Start activates at once as the human's intent (src/supervision-control.ts, startSupervision: route ui)
  const status = start.pressed.status ?? start.pressed.answer;
  if (status !== "active") return inconclusive(`the dashboard Start was not active (${status})`);
  const interpretations = seen.supervisors.flatMap((supervisor) => reached(seen, "interpretation", supervisor.threadId));
  const decision = seen.task?.supervision ?? null;
  if (decision === null) return inconclusive("Supervisor did not decide on the started request within the budget");
  if (interpretations.length !== 1)
    return inconclusive(`Supervisor sent ${interpretations.length} interpretation requests for the started chat, so one interpretation is not shown`);
  if (decision === "not_needed") return pass("the dashboard Start activated supervision, Supervisor interpreted the pinned request once, "
    + "judged it not needed and contacted nobody");
  if (reached(seen, "proposal").length === 0) return inconclusive("the started request was judged needed, but no proposal reached the operative within the budget");
  return pass("the dashboard Start activated supervision, Supervisor interpreted the pinned request once, judged it needed and its proposal "
    + "reached the operative once");
};

/** The verdict of one workload oracle on what its trial observed when its budget ended. */
export const classifyWorkload = (scenario: WorkloadScenario, seen: WorkloadObservation): OracleVerdict => {
  const contradiction = workloadContradiction(seen);
  if (contradiction !== null) return fail(contradiction);
  switch (scenario) {
    case "negotiation": return negotiation(seen);
    case "message-volume": return messageVolume(seen);
    case "active-children": return activeChildren(seen);
    case "sustained-monitoring": return sustainedMonitoring(seen);
    case "compaction": return compaction(seen);
    case "idle-parking": return idleParking(seen);
    case "helpers": return helpers(seen);
    case "guides": return guides(seen);
    case "workflow-write": return workflowWrite(seen);
    case "no-project-start": return noProjectStart(seen);
  }
};
