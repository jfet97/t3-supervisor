import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Clock, Console, Data, Effect, FileSystem, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/http";
import { NativeEnvelope } from "../src/native-envelope.js";
import { forgeDashboardToken } from "../src/service-auth.js";
import { interpretationSubmitToolName } from "../src/interpretation-submission.js";
import { helperInstructionsVersion } from "../src/supervisor-helper-instructions.js";
import { NativeRpc, type NativeRpcShape } from "../src/supervisor-native.js";
import { interpretationRulesVersion } from "../src/supervisor-workflow.js";
import { canonicalJson, isRecord, recognisedWorkflowCallArguments } from "../src/workflow-write-evidence.js";
import { directParentChildLifecycle } from "../src/supervisor-observation.js";
import type { Projection } from "../src/types.js";
import { runProcess } from "../test/support/g8-process.js";
import { devPaths, devPorts, t3Environment } from "./dev-environment.js";
import { checkoutInputs } from "./local-run.js";
import { decodeDescriptor, ensureRuntime, issueSession, orchestrationProtocol, t3Command, t3Release, type T3Cli } from "./local-stack.js";
import { classifyWorkload, isWorkloadScenario, nativeTime, quietTailMs, repeatedContent, trafficKind, trafficTotals, unboundedChildren, type ChildLifecycle,
  type NativeExecution, type NativeRun, type ParkingFacts,
  type TrafficMessage, type WorkloadObservation, type WriteCall } from "./provider-trial-oracles.js";

/*
  `./dev trial SCENARIO[,SCENARIO...] --budget-minutes N`: one local provider trial (docs/testing.md, execution type 6) in the running
  signed-in development environment. It never runs in CI. The trial owns a fresh disposable project in the development workspaces, or
  for a No Project scenario the chat it starts in T3's own scratch project, and the one operative chat it starts there with an
  uncoached request, launched automatically through the call T3's web app makes, so T3 records it as the user's from the web although
  no person typed it; it never reads, edits or resets any other conversation. It reads through its own scoped T3 read session and its
  own dashboard sign-in, both ended when it ends, and observes for the whole budget the caller chose: the Supervisor messages that
  reach the operative chat (by the message identities Supervisor gives them, or their sender) and the task Supervisor records for the
  chat, and in a workload trial (scripts/provider-trial-oracles.ts) also the Supervisor root, the operative's delegated children,
  Supervisor's helpers and its workflow progress. The outcome is pass only on the scenario's required observed sequence, fail when an
  invariant is contradicted, inconclusive when the budget ended first and unavailable when the environment or the provider was. A
  pass whose evidence has a gap (the end of the budget unobserved, a missing provenance or runtime input, an unsuccessful cleanup) is
  reported inconclusive with its gaps. Several observing workload scenarios may share one launch, each with its own verdict. It prints
  the outcome with its inputs and, for each milestone, the sampling bounds of when it happened: the last readable look before it and
  the look that first showed it. The stop scenario also stops its own chat once with the chat's Stop in the dashboard, as a person
  does, at the first look after the proposal reached the operative that shows the operative's run running; it never presses again,
  whatever the answer. The No Project scenarios press the dashboard's Start once while the request's run is open, and no-project-stop
  presses the chat's Stop once while Supervisor's interpretation of the started request is in flight. Idle parking sends one follow-up
  message, as a person adds to finished work, once Supervisor has parked and stayed parked through a hold.
  When it ends, also by a failure or an interruption, the trial turns supervision off for its own project and asks T3 to remove that
  project with its chats; it reports the removal T3 acknowledged, which on the pinned T3 commits the chats' deletion with their
  provider sessions' detachment as durable effects, not a physically observed end of model work. A No Project trial instead asks T3
  to delete its own chat, the chat's descendants, its Supervisor root and that root's helpers, one by one. `--keep` keeps the project
  with supervision off, or the No Project chats with the chat stopped, for inspection. It changes no other project, chat, chat Stop or
  setting. The provider and model T3 selected are read from the operative's and the Supervisor root's own projections, and the
  runtime version of each selected provider instance from T3's own provider status; the Codex CLI found in the environment is
  reported apart, labelled unverified, because it need not be the runtime T3 runs.
*/

export class ProviderTrialError extends Data.TaggedError("ProviderTrialError")<{readonly message: string}> {}
const failure = (message: string) => new ProviderTrialError({message});

export type TrialOutcome = "pass" | "fail" | "inconclusive" | "unavailable";

// substantive work on tracked content, which Supervisor decides it supervises
const substantiveRequest = "Add a CONTRIBUTING.md that explains how to propose a change, with a short checklist, and link it from the README.";
// the shared workload: a change to the configured library's code, tests and documentation (libraryProject below)
const workloadRequest = "Make parseDuration in src/duration.js understand compound durations such as \"1h30m\" and \"2d4h15m\", with days as a new "
  + "unit, make formatDuration produce the same compound form, keep single-unit input working, and cover the new format with tests and a README example.";
// work for a chat without a project, in the empty folder T3 gives it
const scratchRequest = "Write a small Python script, wordfreq.py, that prints the ten most frequent words of a text file given on the command line, "
  + "ignoring case and punctuation, and add a short README that shows how to run it.";
/** The one message idle parking adds to the finished work once Supervisor has parked, as a person adds to it. */
export const followUpRequest = "Also let parseDuration take uppercase units such as \"2H\" or \"15M\", with a test for it.";

/** The trials: an uncoached request each, as a person would type it, and nothing about Supervisor. */
export const trialScenarios = {
  // a quick question that needs no shared plan: Supervisor decides it is not needed and contacts nobody
  "no-contact": "What is this folder for? Answer in one sentence.",
  // Supervisor decides the request is needed and introduces one proposal to the operative
  "introduction": substantiveRequest,
  /* the shared workload's change in the configured library: implementation, tests and review keep the operative's run going, so once
   * the proposal reached the operative the person can stop the chat in the dashboard while that run is running
   */
  "stop": workloadRequest,
  // the shared workload, each with its own oracle (scripts/provider-trial-oracles.ts)
  "negotiation": workloadRequest,
  "message-volume": workloadRequest,
  "active-children": workloadRequest,
  "sustained-monitoring": workloadRequest,
  "compaction": workloadRequest,
  "idle-parking": workloadRequest,
  "helpers": workloadRequest,
  "guides": workloadRequest,
  "workflow-write": workloadRequest,
  // a chat without a project: the person starts its supervision in the dashboard, and in no-project-stop stops it again
  "no-project-start": scratchRequest,
  "no-project-stop": scratchRequest,
} as const;
export type TrialScenario = keyof typeof trialScenarios;
export const isTrialScenario = (value: unknown): value is TrialScenario => typeof value === "string" && Object.hasOwn(trialScenarios, value);

/** Where a trial's request runs: the plain trial project, the configured library project, or T3's scratch project. */
export type TrialWorkload = "question" | "contributing" | "library" | "no-project";
export const trialWorkload = (scenario: TrialScenario): TrialWorkload => scenario === "no-contact" ? "question"
  : scenario === "introduction" ? "contributing" : scenario === "no-project-start" || scenario === "no-project-stop" ? "no-project" : "library";

/** The workload scenarios that only observe; several of them share one launch, each judged by its own oracle. */
export const observingScenarios: ReadonlyArray<TrialScenario> = ["negotiation", "message-volume", "active-children", "sustained-monitoring",
  "compaction", "helpers", "guides", "workflow-write"];

/** The longest budget a trial, or idle parking's follow-up, may ask for: a day, within what T3 grants the trial's read session. */
export const maxTrialMinutes = 24 * 60;
/** Why a budget is refused, or null: a positive number of minutes up to a day. */
export const budgetRefusal = (minutes: number): string | null => !Number.isFinite(minutes) || minutes <= 0 ? "a budget is a positive number of minutes"
  : minutes > maxTrialMinutes ? `a budget is at most ${maxTrialMinutes} minutes, a day` : null;

export interface TrialPlan {
  readonly scenarios: ReadonlyArray<TrialScenario>;
  readonly workload: TrialWorkload;
  readonly request: string;
  // idle parking's budget after its follow-up, null for every other trial
  readonly followUpMs: number | null;
}

/** The trial a command line asks for, or why it is refused: one scenario, or several observing workload scenarios sharing a launch. */
export const planTrial = (names: ReadonlyArray<string>, followUpMinutes: number | null): TrialPlan | {readonly refused: string} => {
  const unknown = names.filter((name) => !isTrialScenario(name));
  if (names.length === 0 || unknown.length > 0) return {refused: `unknown scenario ${unknown.join(", ") || "(none)"}`};
  const scenarios = names.filter(isTrialScenario);
  if (new Set(scenarios).size !== scenarios.length) return {refused: "a scenario is named twice"};
  if (scenarios.length > 1 && !scenarios.every((scenario) => observingScenarios.includes(scenario)))
    return {refused: `only the observing workload scenarios share one launch: ${observingScenarios.join(", ")}`};
  const parking = scenarios.includes("idle-parking");
  if (parking && (followUpMinutes === null || budgetRefusal(followUpMinutes) !== null))
    return {refused: `idle-parking needs --follow-up-minutes M, its budget after the follow-up${followUpMinutes === null ? "" : `: ${budgetRefusal(followUpMinutes)}`}`};
  if (!parking && followUpMinutes !== null) return {refused: "--follow-up-minutes belongs to idle-parking"};
  const first = scenarios[0]!;
  return {scenarios, workload: trialWorkload(first), request: trialScenarios[first], followUpMs: parking && followUpMinutes !== null ? followUpMinutes * 60_000 : null};
};

/** What one look at the trial's operative chat and its Supervisor state shows. */
export interface TrialObservation {
  // ids of the messages in the operative chat that Supervisor sent: its service notices or messages of its root thread
  readonly supervisorMessageIds: ReadonlyArray<string>;
  // the task Supervisor records for the operative chat, once it has one
  readonly task: {readonly id: string | null; readonly status: string; readonly supervision: "needed" | "not_needed" | null; readonly agreed: boolean} | null;
  /* The chat's Stop, pressed once by the trial in the dashboard: the dashboard's answer (saved, conflict, unavailable, or no answer
   * when the outcome is unknown) and, as reads after the answer showed it against the Stop's recorded time, in stop whether the
   * operative's run was running and in no-project-stop whether Supervisor's interpretation of the started request was in flight.
   */
  readonly stop?: {readonly answer: string; readonly runAtPress?: RunPhase; readonly interpretationAtPress?: InterpretationPhase} | null;
  // whether the chat's policy showed it stopped from the dashboard, under a generation after the one pressed, at the last look
  readonly policyStopped?: boolean;
  // the first Stop notice as T3 recorded it, once one reached the chat
  readonly stopNoticeRecord?: {readonly createdAt: string | null; readonly createdBy: string | null; readonly creationSource: string | null} | null;
  // the Supervisor messages T3 created in the chat after its first Stop notice; null when a creation time needed to tell is missing
  readonly afterStopNotice?: ReadonlyArray<string> | null;
  // the Supervisor's settlement at the last look (pending, uncertain, settled or superseded), null while it is not settling
  readonly settlement?: string | null;
  // the dashboard Start of a No Project chat, pressed once: its answer and the status a later read showed
  readonly start?: {readonly answer: string; readonly status: string | null} | null;
  /* The proposal notices in the chat, each with a digest of the text T3 showed for it (null when it showed none), and the proposals
   * Supervisor recorded for the request's task at the looks (its workflowProposalId): what tells a revision from a repeated delivery.
   */
  readonly proposalNotices?: ReadonlyArray<{readonly id: string; readonly textHash: string | null}>;
  readonly proposalIds?: ReadonlyArray<string>;
  // everything a workload trial observed for its whole budget
  readonly workload?: WorkloadObservation;
}

export interface TrialVerdict {
  readonly outcome: Exclude<TrialOutcome, "unavailable">;
  readonly reason: string;
}

const workflowNotice = "supervisor-notice:workflow:";
const stopNotice = "supervisor-notice:stop:";
const openRunStatuses: ReadonlySet<string> = new Set(["preparing", "queued", "starting", "running", "waiting"]);
// an interpretation Supervisor has sent its root, or is sending, and not yet decided (src/project-supervisor.ts, dispatch)
const interpretingStatuses: ReadonlySet<string> = new Set(["dispatching", "waiting"]);

/** Whether the operative's run was running when the Stop took effect, judged afterwards from T3's own times of that run. */
export type RunPhase = "running" | "not-running" | "unknown";
/** Whether Supervisor's interpretation of the started request was in flight when the Stop took effect. */
export type InterpretationPhase = "interpreting" | "not-interpreting" | "unknown";
/** The request's task as one read of Supervisor's state showed it: its identity, status and the time of its last change. */
export interface TaskReading {readonly id: string | null; readonly status: string; readonly updatedAt: number | null}
/** When the Stop took effect, in milliseconds on the stack's one clock: a moment, or a window it fell somewhere in. */
export interface StopTime {readonly from: number; readonly to: number}

/**
 * When the Stop took effect: Supervisor's own record of the chat's stop by the dashboard (chatSupervision.stoppedAt) when it lies
 * between the press's sending and its answer, otherwise only that it fell somewhere between them.
 */
export const stopTime = (press: {readonly sentAt: number; readonly answeredAt: number},
  recorded: {readonly stoppedBy: string | null; readonly stoppedAt: number | null} | null): StopTime =>
  recorded !== null && recorded.stoppedBy === "ui" && recorded.stoppedAt !== null && recorded.stoppedAt >= press.sentAt && recorded.stoppedAt <= press.answeredAt
    ? {from: recorded.stoppedAt, to: recorded.stoppedAt} : {from: press.sentAt, to: press.answeredAt};

/**
 * Whether the run a fresh read showed running just before the press was running when the Stop took effect, from T3's own times of
 * that run as reads after the press's answer showed them: started before the Stop and completed after it, or still open. No read
 * after the answer, no native start, or a start or completion within the Stop's window leaves it unknown.
 */
export const runPhaseAtPress = (run: {readonly startedAt: string | null; readonly completedAt: string | null; readonly status: string} | null,
  stop: StopTime): RunPhase => {
  if (run === null) return "unknown";
  const started = nativeTime(run.startedAt);
  if (started === null) return "unknown";
  if (started > stop.to) return "not-running";
  if (started >= stop.from) return "unknown";
  const completed = nativeTime(run.completedAt);
  if (completed === null) return openRunStatuses.has(run.status) ? "running" : "unknown";
  if (completed < stop.from) return "not-running";
  return completed > stop.to ? "running" : "unknown";
};

/**
 * Whether Supervisor's interpretation of the started request was in flight when the Stop took effect, from its task read just before
 * the press and again at once after the answer. A task's updatedAt is its last change, so the status that held at the Stop is known
 * only when the later read shows the same task unchanged, or changed last before the Stop. A change at or after the Stop, a missing
 * read or time, or another task leaves it unknown: the interpretation may have ended just before the Stop.
 */
export const interpretationPhaseAtPress = (before: TaskReading | null, after: TaskReading | null, stop: StopTime): InterpretationPhase => {
  if (before === null || after === null || before.updatedAt === null || after.updatedAt === null || before.id !== after.id) return "unknown";
  const held = after.updatedAt === before.updatedAt ? (after.status === before.status ? before.status : null)
    : after.updatedAt < stop.from ? after.status : null;
  return held === null ? "unknown" : interpretingStatuses.has(held) ? "interpreting" : "not-interpreting";
};

/**
 * Whether fresh reads just before the press show the moment to press the chat's Stop, with the policy generation to press and, in
 * stop, the one run running: in stop the proposal in the chat and exactly one run running; in no-project-stop an active Start and the
 * started request's interpretation in flight. The chat's policy must show it not stopped.
 */
export const stopPressReady = (scenario: "stop" | "no-project-stop", fresh: {
  readonly policy: {readonly stopped: boolean; readonly policyGeneration: number; readonly activation?: string | null | undefined} | null;
  readonly runs: ReadonlyArray<{readonly id: string; readonly status: string}> | null;
  readonly proposalReached: boolean; readonly task: TaskReading | null}): {readonly policyGeneration: number; readonly runId: string | null} | null => {
  if (fresh.policy === null || fresh.policy.stopped) return null;
  if (scenario === "stop") {
    const running = (fresh.runs ?? []).filter((run) => run.status === "running");
    return fresh.proposalReached && running.length === 1 ? {policyGeneration: fresh.policy.policyGeneration, runId: running[0]!.id} : null;
  }
  return fresh.policy.activation === "active" && fresh.task !== null && interpretingStatuses.has(fresh.task.status)
    ? {policyGeneration: fresh.policy.policyGeneration, runId: null} : null;
};

