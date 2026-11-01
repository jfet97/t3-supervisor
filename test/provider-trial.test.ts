import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import {Effect, Redacted} from "effect";
import {actorGaps, budgetRefusal, classifyTrial, combinedOutcome, detailReceipt, evidenceGaps, finalVerdict, followUpRequest, interpretationPhaseAtPress,
  isTrialScenario, observingScenarios, ownExecutions, parentChildLifecycle, planTrial, projectFiles, readBound, runPhaseAtPress, scenarioActors, scenarioVerdicts, scratchDeletions, selectionShown,
  stopPressReady, stopTime, successfulReceipt, trialScenarios, workflowMcpAlias, workflowMcpRegistration, type ActorProvenance, type FullRecordProblem,
  type RunPhase, type InterpretationPhase, type StopTime, type TaskReading, type TrialEvidence, type TrialObservation, type TrialVerdict}
  from "../scripts/provider-trial.js";
import {trafficKind, type WorkloadObservation} from "../scripts/provider-trial-oracles.js";
import {parseDefinitionStep, parseDefinitionWorkflow, parseProjectConfiguration} from "../src/project-definitions.js";

/* The provider trials' verdicts (scripts/provider-trial.ts) are pure over what the trial observed when its budget ended; the trials
 * themselves run only locally in the signed-in environment (docs/testing.md, execution type 6).
 */

const task = (supervision: "needed" | "not_needed" | null, agreed = false): NonNullable<TrialObservation["task"]> =>
  ({id: "task-a", status: supervision === "needed" ? "inferred" : supervision === "not_needed" ? "not_supervised" : "waiting", supervision, agreed});
const seen = (ids: ReadonlyArray<string>, value: TrialObservation["task"]): TrialObservation => ({supervisorMessageIds: ids, task: value});
const notice = "supervisor-notice:workflow:task-a";

it.live("a no-contact trial passes only when the request was judged not needed and nobody was contacted", () => Effect.sync(() => {
  assert.equal(classifyTrial("no-contact", seen([], task("not_needed"))).outcome, "pass");
  assert.equal(classifyTrial("no-contact", seen([notice], task("not_needed"))).outcome, "fail");
  assert.equal(classifyTrial("no-contact", seen(["root-message"], task(null))).outcome, "fail", "a message of the Supervisor's root is contact too");
  assert.equal(classifyTrial("no-contact", seen([], task("needed"))).outcome, "inconclusive", "the no-contact case did not happen");
  assert.equal(classifyTrial("no-contact", seen([], task(null))).outcome, "inconclusive", "nothing decided within the budget");
  assert.equal(classifyTrial("no-contact", seen([], null)).outcome, "inconclusive");
}));

it.live("an introduction trial passes only when the needed request's proposal reached the operative exactly once", () => Effect.sync(() => {
  assert.equal(classifyTrial("introduction", seen([notice], task("needed"))).outcome, "pass");
  assert.match(classifyTrial("introduction", seen([notice], task("needed", true))).reason, /agreed/u, "a natural agreement is reported");
  // the notice names its own proposal, so the same text twice is one proposal delivered twice, whatever identities carried it
  const notices = (...entries: ReadonlyArray<readonly [string, string | null]>) => entries.map(([id, textHash]) => ({id, textHash}));
  const queued = `${notice}:queue`;
  const revised = `${notice}:revised`;
  const twice = classifyTrial("introduction", {...seen([notice, queued], task("needed")), proposalNotices: notices([notice, "text-1"], [queued, "text-1"]),
    proposalIds: ["proposal-1"]});
  assert.equal(twice.outcome, "fail", "one proposal delivered twice");
  assert.equal(classifyTrial("introduction", {...seen([notice, revised], task("needed")), proposalNotices: notices([notice, "text-1"], [revised, "text-1"]),
    proposalIds: ["proposal-1", "proposal-2"]}).outcome, "fail", "a second proposal recorded does not excuse a repeated text");
  // a genuine revision: Supervisor recorded a later proposal for the request and its notice has its own text
  const revision = classifyTrial("introduction", {...seen([notice, revised], task("needed")), proposalNotices: notices([notice, "text-1"], [revised, "text-2"]),
    proposalIds: ["proposal-1", "proposal-2"]});
  assert.equal(revision.outcome, "pass", "a revision reaches the operative as its own notice");
  assert.equal(classifyTrial("introduction", {...seen([notice, revised], task("needed")), proposalNotices: notices([notice, "text-1"], [revised, "text-2"]),
    proposalIds: ["proposal-1"]}).outcome, "inconclusive", "more notices than proposals Supervisor was seen recording");
  assert.equal(classifyTrial("introduction", {...seen([notice, revised], task("needed")), proposalNotices: notices([notice, "text-1"], [revised, null]),
    proposalIds: ["proposal-1", "proposal-2"]}).outcome, "inconclusive", "a notice whose text T3 did not show");
  assert.equal(classifyTrial("introduction", seen([notice, queued], task("needed"))).outcome, "inconclusive", "notices observed without their texts");
  // the current-state guards stay: contact for a request judged not needed fails, revisions or not
  assert.equal(classifyTrial("introduction", {...seen([notice, revised], task("not_needed")), proposalNotices: notices([notice, "text-1"], [revised, "text-2"]),
    proposalIds: ["proposal-1", "proposal-2"]}).outcome, "fail", "contact for a request judged not needed");
  assert.equal(classifyTrial("introduction", seen([], task("needed"))).outcome, "inconclusive", "the budget ended before the introduction");
  assert.equal(classifyTrial("introduction", seen([], task("not_needed"))).outcome, "inconclusive", "no introduction was due");
  assert.equal(classifyTrial("introduction", seen([notice], task("not_needed"))).outcome, "fail", "contact for a request judged not needed");
  assert.equal(classifyTrial("introduction", seen([], null)).outcome, "inconclusive");
}));

