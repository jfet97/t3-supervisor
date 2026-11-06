import { Schema } from "effect";
import { canonicalStoredJson } from "./canonical-json.js";

const text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const texts = (count: number, max: number) => Schema.Array(text(max)).check(Schema.isMaxLength(count));
export const RequesterSource = Schema.Struct({
  messageId: text(512), runId: text(512), ordinal: Schema.Int, hash: text(128),
  requester: Schema.Literals(["human", "launching_agent", "unattributed_agent"]),
});
export type RequesterSource = typeof RequesterSource.Type;
export const ConversationDraft = Schema.Struct({
  objective: Schema.NullOr(text(2000)), constraints: texts(10, 300), questions: texts(10, 300),
  findings: Schema.Array(Schema.Struct({text: text(600), messageIds: texts(8, 512)})).check(Schema.isMaxLength(12)),
  duties: texts(12, 600),
});
export type ConversationDraft = typeof ConversationDraft.Type;
export const ConversationAuthorization = Schema.Struct({
  scopeRevision: text(128), outcome: text(2000), limits: texts(10, 300),
  scopeSources: Schema.Array(RequesterSource).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  state: Schema.Literals(["authorized", "paused"]), stateSource: RequesterSource,
  attemptId: text(512),
});
export type ConversationAuthorization = typeof ConversationAuthorization.Type;
export const ConversationFacts = Schema.Struct({
  draft: ConversationDraft, authorization: Schema.NullOr(ConversationAuthorization),
  considered: Schema.NullOr(RequesterSource), observed: Schema.NullOr(RequesterSource), updatedAt: Schema.Number,
});
export type ConversationFacts = typeof ConversationFacts.Type;
/** A source-bound semantic decision. Source IDs are assertions; the service resolves and verifies every one. */
export const ConversationDecision = Schema.Struct({
  draft: ConversationDraft, intent: Schema.Literals(["following", "authorize", "pause", "resume"]),
  outcome: Schema.NullOr(text(2000)), limits: texts(10, 300),
  sourceMessageIds: texts(12, 512), antecedentMessageIds: texts(12, 512),
  scope: Schema.Literals(["same", "changed"]),
});
export type ConversationDecision = typeof ConversationDecision.Type;
export const ConversationEngagement = Schema.Struct({
  mode: Schema.Literals(["following", "engaged"]),
  availability: Schema.Literals(["current", "catching_up", "stale", "uncertain", "stopped", "unavailable"]),
  consideredAt: Schema.NullOr(Schema.Number),
});
export type ConversationEngagement = typeof ConversationEngagement.Type;

export const emptyConversation = (at: number): ConversationFacts => ({
  draft: {objective: null, constraints: [], questions: [], findings: [], duties: []},
  authorization: null, considered: null, observed: null, updatedAt: at,
});

export type ConversationTask = {sourceHash?: string; status: string; supervision?: "needed" | "not_needed"; conversation?: ConversationFacts | undefined};
export const taskScopeRevision = (task: ConversationTask): string => task.conversation?.authorization?.scopeRevision ?? task.sourceHash ?? "";
export const conversationEngaged = (task: ConversationTask): boolean => task.conversation?.authorization?.state === "authorized";

/** A task with the agreement it recorded and the plan it currently keeps, under its proposal identity */
export type AgreementTask = ConversationTask & {
  readonly id?: string | undefined;
  readonly agreement?: {readonly status: string; readonly proposalId?: string; readonly workflow?: unknown} | null | undefined;
  readonly agreementSourceHash?: string | null | undefined;
  readonly workflow?: unknown;
  readonly workflowProposalId?: string | undefined;
};

/**
 * The authorized scope revision a task's agreement accepted, null without an agreement. An acceptance records its scope, and every
 * path that changes the scope records it first, so an agreement stored without one was made under the current scope, as its
 * acceptance evidence is also pinned.
 */
export const agreementScopeRevision = (task: AgreementTask): string | null => task.agreement ? task.agreementSourceHash ?? taskScopeRevision(task) : null;