/*
  One notice per proposal, and one more per genuine revision (src/supervisor-conversation.ts, sendIntroductions): Supervisor creates an
  introduction only while none was sent for the task or the sent one carried another proposal than the task's current one, under a new
  identity `supervisor-notice:workflow:<task>:<scope revision>`, suffixed with the proposal's fingerprint where that identity was used
  already. A queued or retried identity (`:queue`, `:retry:<n>`) replaces an attempt only after T3 definitely rejected it, so that
  attempt never reached the chat. A notice's text names its own proposal (workflowIntroductionText), so the same text twice is one
  proposal delivered twice: a failure. Notices with distinct texts count as revisions only as far as Supervisor itself was seen
  recording that many proposals for the request; more of them, or a notice whose text T3 did not show, leaves the trial inconclusive,
  since a proposal recorded and replaced between two looks cannot be ruled out.
*/
const proposalDelivery = (notices: ReadonlyArray<string>, seen: TrialObservation): TrialVerdict | null => {
  if (notices.length < 2) return null;
  const textOf = (id: string): string | null => seen.proposalNotices?.find((entry) => entry.id === id)?.textHash ?? null;
  const byText = new Map<string, ReadonlyArray<string>>();
  for (const id of notices) {
    const hash = textOf(id);
    if (hash !== null) byText.set(hash, [...(byText.get(hash) ?? []), id]);
  }
  const repeated = [...byText.values()].find((ids) => ids.length > 1);
  if (repeated !== undefined) return {outcome: "fail", reason: `the same proposal notice reached the chat ${repeated.length} times: ${repeated.join(", ")}`};
  if (notices.some((id) => textOf(id) === null)) return {outcome: "inconclusive",
    reason: `${notices.length} proposal notices reached the chat, but T3 did not show every one's text, so a repeat cannot be told from a revision`};
  const proposals = new Set(seen.proposalIds ?? []).size;
  if (notices.length > proposals) return {outcome: "inconclusive", reason: `${notices.length} proposal notices with distinct texts reached the chat `
    + `while Supervisor was seen recording ${proposals} proposal${proposals === 1 ? "" : "s"} for the request, so not every one is a seen revision`};
  return null;
};

/** The verdict of a trial whose budget ended on this last observation: each scenario's required sequence and its invariants. */
export const classifyTrial = (scenario: TrialScenario, seen: TrialObservation): TrialVerdict => {
  const notices = seen.supervisorMessageIds.filter((id) => id.startsWith(workflowNotice));
  const stops = seen.supervisorMessageIds.filter((id) => id.startsWith(stopNotice));
  const press = seen.stop ?? null;
  if (stops.length > 0 && press === null) return {outcome: "fail", reason: "a Stop notice reached the chat although nobody stopped it"};
  // a Stop notice answers the person's own Stop, so it is no contact about the request
  const contact = press === null ? seen.supervisorMessageIds : seen.supervisorMessageIds.filter((id) => !id.startsWith(stopNotice));
  if (seen.task?.supervision === "not_needed" && contact.length > 0)
    return {outcome: "fail", reason: `Supervisor contacted a chat whose request it judged not needed: ${contact.join(", ")}`};
  if (isWorkloadScenario(scenario)) return seen.workload === undefined
    ? {outcome: "inconclusive", reason: "the trial recorded no observation of its workload"} : classifyWorkload(scenario, seen.workload);
  if (scenario === "no-contact") {
    if (seen.supervisorMessageIds.length > 0) return {outcome: "fail", reason: `Supervisor contacted the chat: ${seen.supervisorMessageIds.join(", ")}`};
    if (seen.task?.supervision === "not_needed") return {outcome: "pass", reason: "the request was judged not needed and nobody was contacted"};
    if (seen.task?.supervision === "needed") return {outcome: "inconclusive", reason: "Supervisor judged this request needed, so the no-contact case did not happen"};
    return {outcome: "inconclusive", reason: "Supervisor decided nothing within the budget"};
  }
  const delivery = proposalDelivery(notices, seen);
  if (delivery !== null) return delivery;
  if (scenario === "stop" || scenario === "no-project-stop") {
    if (stops.length > 1) return {outcome: "fail", reason: `the chat received ${stops.length} Stop notices: ${stops.join(", ")}`};
    const after = seen.afterStopNotice;
    if (after !== null && after !== undefined && after.length > 0) return {outcome: "fail", reason: `Supervisor contacted the chat after its Stop notice: ${after.join(", ")}`};
    if (scenario === "no-project-stop") {
      // a dashboard Start activates at once as the person's intent (src/supervision-control.ts, startSupervision on the ui route)
      const started = seen.start?.status ?? seen.start?.answer ?? null;
      if (started !== "active") return {outcome: "inconclusive", reason: seen.start === null || seen.start === undefined
        ? "the trial never pressed Start, so there was no started supervision to stop" : `the dashboard Start was not active (${started ?? "no answer"})`};
      if (press === null) return {outcome: "inconclusive", reason: seen.task?.supervision === null || seen.task?.supervision === undefined
        ? "Supervisor's interpretation of the started request was not seen in flight within the budget, so the chat was not stopped during it"
        : "Supervisor had already decided on the started request at the first chance to stop it, so the chat was not stopped during its interpretation"};
      if (press.interpretationAtPress !== "interpreting") return {outcome: "inconclusive", reason: press.interpretationAtPress === "not-interpreting"
        ? "Supervisor's interpretation was not in flight at the Stop" : "the reads around the Stop could not show Supervisor's interpretation in flight when it took effect"};
    } else {
      if (press === null) return {outcome: "inconclusive", reason: seen.task?.supervision === "not_needed"
        ? "Supervisor judged this request not needed, so there was no supervised work to stop"
        : "the operative was not seen running after the proposal reached it within the budget, so the chat was not stopped during model work"};
      if (press.runAtPress !== "running") return {outcome: "inconclusive", reason: press.runAtPress === "not-running"
        ? "the operative's run was not running at the Stop, so it was not a Stop during model work"
        : "T3's times of the operative's run could not show it running when the Stop took effect"};
    }
    // one press only: a refused one ends the trial inconclusive, and an unanswered one counts only once the chat's policy shows it stopped
    if (press.answer !== "saved" && seen.policyStopped !== true) return {outcome: "inconclusive",
      reason: press.answer === "no answer" ? "the Stop's outcome is unknown and the chat's policy never showed it stopped" : `the dashboard did not save the Stop: ${press.answer}`};
    if (stops.length === 0) return {outcome: "inconclusive", reason: "the chat was stopped, but no Stop notice reached it within the budget"};
    const record = seen.stopNoticeRecord ?? null;
    if (record === null || record.createdAt === null || Number.isNaN(Date.parse(record.createdAt)) || record.creationSource !== "server")
      return {outcome: "inconclusive", reason: "T3 did not record the Stop notice's creation time and Supervisor's provenance, so its order cannot be checked"};
    if (after === null || after === undefined) return {outcome: "inconclusive", reason: "a Supervisor message has no creation time, so contact after the Stop notice cannot be ruled out"};
    if (seen.settlement !== "settled") return {outcome: "inconclusive", reason: `the Stop notice reached the chat once, but Supervisor had not settled when the budget ended (${seen.settlement ?? "not settling"})`};
    return {outcome: "pass", reason: scenario === "stop"
      ? "the chat was stopped while its run was running, its Stop notice reached the operative once, nothing followed it and Supervisor settled"
      : "the started chat was stopped while Supervisor interpreted its request, its Stop notice reached the operative once, nothing followed it and Supervisor settled"};
  }
  if (seen.task?.supervision === "needed" && notices.length > 0) return {outcome: "pass", reason: `the request was judged needed and ${notices.length === 1
    ? "its proposal reached the operative once" : `each of its ${notices.length} proposal revisions reached the operative once`}${seen.task.agreed ? ", which agreed to it" : ""}`};
  if (seen.task?.supervision === "not_needed") return {outcome: "inconclusive", reason: "Supervisor judged this request not needed, so no introduction was due"};
  return {outcome: "inconclusive", reason: seen.task ? `no proposal reached the operative within the budget (task ${seen.task.status})` : "Supervisor decided nothing within the budget"};
};

/** What a trial observed and recorded beside its verdict, in milliseconds after the launch where it is a time. */
export interface TrialEvidence {
  readonly budgetMs: number;
  // the last look whose reads all succeeded, null when none did
  readonly lastReadableMs: number | null;
  readonly checkout: {readonly revision: string | null; readonly clean: boolean | null};
  readonly requestRecorded: boolean;
  /* The trial's actors, each with every model selection its own T3 projection showed: the operative and every Supervisor root the
   * binding named, which every scenario needs, and the helpers and descendants a workload trial read, which only the scenarios that
   * rest on them need (scenarioActors). A selection is never inferred from another actor or from the CLI.
   */
  readonly actors: ReadonlyArray<ActorProvenance>;
  // the runtime versions T3's provider status (server.getConfig) reported for the instances those selections name, null when unreadable
  readonly runtimes: ReadonlyArray<{readonly instanceId: string; readonly version: string | null}> | null;
  readonly cleanup: {readonly supervisionOff: boolean; readonly project: string};
  // what a workload trial's last readable look could not read beside the chat and its Supervisor state: a child, a helper, the progress
  readonly unreadAtEnd?: ReadonlyArray<string>;
}

/** A model selection as an actor's own T3 projection showed it, reduced to its known fields: the provider instance, the model, its settings. */
export type ActorSelection = typeof ShownSelection.Type;
export type ActorRole = "operative" | "root" | "helper" | "child";
/** One actor of a trial and each distinct model selection its own projection showed. */
export interface ActorProvenance {readonly threadId: string; readonly role: ActorRole; readonly selections: ReadonlyArray<ActorSelection>}

/**
 * The provenance gaps of the actors a verdict rests on: each must have shown a model selection in its own projection, and T3 must
 * have reported a runtime version for every instance those selections name, one gap per instance. An unreadable provider status is
 * a gap of its own (evidenceGaps).
 */
export const actorGaps = (required: ReadonlyArray<{readonly threadId: string; readonly role: ActorRole}>,
  evidence: Pick<TrialEvidence, "actors" | "runtimes">): ReadonlyArray<string> => {
  const named = required.map(({threadId, role}) => {
    const actor = evidence.actors.find((item) => item.threadId === threadId);
    const known = actor?.role ?? role;
    return {name: known === "operative" ? "the operative chat" : known === "root" ? `the Supervisor root ${threadId}` : `${known} ${threadId}`,
      instances: new Set((actor?.selections ?? []).map((selection) => selection.instanceId))};
  });
  const runtimes = evidence.runtimes;
  const unreported = runtimes === null ? [] : [...new Set(named.flatMap((actor) => [...actor.instances]))]
    .filter((instance) => !runtimes.some((runtime) => runtime.instanceId === instance && runtime.version !== null));
  return [...named.filter((actor) => actor.instances.size === 0).map((actor) => `T3 showed no model selection for ${actor.name}`),
    ...unreported.map((instance) => `T3 reported no runtime version for ${instance}, selected by ${named.filter((actor) => actor.instances.has(instance))
      .map((actor) => actor.name).join(", ")}`)];
};

/**
 * The actors a scenario's verdict rests on beyond the operative and Supervisor's roots: every helper Supervisor recruited for helpers,
 * the verified delegated children for active-children, and the threads a guide reached for guides. No other scenario needs them.
 */
export const scenarioActors = (scenario: TrialScenario, workload: WorkloadObservation | undefined): ReadonlyArray<{readonly threadId: string; readonly role: ActorRole}> =>
  workload === undefined ? []
  : scenario === "helpers" ? workload.helpers.threadIds.map((threadId) => ({threadId, role: "helper" as const}))
  : scenario === "active-children" ? workload.children.filter((child) => child.lineageVerified).map((child) => ({threadId: child.threadId, role: "child" as const}))
  : scenario === "guides" ? [...new Set(workload.traffic.filter((message) => message.kind === "guide" && message.threadId !== workload.operativeThreadId)
    .map((message) => message.threadId))].map((threadId) => ({threadId, role: "child" as const}))
  : [];

/** The gaps that keep a trial's evidence from supporting a clean pass. */
export const evidenceGaps = (evidence: TrialEvidence): ReadonlyArray<string> => {
  const {runtimes, lastReadableMs} = evidence;
  return [
    // the verdict reads the last readable look, so the end of the window must be observed: an older look would pass stale evidence
    ...(lastReadableMs === null ? ["no look at the chat was readable"] : lastReadableMs < evidence.budgetMs
      ? [`the last readable look was ${minutes(lastReadableMs)} min after the launch, before the ${minutes(evidence.budgetMs)}-minute budget ended`] : []),
    ...(evidence.checkout.revision === null ? ["this checkout's commit is unknown"] : evidence.checkout.clean !== true ? ["this checkout had uncommitted changes"] : []),
    ...(evidence.requestRecorded ? [] : ["T3 never showed the original request's provenance"]),
    ...(runtimes === null ? ["T3's provider status was unreadable"] : []),
    ...actorGaps(evidence.actors.filter((actor) => actor.role === "operative" || actor.role === "root"), evidence),
    ...(evidence.cleanup.supervisionOff ? [] : ["supervision could not be turned off for the trial project"]),
    ...(["removal acknowledged", "deletion acknowledged", "kept"].includes(evidence.cleanup.project) ? [] : [`the trial project: ${evidence.cleanup.project}`]),
    ...(evidence.unreadAtEnd ?? []).map((what) => `the last readable look could not read ${what}`),
  ];
};

/**
 * Each scenario's verdict, a pass kept only without gaps: those every trial shares and those of the actors that scenario rests on
 * (scenarioActors), which leave every other scenario's verdict alone.
 */
export const scenarioVerdicts = (scenarios: ReadonlyArray<TrialScenario>, observation: TrialObservation, gaps: ReadonlyArray<string>,
  provenance: Pick<TrialEvidence, "actors" | "runtimes">) => scenarios.map((scenario) => {
  const ownGaps = actorGaps(scenarioActors(scenario, observation.workload), provenance);
  return {scenario, ...finalVerdict(classifyTrial(scenario, observation), [...gaps, ...ownGaps]), ...(ownGaps.length > 0 ? {actorGaps: ownGaps} : {})};
});

/** The outcome a trial reports: its verdict, except that a pass with an evidence gap is inconclusive. */
export const finalVerdict = (verdict: TrialVerdict, gaps: ReadonlyArray<string>): TrialVerdict =>
  verdict.outcome === "pass" && gaps.length > 0 ? {outcome: "inconclusive", reason: `${verdict.reason}, but the evidence has gaps: ${gaps.join("; ")}`} : verdict;

/** The outcome of a trial that judged several scenarios at once: a failure fails it, and it passes only when every one passed. */
export const combinedOutcome = (verdicts: ReadonlyArray<TrialVerdict>): TrialVerdict["outcome"] =>
  verdicts.some((verdict) => verdict.outcome === "fail") ? "fail" : verdicts.length > 0 && verdicts.every((verdict) => verdict.outcome === "pass") ? "pass" : "inconclusive";

const minutes = (ms: number): number => Math.round(ms / 600) / 100;

/** The alias Supervisor's root calls its workflow tools through (docs/workflow-mcp.md, MCP interface). */
export const workflowMcpAlias = "t3-supervisor-workflows";

const McpServers = Schema.Array(Schema.Struct({name: Schema.String, enabled: Schema.optional(Schema.Boolean),
  transport: Schema.Struct({type: Schema.String, url: Schema.optional(Schema.NullOr(Schema.String)),
    bearer_token_env_var: Schema.optional(Schema.NullOr(Schema.String)), http_headers: Schema.optional(Schema.Unknown),
    env_http_headers: Schema.optional(Schema.Unknown)})}));

// the value of a header map's Authorization entry; it is compared or tested for presence, never reported
const authorization = (headers: unknown): string | null => {
  if (typeof headers !== "object" || headers === null) return null;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === "authorization");
  return entry !== undefined && typeof entry[1] === "string" && entry[1].length > 0 ? entry[1] : null;
};
// a registered URL as it may be reported: without any user information it carries
const shownUrl = (value: string | null | undefined): string => value === null || value === undefined ? "no URL"
  : Option.match(Option.liftThrowable((text: string) => new URL(text))(value), {onNone: () => "an unreadable URL",
    onSome: (parsed) => `${parsed.protocol}//${parsed.host}${parsed.pathname}`});

/** The workflow tools Supervisor's root needs to read its context and submit an interpretation. */
export const requiredWorkflowTools = ["workflow_read", interpretationSubmitToolName] as const;