it.live("a stop trial passes only on one saved Stop during a running turn, one recorded Stop notice, nothing after it and settlement", () => Effect.sync(() => {
  const stopped = "supervisor-notice:stop:s1";
  const record = {createdAt: "2026-11-01T18:00:00.000Z", createdBy: "user", creationSource: "server"};
  const after = (ids: ReadonlyArray<string>, observed: Partial<TrialObservation>): TrialObservation => ({...seen(ids, task("needed")), ...observed});
  const pressed = {answer: "saved", runAtPress: "running" as const};
  const clean: Partial<TrialObservation> = {stop: pressed, policyStopped: true, stopNoticeRecord: record, afterStopNotice: [], settlement: "settled"};
  assert.equal(classifyTrial("stop", after([notice, stopped], clean)).outcome, "pass");
  assert.equal(classifyTrial("stop", after([notice, stopped, "supervisor-notice:stop:s2"], clean)).outcome, "fail", "a second Stop notice");
  assert.equal(classifyTrial("stop", after([notice, stopped, "root-message"], {...clean, afterStopNotice: ["root-message"]})).outcome, "fail",
    "contact after the Stop notice");
  // inconclusive, never failed or passed, when the trial cannot tell
  const inconclusive: ReadonlyArray<readonly [string, TrialObservation]> = [
    ["the operative's run was not running", after([notice, stopped], {...clean, stop: {answer: "saved", runAtPress: "not-running"}})],
    ["T3's run times could not show the phase at the Stop", after([notice, stopped], {...clean, stop: {answer: "saved", runAtPress: "unknown"}})],
    ["no phase was judged", after([notice, stopped], {...clean, stop: {answer: "saved"}})],
    ["a conflict refused the one press", after([notice], {...clean, stop: {answer: "conflict", runAtPress: "running"}, policyStopped: false})],
    ["the dashboard was unavailable", after([notice], {...clean, stop: {answer: "unavailable", runAtPress: "running"}, policyStopped: false})],
    ["an unanswered press the policy never showed", after([notice], {...clean, stop: {answer: "no answer", runAtPress: "running"}, policyStopped: false})],
    ["no Stop notice yet", after([notice], clean)],
    ["the notice has no creation time", after([notice, stopped], {...clean, stopNoticeRecord: {...record, createdAt: null}})],
    ["the notice is not recorded as Supervisor's", after([notice, stopped], {...clean, stopNoticeRecord: {...record, createdBy: "user", creationSource: "web"}})],
    ["a Supervisor message has no creation time", after([notice, stopped], {...clean, afterStopNotice: null})],
    ["Supervisor had not settled", after([notice, stopped], {...clean, settlement: "pending"})],
    ["nothing was pressed", seen([notice], task("needed"))],
  ];
  for (const [why, observed] of inconclusive) assert.equal(classifyTrial("stop", observed).outcome, "inconclusive", why);
  assert.equal(classifyTrial("stop", after([notice, stopped], {...clean, stop: {answer: "no answer", runAtPress: "running"}})).outcome, "pass",
    "an unanswered press counts once the chat's policy shows it stopped");
  assert.equal(classifyTrial("stop", {...seen([notice, `${notice}:queue`], task("needed")), proposalNotices: [{id: notice, textHash: "text-1"},
    {id: `${notice}:queue`, textHash: "text-1"}], proposalIds: ["proposal-1"]}).outcome, "fail", "a repeated proposal fails here too");
  assert.equal(classifyTrial("stop", after([notice, stopped, `${stopped}:duplicate`], {...clean,
    stop: {answer: "conflict", runAtPress: "running"}, policyStopped: false})).outcome, "fail",
  "a duplicate Stop notice remains a failure when the one press was refused");
}));

it.live("a pass needs gapless evidence: the end of the budget observed, provenance and runtimes recorded, the cleanup done", () => Effect.sync(() => {
  const codex = {instanceId: "codex", model: "gpt-5.5"};
  const operative: ActorProvenance = {threadId: "operative", role: "operative", selections: [codex]};
  const root: ActorProvenance = {threadId: "root-a", role: "root", selections: [codex]};
  const complete: TrialEvidence = {budgetMs: 600_000, lastReadableMs: 605_000, checkout: {revision: "abc", clean: true}, requestRecorded: true,
    actors: [operative, root], runtimes: [{instanceId: "codex", version: "0.99.0"}], cleanup: {supervisionOff: true, project: "removal acknowledged"}};
  const passed: TrialVerdict = {outcome: "pass", reason: "the sequence happened"};
  assert.deepEqual(evidenceGaps(complete), []);
  assert.deepEqual(finalVerdict(passed, evidenceGaps(complete)), passed);
  assert.deepEqual(evidenceGaps({...complete, cleanup: {supervisionOff: true, project: "kept"}}), [], "a kept project is the caller's choice");
  assert.deepEqual(evidenceGaps({...complete, actors: [operative]}), [], "without a root no root selection is due");
  assert.deepEqual(evidenceGaps({...complete, actors: [operative, root, {threadId: "helper-a", role: "helper", selections: []}]}), [],
    "a helper's selection is no gap of the trial as a whole: only the scenarios that rest on it need it");
  const gapped: ReadonlyArray<readonly [string, TrialEvidence]> = [
    ["the last readable look came before the budget ended", {...complete, lastReadableMs: 540_000}],
    ["no look was readable", {...complete, lastReadableMs: null}],
    ["the native request provenance was never recorded", {...complete, requestRecorded: false}],
    ["the checkout had changes", {...complete, checkout: {revision: "abc", clean: false}}],
    ["the commit is unknown", {...complete, checkout: {revision: null, clean: null}}],
    ["no operative selection", {...complete, actors: [{...operative, selections: []}, root]}],
    ["no root selection", {...complete, actors: [operative, {...root, selections: []}]}],
    ["no selection of a later root", {...complete, actors: [operative, root, {threadId: "root-b", role: "root", selections: []}]}],
    ["no runtime for the instance a root selected", {...complete, actors: [operative, {...root, selections: [{instanceId: "claude", model: "opus"}]}]}],
    ["no runtime version", {...complete, runtimes: [{instanceId: "codex", version: null}]}],
    ["no runtime for the instance", {...complete, runtimes: [{instanceId: "claude", version: "1.0.0"}]}],
    ["the provider status was unreadable", {...complete, runtimes: null}],
    ["supervision stayed on", {...complete, cleanup: {supervisionOff: false, project: "removal acknowledged"}}],
    ["the removal failed", {...complete, cleanup: {supervisionOff: true, project: "removal failed: t3 project remove exited 1"}}],
    ["a No Project chat's deletion failed", {...complete, cleanup: {supervisionOff: true, project: "deletion failed: root (uncertain)"}}],
    ["the last look could not read a child", {...complete, unreadAtEnd: ["child child-a"]}],
  ];
  for (const [gap, evidence] of gapped) {
    assert.equal(evidenceGaps(evidence).length, 1, gap);
    const verdict = finalVerdict(passed, evidenceGaps(evidence));
    assert.equal(verdict.outcome, "inconclusive", gap);
    assert.match(verdict.reason, /evidence has gaps/u, gap);
  }
  const failed: TrialVerdict = {outcome: "fail", reason: "a duplicate notice"};
  assert.deepEqual(finalVerdict(failed, ["no look at the chat was readable"]), failed, "a failure stays a failure");
  assert.deepEqual(evidenceGaps({...complete, cleanup: {supervisionOff: true, project: "deletion acknowledged"}}), [], "T3 acknowledged deleting a No Project trial's chats");
}));