/** Whether the task's agreement is agreed for its current authorized scope; an acceptance of an earlier scope is history, never a current plan or duty */
export const agreementCurrent = (task: AgreementTask): boolean => task.agreement?.status === "agreed" && agreementScopeRevision(task) === taskScopeRevision(task);

// a workflow record's plan content as stored, apart from its human-facing message: what a JSON round trip drops is dropped and key order
// is ignored; the plan's own validation bounds its depth
const storedPlanContent = (workflow: unknown): string => canonicalStoredJson(typeof workflow === "object" && workflow !== null
  ? Object.fromEntries(Object.entries(workflow).filter(([key]) => key !== "message")) : workflow, Number.POSITIVE_INFINITY);

/**
 * Whether the task's plan is the plan an acceptance of an earlier scope accepted, kept as history: identity decides, so a plan kept under
 * that acceptance's own proposal identity is it. Content decides only for a current request that needs no plan, which names no proposal:
 * the same plan content proves the accepted plan was kept, also under an unpublished identity once named for it. A changed scope that
 * needs no plan keeps it as the base of later proposals; it is never a proposal or an obligation of the current scope. A proposal of its
 * own identity for a scope that needs a plan stays negotiable, whatever its content.
 */
export const earlierAcceptedSnapshot = (task: AgreementTask): boolean => task.agreement?.status === "agreed" && task.workflow != null && !agreementCurrent(task) &&
  ((task.workflowProposalId ?? task.id) === task.agreement.proposalId ||
    task.supervision === "not_needed" && storedPlanContent(task.workflow) === storedPlanContent(task.agreement.workflow));

/**
 * Whether the task's plan is a proposal of its current request: a request judged to need no plan proposes nothing, whether an earlier
 * acceptance is agreed, stale or absent, and an earlier scope's accepted plan the task keeps is history. The agreement itself stays
 * current or history by its own scope.
 */
export const proposalCurrent = (task: AgreementTask): boolean => task.workflow != null && task.supervision !== "not_needed" && !earlierAcceptedSnapshot(task);

/** Observation needs current requester context, never permission to act or a shared plan. */
export const conversationMayObserve = (task: ConversationTask): boolean => task.status === "inferred" && task.conversation?.authorization?.state !== "paused" &&
  Boolean(task.conversation?.considered && task.conversation.considered.ordinal === task.conversation.observed?.ordinal &&
    task.conversation.considered.messageId === task.conversation.observed.messageId && task.conversation.considered.hash === task.conversation.observed.hash);

export const conversationMayContact = (task: ConversationTask): boolean => conversationEngaged(task) && task.supervision !== "not_needed" && task.status === "inferred" &&
  Boolean(task.conversation?.considered && task.conversation.considered.ordinal === task.conversation.observed?.ordinal &&
    task.conversation.considered.messageId === task.conversation.observed.messageId && task.conversation.considered.hash === task.conversation.observed.hash);


/** One derivation for HTTP, Home and scheduling. A persisted mode latch cannot become stale independently of these facts. */
export const deriveConversationEngagement = (input: {
  task?: ConversationTask | undefined; enabled: boolean; available: boolean; bindingState?: string | null | undefined;
  monitoringState?: string | undefined; stale?: boolean | undefined;
}): ConversationEngagement => {
  const task = input.task, facts = task?.conversation;
  const mode = task && conversationEngaged(task) ? "engaged" : "following";
  const availability = !input.enabled ? "stopped" : !input.available || input.bindingState === "missing" || input.bindingState === "rejected" ? "unavailable"
    : input.bindingState === "uncertain" || input.monitoringState === "uncertain" || task?.status === "uncertain" ? "uncertain"
    : input.monitoringState === "unavailable" || task?.status === "unavailable" ? "unavailable"
    : input.stale || task?.status === "expired" ? "stale"
    : ["queued", "dispatching", "waiting"].includes(task?.status ?? "") ? "catching_up"
    : !facts?.considered || !facts.observed ? "unavailable"
    : facts.observed.ordinal !== facts.considered.ordinal || facts.observed.messageId !== facts.considered.messageId ||
      facts.observed.hash !== facts.considered.hash ? "catching_up" : "current";
  return {mode, availability, consideredAt: facts?.considered ? facts.updatedAt : null};
};