/**
 * What the Codex CLI's own MCP registrations (`codex mcp list --json`) say about Supervisor's workflow MCP: registered under its
 * alias, enabled, reached at exactly the dashboard's loopback URL over Streamable HTTP, and carrying a bearer. Only the alias, the
 * URL without user information and the kind of bearer leave it as text; `authorization` builds the Authorization header the root
 * will send, redacted, from the registration and the environment T3 runs in, or null when an environment variable it names is unset.
 */
export const workflowMcpRegistration = (listed: string, url: string):
  | {readonly registered: true; readonly auth: "bearer_token_env_var" | "http_headers" | "env_http_headers";
    readonly authorization: (environment: Readonly<Record<string, string | undefined>>) => Redacted.Redacted<string> | null}
  | {readonly registered: false; readonly found: string} => {
  const servers = Schema.decodeUnknownOption(Schema.fromJsonString(McpServers))(listed.trim());
  if (Option.isNone(servers)) return {registered: false, found: "registrations that could not be read"};
  const server = servers.value.find((entry) => entry.name === workflowMcpAlias);
  if (server === undefined) return {registered: false, found: servers.value.length === 0 ? "no MCP server registered"
    : `no ${workflowMcpAlias} among ${servers.value.length} registered`};
  const {transport} = server;
  if (server.enabled === false) return {registered: false, found: `${workflowMcpAlias} disabled`};
  if (transport.type !== "streamable_http") return {registered: false, found: `${workflowMcpAlias} over ${transport.type}`};
  if ((transport.url ?? "").replace(/\/$/u, "") !== url) return {registered: false, found: `${workflowMcpAlias} at ${shownUrl(transport.url)}`};
  const variable = transport.bearer_token_env_var;
  if (typeof variable === "string" && variable.length > 0) return {registered: true, auth: "bearer_token_env_var",
    authorization: (environment) => {const token = environment[variable]; return token ? Redacted.make(`Bearer ${token}`) : null;}};
  const header = authorization(transport.http_headers);
  if (header !== null) return {registered: true, auth: "http_headers", authorization: () => Redacted.make(header)};
  const headerVariable = authorization(transport.env_http_headers);
  if (headerVariable !== null) return {registered: true, auth: "env_http_headers",
    authorization: (environment) => {const value = environment[headerVariable]; return value ? Redacted.make(value) : null;}};
  return {registered: false, found: `${workflowMcpAlias} without a bearer`};
};

const ToolList = Schema.Struct({result: Schema.Struct({tools: Schema.Array(Schema.Struct({name: Schema.String}))})});

// the platform fetch, as the stack check's own client
const fetchClient = FetchHttpClient.layer.pipe(Layer.provide(Layer.sync(FetchHttpClient.Fetch, () => globalThis.fetch)));

// one JSON request on the container's loopback: its status and parsed body, or none when it failed or timed out
const jsonRequest = (url: string, init: {readonly method?: "GET" | "POST"; readonly headers?: Readonly<Record<string, string>>; readonly body?: unknown} = {}) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const base = (init.method === "POST" ? HttpClientRequest.post(url) : HttpClientRequest.get(url)).pipe(HttpClientRequest.setHeaders(init.headers ?? {}));
    const request = init.body === undefined ? base : base.pipe(HttpClientRequest.setBody(HttpBody.text(JSON.stringify(init.body), "application/json")));
    const response = yield* client.execute(request);
    const text = yield* response.text;
    return {status: response.status, body: Option.getOrNull(Option.liftThrowable((): unknown => JSON.parse(text))())};
  }).pipe(Effect.timeout("20 seconds"), Effect.option, Effect.provide(fetchClient));

const optionalText = Schema.optional(Schema.NullOr(Schema.String));
const NativeRunRow = Schema.Struct({id: Schema.String, status: Schema.String, requestedAt: optionalText, startedAt: optionalText, completedAt: optionalText,
  userMessageId: optionalText});
const Projection = Schema.Struct({projection: Schema.Struct({
  thread: Schema.Struct({modelSelection: Schema.optional(Schema.Unknown), settledAt: optionalText,
    lineage: Schema.optional(Schema.Struct({parentThreadId: optionalText, relationshipToParent: optionalText}))}),
  runs: Schema.optional(Schema.Array(NativeRunRow)),
  messages: Schema.Array(Schema.Struct({id: Schema.String, role: Schema.optional(Schema.String), senderThreadId: optionalText,
    createdBy: optionalText, creationSource: optionalText, createdAt: Schema.optional(Schema.String), runId: optionalText,
    text: Schema.optional(Schema.String)})),
  turnItems: Schema.optional(Schema.Array(Schema.Unknown)),
  subagents: Schema.optional(Schema.Array(Schema.Unknown)),
})});
type ProjectionView = typeof Projection.Type["projection"];
const Observed = Schema.Struct({actorThreadId: Schema.String, targetThreadId: Schema.String, at: Schema.Number});
const Snapshot = Schema.Struct({
  noProjectMode: Schema.optional(Schema.String),
  settings: Schema.optional(Schema.Struct({teamSettings: Schema.optional(Schema.Struct({maxHelpersPerRoot: Schema.Number}))})),
  binding: Schema.NullOr(Schema.Struct({threadId: Schema.String, generation: Schema.optional(Schema.Number), settlementState: optionalText,
    settlementBlockedBy: optionalText})),
  chatSupervision: Schema.optional(Schema.NullOr(Schema.Struct({stopped: Schema.Boolean, policyGeneration: Schema.Number,
    stoppedBy: optionalText, stoppedAt: Schema.optional(Schema.NullOr(Schema.Number)), activation: optionalText}))),
  tasks: Schema.Array(Schema.Struct({id: Schema.optional(Schema.String), threadId: Schema.String, status: Schema.String,
    updatedAt: Schema.optional(Schema.Number),
    supervision: Schema.optional(Schema.Literals(["needed", "not_needed"])), workflowProposalId: Schema.optional(Schema.String),
    agreement: Schema.optional(Schema.NullOr(Schema.Struct({status: Schema.String, proposalId: Schema.optional(Schema.String),
      agentMessageId: Schema.optional(Schema.String)})))})),
  monitoringStatus: Schema.optional(Schema.Struct({state: Schema.String, pendingItems: Schema.Number,
    awareness: Schema.optional(Schema.Struct({reads: Schema.Array(Observed), assessments: Schema.Array(Observed)}))})),
  team: Schema.optional(Schema.NullOr(Schema.Struct({members: Schema.Array(Schema.Struct({threadId: Schema.String, readiness: Schema.String,
    lifecycle: Schema.String, assignments: Schema.Array(Schema.Struct({threadId: Schema.String, state: Schema.String}))}))}))),
});
type SnapshotView = typeof Snapshot.Type;
// the workflow progress a workload trial reads (src/workflow-progress.ts, WorkflowProgressSnapshotSchema)
const Progress = Schema.Struct({
  workflows: Schema.Array(Schema.Struct({
    history: Schema.optional(Schema.Array(Schema.Struct({operationId: Schema.optional(Schema.String), recordedAt: Schema.Number}))),
    participants: Schema.optional(Schema.Array(Schema.Struct({threadId: Schema.NullOr(Schema.String),
      currentReceipt: Schema.NullOr(Schema.Struct({actorSupervisorThreadId: Schema.String, recordedAt: Schema.Number}))}))),
  })),
  scope: Schema.NullOr(Schema.Struct({threads: Schema.Array(Schema.Struct({threadId: Schema.String, origin: Schema.String}))})),
});
// T3's turn items a workload trial reads (packages/contracts/src/orchestrationV2.ts, OrchestrationV2TurnItem)
const itemTimes = {startedAt: optionalText, completedAt: optionalText};
const CompactionItem = Schema.Struct({id: Schema.String, type: Schema.Literal("compaction"), runId: optionalText, status: Schema.String, ...itemTimes});
const ToolItem = Schema.Struct({id: Schema.String, type: Schema.Literal("dynamic_tool"), runId: optionalText, status: Schema.String,
  toolName: optionalText, input: Schema.optional(Schema.Unknown), output: Schema.optional(Schema.Unknown), ...itemTimes});
const StartedItem = Schema.Struct({startedAt: optionalText});
// a subagent turn item or a subagent record of the parent (src/supervisor-observation.ts, directParentChildLifecycle)
const ChildRecord = Schema.Struct({childThreadId: optionalText});
const SubagentItem = Schema.Struct({type: Schema.Literal("subagent"), childThreadId: optionalText});
/* A turn item of a thread's own work (packages/contracts/src/orchestrationV2.ts): a command it ran, a reply it wrote, a file it
 * changed or a tool it called. A user message, a checkpoint or a subagent record is no work of the thread's own.
 */
const ExecutionItem = Schema.Struct({id: Schema.String, type: Schema.Literals(["command_execution", "assistant_message", "file_change", "dynamic_tool"]),
  threadId: optionalText, status: Schema.optional(Schema.String), ...itemTimes});

/**
 * A thread's own timed work as its own projection shows it: the items of its own work that carry a native start, kept apart from
 * T3's runs. A provider-native child can have such items while T3 records no run of it.
 */
export const ownExecutions = (threadId: string, turnItems: ReadonlyArray<unknown>): ReadonlyArray<NativeExecution> => turnItems.flatMap((item) =>
  Option.toArray(Option.flatMap(Schema.decodeUnknownOption(ExecutionItem)(item), (work) => (work.threadId ?? threadId) === threadId && work.startedAt
    && nativeTime(work.startedAt) !== null ? Option.some({itemId: work.id, type: work.type, status: work.status ?? null, startedAt: work.startedAt,
      completedAt: work.completedAt ?? null}) : Option.none())));
/**
 * A child's lifecycle as its direct parent's projection records it, through Supervisor's own reconciliation of the parent's subagent
 * record and subagent turn item (directParentChildLifecycle: one status, the turn item preferred); null when the parent records none
 * or conflicting statuses. The reconciliation reads only those two lists of the parent's projection, so only they are passed.
 */
export const parentChildLifecycle = (parent: {readonly subagents?: ReadonlyArray<unknown> | undefined; readonly turnItems?: ReadonlyArray<unknown> | undefined},
  childThreadId: string): ChildLifecycle | null => {
  const records = (values: ReadonlyArray<unknown> | undefined) => (values ?? []).filter(isRecord);
  const record = directParentChildLifecycle({subagents: records(parent.subagents), turnItems: records(parent.turnItems)} as unknown as Projection, childThreadId);
  return record === null ? null : {status: record.status, source: record.source, recordId: record.recordId, parentRunId: record.parentRunId,
    startedAt: record.startedAt, completedAt: record.completedAt};
};
// what an MCP tool call returned: its structured content, or its one text content holding JSON (toolResult)
const ToolEnvelope = Schema.Struct({isError: Schema.optional(Schema.Boolean), structuredContent: Schema.optional(Schema.Unknown),
  content: Schema.optional(Schema.Array(Schema.Unknown))});
const TextContent = Schema.Struct({type: Schema.Literal("text"), text: Schema.String});
// T3's full record of one turn item (orchestration.getTurnItem; packages/contracts/src/orchestrationV2.ts, OrchestrationV2GetTurnItemResult)
const TurnItemDetail = Schema.Struct({item: Schema.NullOr(Schema.Struct({id: Schema.String, type: Schema.String, threadId: optionalText,
  toolName: optionalText, status: Schema.String, output: Schema.optional(Schema.Unknown)}))});
// a successful workflow_write receipt (src/workflow-write-controller.ts, isSuccessfulResult)
const SuccessfulReceipt = Schema.Struct({status: Schema.Literals(["applied", "created", "exists", "recorded"])});
const Control = Schema.Struct({generation: Schema.Number, enabled: Schema.Boolean, globallyEnabled: Schema.Boolean, effectiveEnabled: Schema.Boolean});
const NoProjectControl = Schema.Struct({mode: Schema.String, globallyEnabled: Schema.Boolean});
const StartStatus = Schema.Struct({status: Schema.String});
const Scratch = Schema.Struct({projectId: Schema.String});
const Dispatched = Schema.Struct({sequence: Schema.Number});
const Csrf = Schema.Struct({csrf: Schema.String});
const Saved = Schema.Struct({status: Schema.String});
const ReportedRuntime = Schema.Struct({version: Schema.String, revision: Schema.NullOr(Schema.String)});
// T3's model selection (packages/contracts modelSelection): decoding keeps only these fields and drops any other
const ShownSelection = Schema.Struct({instanceId: Schema.String, model: Schema.String,
  options: Schema.optional(Schema.Array(Schema.Struct({id: Schema.String, value: Schema.Union([Schema.String, Schema.Boolean])})))});
/** A model selection as T3 showed it, reduced to its instance, model and settings, or null when it has not that shape. */
export const selectionShown = (value: unknown): ActorSelection | null => Option.getOrNull(Schema.decodeUnknownOption(ShownSelection)(value));
const ProviderStatus = Schema.Struct({providers: Schema.Array(Schema.Struct({instanceId: Schema.String, driver: Schema.String,
  version: Schema.optional(Schema.NullOr(Schema.String))}))});
const Launched = Schema.Struct({threadId: Schema.String});
const Manifest = Schema.Struct({manifest: Schema.Struct({currentModels: Schema.Struct({codex: Schema.Array(Schema.Unknown)})})});

const minutesSince = (start: number, now: number): number => Math.round((now - start) / 600) / 100;
// a dashboard or T3 read: its decoded value, or why it gave none (no answer, the HTTP status, or an answer of an unexpected shape)
type ReadResult<A> = {readonly ok: true; readonly value: A} | {readonly ok: false; readonly problem: string};
const readResult = <A>(reply: Option.Option<{readonly status: number; readonly body: unknown}>, decode: (body: unknown) => Option.Option<A>): ReadResult<A> => {
  if (Option.isNone(reply)) return {ok: false, problem: "no answer"};
  if (reply.value.status !== 200) return {ok: false, problem: `HTTP ${reply.value.status}`};
  const decoded = decode(reply.value.body);
  return Option.isSome(decoded) ? {ok: true, value: decoded.value} : {ok: false, problem: "an answer of an unexpected shape"};
};
// a message's text as a short digest, so a repeated text shows without its body
const hashText = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);
// a tool input or output that a provider may record as JSON text
const jsonValue = (value: unknown): unknown => typeof value === "string"
  ? Option.getOrElse(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(value), () => value) : value;

// the JSON of the one text block among content blocks; none, or more than one, is no single result
const oneText = (blocks: ReadonlyArray<unknown>): unknown => {
  const texts = blocks.flatMap((block) => Option.toArray(Schema.decodeUnknownOption(TextContent)(block)));
  return texts.length === 1 ? jsonValue(texts[0]!.text) : null;
};
/*
  The one result a workflow tool call returned, from its output as T3 records it, itself or as JSON text: the MCP result envelope
  (its structured content, or its one text block of JSON); the content blocks alone, as T3's full record of a Codex dynamic_tool
  call holds them ([{type: "text", text: "<JSON>"}]), which must be exactly one text block; or the result itself. An error envelope,
  and blocks that are not exactly one text block, give none: the output is an error, or ambiguous.
*/
const toolResult = (output: unknown): unknown => {
  const value = jsonValue(output);
  if (Array.isArray(value)) return value.length === 1 ? oneText(value) : null;
  return Option.match(Schema.decodeUnknownOption(ToolEnvelope)(value), {onNone: () => value, onSome: (result) => result.isError === true ? null
    : result.structuredContent !== undefined ? result.structuredContent : result.content !== undefined ? oneText(result.content) : value});
};

/** The successful receipt a workflow tool call returned, as its status and a digest of its canonical form, or null. */
export const successfulReceipt = (output: unknown): {readonly status: string; readonly hash: string} | null => {
  const body = toolResult(output);
  return Option.getOrNull(Option.map(Schema.decodeUnknownOption(SuccessfulReceipt)(body), (receipt) => ({status: receipt.status, hash: hashText(canonicalJson(body))})));
};

/** Why T3's full record of a workflow_write call gave no receipt. */
export type FullRecordProblem = "unexpected-shape" | "no-record" | "another-item" | "not-completed" | "output-omitted" | "no-successful-receipt";

/**
 * The receipt in T3's full record of one workflow_write call, read when the thread projection omitted the call's output: the record
 * must be that call (its item, thread and tool) and completed, and only its successful receipt's status and digest are kept, never the
 * output itself. A reply that shows no receipt says why, so the trial reports it instead of a pass.
 */