it.live("a Stop notice that nobody asked for fails every trial", () => Effect.sync(() => {
  for (const scenario of Object.keys(trialScenarios)) {
    assert.ok(isTrialScenario(scenario));
    assert.equal(classifyTrial(scenario, seen(["supervisor-notice:stop:a", notice], task("needed"))).outcome, "fail", scenario);
  }
}));

it.live("the trial requests are uncoached: none names Supervisor, its tools or the agreement it should reach", () => Effect.sync(() => {
  for (const request of [...Object.values(trialScenarios), followUpRequest]) assert.doesNotMatch(request, /supervis|workflow|proposal|agree|accept|plan\b/iu, request);
  assert.equal(isTrialScenario("unknown"), false);
}));

it.live("a trial starts only with the Codex CLI's registration of Supervisor's workflow MCP, whose bearer stays redacted", () => Effect.sync(() => {
  const url = "http://127.0.0.1:9008/mcp/workflows";
  const secret = "Bearer fixture-only-secret";
  const entry = (overrides: Record<string, unknown> = {}, transport: Record<string, unknown> = {}) => ({name: workflowMcpAlias, enabled: true,
    transport: {type: "streamable_http", url, bearer_token_env_var: null, http_headers: {Authorization: secret}, env_http_headers: null, ...transport},
    ...overrides});
  const check = (servers: unknown) => workflowMcpRegistration(JSON.stringify(servers), url);
  const header = check([entry()]);
  assert.ok(header.registered && header.auth === "http_headers");
  const sent = header.registered ? header.authorization({}) : null;
  assert.ok(sent !== null && Redacted.value(sent) === secret, "a header bearer is sent as registered");
  assert.doesNotMatch(String(sent), /fixture-only-secret/u, "and stays redacted as text");
  assert.equal(check([entry({}, {url: `${url}/`})]).registered, true, "a trailing slash is the same URL");
  const variable = check([entry({}, {bearer_token_env_var: "T3_SUPERVISOR_WORKFLOW_TOKEN", http_headers: null})]);
  assert.ok(variable.registered && variable.auth === "bearer_token_env_var");
  const fromVariable = variable.registered ? variable.authorization({T3_SUPERVISOR_WORKFLOW_TOKEN: "fixture-only-secret"}) : null;
  assert.ok(fromVariable !== null && Redacted.value(fromVariable) === secret, "a variable's token becomes a bearer header");
  assert.equal(variable.registered ? variable.authorization({}) : "", null, "an unset variable gives no header");
  const headerVariable = check([entry({}, {http_headers: null, env_http_headers: {authorization: "T3_SUPERVISOR_WORKFLOW_HEADER"}})]);
  assert.ok(headerVariable.registered && headerVariable.auth === "env_http_headers");
  const fromHeaderVariable = headerVariable.registered ? headerVariable.authorization({T3_SUPERVISOR_WORKFLOW_HEADER: secret}) : null;
  assert.ok(fromHeaderVariable !== null && Redacted.value(fromHeaderVariable) === secret, "a header variable's value is the header");
  const refused: ReadonlyArray<readonly [string, unknown, RegExp]> = [
    ["nothing registered", [], /no MCP server registered/u],
    ["another server only", [{...entry(), name: "other"}], /no t3-supervisor-workflows among 1 registered/u],
    ["disabled", [entry({enabled: false})], /disabled/u],
    ["over stdio", [entry({}, {type: "stdio"})], /over stdio/u],
    ["another port", [entry({}, {url: "http://user:fixture-only-secret@127.0.0.1:9009/mcp/workflows"})], /at http:\/\/127\.0\.0\.1:9009\/mcp\/workflows/u],
    ["localhost, which Supervisor's host check refuses", [entry({}, {url: "http://localhost:9008/mcp/workflows"})], /at http:\/\/localhost:9008/u],
    ["no bearer", [entry({}, {http_headers: {"X-Other": "value"}})], /without a bearer/u],
  ];
  for (const [why, servers, found] of refused) {
    const result = check(servers);
    assert.equal(result.registered, false, why);
    assert.match(result.registered ? "" : result.found, found, why);
    assert.doesNotMatch(JSON.stringify(result), /fixture-only-secret/u, `${why}: no header value or URL credential is reported`);
  }
  assert.equal(workflowMcpRegistration("not json", url).registered, false, "unreadable registrations are not a registration");
}));

it.live("a budget is a positive number of minutes up to a day, which T3's read session for the trial can cover", () => Effect.sync(() => {
  for (const minutes of [1, 30, 24 * 60]) assert.equal(budgetRefusal(minutes), null, `${minutes} minutes`);
  for (const minutes of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 24 * 60 + 1]) assert.notEqual(budgetRefusal(minutes), null, `${minutes} minutes`);
}));

