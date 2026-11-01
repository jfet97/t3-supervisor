import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import {Effect, Redacted} from "effect";
import {classifyTrial, evidenceGaps, finalVerdict, isTrialScenario, trialScenarios, workflowMcpAlias, workflowMcpRegistration, type TrialEvidence,
  type TrialObservation, type TrialVerdict}
  from "../scripts/provider-trial.js";

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
  assert.equal(classifyTrial("introduction", seen([notice, `${notice}:queue`], task("needed"))).outcome, "fail", "a second accepted notice is a duplicate");
  assert.equal(classifyTrial("introduction", seen([], task("needed"))).outcome, "inconclusive", "the budget ended before the introduction");
  assert.equal(classifyTrial("introduction", seen([], task("not_needed"))).outcome, "inconclusive", "no introduction was due");
  assert.equal(classifyTrial("introduction", seen([notice], task("not_needed"))).outcome, "fail", "contact for a request judged not needed");
  assert.equal(classifyTrial("introduction", seen([], null)).outcome, "inconclusive");
}));

it.live("a stop trial passes only on one saved Stop during a running turn, one recorded Stop notice, nothing after it and settlement", () => Effect.sync(() => {
  const stopped = "supervisor-notice:stop:s1";
  const record = {createdAt: "2026-11-01T18:00:00.000Z", createdBy: "user", creationSource: "server"};
  const after = (ids: ReadonlyArray<string>, observed: Partial<TrialObservation>): TrialObservation => ({...seen(ids, task("needed")), ...observed});
  const pressed = {answer: "saved", runActiveAtPress: true};
  const clean: Partial<TrialObservation> = {stop: pressed, policyStopped: true, stopNoticeRecord: record, afterStopNotice: [], settlement: "settled"};
  assert.equal(classifyTrial("stop", after([notice, stopped], clean)).outcome, "pass");
  assert.equal(classifyTrial("stop", after([notice, stopped, "supervisor-notice:stop:s2"], clean)).outcome, "fail", "a second Stop notice");
  assert.equal(classifyTrial("stop", after([notice, stopped, "root-message"], {...clean, afterStopNotice: ["root-message"]})).outcome, "fail",
    "contact after the Stop notice");
  // inconclusive, never failed or passed, when the trial cannot tell
  const inconclusive: ReadonlyArray<readonly [string, TrialObservation]> = [
    ["the operative's run was not running", after([notice, stopped], {...clean, stop: {answer: "saved", runActiveAtPress: false}})],
    ["a conflict refused the one press", after([notice], {...clean, stop: {answer: "conflict", runActiveAtPress: true}, policyStopped: false})],
    ["the dashboard was unavailable", after([notice], {...clean, stop: {answer: "unavailable", runActiveAtPress: true}, policyStopped: false})],
    ["an unanswered press the policy never showed", after([notice], {...clean, stop: {answer: "no answer", runActiveAtPress: true}, policyStopped: false})],
    ["no Stop notice yet", after([notice], clean)],
    ["the notice has no creation time", after([notice, stopped], {...clean, stopNoticeRecord: {...record, createdAt: null}})],
    ["the notice is not recorded as Supervisor's", after([notice, stopped], {...clean, stopNoticeRecord: {...record, createdBy: "user", creationSource: "web"}})],
    ["a Supervisor message has no creation time", after([notice, stopped], {...clean, afterStopNotice: null})],
    ["Supervisor had not settled", after([notice, stopped], {...clean, settlement: "pending"})],
    ["nothing was pressed", seen([notice], task("needed"))],
  ];
  for (const [why, observed] of inconclusive) assert.equal(classifyTrial("stop", observed).outcome, "inconclusive", why);
  assert.equal(classifyTrial("stop", after([notice, stopped], {...clean, stop: {answer: "no answer", runActiveAtPress: true}})).outcome, "pass",
    "an unanswered press counts once the chat's policy shows it stopped");
  assert.equal(classifyTrial("stop", seen([notice, `${notice}:queue`], task("needed"))).outcome, "fail", "a duplicate proposal fails here too");
  assert.equal(classifyTrial("stop", after([notice, stopped, `${stopped}:duplicate`], {...clean,
    stop: {answer: "conflict", runActiveAtPress: true}, policyStopped: false})).outcome, "fail",
  "a duplicate Stop notice remains a failure when the one press was refused");
}));