export const detailReceipt = (reply: unknown, call: {readonly itemId: string; readonly threadId: string; readonly toolName: string | null}):
  {readonly receipt: {readonly status: string; readonly hash: string} | null; readonly problem: FullRecordProblem | null} => {
  const decoded = Schema.decodeUnknownOption(TurnItemDetail)(reply);
  if (Option.isNone(decoded)) return {receipt: null, problem: "unexpected-shape"};
  const item = decoded.value.item;
  if (item === null) return {receipt: null, problem: "no-record"};
  if (item.id !== call.itemId || item.type !== "dynamic_tool" || (item.threadId ?? call.threadId) !== call.threadId || (item.toolName ?? null) !== call.toolName)
    return {receipt: null, problem: "another-item"};
  if (item.status !== "completed") return {receipt: null, problem: "not-completed"};
  if (item.output === undefined) return {receipt: null, problem: "output-omitted"};
  const receipt = successfulReceipt(item.output);
  return receipt === null ? {receipt: null, problem: "no-successful-receipt"} : {receipt, problem: null};
};

const lines = (...text: ReadonlyArray<string>): string => `${text.join("\n")}\n`;
const plainProject: ReadonlyArray<readonly [string, string]> = [
  ["README.md", "# Trial project\n\nA small project for trying out changes.\n"],
  [".t3-supervisor/project.yaml", "workflows: []\nsteps: []\n"],
];
/*
  The shared workload's project: a small library with its tests and real definitions (docs/steps-and-workflows.md), whose required
  workflow implements, tests and has a separate reviewer assess each change. The definitions are the project's own configuration,
  as a supervised project has; the request says nothing of them or of Supervisor.
*/
const libraryProject: ReadonlyArray<readonly [string, string]> = [
  ["README.md", lines("# Durations", "", "A small library that reads and writes durations such as `90s`, `15m` and `2h`.", "",
    "- `parseDuration(text)` returns the duration in milliseconds and throws on text it does not understand.",
    "- `formatDuration(milliseconds)` writes a duration in its largest whole unit.", "", "Run the tests with `npm test`.")],
  ["package.json", lines("{", "  \"name\": \"durations\",", "  \"version\": \"0.1.0\",", "  \"private\": true,", "  \"type\": \"module\",",
    "  \"scripts\": {\"test\": \"node --test\"}", "}")],
  ["src/duration.js", lines("const units = {s: 1000, m: 60_000, h: 3_600_000};", "",
    "/** The duration a text such as \"90s\", \"15m\" or \"2h\" names, in milliseconds. */",
    "export function parseDuration(text) {",
    "  const match = /^(\\d+)([smh])$/.exec(String(text).trim());",
    "  if (!match) throw new Error(`not a duration: ${text}`);",
    "  return Number(match[1]) * units[match[2]];",
    "}", "",
    "/** A duration in milliseconds written in its largest whole unit, such as \"2h\" or \"90s\". */",
    "export function formatDuration(milliseconds) {",
    "  if (!Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds % units.s !== 0) throw new Error(`not a whole number of seconds: ${milliseconds}`);",
    "  for (const unit of [\"h\", \"m\"]) if (milliseconds > 0 && milliseconds % units[unit] === 0) return `${milliseconds / units[unit]}${unit}`;",
    "  return `${milliseconds / units.s}s`;",
    "}")],
  ["test/duration.test.js", lines("import assert from \"node:assert/strict\";", "import { test } from \"node:test\";",
    "import { formatDuration, parseDuration } from \"../src/duration.js\";", "",
    "test(\"reads a duration in one unit\", () => {", "  assert.equal(parseDuration(\"90s\"), 90_000);", "  assert.equal(parseDuration(\"15m\"), 900_000);",
    "  assert.equal(parseDuration(\"2h\"), 7_200_000);", "});", "",
    "test(\"refuses text it does not understand\", () => {", "  assert.throws(() => parseDuration(\"soon\"));", "  assert.throws(() => parseDuration(\"5x\"));", "});", "",
    "test(\"writes a duration in its largest whole unit\", () => {", "  assert.equal(formatDuration(7_200_000), \"2h\");",
    "  assert.equal(formatDuration(900_000), \"15m\");", "  assert.equal(formatDuration(90_000), \"90s\");", "});")],
  [".t3-supervisor/project.yaml", lines("workflows:", "  - path: workflows/change.yaml", "    summary: Use for any change to the library's code, tests or documentation.",
    "    required: true", "steps:", "  - path: steps/implement.md", "    summary: Make the requested change with tests that cover it.",
    "  - path: steps/test.md", "    summary: Run the whole test suite on the final change.",
    "  - path: steps/independent-review.md", "    summary: A separate reviewer assesses the frozen change before it is reported done.")],
  [".t3-supervisor/workflows/change.yaml", lines("name: Change", "description: |",
    "  A change to the library: implement it with tests, run the whole suite, then have a",
    "  separate reviewer assess the frozen change before it is reported done.", "sequence:", "  - step: implement", "  - step: test",
    "  - step: independent-review")],
  [".t3-supervisor/steps/implement.md", lines("---", "id: implement", "name: Implement", "description: |",
    "  Make the requested change in src/ with tests in test/ that cover the new and the changed",
    "  behaviour. Keep existing behaviour unless the request changes it, and update the README",
    "  where users see the change.", "references:", "  - README.md", "---")],
  [".t3-supervisor/steps/test.md", lines("---", "id: test", "name: Test", "description: |",
    "  Run the whole suite with npm test on the final change and report the result.", "---")],
  [".t3-supervisor/steps/independent-review.md", lines("---", "id: independent-review", "name: Independent review", "description: |",
    "  A separate reviewer conversation, not the author, assesses the frozen change against the",
    "  request and the README and reports its findings and a verdict. The author accounts for",
    "  every finding before reporting the work done.", "---")],
];
/** The files a trial's disposable project starts with: the configured library for the shared workload, a plain project otherwise. */
export const projectFiles = (workload: TrialWorkload): ReadonlyArray<readonly [string, string]> => workload === "library" ? libraryProject : plainProject;

/** The actors one look reads, at most `limit`, and those it skips, which the look reports unread so no pass rests on them. */
export const readBound = (ids: ReadonlyArray<string>, limit: number): {readonly read: ReadonlyArray<string>; readonly skipped: ReadonlyArray<string>} =>
  ({read: ids.slice(0, limit), skipped: ids.slice(limit)});

/** Why a No Project trial's cleanup leaves a thread it found. */
export type LeftThread = {readonly threadId: string; readonly reason: "launch-reply-identity-unconfirmed" | "lineage-unknown" | "lineage-outside"};

/**
 * The threads a No Project trial deletes in T3's shared scratch project: its own chat under the identity it chose, and the threads
 * proven its own apart from that, the verified descendants and the Supervisor roots and helpers Supervisor's own state named for
 * that chat. An identity T3's launch reply named instead of the trial's own is unconfirmed and left, as is a descendant whose lineage
 * is unknown or outside the scope: a chat that may be someone else's is never deleted. When the launch's outcome was unknown and T3
 * has no chat under the trial's identity, nothing was made and nothing is deleted.
 */
export const scratchDeletions = (input: {readonly operative: string; readonly launchUncertain: boolean; readonly reservedExists: boolean | null;
  readonly unconfirmedChats: ReadonlyArray<string>; readonly owned: ReadonlyArray<string>;
  readonly children: ReadonlyArray<{readonly threadId: string; readonly lineageVerified: boolean; readonly lineageKnown: boolean}>}):
  {readonly deletes: ReadonlyArray<string>; readonly left: ReadonlyArray<LeftThread>} => {
  const nothingMade = input.launchUncertain && input.reservedExists === false;
  const deletes = nothingMade ? [] : [...new Set([input.operative, ...input.children.filter((child) => child.lineageVerified).map((child) => child.threadId),
    ...input.owned])];
  const left: ReadonlyArray<LeftThread> = [
    ...[...new Set(input.unconfirmedChats)].filter((threadId) => !deletes.includes(threadId))
      .map((threadId) => ({threadId, reason: "launch-reply-identity-unconfirmed" as const})),
    ...(nothingMade ? [] : input.children.filter((child) => !child.lineageVerified)
      .map((child) => ({threadId: child.threadId, reason: child.lineageKnown ? "lineage-outside" as const : "lineage-unknown" as const}))),
  ];
  return {deletes, left};
};