it.live("a command line names one scenario, or several observing workload scenarios that share one launch", () => Effect.sync(() => {
  const planned = (names: ReadonlyArray<string>, followUp: number | null = null) => planTrial(names, followUp);
  const one = planned(["introduction"]);
  assert.ok(!("refused" in one) && one.workload === "contributing" && one.request === trialScenarios.introduction && one.followUpMs === null);
  const shared = planned(["negotiation", "message-volume", "compaction"]);
  assert.ok(!("refused" in shared) && shared.workload === "library" && shared.scenarios.length === 3 && shared.request === trialScenarios.negotiation);
  assert.ok(!("refused" in planned([...observingScenarios])), "every observing scenario at once");
  const parking = planned(["idle-parking"], 20);
  assert.ok(!("refused" in parking) && parking.followUpMs === 20 * 60_000 && parking.workload === "library");
  const stop = planned(["stop"]);
  assert.ok(!("refused" in stop) && stop.workload === "library" && stop.request === trialScenarios.negotiation,
    "the Stop acts on the shared workload's change, which keeps the operative's run going");
  const scratch = planned(["no-project-stop"]);
  assert.ok(!("refused" in scratch) && scratch.workload === "no-project");
  const refused: ReadonlyArray<readonly [string, ReadonlyArray<string>, number | null]> = [
    ["no scenario", [], null], ["an unknown scenario", ["nope"], null], ["a scenario twice", ["negotiation", "negotiation"], null],
    ["a scenario that acts beside others", ["negotiation", "stop"], null], ["idle parking beside others", ["idle-parking", "negotiation"], 20],
    ["two No Project scenarios", ["no-project-start", "no-project-stop"], null], ["idle parking without its follow-up budget", ["idle-parking"], null],
    ["a follow-up budget elsewhere", ["negotiation"], 20], ["a follow-up budget that is no budget", ["idle-parking"], 0],
    ["a follow-up budget beyond a day", ["idle-parking"], 24 * 60 + 1],
  ];
  for (const [why, names, followUp] of refused) assert.ok("refused" in planned(names, followUp), why);
}));

it.live("a trial of several scenarios fails on any failure and passes only when every one passed", () => Effect.sync(() => {
  const verdict = (outcome: TrialVerdict["outcome"]): TrialVerdict => ({outcome, reason: outcome});
  assert.equal(combinedOutcome([verdict("pass"), verdict("pass")]), "pass");
  assert.equal(combinedOutcome([verdict("pass"), verdict("inconclusive")]), "inconclusive");
  assert.equal(combinedOutcome([verdict("inconclusive"), verdict("fail"), verdict("pass")]), "fail");
  assert.equal(combinedOutcome([]), "inconclusive");
}));

it.live("a workload scenario is judged by its oracle, after the rules every trial shares", () => Effect.sync(() => {
  assert.equal(classifyTrial("negotiation", seen([notice], task("needed"))).outcome, "inconclusive", "no workload observation");
  assert.equal(classifyTrial("message-volume", seen([notice], task("not_needed"))).outcome, "fail", "contact on a request judged not needed");
}));

it.live("No Project Stop passes only on one saved Stop during the started request's interpretation, one notice, nothing after and settlement", () => Effect.sync(() => {
  const stopped = "supervisor-notice:stop:s1";
  const record = {createdAt: "2026-11-01T18:00:00.000Z", createdBy: "user", creationSource: "server"};
  const started = {answer: "active", status: "active"};
  const clean: TrialObservation = {supervisorMessageIds: [stopped], task: task(null), start: started,
    stop: {answer: "saved", interpretationAtPress: "interpreting"}, policyStopped: true, stopNoticeRecord: record, afterStopNotice: [], settlement: "settled"};
  assert.equal(classifyTrial("no-project-stop", clean).outcome, "pass");
  assert.equal(classifyTrial("no-project-stop", {...clean, task: task("not_needed")}).outcome, "pass", "the Stop notice answers the Stop, so it is no contact");
  assert.equal(classifyTrial("no-project-stop", {...clean, supervisorMessageIds: [stopped, "supervisor-notice:stop:s2"]}).outcome, "fail", "a second Stop notice");
  assert.equal(classifyTrial("no-project-stop", {...clean, supervisorMessageIds: [stopped, notice], afterStopNotice: [notice]}).outcome, "fail",
    "a proposal after the Stop notice");
  const inconclusive: ReadonlyArray<readonly [string, TrialObservation]> = [
    ["Start never pressed", {...clean, start: null}],
    ["Start not active", {...clean, start: {answer: "denied", status: null}}],
    ["not stopped during the interpretation", {...clean, stop: {answer: "saved", interpretationAtPress: "not-interpreting"}}],
    ["the reads around the Stop could not show the interpretation in flight", {...clean, stop: {answer: "saved", interpretationAtPress: "unknown"}}],
    ["no phase was judged", {...clean, stop: {answer: "saved"}}],
    ["never stopped", {...clean, stop: null, supervisorMessageIds: []}],
    ["not settled", {...clean, settlement: "pending"}],
    ["no notice", {...clean, supervisorMessageIds: []}],
  ];
  for (const [why, observed] of inconclusive) assert.equal(classifyTrial("no-project-stop", observed).outcome, "inconclusive", why);
}));

it.live("a workflow tool's successful receipt is read from its MCP result, and an exact replay has the same digest", () => Effect.sync(() => {
  const receipt = {formatVersion: 2, status: "applied", operationId: "op-a", workflowId: "w", revision: 3, stateHash: "s"};
  const structured = successfulReceipt({structuredContent: receipt});
  assert.equal(structured?.status, "applied");
  assert.deepEqual(successfulReceipt(JSON.stringify({content: [{type: "text", text: JSON.stringify(receipt)}]})), structured, "one text content as JSON text");
  assert.notDeepEqual(successfulReceipt({structuredContent: {...receipt, revision: 4}}), structured, "another revision is another receipt");
  assert.equal(successfulReceipt({structuredContent: {status: "recorded", operationId: "op-b", requestId: "r", outcome: "no_change"}})?.status, "recorded");
  assert.equal(successfulReceipt({isError: true, structuredContent: receipt}), null, "an error result");
  assert.equal(successfulReceipt({structuredContent: {status: "pending", reason: "evidence_pending"}}), null, "a pending write");
  assert.equal(successfulReceipt(undefined), null);
  // T3's full record of a Codex dynamic_tool call holds the content blocks alone: one text block of JSON is the result itself
  const blocks = (...texts: ReadonlyArray<string>) => texts.map((text) => ({type: "text", text}));
  assert.deepEqual(successfulReceipt(blocks(JSON.stringify(receipt))), structured, "one text block: the same status and digest");
  assert.deepEqual(successfulReceipt(JSON.stringify(blocks(JSON.stringify(receipt)))), structured, "the blocks recorded as JSON text");
  assert.equal(successfulReceipt(blocks("{\"status\":\"invalid\",\"reason\":\"invalid_apply\"}")), null, "the refusal Codex recorded for a malformed apply");
  assert.equal(successfulReceipt(blocks(JSON.stringify(receipt), JSON.stringify(receipt))), null, "two text blocks are ambiguous, even when equal");
  assert.equal(successfulReceipt([{type: "image", data: "", mimeType: "image/png"}]), null, "a block that is not text");
  assert.equal(successfulReceipt([...blocks(JSON.stringify(receipt)), {type: "image", data: "", mimeType: "image/png"}]), null, "more than one block");
  assert.equal(successfulReceipt([]), null, "no block");
  assert.equal(successfulReceipt(blocks("applied")), null, "a text that is no JSON result");
  assert.equal(successfulReceipt({content: blocks(JSON.stringify(receipt), JSON.stringify(receipt))}), null, "an envelope with two text blocks");
}));