it.live("a pass needs gapless evidence: the end of the budget observed, provenance and runtimes recorded, the cleanup done", () => Effect.sync(() => {
  const complete: TrialEvidence = {budgetMs: 600_000, lastReadableMs: 605_000, checkout: {revision: "abc", clean: true}, requestRecorded: true, operativeSelection: true,
    supervisorRoot: true, supervisorSelection: true, instances: ["codex"], runtimes: [{instanceId: "codex", version: "0.99.0"}],
    cleanup: {supervisionOff: true, project: "removal acknowledged"}};
  const passed: TrialVerdict = {outcome: "pass", reason: "the sequence happened"};
  assert.deepEqual(evidenceGaps(complete), []);
  assert.deepEqual(finalVerdict(passed, evidenceGaps(complete)), passed);
  assert.deepEqual(evidenceGaps({...complete, cleanup: {supervisionOff: true, project: "kept"}}), [], "a kept project is the caller's choice");
  assert.deepEqual(evidenceGaps({...complete, supervisorRoot: false, supervisorSelection: false}), [], "without a root no root selection is due");
  const gapped: ReadonlyArray<readonly [string, TrialEvidence]> = [
    ["the last readable look came before the budget ended", {...complete, lastReadableMs: 540_000}],
    ["no look was readable", {...complete, lastReadableMs: null}],
    ["the native request provenance was never recorded", {...complete, requestRecorded: false}],
    ["the checkout had changes", {...complete, checkout: {revision: "abc", clean: false}}],
    ["the commit is unknown", {...complete, checkout: {revision: null, clean: null}}],
    ["no operative selection", {...complete, operativeSelection: false}],
    ["no root selection", {...complete, supervisorSelection: false}],
    ["no runtime version", {...complete, runtimes: [{instanceId: "codex", version: null}]}],
    ["no runtime for the instance", {...complete, runtimes: [{instanceId: "claude", version: "1.0.0"}]}],
    ["the provider status was unreadable", {...complete, runtimes: null}],
    ["supervision stayed on", {...complete, cleanup: {supervisionOff: false, project: "removal acknowledged"}}],
    ["the removal failed", {...complete, cleanup: {supervisionOff: true, project: "removal failed: t3 project remove exited 1"}}],
  ];
  for (const [gap, evidence] of gapped) {
    assert.equal(evidenceGaps(evidence).length, 1, gap);
    const verdict = finalVerdict(passed, evidenceGaps(evidence));
    assert.equal(verdict.outcome, "inconclusive", gap);
    assert.match(verdict.reason, /evidence has gaps/u, gap);
  }
  const failed: TrialVerdict = {outcome: "fail", reason: "a duplicate notice"};
  assert.deepEqual(finalVerdict(failed, ["no look at the chat was readable"]), failed, "a failure stays a failure");
}));

it.live("a Stop notice that nobody asked for fails every trial", () => Effect.sync(() => {
  for (const scenario of Object.keys(trialScenarios)) {
    assert.ok(isTrialScenario(scenario));
    assert.equal(classifyTrial(scenario, seen(["supervisor-notice:stop:a", notice], task("needed"))).outcome, "fail", scenario);
  }
}));

it.live("the trial requests are uncoached: none names Supervisor, its tools or the agreement it should reach", () => Effect.sync(() => {
  for (const request of Object.values(trialScenarios)) assert.doesNotMatch(request, /supervis|workflow|proposal|agree|accept|plan\b/iu, request);
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