/** One trial in the running environment, owning its project or chat, its read session and its sign-in for the caller's scope. */
export const runTrial = (plan: TrialPlan, budgetMs: number, chosenModel: string | undefined, keep: boolean) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* devPaths();
  const ports = yield* devPorts();
  const env = t3Environment(process.env, paths);
  const cli: T3Cli = {executable: yield* ensureRuntime(paths.t3Runtime), baseDir: paths.t3Home, env, cwd: paths.workspaces};
  const t3Url = `http://127.0.0.1:${ports.t3}`;
  const origin = `http://127.0.0.1:${ports.ui}`;
  const scenarios = new Set(plan.scenarios);
  const scenario = plan.scenarios.join(",");
  const label = plan.scenarios.length === 1 ? plan.scenarios[0]! : "workload";
  /* A workload trial reads the whole supervised scope at every look: a workload scenario's oracle judges it, and a No Project trial
   * deletes the threads it found. The stop scenario only runs in the library project; its verdict reads the chat and Supervisor's state.
   */
  const workloadTrial = plan.scenarios.some((name) => isWorkloadScenario(name)) || plan.workload === "no-project";
  const scratchTrial = plan.workload === "no-project";
  const followUpMs = plan.followUpMs;
  const manifest = yield* fs.readFileString(join(paths.t3Home, "userdata", "model-manifest.json")).pipe(Effect.option);
  const model = chosenModel ?? Option.getOrElse(Option.flatMap(Option.flatMap(manifest, (text) => Schema.decodeUnknownOption(Schema.fromJsonString(Manifest))(text)),
    (value) => Option.fromNullishOr(value.manifest.currentModels.codex.find((item): item is string => typeof item === "string"))), () => "unknown");
  const version = yield* runProcess("codex", ["--version"], {env, cwd: paths.home, timeoutMs: 30_000});
  /* What T3 actually selected is filled in once the threads exist: each one's model selection from its own projection and the
   * runtime T3 reports for the selected provider instances. The CLI found in the environment is reported apart, as unverified.
   */
  const selected: {actors: Record<string, {role: ActorRole; selections: Array<ActorSelection>}>; runtimes: ReadonlyArray<{readonly instanceId: string;
    readonly driver: string; readonly version: string | null}> | null} = {actors: {}, runtimes: null};
  // an actor, and the model selection its own projection shows when given: never one taken from another actor or from the CLI
  const noteActor = (threadId: string, role: ActorRole, shown?: unknown) => {
    const actor: {role: ActorRole; selections: Array<ActorSelection>} = selected.actors[threadId] ?? {role, selections: []};
    // a thread first read as a possible descendant may turn out to be Supervisor's own
    if (actor.role === "child" && role !== "child") actor.role = role;
    selected.actors[threadId] = actor;
    const selection = selectionShown(shown);
    if (selection !== null && !actor.selections.some((known) => JSON.stringify(known) === JSON.stringify(selection))) actor.selections.push(selection);
  };
  const hasSelection = (threadId: string): boolean => (selected.actors[threadId]?.selections.length ?? 0) > 0;
  const supervisorRuntime: {version: string | null; revision: string | null} = {version: null, revision: null};
  // Supervisor's workflow MCP as the Codex CLI registered it, filled in by the check before anything is created
  const workflowUrl = `${origin}/mcp/workflows`;
  const workflowMcp: {auth: string | null; endpoint: string | null} = {auth: null, endpoint: null};
  const inputs = {supervisor: yield* checkoutInputs, supervisorRuntime,
    supervisorProvenance: "supervisor names this script's checkout; supervisorRuntime is the running service's health metadata, "
      + "whose null revision means it reports no commit; the checkout revision alone does not identify the running service",
    t3: t3Release.version, prompts: {interpretationRulesVersion, helperInstructionsVersion},
    workflowMcp: {alias: workflowMcpAlias, url: workflowUrl, registration: workflowMcp,
      provenance: "the Codex CLI's own registrations (codex mcp list --json), read without reporting any header value, and one "
        + "tools/list call to the registered endpoint with the registered Authorization header"},
    provider: {driver: "codex", requestedModel: model, selectedByT3: selected,
      selectedByT3Provenance: "each actor's model selections from its own T3 projection, reduced to instance, model and settings: the operative, "
        + "every Supervisor root the binding named, and the helpers and descendants a workload trial read, an empty list while T3 showed none; "
        + "never inferred from another actor or the CLI; runtimes from one read of T3's provider status (server.getConfig) for every instance "
        + "those selections name, a null version being one T3 did not report",
      cliFoundInEnvironment: version.code === 0 ? version.stdout.trim() : null,
      cliFoundInEnvironmentProvenance: "unverified: a Codex CLI found in the environment, which need not be the runtime T3 runs"},
    request: {text: plan.request, workload: plan.workload, launch: "automated, not typed by a person: one orchestration.launchThread call over T3's "
      + "WebSocket RPC, made by this script with a launch-only orchestration:operate session (runtimeMode full-access, interactionMode "
      + `default, ${scratchTrial ? "T3's scratch project from projects.ensureScratch, as its web app opens one for a chat without a project," : "the project folder"} `
      + "as its workspace); T3 records such a call as the user's request from the web",
      ...(followUpMs === null ? {} : {followUp: {text: followUpRequest, send: "automated, once, after Supervisor parked and stayed parked through a hold: one "
        + "orchestration.dispatchCommand message.dispatch call over T3's WebSocket RPC with createdBy user, creationSource web and dispatchMode "
        + "queue_after_active, made with an orchestration:operate session of its own; T3 records it as the user's from the web"}})},
    budgetMinutes: budgetMs / 60_000, ...(followUpMs === null ? {} : {followUpMinutes: followUpMs / 60_000, parkingHoldSeconds: quietTailMs / 1000}),
    sampling: "a look every 10 seconds; a milestone's after and seenBy bound when it happened: the last readable look before it and "
      + "the look that first showed it, in minutes after the launch"};
  const unavailable = (reason: string) => ({scenario, outcome: "unavailable" as TrialOutcome, reason, inputs});

  // the environment and the provider first: a trial that cannot start reports so and leaves nothing behind
  const descriptor = yield* jsonRequest(`${t3Url}/.well-known/t3/environment`);
  const served = Option.flatMap(descriptor, (reply) => reply.status === 200 ? Option.some(reply.body) : Option.none());
  if (Option.isNone(served)) return unavailable("T3 is not serving; start the environment with ./dev up");
  const published = yield* decodeDescriptor(JSON.stringify(served.value)).pipe(Effect.option);
  if (Option.isNone(published) || published.value.serverVersion !== t3Release.version || published.value.orchestrationProtocolVersion !== orchestrationProtocol)
    return unavailable(`T3 does not serve the pinned ${t3Release.version} on protocol ${orchestrationProtocol}`);
  const health = yield* jsonRequest(`http://127.0.0.1:${ports.health}/health`);
  if (!Option.exists(health, (reply) => reply.status === 200)) return unavailable("Supervisor is not ready; see ./dev logs");
  const reported = Option.flatMap(health, (reply) => Schema.decodeUnknownOption(ReportedRuntime)(reply.body));
  if (Option.isNone(reported)) return unavailable("Supervisor's health response did not identify its running version");
  supervisorRuntime.version = reported.value.version;
  supervisorRuntime.revision = reported.value.revision;
  const login = yield* runProcess("codex", ["login", "status"], {env, cwd: paths.home, timeoutMs: 30_000});
  if (login.code !== 0) return unavailable("the Codex CLI is not signed in; sign in with ./dev login codex");
  if (model === "unknown") return unavailable("T3's model manifest names no Codex model; pass --model");
  /* Supervisor's root calls its workflow tools through the Codex CLI's registration of Supervisor's workflow MCP (docs/local-stack.md).
   * Without it the root can never submit an interpretation, and a trial would end inconclusive for a reason outside the product.
   */
  const listed = yield* runProcess("codex", ["mcp", "list", "--json"], {env, cwd: paths.home, timeoutMs: 30_000});
  const registration = listed.code === 0 ? workflowMcpRegistration(listed.stdout, workflowUrl) : {registered: false as const, found: "registrations that could not be listed"};
  if (!registration.registered) return unavailable(`the Codex CLI has no usable registration of Supervisor's workflow MCP (${registration.found}): `
    + `register ${workflowMcpAlias} at ${workflowUrl} with Supervisor's workflow MCP bearer, as docs/local-stack.md describes`);
  /* The registered endpoint with the registered auth, as the root will call it: it must list the root's workflow tools. A bearer
   * from an environment variable unset here is unset where T3 runs too; ./dev reset creates a new token, which a stale header lacks.
   */
  const header = registration.authorization(env);
  if (header === null) return unavailable(`the bearer of the Codex CLI's ${workflowMcpAlias} registration comes from an environment `
    + "variable that is not set in the environment T3 runs in");
  const answered = yield* jsonRequest(workflowUrl, {method: "POST", headers: {Authorization: Redacted.value(header), Accept: "application/json, text/event-stream"},
    body: {jsonrpc: "2.0", id: 1, method: "tools/list", params: {}}});
  const tools = Option.getOrElse(Option.map(Option.flatMap(answered, (reply) => reply.status === 200 ? Schema.decodeUnknownOption(ToolList)(reply.body) : Option.none()),
    (list) => list.result.tools.map((tool) => tool.name)), (): ReadonlyArray<string> => []);
  const missing = requiredWorkflowTools.filter((name) => !tools.includes(name));
  if (missing.length > 0) return unavailable(`Supervisor's workflow MCP at ${workflowUrl} did not list ${missing.join(" and ")} for the Codex CLI's `
    + `registered bearer (${Option.match(answered, {onNone: () => "no answer", onSome: (reply) => `HTTP ${reply.status}`})}); register the current token again`);
  workflowMcp.auth = registration.auth;
  workflowMcp.endpoint = `listed ${tools.length} tools, ${requiredWorkflowTools.join(" and ")} among them`;

  // the trial's own read session and dashboard sign-in, both ended with the trial
  const secrets = yield* fs.makeTempDirectoryScoped({prefix: "t3sup-trial-"});
  yield* fs.chmod(secrets, 0o700);
  /* The read session lasts the whole trial: an hour beyond the budget, and idle parking's hold and follow-up budget, for the setup
   * before it and the cleanup after it, and T3 must grant at least half an hour of that, or reads would fail and leave stale evidence
   * late in the budget.
   */
  const windowMs = budgetMs + (followUpMs === null ? 0 : quietTailMs + followUpMs);
  const read = yield* issueSession(cli, {name: "trial-read", variable: "T3_TOKEN_FILE", scopes: ["orchestration:read"]},
    {file: join(secrets, "t3-read-token"), ttl: `${Math.ceil(windowMs / 60_000) + 60}m`, label: "t3-supervisor-trial-read", subject: "t3-supervisor-trial:read"});
  yield* Effect.addFinalizer(() => Effect.ignore(t3Command(cli, ["auth", "session", "revoke", read.sessionId])));
  if (!(Date.parse(read.expiresAt) >= (yield* Clock.currentTimeMillis) + windowMs + 30 * 60_000))
    return unavailable(`T3 issued the trial's read session until ${read.expiresAt}, which does not cover the ${windowMs / 60_000}-minute trial`);
  const readToken = (yield* fs.readFileString(read.file)).trim();
  const bearer = {Authorization: `Bearer ${readToken}`, "x-t3-orchestration-protocol": String(orchestrationProtocol)};
  const forged = yield* forgeDashboardToken(paths.supervisorData).pipe(Effect.mapError(() => failure("Supervisor's sign-in state is unavailable")));
  const signedIn = yield* jsonRequest(`${origin}/auth/login`, {method: "POST", headers: {Origin: origin}, body: {token: Redacted.value(forged.token)}});
  const session = Option.flatMap(signedIn, (reply) => reply.status === 200 && typeof (reply.body as {session?: unknown} | null)?.session === "string"
    ? Option.some(String((reply.body as {session: string}).session)) : Option.none());
  if (Option.isNone(session)) return unavailable("the dashboard refused the trial's sign-in");
  const dashboard = {"x-supervisor-session": session.value};
  yield* Effect.addFinalizer(() => Effect.ignore(jsonRequest(`${origin}/auth/logout`, {method: "POST", headers: {Origin: origin, ...dashboard}, body: {}})));
  const csrf = Option.flatMap(yield* jsonRequest(`${origin}/api/csrf`, {headers: dashboard}),
    (reply) => reply.status === 200 ? Schema.decodeUnknownOption(Csrf)(reply.body) : Option.none());
  if (Option.isNone(csrf)) return unavailable("the dashboard gave the trial no CSRF token");
  const change = {Origin: origin, ...dashboard, "x-csrf-token": csrf.value.csrf};
  const stamp = new Date(yield* Clock.currentTimeMillis).toISOString().replaceAll(/[:.]/gu, "-");

  /* A few native commands on a short orchestration:operate session of the trial's own, revoked as soon as they end: the launch, idle
   * parking's follow-up and a No Project trial's deletions. Only the commands' own failures are answered by `use`.
   */
  const operate = <A, E>(name: string, use: (native: NativeRpcShape) => Effect.Effect<A, E>) => Effect.scoped(Effect.gen(function* () {
    const issued = yield* issueSession(cli, {name: `trial-${name}`, variable: "T3_TRIAL_OPERATE_TOKEN_FILE", scopes: ["orchestration:operate"]},
      {file: join(secrets, `t3-${name}-token`), ttl: "10m", label: `t3-supervisor-trial-${name}`, subject: `t3-supervisor-trial:${name}`});
    yield* Effect.addFinalizer(() => Effect.ignore(t3Command(cli, ["auth", "session", "revoke", issued.sessionId])));
    yield* Effect.addFinalizer(() => Effect.ignore(fs.remove(issued.file)));
    const token = (yield* fs.readFileString(issued.file)).trim();
    return yield* Effect.gen(function* () {
      const native = yield* NativeRpc;
      return yield* use(native);
    }).pipe(Effect.provide(NativeRpc.layer({baseUrl: t3Url, token}).pipe(Layer.provide(NativeEnvelope.layer))));
  }));

  // the project the request runs in: a disposable one of the trial's own, which detection supervises, or T3's scratch project
  let projectId = "";
  let path: string | null = null;
  if (scratchTrial) {
    // the scratch project T3 opens for a chat without a project, as its web app does (apps/web/src/hooks/useScratchProject.ts):
    // `projects.ensureScratch` with payload {} answers {projectId} (packages/contracts/src/rpc.ts, apps/server/src/ws.ts)
    const opened = yield* operate("scratch", (native) => native.call("projects.ensureScratch", {}).pipe(Effect.option));
    const scratch = Option.flatMap(opened, (value) => Schema.decodeUnknownOption(Scratch)(value));
    if (Option.isNone(scratch)) return unavailable("T3 did not open its scratch project for a chat without a project");
    projectId = scratch.value.projectId;
    const mode = Option.flatMap(yield* jsonRequest(`${origin}/api/guidance/no-project-control`, {headers: dashboard}),
      (reply) => reply.status === 200 ? Schema.decodeUnknownOption(NoProjectControl)(reply.body) : Option.none());
    const scope = Option.flatMap(yield* jsonRequest(`${origin}/api/guidance/project-supervisor?${new URLSearchParams({projectId})}`, {headers: dashboard}),
      (reply) => reply.status === 200 ? Schema.decodeUnknownOption(Snapshot)(reply.body) : Option.none());
    // Supervisor names its No Project mode only for a project it takes for No Project (src/project-supervisor.ts, snapshot)
    if (Option.isNone(scope) || scope.value.noProjectMode === undefined) return unavailable("Supervisor does not take T3's scratch project for No Project "
      + "here: its T3_MANAGED_SCRATCH_ROOT is not T3's scratch folder (docs/local-stack.md)");
    if (Option.isNone(mode) || !mode.value.globallyEnabled) return unavailable("global supervision is off in this environment");
    if (mode.value.mode !== "on_request") return unavailable(`No Project mode is ${mode.value.mode}; a dashboard Start applies On request, and the trial changes no setting`);
  } else {
    path = join(paths.workspaces, `trial-${label}-${stamp}`);
    const folder = path;
    yield* fs.makeDirectory(join(folder, ".t3-supervisor"), {recursive: true});
    for (const [file, contents] of projectFiles(plan.workload)) {
      yield* fs.makeDirectory(join(folder, file, ".."), {recursive: true});
      yield* fs.writeFileString(join(folder, file), contents);
    }
    const gitEnv = {...env, GIT_AUTHOR_NAME: "Provider trial", GIT_AUTHOR_EMAIL: "provider-trial@example.invalid",
      GIT_COMMITTER_NAME: "Provider trial", GIT_COMMITTER_EMAIL: "provider-trial@example.invalid"};
    for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["commit", "-q", "-m", "Trial project"]]) {
      const git = yield* runProcess("git", args, {env: gitEnv, cwd: folder, timeoutMs: 30_000});
      if (git.code !== 0) return yield* failure(`git ${args[0]} failed in the trial project: ${git.stderr.trim()}`);
    }
  }
  const control = () => Effect.map(jsonRequest(`${origin}/api/guidance/supervision-control?${new URLSearchParams({projectId})}`, {headers: dashboard}),
    (reply) => Option.flatMap(reply, (value) => value.status === 200 ? Schema.decodeUnknownOption(Control)(value.body) : Option.none()));
  const readSnapshot = (mainThreadId: string) => Effect.map(jsonRequest(`${origin}/api/guidance/project-supervisor?${new URLSearchParams({projectId, mainThreadId})}`,
    {headers: dashboard}), (reply) => readResult(reply, Schema.decodeUnknownOption(Snapshot)));
  const snapshotOf = (mainThreadId: string) => Effect.map(readSnapshot(mainThreadId), (read) => read.ok ? Option.some(read.value) : Option.none());
  const readThread = (threadId: string) => Effect.map(jsonRequest(`${t3Url}/api/orchestration/threads/${encodeURIComponent(threadId)}`, {headers: bearer}),
    (reply) => readResult(reply, Schema.decodeUnknownOption(Projection)));
  // whether T3 has a chat under this identity: true, false when it answers it has none, null when it cannot tell
  const threadExists = (threadId: string) => Effect.map(jsonRequest(`${t3Url}/api/orchestration/threads/${encodeURIComponent(threadId)}`, {headers: bearer}),
    (reply) => Option.match(reply, {onNone: () => null, onSome: (value) => value.status === 200 ? true : value.status === 404 ? false : null}));

  /* Everything a workload trial observed, accumulated over its readable looks: a message, run or record seen once stays recorded
   * however later reads page the threads, and the values Supervisor reports as current are those of the last readable look.
   */
  const ledger = {
    runs: new Map<string, Map<string, NativeRun>>(),
    // each descendant's own timed work, and its lifecycle as its direct parent recorded it, apart from its runs
    executions: new Map<string, Map<string, NativeExecution>>(),
    lifecycles: new Map<string, ChildLifecycle | null>(),
    traffic: new Map<string, TrafficMessage>(),
    operativeMessages: new Map<string, {readonly role: string | null; readonly createdAt: string | null; readonly senderThreadId: string | null}>(),
    supervisors: new Map<string, {readonly threadId: string; readonly generation: number; readonly firstSeenAt: number}>(),
    helpers: new Set<string>(), readyHelpers: new Set<string>(), assignedHelpers: new Set<string>(), mostHelpers: 0, helperLimit: null as number | null,
    children: new Map<string, {readonly threadId: string; readonly lineageVerified: boolean; readonly lineageKnown: boolean}>(),
    monitoring: new Map<string, WorkloadObservation["monitoring"][number]>(),
    monitor: null as WorkloadObservation["monitor"],
    settlements: new Map<string, {readonly threadId: string; readonly settledAt: string}>(),
    compactions: new Map<string, WorkloadObservation["compactions"][number]>(),
    rootLatestStart: new Map<string, string>(),
    instructionReads: new Map<string, {readonly threadId: string; readonly startedAt: string | null; readonly status: string}>(),
    writes: new Map<string, WriteCall>(),
    // the completed workflow_write calls whose output the projection omitted, read through getTurnItem: wanted, attempts, results
    detailWanted: new Map<string, {readonly itemId: string; readonly threadId: string; readonly toolName: string | null}>(),
    detailAttempts: new Map<string, number>(),
    detailReceipts: new Map<string, {readonly status: string; readonly hash: string}>(),
    detailProblems: new Map<string, string>(),
    history: new Map<string, {readonly operationId: string; readonly recordedAt: number}>(),
    task: null as WorkloadObservation["task"],
    agreement: null as {readonly proposalId: string; readonly agentMessageId: string} | null,
  };
  const ownedThreads = (): ReadonlySet<string> => new Set([...[...ledger.supervisors.values()].map((supervisor) => supervisor.threadId), ...ledger.helpers]);
  const remember = (threadId: string, view: ProjectionView) => {
    const runs = ledger.runs.get(threadId) ?? new Map<string, NativeRun>();
    for (const run of view.runs ?? []) runs.set(run.id, {id: run.id, status: run.status, requestedAt: run.requestedAt ?? null, startedAt: run.startedAt ?? null,
      completedAt: run.completedAt ?? null, userMessageId: run.userMessageId ?? null});
    ledger.runs.set(threadId, runs);
    const owned = ownedThreads();
    for (const message of view.messages) {
      const sender = message.senderThreadId ?? null;
      const kind = trafficKind(message.id, sender !== null && sender !== threadId && owned.has(sender), owned.has(threadId));
      if (kind !== null) ledger.traffic.set(`${threadId}\u0000${message.id}`, {id: message.id, threadId, kind, runId: message.runId ?? null,
        createdAt: message.createdAt ?? null, textHash: message.text === undefined ? null : hashText(message.text)});
    }
  };
  const rememberRoot = (threadId: string, view: ProjectionView) => {
    const starts = [...(view.runs ?? []).flatMap((run) => [run.requestedAt ?? null, run.startedAt ?? null]),
      ...(view.turnItems ?? []).map((item) => Option.getOrNull(Option.flatMap(Schema.decodeUnknownOption(StartedItem)(item), (value) => Option.fromNullishOr(value.startedAt))))];
    for (const start of starts) if (start !== null && (nativeTime(start) ?? -Infinity) > (nativeTime(ledger.rootLatestStart.get(threadId)) ?? -Infinity))
      ledger.rootLatestStart.set(threadId, start);
    for (const item of view.turnItems ?? []) {
      const compacted = Schema.decodeUnknownOption(CompactionItem)(item);
      if (Option.isSome(compacted)) ledger.compactions.set(compacted.value.id, {threadId, itemId: compacted.value.id, runId: compacted.value.runId ?? null,
        status: compacted.value.status, completedAt: compacted.value.completedAt ?? null});
      const tool = Schema.decodeUnknownOption(ToolItem)(item);
      if (Option.isNone(tool)) continue;
      // the root's own workflow calls, recognised on the native routes Supervisor itself accepts (src/workflow-write-evidence.ts)
      const call = {toolName: tool.value.toolName ?? null, input: jsonValue(tool.value.input)};
      const write = recognisedWorkflowCallArguments(call, "write");
      if (write !== null) {
        const operationId = typeof write.operationId === "string" ? write.operationId
          : isRecord(write.input) && typeof write.input.operationId === "string" ? write.input.operationId : null;
        const completed = tool.value.status === "completed";
        const shown = completed && tool.value.output !== undefined ? successfulReceipt(tool.value.output) : null;
        const fetched = ledger.detailReceipts.get(tool.value.id) ?? null;
        ledger.writes.set(tool.value.id, {threadId, itemId: tool.value.id, runId: tool.value.runId ?? null, startedAt: tool.value.startedAt ?? null,
          completedAt: tool.value.completedAt ?? null, operationId, receipt: shown ?? fetched,
          ...(shown !== null ? {receiptSource: "projection" as const} : fetched !== null ? {receiptSource: "detail" as const} : {})});
        // a completed call whose output the projection omitted is read in full once through getTurnItem (below, bounded per look)
        if (completed && tool.value.output === undefined && fetched === null && !ledger.detailProblems.has(tool.value.id))
          ledger.detailWanted.set(tool.value.id, {itemId: tool.value.id, threadId, toolName: tool.value.toolName ?? null});
      }
      const reread = recognisedWorkflowCallArguments(call, "read");
      if (reread !== null && reread.view === "instructions") ledger.instructionReads.set(tool.value.id,
        {threadId, startedAt: tool.value.startedAt ?? null, status: tool.value.status});
    }
  };
  const childrenOf = (view: ProjectionView): ReadonlyArray<string> => [
    ...(view.turnItems ?? []).flatMap((item) => Option.toArray(Option.flatMap(Schema.decodeUnknownOption(SubagentItem)(item), (value) => Option.fromNullishOr(value.childThreadId)))),
    ...(view.subagents ?? []).flatMap((item) => Option.toArray(Option.flatMap(Schema.decodeUnknownOption(ChildRecord)(item), (value) => Option.fromNullishOr(value.childThreadId)))),
  ];
  const rememberSnapshot = (value: SnapshotView, now: number, rootSettledAt: string | null) => {
    const binding = value.binding;
    if (binding !== null && !ledger.supervisors.has(`${binding.threadId}\u0000${binding.generation ?? 0}`))
      ledger.supervisors.set(`${binding.threadId}\u0000${binding.generation ?? 0}`, {threadId: binding.threadId, generation: binding.generation ?? 0, firstSeenAt: now});
    const task = value.tasks.find((item) => item.threadId === operativeId) ?? null;
    // the original request's task: Supervisor's decision on it as last seen while it was the chat's task
    if (task !== null && (ledger.task === null || ledger.task.id === (task.id ?? null))) ledger.task = {id: task.id ?? null, supervision: task.supervision ?? null};
    const agreement = task?.agreement ?? null;
    if (ledger.agreement === null && agreement?.status === "agreed" && agreement.proposalId !== undefined && agreement.agentMessageId !== undefined)
      ledger.agreement = {proposalId: agreement.proposalId, agentMessageId: agreement.agentMessageId};
    const status = value.monitoringStatus;
    ledger.monitor = status === undefined ? null : {state: status.state, pendingItems: status.pendingItems};
    for (const [kind, entries] of [["read", status?.awareness?.reads ?? []], ["assessment", status?.awareness?.assessments ?? []]] as const)
      for (const entry of entries) ledger.monitoring.set(`${kind}\u0000${entry.actorThreadId}\u0000${entry.targetThreadId}\u0000${entry.at}`,
        {actorThreadId: entry.actorThreadId, targetThreadId: entry.targetThreadId, at: entry.at, kind});
    const members = value.team?.members ?? [];
    ledger.helperLimit = value.settings?.teamSettings?.maxHelpersPerRoot ?? ledger.helperLimit;
    // the helpers the limit counts: ready and registering ones that are not retired, quarantined or failed (src/supervisor-conversation.ts, teamRules)
    ledger.mostHelpers = Math.max(ledger.mostHelpers, members.filter((member) => ["ready", "pending"].includes(member.readiness) &&
      !["retired", "quarantined", "failed"].includes(member.lifecycle)).length);
    for (const member of members) {
      ledger.helpers.add(member.threadId);
      if (member.readiness === "ready") ledger.readyHelpers.add(member.threadId);
      if (member.assignments.some((assignment) => assignment.state === "active")) ledger.assignedHelpers.add(member.threadId);
    }
    // a root settlement counts as Supervisor's only while Supervisor records its own settlement as settled (src/supervisor-lifecycle.ts)
    if (binding !== null && binding.settlementState === "settled" && rootSettledAt !== null)
      ledger.settlements.set(`${binding.threadId}\u0000${rootSettledAt}`, {threadId: binding.threadId, settledAt: rootSettledAt});
  };
  const rememberProgress = (value: typeof Progress.Type): ReadonlyArray<string> => {
    for (const workflow of value.workflows) {
      for (const event of workflow.history ?? []) if (event.operationId !== undefined)
        ledger.history.set(`${event.operationId}\u0000${event.recordedAt}`, {operationId: event.operationId, recordedAt: event.recordedAt});
      // a participant's current receipt is the root's or a helper's attributed read of it (src/workflow-progress.ts, participantCoverageStates)
      for (const participant of workflow.participants ?? []) if (participant.threadId !== null && participant.currentReceipt !== null)
        ledger.monitoring.set(`read\u0000${participant.currentReceipt.actorSupervisorThreadId}\u0000${participant.threadId}\u0000${participant.currentReceipt.recordedAt}`,
          {actorThreadId: participant.currentReceipt.actorSupervisorThreadId, targetThreadId: participant.threadId, at: participant.currentReceipt.recordedAt, kind: "read"});
    }
    return (value.scope?.threads ?? []).filter((thread) => thread.origin !== "main").map((thread) => thread.threadId);
  };

  /* The trial's own work ends with it, also on a failure or an interruption. A project trial turns supervision off for its own
   * project, so Supervisor starts nothing more there, then asks T3 to remove the project with its chats, the Supervisor root among
   * them; a No Project trial asks T3 to delete its own chat, the chat's descendants, its Supervisor root and the root's helpers, one
   * `thread.delete` each (packages/contracts/src/orchestrationV2.ts; apps/server/src/orchestration-v2/ThreadDeletion.ts cancels each
   * one's open runs and requests). T3's acknowledgement is what is reported, not a physically observed end of their model work.
   * `--keep` keeps them, with supervision off or the chat stopped, where a turn still running finishes on its own. Nothing else is
   * touched: no other project, chat, chat Stop or setting. It runs whole once, so an interruption neither repeats it nor misreports it.
   */
  let operativeId: string | null = null;
  let launchUncertain = false;
  // an identity T3's launch reply named instead of the trial's own: unconfirmed, so reported and never deleted
  const unconfirmedChats: string[] = [];
  // a project trial's project: never asked for, asked for (T3 may have added it without reporting it), or added under projectId
  let projectAdd: "none" | "attempted" | "added" = "none";
  let cleanedUp: {readonly supervisionOff: boolean; readonly project: string} | null = null;
  const stopChat = (threadId: string) => Effect.gen(function* () {
    const policy = Option.getOrNull(Option.flatMap(yield* snapshotOf(threadId), (value) => Option.fromNullishOr(value.chatSupervision)));
    if (policy === null) return false;
    if (policy.stopped) return true;
    return Option.exists(Option.flatMap(yield* jsonRequest(`${origin}/api/guidance/project-supervisor/chat-supervision`, {method: "POST", headers: change,
      body: {projectId, mainThreadId: threadId, enabled: false, policyGeneration: policy.policyGeneration}}),
    (reply) => reply.status === 200 ? Schema.decodeUnknownOption(Saved)(reply.body) : Option.none()), (saved) => saved.status === "saved");
  });
  const cleanup = Effect.uninterruptible(Effect.gen(function* () {
    if (cleanedUp !== null) return cleanedUp;
    if (scratchTrial) {
      const operative = operativeId;
      if (operative === null) {
        cleanedUp = {supervisionOff: true, project: "nothing created"};
        return cleanedUp;
      }
      // a launch whose outcome is unknown was made under the trial's own chat identity: a chat T3 does not have was never made
      const reservedExists = launchUncertain ? yield* threadExists(operative) : null;
      if (reservedExists === false) {
        const left = scratchDeletions({operative, launchUncertain, reservedExists, unconfirmedChats, owned: [], children: []}).left;
        cleanedUp = {supervisionOff: true, project: left.length === 0 ? "nothing created: T3 has no chat under the launch's identity"
          : `deletion failed: nothing created under the trial's identity; ${left.map((entry) => `${entry.threadId} (${entry.reason}, not deleted)`).join(", ")}`};
        return cleanedUp;
      }
      if (keep) {
        cleanedUp = {supervisionOff: yield* stopChat(operative), project: "kept"};
        return cleanedUp;
      }
      // a Supervisor root or helper made after the last look is read once more from Supervisor's own state, so the deletion covers it too
      const late = Option.getOrNull(yield* snapshotOf(operative));
      const lateThreads = late === null ? [] : [...(late.binding === null ? [] : [late.binding.threadId]), ...(late.team?.members ?? []).map((member) => member.threadId)];
      // the trial's own chats only (scratchDeletions): an unconfirmed identity, or a descendant not verified as the operative's, is left and named
      const plan = scratchDeletions({operative, launchUncertain, reservedExists, unconfirmedChats, children: [...ledger.children.values()],
        owned: [...ledger.helpers, ...[...ledger.supervisors.values()].map((supervisor) => supervisor.threadId), ...lateThreads]});
      const unverified = plan.left.map((entry) => `${entry.threadId} (${entry.reason}, not deleted)`);
      const refused = yield* operate("cleanup", (native) => Effect.forEach(plan.deletes, (threadId) => native.call("orchestration.dispatchCommand",
        {type: "thread.delete", commandId: `provider-trial:${label}:${stamp}:delete:${threadId}`, threadId}).pipe(
        Effect.match({onFailure: (error): ReadonlyArray<string> => [`${threadId} (${error.outcome})`],
          onSuccess: (reply): ReadonlyArray<string> => Option.isSome(Schema.decodeUnknownOption(Dispatched)(reply)) ? [] : [`${threadId} (unconfirmed)`]})))).pipe(
        Effect.map((answers) => answers.flat()), Effect.catch(() => Effect.succeed(["every chat: T3 issued no operate session for the deletion"])));
      const failures = [...refused, ...unverified];
      cleanedUp = {supervisionOff: !refused.some((entry) => entry.startsWith(operative) || entry.startsWith("every chat")),
        project: failures.length === 0 ? "deletion acknowledged" : `deletion failed: ${failures.join(", ")}`};
      return cleanedUp;
    }
    // nothing to undo before the trial asked T3 for its project; one T3 added without reporting it is removed by its folder below
    if (projectAdd === "none") {
      cleanedUp = {supervisionOff: true, project: "nothing added to T3"};
      return cleanedUp;
    }
    const saved = (generation: number) => Effect.map(jsonRequest(`${origin}/api/guidance/supervision-control`, {method: "POST",
      headers: change, body: {projectId, expectedGeneration: generation, enabled: false}}),
    (reply) => Option.exists(Option.flatMap(reply, (value) => value.status === 200 ? Schema.decodeUnknownOption(Saved)(value.body) : Option.none()),
      (result) => result.status === "saved"));
    // supervision is turned off for a project T3 reported; a project it never reported has no supervision control the trial can name
    const supervisionOff = projectAdd !== "added" ? true : yield* Effect.flatMap(control(), (current) => Option.isNone(current) ? Effect.succeed(false)
      : current.value.enabled ? saved(current.value.generation) : Effect.succeed(true));
    const project = keep ? "kept" : yield* t3Command(cli, ["project", "remove", "--force", path ?? ""], 120_000).pipe(
      Effect.as("removal acknowledged"), Effect.catch((error) => Effect.succeed(`removal failed: ${error.message}`)));
    cleanedUp = {supervisionOff, project};
    return cleanedUp;
  }));
  // a trial that ends without its report, by a failure or an interruption, still says what its cleanup did
  yield* Effect.addFinalizer(() => cleanedUp !== null ? Effect.void
    : Effect.ignore(Effect.flatMap(cleanup, (done) => Console.error(`trial cleanup: ${JSON.stringify({projectIdentity: {id: projectId, path}, ...done})}`))));

  // the trial's project is added to T3 only now, with its cleanup in place: a project T3 added without reporting it is still removed
  if (!scratchTrial) {
    projectAdd = "attempted";
    const added = yield* t3Command(cli, ["project", "add", "--title", `Provider trial ${label}`, path ?? ""]).pipe(Effect.option);
    const addedId = Option.flatMap(added, (output) => Option.fromNullishOr(/Added project (\S+)/u.exec(output)?.[1]));
    if (Option.isNone(addedId)) return {scenario, outcome: "unavailable" as TrialOutcome, reason: "T3 did not report adding the trial project",
      project: {id: projectId, path}, cleanup: yield* cleanup, inputs};
    projectId = addedId.value;
    projectAdd = "added";
  }

  if (!scratchTrial) {
    // the project must be supervised before the request, or the request would precede its activation boundary
    const supervisedBy = (yield* Clock.currentTimeMillis) + 120_000;
    let supervised = yield* control();
    while (!Option.exists(supervised, (value) => value.effectiveEnabled) && (yield* Clock.currentTimeMillis) < supervisedBy) {
      yield* Effect.sleep("2 seconds");
      supervised = yield* control();
    }
    if (Option.exists(supervised, (value) => !value.globallyEnabled)) return {...unavailable("global supervision is off in this environment"), cleanup: yield* cleanup};
    if (!Option.exists(supervised, (value) => value.effectiveEnabled))
      return {scenario, outcome: "fail" as TrialOutcome, reason: "detection never supervised the trial project", project: {id: projectId, path}, cleanup: yield* cleanup, inputs};
  }

  /* The operative chat starts as a person starts one in T3's web app. T3 records a launch over its WebSocket RPC as the user's from
   * the web unless the caller names another source (createdBy user, creationSource web); it is the launch Supervisor makes for its
   * own root, without a source. `t3 thread start` would launch over T3's MCP server, which records the chat and its request as an
   * agent's (createdBy agent, creationSource mcp), and Supervisor does not take that for a person's request (src/task-requester.ts).
   * The session that may operate exists only for this launch and is revoked right after it.
   */
  /* The chat's identity is the trial's own, as a web client names a new chat (launchThread's optional threadId), so a launch whose
   * outcome is unknown can still be found, and its chat deleted, by that identity.
   */
  const reservedOperative = randomUUID();
  operativeId = reservedOperative;
  launchUncertain = true;
  const launched = yield* operate("launch", (native) => native.call("orchestration.launchThread", {commandId: `provider-trial:${label}:${stamp}`,
    threadId: reservedOperative, projectId,
    title: `Provider trial ${label}`, generateTitle: false, modelSelection: {instanceId: "codex", model}, runtimeMode: "full-access", interactionMode: "default",
    workspaceStrategy: {type: "root"}, initialMessage: {text: plan.request, attachments: []}}).pipe(
    Effect.match({onFailure: (error) => ({reply: null as unknown, outcome: `T3 answered ${error.outcome}`}),
      onSuccess: (reply) => ({reply, outcome: "T3's answer had an unexpected shape"})})));
  const launchedId = Option.flatMap(Option.fromNullishOr(launched.reply), (value) => Schema.decodeUnknownOption(Launched)(value));
  /* An unconfirmed launch may still have made the chat: a project trial's cleanup removes the project with whatever chat it holds, and
   * a No Project trial's deletes the chat under the trial's identity, or reports that T3 never made it.
   */
  if (Option.isNone(launchedId) || launchedId.value.threadId !== reservedOperative) {
    if (Option.isSome(launchedId)) unconfirmedChats.push(launchedId.value.threadId);
    return {scenario, outcome: "unavailable" as TrialOutcome, reason: `T3 did not confirm the operative chat's launch under the trial's identity (${
      Option.isSome(launchedId) ? `it named ${launchedId.value.threadId}` : launched.outcome})`, project: {id: projectId, path}, cleanup: yield* cleanup, inputs};
  }
  launchUncertain = false;
  const operative = reservedOperative;
  noteActor(operative, "operative");
  const begin = yield* Clock.currentTimeMillis;
  // how T3 recorded the request, from the chat's earliest user message once a read shows it
  let recorded: {readonly createdBy: string | null; readonly creationSource: string | null; readonly senderThreadId: string | null} | null = null;
  let requestRunId: string | null = null;
  let requestMessageId: string | null = null;

  /* The whole budget is observed, so a late or repeated contact still shows; a milestone keeps the bounds of when it happened, the
   * last readable look before it and the look that first showed it.
   */
  const milestones: Record<string, {readonly after: number; readonly seenBy: number}> = {};
  let previousLook = begin;
  const mark = (name: string, now: number) => {if (!(name in milestones)) milestones[name] = {after: minutesSince(begin, previousLook), seenBy: minutesSince(begin, now)};};
  // the Supervisor messages of the last readable look, with the times T3 created them
  let supervisorMessages: ReadonlyArray<{readonly id: string; readonly createdAt: string | null}> = [];
  let last: TrialObservation = {supervisorMessageIds: [], task: null};
  // the proposals Supervisor recorded for the request's task, the first task the chat showed, at the readable looks
  let requestTaskId: string | null | undefined = undefined;
  const proposalIds = new Set<string>();
  let supervisorThreadId: string | null = null;
  // the chat's Stop, pressed once by a stop scenario, and why Supervisor last kept itself from settling
  /* The Stop's one press: the fresh reads before it (begun at readAt, done at observedAt), its sending and answer, the reads at once
   * after it (done at afterObservedAt), the run it was pressed in and Supervisor's task before and after it.
   */
  let stop: {readonly answer: string; readonly readAt: number; readonly observedAt: number; readonly sentAt: number; readonly answeredAt: number;
    readonly afterObservedAt: number; readonly runId: string | null; readonly taskBefore: TaskReading | null; readonly taskAfter: TaskReading | null;
    readonly policyGeneration: number; readonly runs: ReadonlyArray<string> | null} | null = null;
  // T3's latest record of the run pressed in, and Supervisor's record of the chat's stop, each only from reads after the press's answer
  const afterPress: {run: {readonly startedAt: string | null; readonly completedAt: string | null; readonly status: string} | null;
    recorded: {readonly stoppedBy: string | null; readonly stoppedAt: number | null} | null} = {run: null, recorded: null};
  // the Start's press: the fresh read before it, its sending and its answer
  let startPress: {readonly observedAt: number; readonly sentAt: number; readonly answeredAt: number} | null = null;
  // the request's task in one read of Supervisor's state
  const taskReading = (state: SnapshotView): TaskReading | null => {
    const found = state.tasks.find((item) => item.threadId === operative);
    return found === undefined ? null : {id: found.id ?? null, status: found.status, updatedAt: found.updatedAt ?? null};
  };
  // a read after the press's answer: T3's record of the run pressed in, and Supervisor's record of the chat's stop by the dashboard
  const readAfterPress = (press: {readonly runId: string | null; readonly policyGeneration: number}, state: SnapshotView | null,
    runs: ReadonlyArray<typeof NativeRunRow.Type> | null) => {
    const pressedRun = press.runId === null ? undefined : (runs ?? []).find((run) => run.id === press.runId);
    if (pressedRun !== undefined) afterPress.run = {startedAt: pressedRun.startedAt ?? null, completedAt: pressedRun.completedAt ?? null, status: pressedRun.status};
    const policy = state?.chatSupervision ?? null;
    if (policy !== null && policy.stopped && policy.stoppedBy === "ui" && policy.policyGeneration > press.policyGeneration)
      afterPress.recorded = {stoppedBy: policy.stoppedBy, stoppedAt: policy.stoppedAt ?? null};
  };
  let settlementBlockedBy: string | null = null;
  // the dashboard Start of a No Project chat: pressed once while the request's run is open, or never once that run has ended
  const startOperation = `provider-trial:${label}:${stamp}:start`;
  let start: {readonly answer: string; readonly status: string | null} | null = null;
  let startMissed = false;
  // idle parking: Supervisor's settlement as first seen, the hold after it and the follow-up the trial then sends once
  let parking: ParkingFacts | null = null;
  const unreadable: string[] = [];
  let unreadAtEnd: ReadonlyArray<string> = [];
  // the last look starts once the observation window has ended, so a readable last look covers the whole window
  let observeUntil = begin + budgetMs;
  let lastReadable: number | null = null;
  let ended = false;
  // the first look right after the launch, so a short run is not missed, then one every 10 seconds
  let firstLook = true;
  while (!ended) {
    if (!firstLook) yield* Effect.sleep("10 seconds");
    firstLook = false;
    const now = yield* Clock.currentTimeMillis;
    ended = now >= observeUntil;
    const snapshotRead = yield* readSnapshot(operative);
    const projectionRead = yield* readThread(operative);
    if (!snapshotRead.ok || !projectionRead.ok) {
      unreadable.push(`${minutesSince(begin, now)} min (${[snapshotRead.ok ? null : `Supervisor's state: ${snapshotRead.problem}`,
        projectionRead.ok ? null : `the chat: ${projectionRead.problem}`].filter((entry) => entry !== null).join("; ")})`);
      continue;
    }
    const snapshot = {value: snapshotRead.value};
    const view = projectionRead.value.projection;
    const opening = view.messages.find((message) => message.role === "user");
    if (recorded === null && opening !== undefined) {
      recorded = {createdBy: opening.createdBy ?? null, creationSource: opening.creationSource ?? null, senderThreadId: opening.senderThreadId ?? null};
      requestMessageId = opening.id;
      requestRunId = opening.runId ?? null;
      // Supervisor takes a request for a person's only when T3 recorded it as the user's from the web or mobile app, from no other chat
      if (recorded.createdBy !== "user" || !["web", "mobile"].includes(recorded.creationSource ?? "") || recorded.senderThreadId !== null)
        return {scenario, outcome: "unavailable" as TrialOutcome, reason: `T3 recorded the request as ${recorded.createdBy ?? "unknown"} from `
          + `${recorded.creationSource ?? "unknown"}, not as a person's`, requestRecordedAs: recorded, project: {id: projectId, path},
          operativeThreadId: operative, cleanup: yield* cleanup, inputs};
    }
    // T3 may show the request before it ties the request to its run: the run's identity is read again until it shows
    if (requestRunId === null && requestMessageId !== null) {
      const requestMessage = requestMessageId;
      requestRunId = view.messages.find((message) => message.id === requestMessage)?.runId ?? null;
    }
    supervisorThreadId = snapshot.value.binding?.threadId ?? supervisorThreadId;
    noteActor(operative, "operative", view.thread.modelSelection);
    // the Supervisor root: at every look of a workload trial, otherwise until it shows its model selection
    let rootView: ProjectionView | null = null;
    if (supervisorThreadId !== null) noteActor(supervisorThreadId, "root");
    if (supervisorThreadId !== null && (workloadTrial || !hasSelection(supervisorThreadId))) {
      const root = yield* readThread(supervisorThreadId);
      if (root.ok) {
        rootView = root.value.projection;
        noteActor(supervisorThreadId, "root", rootView.thread.modelSelection);
      } else if (workloadTrial) {
        unreadable.push(`${minutesSince(begin, now)} min (the Supervisor root: ${root.problem})`);
        continue;
      }
    }
    const task = snapshot.value.tasks.find((item) => item.threadId === operative) ?? null;
    if (task !== null && requestTaskId === undefined) requestTaskId = task.id ?? null;
    if (task !== null && (task.id ?? null) === requestTaskId && task.workflowProposalId !== undefined) proposalIds.add(task.workflowProposalId);
    // a workload trial also reads Supervisor's helpers, the operative's delegated children and Supervisor's workflow progress
    const unread: string[] = [];
    if (workloadTrial) {
      rememberSnapshot(snapshot.value, now, rootView?.thread.settledAt ?? null);
      if (supervisorThreadId !== null && rootView !== null) {remember(supervisorThreadId, rootView); rememberRoot(supervisorThreadId, rootView);}
      remember(operative, view);
      for (const message of view.messages) ledger.operativeMessages.set(message.id, {role: message.role ?? null, createdAt: message.createdAt ?? null,
        senderThreadId: message.senderThreadId ?? null});
      let scoped: ReadonlyArray<string> = [];
      if (supervisorThreadId !== null) {
        const progress = readResult(yield* jsonRequest(`${origin}/api/guidance/workflow-progress?${new URLSearchParams({projectId, mainThreadId: operative})}`,
          {headers: dashboard}), Schema.decodeUnknownOption(Progress));
        if (progress.ok) scoped = rememberProgress(progress.value);
        else unread.push(`Supervisor's workflow progress (${progress.problem})`);
      }
      // at most 10 helpers and 20 descendants a look; those beyond the bound are reported unread, an evidence gap, never silently dropped
      const helperReads = readBound([...ledger.helpers], 10);
      for (const skipped of helperReads.skipped) unread.push(`helper ${skipped} (beyond the 10 helpers read per look)`);
      for (const helper of helperReads.read) {
        const helperView = yield* readThread(helper);
        noteActor(helper, "helper", helperView.ok ? helperView.value.projection.thread.modelSelection : undefined);
        if (helperView.ok) remember(helper, helperView.value.projection);
        else unread.push(`helper ${helper} (${helperView.problem})`);
      }
      // a child counts once its own projection shows it as a subagent of the operative or of a child already verified
      for (const candidate of [...childrenOf(view), ...scoped]) if (!ledger.children.has(candidate))
        ledger.children.set(candidate, {threadId: candidate, lineageVerified: false, lineageKnown: false});
      /* A workflow_write call whose output the thread projection omitted is read in full through the pinned, read-scoped
       * `orchestration.getTurnItem` (packages/contracts/src/orchestrationV2.ts; Supervisor reads its evidence the same way), at most
       * four per look on one connection, each with ten seconds and three attempts, and only the receipt's status and digest are kept.
       */
      if (scenarios.has("workflow-write") && ledger.detailWanted.size > 0) {
        const batch = [...ledger.detailWanted.values()].filter((call) => (ledger.detailAttempts.get(call.itemId) ?? 0) < 3).slice(0, 4);
        const answers = yield* Effect.gen(function* () {
          const native = yield* NativeRpc;
          return yield* Effect.forEach(batch, (call) => native.call("orchestration.getTurnItem", {threadId: call.threadId, itemId: call.itemId}).pipe(
            Effect.timeout("10 seconds"), Effect.option, Effect.map((reply) => ({call, reply}))));
        }).pipe(Effect.provide(NativeRpc.layer({baseUrl: t3Url, token: readToken}).pipe(Layer.provide(NativeEnvelope.layer))),
          Effect.catch(() => Effect.succeed(batch.map((call) => ({call, reply: Option.none<unknown>()})))));
        for (const {call, reply} of answers) {
          const attempts = (ledger.detailAttempts.get(call.itemId) ?? 0) + 1;
          ledger.detailAttempts.set(call.itemId, attempts);
          if (Option.isNone(reply)) {
            if (attempts >= 3) {ledger.detailWanted.delete(call.itemId); ledger.detailProblems.set(call.itemId, "no-answer");}
            continue;
          }
          const read = detailReceipt(reply.value, call);
          ledger.detailWanted.delete(call.itemId);
          if (read.receipt === null) {ledger.detailProblems.set(call.itemId, read.problem ?? "no-successful-receipt"); continue;}
          ledger.detailReceipts.set(call.itemId, read.receipt);
          const write = ledger.writes.get(call.itemId);
          if (write !== undefined && write.receipt === null) ledger.writes.set(call.itemId, {...write, receipt: read.receipt, receiptSource: "detail"});
        }
      }
      const childReads = readBound([...ledger.children.keys()], 20);
      for (const skipped of childReads.skipped) unread.push(`child ${skipped} (beyond the 20 descendants read per look)`);
      // the projections of this look, by thread, and each child's direct parent, for the parent's own record of the child's lifecycle
      const looked = new Map<string, ProjectionView>([[operative, view]]);
      const parentOf = new Map<string, string>();
      for (const child of childReads.read) {
        const childView = yield* readThread(child);
        noteActor(child, "child", childView.ok ? childView.value.projection.thread.modelSelection : undefined);
        if (!childView.ok) {unread.push(`child ${child} (${childView.problem})`); continue;}
        looked.set(child, childView.value.projection);
        const lineage = childView.value.projection.thread.lineage;
        const parent = lineage?.parentThreadId ?? null;
        if (parent !== null) parentOf.set(child, parent);
        const subagent = lineage?.relationshipToParent === "subagent";
        const parentRecord = parent === null ? undefined : ledger.children.get(parent);
        const verified = subagent && parent !== null && (parent === operative || parentRecord?.lineageVerified === true);
        /* Outside is decided only from what the child's own projection shows: no subagent, no parent, Supervisor's own thread as its
         * parent, or a parent already decided outside. A parent the trial has not decided, or not found, keeps the child unknown.
         */
        const outside = !verified && (!subagent || parent === null || ownedThreads().has(parent) ||
          (parentRecord !== undefined && parentRecord.lineageKnown && !parentRecord.lineageVerified));
        const previous = ledger.children.get(child);
        ledger.children.set(child, {threadId: child, lineageVerified: verified || previous?.lineageVerified === true,
          lineageKnown: verified || outside || previous?.lineageKnown === true});
        remember(child, childView.value.projection);
        const work = ledger.executions.get(child) ?? new Map<string, NativeExecution>();
        for (const item of ownExecutions(child, childView.value.projection.turnItems ?? [])) work.set(item.itemId, item);
        ledger.executions.set(child, work);
        for (const grandchild of childrenOf(childView.value.projection)) if (!ledger.children.has(grandchild))
          ledger.children.set(grandchild, {threadId: grandchild, lineageVerified: false, lineageKnown: false});
      }
      // each child's lifecycle as its direct parent's projection of this look records it, or none; an unread parent keeps the last
      for (const [child, parent] of parentOf) {
        const parentView = looked.get(parent);
        if (parentView !== undefined) ledger.lifecycles.set(child, parentChildLifecycle(parentView, child));
      }
    }
    const sent = view.messages.filter((message) => message.id.startsWith("supervisor-") ||
      (supervisorThreadId !== null && message.senderThreadId === supervisorThreadId));
    const policy = snapshot.value.chatSupervision;
    // this look's reads came after an earlier look's press
    if (stop !== null) readAfterPress(stop, snapshot.value, view.runs ?? null);
    /* The person's Stop, pressed once while the trial watches: in stop once the proposal reached the operative and its run is running,
     * so the Stop falls during model work; in no-project-stop once the Start is active and Supervisor's interpretation of the started
     * request is in flight. A look only nominates the moment. The press rests on fresh reads taken just before its one POST
     * (stopPressReady): Supervisor's state, then in stop the chat, whose running run is the fact closest to the press. The reads, the
     * sending and the answer are timed, and Supervisor's state, with the chat in stop, is read again at once after the answer. Whether
     * the Stop fell during model work or the interpretation is judged only from reads after the answer, against Supervisor's recorded
     * Stop time (runPhaseAtPress, interpretationPhaseAtPress), never from the look; otherwise it is unknown and the trial inconclusive.
     * It is never pressed again, whatever the answer: an unanswered press is judged by the policy the chat later shows under the
     * generation pressed, and a refused one is recorded as it was answered.
     */
    const startActive = start !== null && (start.status ?? start.answer) === "active";
    const stopScenario = scenarios.has("stop") ? "stop" as const : scenarios.has("no-project-stop") ? "no-project-stop" as const : null;
    const nominated = stopScenario !== null && stop === null && (stopScenario === "stop"
      ? (view.runs ?? []).some((run) => run.status === "running") && sent.some((message) => message.id.startsWith(workflowNotice))
      : startActive && task !== null && interpretingStatuses.has(task.status));
    if (stopScenario !== null && nominated) {
      const readAt = yield* Clock.currentTimeMillis;
      const freshState = yield* readSnapshot(operative);
      const freshChat = stopScenario === "stop" ? yield* readThread(operative) : null;
      const observedAt = yield* Clock.currentTimeMillis;
      const fresh = !freshState.ok ? null : freshChat === null ? {state: freshState.value, chat: null}
        : freshChat.ok ? {state: freshState.value, chat: freshChat.value.projection} : null;
      const taskBefore = fresh === null ? null : taskReading(fresh.state);
      const decision = fresh === null ? null : stopPressReady(stopScenario, {policy: fresh.state.chatSupervision ?? null, runs: fresh.chat?.runs ?? null,
        proposalReached: fresh.chat?.messages.some((message) => message.id.startsWith(workflowNotice)) ?? false, task: taskBefore});
      if (fresh !== null && decision !== null) {
        const sentAt = yield* Clock.currentTimeMillis;
        const answer = Option.flatMap(yield* jsonRequest(`${origin}/api/guidance/project-supervisor/chat-supervision`, {method: "POST",
          headers: change, body: {projectId, mainThreadId: operative, enabled: false, policyGeneration: decision.policyGeneration}}),
        (reply) => reply.status === 200 ? Schema.decodeUnknownOption(Saved)(reply.body) : Option.none());
        const answeredAt = yield* Clock.currentTimeMillis;
        const afterState = yield* readSnapshot(operative);
        const afterChat = stopScenario === "stop" ? yield* readThread(operative) : null;
        const afterObservedAt = yield* Clock.currentTimeMillis;
        stop = {answer: Option.match(answer, {onNone: () => "no answer", onSome: (value) => value.status}), readAt, observedAt, sentAt, answeredAt,
          afterObservedAt, runId: decision.runId, taskBefore, taskAfter: afterState.ok ? taskReading(afterState.value) : null,
          policyGeneration: decision.policyGeneration, runs: fresh.chat === null ? null : (fresh.chat.runs ?? []).map((run) => `${run.id}:${run.status}`)};
        readAfterPress(stop, afterState.ok ? afterState.value : null, afterChat !== null && afterChat.ok ? afterChat.value.projection.runs ?? null : null);
        mark("Stop pressed", sentAt);
      }
    }
    /* The dashboard Start of a No Project chat, pressed once as a person presses it, while the request's own run is open: a Start
     * pins the latest genuine request only while its native run is unfinished (src/supervision-control.ts, startSupervision).
     */
    if (scratchTrial && start === null && !startMissed && requestRunId !== null) {
      const requestRunIdNow = requestRunId;
      const nominatedRun = (view.runs ?? []).find((run) => run.id === requestRunIdNow);
      if (nominatedRun !== undefined && openRunStatuses.has(nominatedRun.status)) {
        // the look only nominates the press: the request's run is read again just before the one POST, which is timed
        const freshChat = yield* readThread(operative);
        const observedAt = yield* Clock.currentTimeMillis;
        const requestRun = freshChat.ok ? (freshChat.value.projection.runs ?? []).find((run) => run.id === requestRunIdNow) : undefined;
        if (requestRun !== undefined && openRunStatuses.has(requestRun.status)) {
          const sentAt = yield* Clock.currentTimeMillis;
          const answer = Option.flatMap(yield* jsonRequest(`${origin}/api/guidance/supervision-start`, {method: "POST", headers: change,
            body: {threadId: operative, operationId: startOperation}}), (reply) => reply.status === 200 ? Schema.decodeUnknownOption(StartStatus)(reply.body) : Option.none());
          start = {answer: Option.match(answer, {onNone: () => "no answer", onSome: (value) => value.status}), status: null};
          startPress = {observedAt, sentAt, answeredAt: yield* Clock.currentTimeMillis};
          mark("Start pressed", sentAt);
        } else if (requestRun !== undefined) startMissed = true;
      } else if (nominatedRun !== undefined) startMissed = true;
    }
    if (start !== null) {
      const status = Option.flatMap(yield* jsonRequest(`${origin}/api/guidance/supervision-start?${new URLSearchParams({threadId: operative, operationId: startOperation})}`,
        {headers: dashboard}), (reply) => reply.status === 200 ? Schema.decodeUnknownOption(StartStatus)(reply.body) : Option.none());
      if (Option.isSome(status)) start = {...start, status: status.value.status};
      if ((start.status ?? start.answer) === "active") mark("Start active", now);
    }
    /* Idle parking: Supervisor's own record of its root settled, with T3's settlement time, starts a hold of the monitor's age bound
     * and cooldown, after which any activity left pending would have become due; then the trial sends one follow-up and observes it
     * for its own budget.
     */
    if (followUpMs !== null) {
      const binding = snapshot.value.binding;
      const settledAt = rootView?.thread.settledAt ?? null;
      if (parking === null && binding !== null && binding.threadId === supervisorThreadId && binding.settlementState === "settled" && settledAt !== null) {
        parking = {threadId: binding.threadId, generation: binding.generation ?? 0, after: previousLook, seenAt: now, settledAt, followUp: null};
        observeUntil = Math.max(observeUntil, now + quietTailMs);
        mark("Supervisor parked", now);
      }
      if (parking !== null && parking.followUp === null && now >= parking.seenAt + quietTailMs) {
        const messageId = `provider-trial:${label}:${stamp}:follow-up`;
        /* `message.dispatch` (packages/contracts/src/orchestrationV2.ts) requires createdBy and creationSource; over the WebSocket RPC
         * `withCreationProvenance` stamps createdBy user and keeps creationSource web (apps/server/src/ws.ts), so T3 records the
         * follow-up as the user's from the web. The chat is idle once Supervisor parked; queue_after_active starts its turn, as
         * Supervisor itself dispatches to an idle chat (src/supervisor-conversation.ts, sendIntroduction).
         */
        const answer = yield* operate("follow-up", (native) => native.call("orchestration.dispatchCommand", {type: "message.dispatch", commandId: messageId,
          threadId: operative, messageId, text: followUpRequest, attachments: [], createdBy: "user", creationSource: "web",
          dispatchMode: {type: "queue_after_active"}}).pipe(Effect.match({onFailure: (error): string => error.outcome,
          onSuccess: (reply): string => Option.isSome(Schema.decodeUnknownOption(Dispatched)(reply)) ? "accepted" : "unconfirmed"})));
        parking = {...parking, followUp: {sentAt: now, messageId, answer, createdAt: null}};
        observeUntil = now + followUpMs;
        mark("follow-up sent", now);
      }
      const followUp: ParkingFacts["followUp"] = parking?.followUp ?? null;
      if (parking !== null && followUp !== null && followUp.createdAt === null) {
        const shown: ProjectionView["messages"][number] | undefined = view.messages.find((message) => message.id === followUp.messageId);
        if (shown !== undefined) {
          // the follow-up counts as a person's only when T3 recorded it as the initial request is recorded
          if (shown.createdBy !== "user" || !["web", "mobile"].includes(shown.creationSource ?? "") || (shown.senderThreadId ?? null) !== null)
            return {scenario, outcome: "unavailable" as TrialOutcome, reason: `T3 recorded the follow-up as ${shown.createdBy ?? "unknown"} from `
              + `${shown.creationSource ?? "unknown"}, not as a person's`, project: {id: projectId, path}, operativeThreadId: operative, cleanup: yield* cleanup, inputs};
          parking = {...parking, followUp: {...followUp, createdAt: shown.createdAt ?? null}};
          mark("follow-up recorded", now);
        }
      }
      ended = now >= observeUntil;
    }
    // what Supervisor sent the chat after T3 created its first Stop notice; without every creation time it cannot be told
    const notice = sent.find((message) => message.id.startsWith(stopNotice));
    const stopNoticeRecord = notice === undefined ? null
      : {createdAt: notice.createdAt ?? null, createdBy: notice.createdBy ?? null, creationSource: notice.creationSource ?? null};
    const createdAt = (message: {readonly createdAt?: string | undefined}) => message.createdAt === undefined ? Number.NaN : Date.parse(message.createdAt);
    const timed = sent.every((message) => !Number.isNaN(createdAt(message)));
    const afterStopNotice = notice === undefined ? [] : !timed ? null
      : sent.filter((message) => message !== notice && createdAt(message) > createdAt(notice)).map((message) => message.id);
    const settlement = snapshot.value.binding?.settlementState ?? null;
    settlementBlockedBy = snapshot.value.binding?.settlementBlockedBy ?? null;
    // idle parking judges the original request's contact: what reached the chat before the follow-up and the task as it was then
    const followedAt = nativeTime(parking?.followUp?.createdAt);
    const original = followedAt === null ? sent : sent.filter((message) => (nativeTime(message.createdAt) ?? Infinity) < followedAt);
    const decided = parking?.followUp && ledger.task !== null ? {id: ledger.task.id, status: task?.status ?? "unknown", supervision: ledger.task.supervision, agreed: false}
      : task === null ? null : {id: task.id ?? null, status: task.status, supervision: task.supervision ?? null, agreed: task.agreement?.status === "agreed"};
    last = {supervisorMessageIds: original.map((message) => message.id), task: decided,
      stop: stop === null ? null : {answer: stop.answer, ...(scenarios.has("stop") ? {runAtPress: runPhaseAtPress(afterPress.run, stopTime(stop, afterPress.recorded))} : {}),
        ...(scenarios.has("no-project-stop") ? {interpretationAtPress: interpretationPhaseAtPress(stop.taskBefore, stop.taskAfter, stopTime(stop, afterPress.recorded))} : {})},
      policyStopped: stop !== null && policy?.stopped === true && policy.stoppedBy === "ui" && policy.policyGeneration > stop.policyGeneration,
      stopNoticeRecord, afterStopNotice, settlement, ...(scratchTrial ? {start} : {}),
      proposalNotices: original.filter((message) => message.id.startsWith(workflowNotice))
        .map((message) => ({id: message.id, textHash: message.text === undefined ? null : hashText(message.text)})),
      proposalIds: [...proposalIds]};
    if (task?.supervision) mark(`decided ${task.supervision}`, now);
    if (sent.some((message) => message.id.startsWith(workflowNotice))) mark("proposal reached the operative", now);
    if (last.task?.agreed || ledger.agreement !== null) mark("agreed", now);
    if (sent.length > 0) mark("first contact", now);
    if (notice !== undefined) mark("Stop notice reached the operative", now);
    if (settlement === "settled") mark("Supervisor settled", now);
    if (workloadTrial && [...ledger.children.values()].some((child) => child.lineageVerified)) mark("a delegated child appeared", now);
    if (workloadTrial && [...ledger.compactions.values()].some((item) => item.status === "completed")) mark("the Supervisor root compacted", now);
    supervisorMessages = sent.map((message) => ({id: message.id, createdAt: message.createdAt ?? null}));
    unreadAtEnd = unread;
    previousLook = now;
    lastReadable = now;
  }
  // the runtime of each selected provider instance as T3 itself reports it, read once through the trial's read session
  const instances = new Set(Object.values(selected.actors).flatMap((actor) => actor.selections.map((selection) => selection.instanceId)));
  const status = yield* Effect.gen(function* () {
    const native = yield* NativeRpc;
    return yield* native.call("server.getConfig", {});
  }).pipe(Effect.provide(NativeRpc.layer({baseUrl: t3Url, token: readToken}).pipe(Layer.provide(NativeEnvelope.layer))), Effect.option);
  selected.runtimes = Option.getOrNull(Option.map(Option.flatMap(status, (value) => Schema.decodeUnknownOption(ProviderStatus)(value)),
    (value) => value.providers.filter((provider) => instances.has(provider.instanceId))
      .map((provider) => ({instanceId: provider.instanceId, driver: provider.driver, version: provider.version ?? null}))));
  const provenance = {actors: Object.entries(selected.actors).map(([threadId, actor]) => ({threadId, role: actor.role, selections: actor.selections})),
    runtimes: selected.runtimes};
  // the trial's own work ends before its verdict, so a cleanup that did not complete keeps the trial from a clean pass
  const cleaned = yield* cleanup;
  const gaps = evidenceGaps({budgetMs: observeUntil - begin, lastReadableMs: lastReadable === null ? null : lastReadable - begin, checkout: inputs.supervisor,
    requestRecorded: recorded !== null, ...provenance, cleanup: cleaned, unreadAtEnd});
  const workload: WorkloadObservation | null = !workloadTrial ? null : {
    operativeThreadId: operative,
    supervisors: [...ledger.supervisors.values()],
    helpers: {threadIds: [...ledger.helpers], ready: [...ledger.readyHelpers], assigned: [...ledger.assignedHelpers], mostAtOnce: ledger.mostHelpers,
      limit: ledger.helperLimit},
    task: ledger.task,
    traffic: [...ledger.traffic.values()],
    runs: Object.fromEntries([...ledger.runs].map(([threadId, runs]) => [threadId, [...runs.values()]])),
    executions: Object.fromEntries([...ledger.executions].map(([threadId, items]) => [threadId, [...items.values()]])),
    childLifecycles: Object.fromEntries(ledger.lifecycles),
    stopPresses: stop === null ? 0 : 1,
    agreement: ledger.agreement === null ? null : {...ledger.agreement, message: ledger.operativeMessages.get(ledger.agreement.agentMessageId) ?? null},
    children: [...ledger.children.values()],
    monitoring: [...ledger.monitoring.values()],
    monitor: ledger.monitor,
    settlements: [...ledger.settlements.values()],
    compactions: [...ledger.compactions.values()],
    rootLatestStart: Object.fromEntries(ledger.rootLatestStart),
    instructionReads: [...ledger.instructionReads.values()],
    writes: [...ledger.writes.values()],
    history: [...ledger.history.values()],
    parking,
    start: scratchTrial ? {pressed: start, runEndedFirst: startMissed} : null,
    endedAt: lastReadable,
  };
  const observation: TrialObservation = workload === null ? last : {...last, workload};
  const verdicts = scenarioVerdicts(plan.scenarios, observation, gaps, provenance);
  const outcome: TrialOutcome = combinedOutcome(verdicts);
  const reason = verdicts.length === 1 ? verdicts[0]!.reason : verdicts.map((verdict) => `${verdict.scenario} ${verdict.outcome}: ${verdict.reason}`).join("; ");
  // a workload trial's evidence: identities, kinds, statuses, counts and native times, never a message body or tool arguments
  const evidence = workload === null ? {} : {workload: {
    traffic: {...trafficTotals(workload.traffic), repeatedContent: repeatedContent(workload.traffic),
      unknownTexts: workload.traffic.filter((message) => message.textHash === null).length,
      messages: workload.traffic.map(({id, threadId, kind, runId, createdAt}) => ({id, threadId, kind, runId, createdAt}))},
    supervisors: workload.supervisors, helpers: workload.helpers, children: workload.children, task: workload.task, agreement: workload.agreement,
    monitor: workload.monitor, monitoring: workload.monitoring.length, settlements: workload.settlements, compactions: workload.compactions,
    instructionReads: workload.instructionReads, writes: workload.writes.map((write) => ({...write, receipt: write.receipt?.status ?? null})),
    fullRecordReads: {attempts: Object.fromEntries(ledger.detailAttempts), withoutReceipt: Object.fromEntries(ledger.detailProblems)},
    history: workload.history, parking: workload.parking, start: workload.start,
    runs: Object.fromEntries(Object.entries(workload.runs).map(([threadId, runs]) => [threadId, runs.length])),
    // each descendant's own timed work and its parent's record of its lifecycle, and the verified children whose lifecycle nothing bounds
    executions: Object.fromEntries(Object.entries(workload.executions).map(([threadId, items]) => [threadId, {items: items.length,
      types: [...new Set(items.map((item) => item.type))], firstStartedAt: items.reduce<string | null>((first, item) =>
        first === null || (nativeTime(item.startedAt) ?? Infinity) < (nativeTime(first) ?? Infinity) ? item.startedAt : first, null)}])),
    childLifecycles: workload.childLifecycles,
    childrenUnbounded: unboundedChildren(workload),
  }};
  const recordedStopAt = afterPress.recorded?.stoppedAt ?? null;
  const sinceLaunch = (reading: TaskReading | null) => reading === null ? null
    : {id: reading.id, status: reading.status, updatedAtMs: reading.updatedAt === null ? null : reading.updatedAt - begin};
  // the provenance gaps of the actors only some scenarios rest on, by scenario
  const scenarioGaps = Object.fromEntries(verdicts.flatMap((verdict) => "actorGaps" in verdict && verdict.actorGaps !== undefined
    ? [[verdict.scenario, verdict.actorGaps]] : []));
  return {scenario, outcome, reason, ...(verdicts.length > 1 ? {verdicts} : {}), evidenceGaps: gaps,
    ...(Object.keys(scenarioGaps).length > 0 ? {actorGaps: scenarioGaps} : {}), milestones, unreadable,
    project: {id: projectId, path, ...(scratchTrial ? {scratch: true} : {})}, operativeThreadId: operative, requestRecordedAs: recorded, supervisorThreadId,
    supervisorMessages, task: last.task, proposals: {notices: last.proposalNotices ?? [], recordedProposalIds: last.proposalIds ?? []},
    ...(scratchTrial ? {startPress: startPress === null ? null : {observedAtMs: startPress.observedAt - begin, sentAtMs: startPress.sentAt - begin,
      answeredAtMs: startPress.answeredAt - begin}} : {}),
    ...(scenarios.has("stop") || scenarios.has("no-project-stop") ? {stop: stop === null ? null : {answer: stop.answer, policyGeneration: stop.policyGeneration,
      readAtMs: stop.readAt - begin, observedAtMs: stop.observedAt - begin, sentAtMs: stop.sentAt - begin, answeredAtMs: stop.answeredAt - begin,
      afterObservedAtMs: stop.afterObservedAt - begin, recordedStopAtMs: recordedStopAt === null ? null : recordedStopAt - begin,
      runId: stop.runId, runs: stop.runs, pressedRun: afterPress.run, taskBefore: sinceLaunch(stop.taskBefore), taskAfter: sinceLaunch(stop.taskAfter),
      phases: last.stop ?? null}, policyStopped: last.policyStopped ?? false, stopNotice: last.stopNoticeRecord ?? null,
      afterStopNotice: last.afterStopNotice ?? null, settlement: last.settlement ?? null, settlementBlockedBy} : {}),
    ...evidence, cleanup: cleaned, inputs};
});