it.live("a workflow_write receipt the projection omitted is read from T3's full record of that same completed call, and nothing else", () => Effect.sync(() => {
  const call = {itemId: "item-1", threadId: "root", toolName: "t3-supervisor-workflows.workflow_write"};
  const receipt = {formatVersion: 2, status: "applied", operationId: "op-a", workflowId: "w", revision: 3, stateHash: "s"};
  const item = (fields: Record<string, unknown>) => ({item: {id: "item-1", type: "dynamic_tool", threadId: "root", toolName: call.toolName,
    status: "completed", ...fields}});
  // the pinned getTurnItem answers {item}; the output is the MCP result as the projection would have carried it
  const read = detailReceipt(item({output: {structuredContent: receipt}}), call);
  assert.equal(read.problem, null);
  assert.deepEqual(read.receipt, successfulReceipt({structuredContent: receipt}), "the same status and digest as a projection receipt");
  assert.deepEqual(detailReceipt(item({output: JSON.stringify({content: [{type: "text", text: JSON.stringify(receipt)}]})}), call).receipt, read.receipt,
    "an output recorded as JSON text");
  // the shape a Codex dynamic_tool call actually has in T3's full record: its content blocks alone
  assert.deepEqual(detailReceipt(item({output: [{type: "text", text: JSON.stringify(receipt)}]}), call), {receipt: read.receipt, problem: null},
    "one text block of the receipt");
  const refused: ReadonlyArray<readonly [string, unknown, FullRecordProblem]> = [
    ["an unexpected shape", {items: []}, "unexpected-shape"],
    ["no record", {item: null}, "no-record"],
    ["another item", item({id: "item-2", output: {structuredContent: receipt}}), "another-item"],
    ["another thread", item({threadId: "operative", output: {structuredContent: receipt}}), "another-item"],
    ["another tool", item({toolName: "t3-supervisor-workflows.workflow_read", output: {structuredContent: receipt}}), "another-item"],
    ["not a tool call", item({type: "assistant_message", output: {structuredContent: receipt}}), "another-item"],
    ["a call still running", item({status: "running", output: {structuredContent: receipt}}), "not-completed"],
    ["an output omitted again", item({}), "output-omitted"],
    ["an error result", item({output: {isError: true, structuredContent: receipt}}), "no-successful-receipt"],
    ["a pending write", item({output: {structuredContent: {status: "pending", reason: "evidence_pending"}}}), "no-successful-receipt"],
    ["a refusal in Codex's content blocks", item({output: [{type: "text", text: "{\"status\":\"invalid\",\"reason\":\"invalid_apply\"}"}]}), "no-successful-receipt"],
    ["two content blocks", item({output: [{type: "text", text: JSON.stringify(receipt)}, {type: "text", text: JSON.stringify(receipt)}]}), "no-successful-receipt"],
    ["content blocks of another item", item({id: "item-2", output: [{type: "text", text: JSON.stringify(receipt)}]}), "another-item"],
    ["content blocks of a call still running", item({status: "running", output: [{type: "text", text: JSON.stringify(receipt)}]}), "not-completed"],
  ];
  for (const [why, reply, problem] of refused) {
    const answer = detailReceipt(reply, call);
    assert.equal(answer.receipt, null, why);
    assert.equal(answer.problem, problem, why);
    assert.doesNotMatch(JSON.stringify(answer), /stateHash|formatVersion/u, `${why}: no output content is kept`);
  }
}));

it.live("a No Project trial deletes only its own chat and the threads proven its own, never an identity T3's launch reply named instead", () => Effect.sync(() => {
  const children = [{threadId: "child-in", lineageVerified: true, lineageKnown: true}, {threadId: "child-out", lineageVerified: false, lineageKnown: true},
    {threadId: "child-unknown", lineageVerified: false, lineageKnown: false}];
  const confirmed = {operative: "reserved", launchUncertain: false, reservedExists: null, unconfirmedChats: [], children, owned: ["root-a", "helper-a", "root-a"]};
  const plan = scratchDeletions(confirmed);
  assert.deepEqual(plan.deletes, ["reserved", "child-in", "root-a", "helper-a"]);
  assert.deepEqual(plan.left, [{threadId: "child-out", reason: "lineage-outside"}, {threadId: "child-unknown", reason: "lineage-unknown"}],
    "a descendant outside the scope or of unknown lineage is left");
  // a launch reply that named another identity than the trial's own: that chat is unconfirmed and never deleted
  const mismatched = scratchDeletions({...confirmed, launchUncertain: true, reservedExists: true, unconfirmedChats: ["someone-else"], children: [], owned: []});
  assert.deepEqual(mismatched.deletes, ["reserved"]);
  assert.deepEqual(mismatched.left, [{threadId: "someone-else", reason: "launch-reply-identity-unconfirmed"}]);
  const missing = scratchDeletions({...confirmed, launchUncertain: true, reservedExists: false, unconfirmedChats: ["someone-else"]});
  assert.deepEqual(missing.deletes, [], "nothing was made under the trial's identity, so nothing is deleted");
  assert.deepEqual(missing.left, [{threadId: "someone-else", reason: "launch-reply-identity-unconfirmed"}]);
  assert.deepEqual(scratchDeletions({...confirmed, launchUncertain: true, reservedExists: false}), {deletes: [], left: []}, "an unknown launch that made nothing");
  // T3 could not tell: the trial's own identity is still deleted, which T3 refuses when it has no such chat
  assert.deepEqual(scratchDeletions({...confirmed, launchUncertain: true, reservedExists: null, children: [], owned: []}).deletes, ["reserved"]);
  // an unconfirmed identity that is proven the trial's apart from the reply, as a verified descendant or Supervisor's own thread, is deleted
  assert.deepEqual(scratchDeletions({...confirmed, unconfirmedChats: ["root-a"]}).left.map((entry) => entry.threadId), ["child-out", "child-unknown"]);
}));

it.live("a child's own timed work is read from its own projection, apart from T3's runs and never from another thread's items", () => Effect.sync(() => {
  // the observed provider-native Codex child: its own selection and subagent lineage, projection.runs [] and two completed items of its own
  const child = "child-native";
  const item = (fields: Record<string, unknown>) => ({threadId: child, runId: null, status: "completed", ...fields});
  const turnItems = [
    item({id: "user-1", type: "user_message", startedAt: "2026-11-01T22:01:17.900Z", completedAt: "2026-11-01T22:01:17.901Z"}),
    item({id: "exec-e0e7", type: "command_execution", startedAt: "2026-11-01T22:01:18.462Z", completedAt: "2026-11-01T22:01:18.465Z", exitCode: 0}),
    item({id: "reply-1", type: "assistant_message", startedAt: "2026-11-01T22:01:24.701Z", completedAt: "2026-11-01T22:01:24.893Z"}),
    item({id: "checkpoint-1", type: "checkpoint", startedAt: "2026-11-01T22:01:25.000Z", completedAt: "2026-11-01T22:01:25.001Z"}),
    item({id: "nested", type: "subagent", childThreadId: "grandchild", startedAt: "2026-11-01T22:01:26.000Z"}),
    item({id: "elsewhere", type: "command_execution", threadId: "operative", startedAt: "2026-11-01T22:01:27.000Z", completedAt: null}),
    item({id: "untimed", type: "file_change", startedAt: null, completedAt: null}),
  ];
  assert.deepEqual(ownExecutions(child, turnItems), [
    {itemId: "exec-e0e7", type: "command_execution", status: "completed", startedAt: "2026-11-01T22:01:18.462Z", completedAt: "2026-11-01T22:01:18.465Z"},
    {itemId: "reply-1", type: "assistant_message", status: "completed", startedAt: "2026-11-01T22:01:24.701Z", completedAt: "2026-11-01T22:01:24.893Z"},
  ]);
  assert.deepEqual(ownExecutions(child, []), []);
  assert.deepEqual(selectionShown({instanceId: "codex", model: "gpt-6.1-sol"}), {instanceId: "codex", model: "gpt-6.1-sol"}, "its own model selection");
}));

it.live("a run-less native child's lifecycle is its direct parent's own record, reconciled as Supervisor reconciles it", () => Effect.sync(() => {
  // the observed parent of a provider-native Codex child with projection.runs []: its subagent record and the matching subagent turn item
  const child = "thread:provider:codex:native-thread:01a19921-8f85-7752-9d67-373ed4ced895";
  const times = {startedAt: "2026-11-01T22:01:15.000Z", completedAt: "2026-11-01T22:01:24.904Z", updatedAt: "2026-11-01T22:01:24.907Z",
    runId: "run:thread:568a1f41-c319-4a62-a727-ff071dc1f0db:ordinal:3"};
  const record = {id: "node:provider:codex:native-item:call_f3a5e507c813493ba4fa64da4aaa0cc2%3A01a19921-8f85-7752-9d67-373ed4ced895", childThreadId: child,
    status: "completed", ...times};
  const item = {type: "subagent", childThreadId: child, status: "completed", ...times};
  const completed = {status: "completed", parentRunId: times.runId, startedAt: times.startedAt, completedAt: times.completedAt};
  assert.deepEqual(parentChildLifecycle({subagents: [record], turnItems: [item]}, child), {...completed, source: "parent_turn_item", recordId: null},
    "both sources agree; the turn item is preferred");
  assert.deepEqual(parentChildLifecycle({subagents: [record]}, child), {...completed, source: "parent_subagents", recordId: record.id});
  assert.equal(parentChildLifecycle({subagents: [record], turnItems: [{...item, status: "running"}]}, child), null, "conflicting statuses");
  assert.equal(parentChildLifecycle({}, child), null, "no record of the child");
  assert.equal(parentChildLifecycle({subagents: [{...record, childThreadId: "another-child"}]}, child), null, "another child's record");
}));

it.live("a look reads a bounded number of helpers and descendants and reports the rest unread, which keeps the trial from a pass", () => Effect.sync(() => {
  const ids = Array.from({length: 23}, (_, index) => `child-${index + 1}`);
  const bound = readBound(ids, 20);
  assert.deepEqual(bound.read, ids.slice(0, 20));
  assert.deepEqual(bound.skipped, ["child-21", "child-22", "child-23"]);
  assert.deepEqual(readBound(ids.slice(0, 3), 20).skipped, []);
  const evidence: TrialEvidence = {budgetMs: 60_000, lastReadableMs: 61_000, checkout: {revision: "abc", clean: true}, requestRecorded: true,
    actors: [{threadId: "operative", role: "operative", selections: [{instanceId: "codex", model: "gpt-5.5"}]}], runtimes: [{instanceId: "codex", version: "1.0"}],
    cleanup: {supervisionOff: true, project: "removal acknowledged"}};
  assert.deepEqual(evidenceGaps(evidence), []);
  assert.equal(evidenceGaps({...evidence, unreadAtEnd: bound.skipped.map((threadId) => `child ${threadId}`)}).length, 3, "one gap per skipped descendant");
  assert.equal(finalVerdict({outcome: "pass", reason: "the work ended"}, evidenceGaps({...evidence, unreadAtEnd: ["child child-21"]})).outcome, "inconclusive");
}));