const usage = `usage: ./dev trial SCENARIO[,SCENARIO...] --budget-minutes N [--follow-up-minutes M] [--model MODEL] [--keep]; scenarios: ${Object.keys(trialScenarios).join(", ")}`;

const main = Effect.gen(function* () {
  const args = process.argv.slice(2);
  const value = (name: string) => {const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined;};
  const minutes = Number(value("--budget-minutes"));
  const followUp = value("--follow-up-minutes");
  const valued = ["--budget-minutes", "--follow-up-minutes", "--model"];
  const unknown = args.slice(1).filter((arg, index, all) => !valued.includes(arg) && arg !== "--keep" && !valued.includes(all[index - 1] ?? ""));
  const plan = planTrial((args[0] ?? "").split(",").filter((name) => name.length > 0), followUp === undefined ? null : Number(followUp));
  if ("refused" in plan) return yield* failure(`${plan.refused}\n${usage}`);
  const budget = budgetRefusal(minutes);
  if (budget !== null || unknown.length) return yield* failure(budget === null ? usage : `--budget-minutes: ${budget}\n${usage}`);
  const report = yield* Effect.scoped(runTrial(plan, minutes * 60_000, value("--model"), args.includes("--keep")));
  yield* Console.log(JSON.stringify(report));
  if (report.outcome !== "pass") return yield* failure(`the ${report.scenario} trial ended ${report.outcome}: ${report.reason}`);
});

if (import.meta.main) NodeRuntime.runMain(main.pipe(Effect.tapError((error) => Console.error(error.message)), Effect.provide(NodeFileSystem.layer)),
  {disableErrorReporting: true});