it.live("the Stop is pressed only on fresh reads that show its moment, and in stop names the one run running", () => Effect.sync(() => {
  const policy = {stopped: false, policyGeneration: 4, activation: "active"};
  const waiting: TaskReading = {id: "task-a", status: "waiting", updatedAt: 100};
  const fresh = {policy, runs: [{id: "run-1", status: "completed"}, {id: "run-2", status: "running"}], proposalReached: true, task: waiting};
  assert.deepEqual(stopPressReady("stop", fresh), {policyGeneration: 4, runId: "run-2"});
  assert.deepEqual(stopPressReady("no-project-stop", {...fresh, runs: null, proposalReached: false}), {policyGeneration: 4, runId: null});
  const notNow: ReadonlyArray<readonly [string, "stop" | "no-project-stop", Parameters<typeof stopPressReady>[1]]> = [
    ["the chat is already stopped", "stop", {...fresh, policy: {...policy, stopped: true}}],
    ["Supervisor's state was unread", "stop", {...fresh, policy: null}],
    ["the proposal has not reached the chat", "stop", {...fresh, proposalReached: false}],
    ["the run the look saw ended before the fresh read", "stop", {...fresh, runs: [{id: "run-2", status: "completed"}]}],
    ["two runs running", "stop", {...fresh, runs: [{id: "run-2", status: "running"}, {id: "run-3", status: "running"}]}],
    ["the chat was unread", "stop", {...fresh, runs: null}],
    ["the Start is not active", "no-project-stop", {...fresh, policy: {...policy, activation: "pending"}}],
    ["the interpretation was decided before the fresh read", "no-project-stop", {...fresh, task: {...waiting, status: "inferred"}}],
    ["the interpretation is only queued", "no-project-stop", {...fresh, task: {...waiting, status: "queued"}}],
    ["no task", "no-project-stop", {...fresh, task: null}],
  ];
  for (const [why, scenario, read] of notNow) assert.equal(stopPressReady(scenario, read), null, why);
}));

it.live("a Stop counts as during model work only when T3's times of its run, read after the answer, span Supervisor's recorded Stop time", () => Effect.sync(() => {
  const base = Date.UTC(2026, 10, 1, 18, 0, 0);
  const press = {sentAt: base + 1_000, answeredAt: base + 1_400};
  // Supervisor's own record of the dashboard Stop fixes the moment; an unread record, one outside the press or another route's leaves the window
  const moment = stopTime(press, {stoppedBy: "ui", stoppedAt: base + 1_200});
  const window = stopTime(press, null);
  assert.deepEqual(moment, {from: base + 1_200, to: base + 1_200});
  assert.deepEqual(window, {from: press.sentAt, to: press.answeredAt});
  assert.deepEqual(stopTime(press, {stoppedBy: "ui", stoppedAt: base + 900}), window, "a record before the press was sent");
  assert.deepEqual(stopTime(press, {stoppedBy: "ui", stoppedAt: base + 1_500}), window, "a record after its answer");
  assert.deepEqual(stopTime(press, {stoppedBy: "chat", stoppedAt: base + 1_200}), window, "a Stop the operative asked for");
  assert.deepEqual(stopTime(press, {stoppedBy: "ui", stoppedAt: null}), window, "a record without its time");
  const at = (offset: number | null) => offset === null ? null : new Date(base + offset).toISOString();
  const run = (startedAt: number | null, completedAt: number | null, status: string) => ({startedAt: at(startedAt), completedAt: at(completedAt), status});
  const cases: ReadonlyArray<readonly [string, ReturnType<typeof run> | null, StopTime, RunPhase]> = [
    ["still running after the answer", run(500, null, "running"), moment, "running"],
    ["completed after the recorded Stop", run(500, 1_300, "completed"), moment, "running"],
    ["completed after the unrecorded press's answer", run(500, 1_500, "completed"), window, "running"],
    ["completed between the fresh read and the Stop", run(500, 1_100, "completed"), moment, "not-running"],
    ["completed before the press was sent", run(500, 900, "completed"), window, "not-running"],
    ["completed while the unrecorded press was in flight", run(500, 1_300, "completed"), window, "unknown"],
    ["completed at the Stop's moment", run(500, 1_200, "completed"), moment, "unknown"],
    ["started at the Stop's moment", run(1_200, null, "running"), moment, "unknown"],
    ["started after the Stop", run(1_300, null, "running"), moment, "not-running"],
    ["without a native start", run(null, null, "running"), moment, "unknown"],
    ["ended without a completion time", run(500, null, "completed"), moment, "unknown"],
    ["no read after the answer showed the run", null, moment, "unknown"],
  ];
  for (const [why, observed, stop, phase] of cases) assert.equal(runPhaseAtPress(observed, stop), phase, why);
}));

it.live("a No Project Stop counts as during the interpretation only when its task shows no change across the Stop, or a last change before it", () => Effect.sync(() => {
  const press = {sentAt: 1_000, answeredAt: 1_400};
  const moment = stopTime(press, {stoppedBy: "ui", stoppedAt: 1_200});
  const window = stopTime(press, null);
  const reading = (status: string, updatedAt: number | null, id: string | null = "task-a"): TaskReading => ({id, status, updatedAt});
  const before = reading("waiting", 100);
  const cases: ReadonlyArray<readonly [string, TaskReading | null, TaskReading | null, StopTime, InterpretationPhase]> = [
    ["unchanged across the press", before, reading("waiting", 100), moment, "interpreting"],
    ["unchanged, with only the press's window known", before, reading("waiting", 100), window, "interpreting"],
    ["sent to the root just before the Stop and still awaited", reading("dispatching", 90), reading("waiting", 1_100), moment, "interpreting"],
    ["decided just before the Stop", before, reading("inferred", 1_100), moment, "not-interpreting"],
    ["changed after the Stop, so it may have been decided before it as well", before, reading("inferred", 1_300), moment, "unknown"],
    ["an unsent dispatch the Stop returned to the queue", reading("dispatching", 90), reading("queued", 1_200), moment, "unknown"],
    ["changed while the unrecorded press was in flight", before, reading("inferred", 1_100), window, "unknown"],
    ["no read after the answer", before, null, moment, "unknown"],
    ["no read before the press", null, reading("waiting", 100), moment, "unknown"],
    ["no change time", reading("waiting", null), reading("waiting", null), moment, "unknown"],
    ["another task", before, reading("waiting", 100, "task-b"), moment, "unknown"],
    ["the same change time with another status", before, reading("inferred", 100), moment, "unknown"],
  ];
  for (const [why, earlier, later, stop, phase] of cases) assert.equal(interpretationPhaseAtPress(earlier, later, stop), phase, why);
}));

it.live("each actor's own model selection and runtime are evidence of the scenarios that rest on it, and of no other", () => Effect.sync(() => {
  // only the instance, the model and its settings are kept of what T3 showed
  assert.deepEqual(selectionShown({instanceId: "claude", model: "opus", options: [{id: "effort", value: "high"}, {id: "fast", value: true}], extra: {token: "t"}}),
    {instanceId: "claude", model: "opus", options: [{id: "effort", value: "high"}, {id: "fast", value: true}]});
  assert.deepEqual(selectionShown({instanceId: "codex", model: "gpt-5.5"}), {instanceId: "codex", model: "gpt-5.5"});
  assert.equal(selectionShown({model: "gpt-5.5"}), null);
  assert.equal(selectionShown(null), null);
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 18, minute)).toISOString();
  const ended = (id: string) => ({id, status: "completed", requestedAt: at(0), startedAt: at(0), completedAt: at(5), userMessageId: null});
  const sent = (id: string, threadId: string) => ({id, threadId, kind: trafficKind(id, false)!, runId: null, createdAt: at(2), textHash: id});
  const proposal = "supervisor-notice:workflow:task-a:rev";
  const workload: WorkloadObservation = {operativeThreadId: "operative", supervisors: [{threadId: "root-a", generation: 1, firstSeenAt: 0}],
    helpers: {threadIds: ["helper-a"], ready: ["helper-a"], assigned: ["helper-a"], mostAtOnce: 1, limit: 5}, task: {id: "task-a", supervision: "needed"},
    traffic: [sent(proposal, "operative"), sent("supervisor-review:r1", "helper-a"), sent("guide:abc:message:0", "child-a")],
    runs: {operative: [ended("op-1")], "root-a": [ended("root-1")], "helper-a": [ended("helper-1")], "child-a": [ended("child-1")]}, executions: {}, childLifecycles: {},
    stopPresses: 0, agreement: null,
    children: [{threadId: "child-a", lineageVerified: true, lineageKnown: true}, {threadId: "child-b", lineageVerified: false, lineageKnown: true}],
    monitoring: [], monitor: {state: "idle", pendingItems: 0}, settlements: [], compactions: [], rootLatestStart: {}, instructionReads: [], writes: [],
    history: [], parking: null, start: null, endedAt: 0};
  assert.deepEqual(scenarioActors("helpers", workload), [{threadId: "helper-a", role: "helper"}]);
  assert.deepEqual(scenarioActors("active-children", workload), [{threadId: "child-a", role: "child"}], "only the verified children are judged");
  assert.deepEqual(scenarioActors("guides", workload), [{threadId: "child-a", role: "child"}], "the threads a guide reached");
  assert.deepEqual(scenarioActors("message-volume", workload), []);
  assert.deepEqual(scenarioActors("helpers", undefined), []);
  const codex = {instanceId: "codex", model: "gpt-5.5"};
  const actors: ReadonlyArray<ActorProvenance> = [{threadId: "operative", role: "operative", selections: [codex]},
    {threadId: "root-a", role: "root", selections: [codex]}, {threadId: "helper-a", role: "helper", selections: []},
    {threadId: "child-a", role: "child", selections: [{instanceId: "claude", model: "opus"}]}];
  const runtimes = [{instanceId: "codex", version: "0.99.0"}];
  // a helper never read keeps its gap whatever the root or the CLI selected
  assert.deepEqual(actorGaps(scenarioActors("helpers", workload), {actors, runtimes}), ["T3 showed no model selection for helper helper-a"]);
  assert.deepEqual(actorGaps(scenarioActors("active-children", workload), {actors, runtimes}), ["T3 reported no runtime version for claude, selected by child child-a"]);
  assert.deepEqual(actorGaps(scenarioActors("guides", workload), {actors, runtimes: [...runtimes, {instanceId: "claude", version: "2.1.0"}]}), []);
  assert.deepEqual(actorGaps([{threadId: "child-z", role: "child"}], {actors, runtimes}), ["T3 showed no model selection for child child-z"], "a required actor never read");
  assert.deepEqual(actorGaps(scenarioActors("helpers", workload), {actors, runtimes: null}), ["T3 showed no model selection for helper helper-a"],
    "an unreadable provider status is the trial's own gap");
  // the missing helper selection keeps only helpers from its pass; message-volume, which does not rest on the helper, keeps its own
  const observation: TrialObservation = {supervisorMessageIds: [proposal], task: {id: "task-a", status: "inferred", supervision: "needed", agreed: false}, workload};
  const judged = scenarioVerdicts(["message-volume", "helpers"], observation, [], {actors, runtimes});
  assert.deepEqual(judged.map((verdict) => verdict.outcome), ["pass", "inconclusive"]);
  assert.deepEqual(judged.map((verdict) => "actorGaps" in verdict ? verdict.actorGaps : null), [null, ["T3 showed no model selection for helper helper-a"]]);
  const read = actors.map((actor) => actor.threadId === "helper-a" ? {...actor, selections: [codex]} : actor);
  assert.deepEqual(scenarioVerdicts(["message-volume", "helpers"], observation, [], {actors: read, runtimes}).map((verdict) => verdict.outcome), ["pass", "pass"]);
  assert.deepEqual(scenarioVerdicts(["helpers"], observation, ["the trial project: removal failed"], {actors: read, runtimes}).map((verdict) => verdict.outcome),
    ["inconclusive"], "the trial's shared gaps still apply");
}));

it.live("the shared workload's project is a real configuration Supervisor's own parsers accept, with every indexed definition present", () => Effect.sync(() => {
  const files = new Map(projectFiles("library"));
  const file = (path: string) => {const contents = files.get(path); assert.ok(contents !== undefined, path); return contents;};
  const index = parseProjectConfiguration(file(".t3-supervisor/project.yaml"));
  assert.deepEqual(index.workflows.map((entry) => [entry.path, entry.required]), [["workflows/change.yaml", true]]);
  for (const entry of index.steps) {
    const id = /^steps\/(.+)\.md$/u.exec(entry.path)?.[1];
    assert.ok(id !== undefined, entry.path);
    assert.equal(parseDefinitionStep(id, file(`.t3-supervisor/${entry.path}`)).id, id);
  }
  const workflow = parseDefinitionWorkflow("change", file(".t3-supervisor/workflows/change.yaml"));
  assert.deepEqual(workflow.sequence, index.steps.map((entry) => ({step: /^steps\/(.+)\.md$/u.exec(entry.path)?.[1]})), "the workflow uses exactly the indexed steps");
  assert.deepEqual(new Map(projectFiles("contributing")).get(".t3-supervisor/project.yaml"), "workflows: []\nsteps: []\n", "the other trials keep their plain project");
}));
