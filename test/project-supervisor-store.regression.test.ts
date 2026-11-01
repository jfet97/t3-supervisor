import assert from "node:assert/strict";
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import type { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { defaultSupervisorModel, prepareStopNotice, type BindingRecord, type TaskRecord } from "../src/project-supervisor-store.js";
import { countingIds, failsWith, guidanceStoresFixture, reopenGuidanceStores, temporaryDataDirectory } from "./support/guidance-store-services.js";

/* Target regressions of the ProjectSupervisorStore service (s6d step 1, manifest CT-PSS-01..08) on a temporary guidance
 * database through the real layers. CT-PSS-04, CT-PSS-07 and CT-PSS-08 run once, in
 * test/project-supervisor.characterization.test.ts, whose seam observes a commit from another connection inside a statement;
 * that file's CT-PSS-01 and CT-PSS-05 pin the controller's replay of a crashed Start and the preload beside a live writer,
 * which these store cases do not.
 */

const live = <A, E, R>(body: Effect.Effect<A, E, R>) => body.pipe(Effect.provide(NodeServices.layer));
const interruptedStartReason = "Start intake was interrupted before permission was reserved. Submit a new explicit request.";
const metaRows = (sql: SqlClient.SqlClient) => Effect.map(sql.unsafe<{key: string; value: string}>("SELECT key,value FROM meta ORDER BY key"),
  (rows) => rows.map((row): [string, string] => [row.key, row.value]));
// the supervision meta rows, without the guidance store's own settings row that its layer writes first
const supervisionMetaRows = (sql: SqlClient.SqlClient) => Effect.map(metaRows(sql), (rows) => rows.filter(([key]) => key !== "settings"));
const tableRows = (sql: SqlClient.SqlClient, table: string) => Effect.map(sql.unsafe<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY rowid`), (rows) => rows.map((row) => ({...row})));
const documentOf = (sql: SqlClient.SqlClient, mainThreadId: string) =>
  Effect.map(sql`SELECT document FROM supervisor_main_bindings WHERE main_thread_id=${mainThreadId}`, ([row]) => String(row?.document));

const proposedWorkflow = {status: "proposed" as const, message: "Current draft", workspaceRoot: "/work/a", revision: "definitions-1", globalRevision: null,
  definitionsStatus: "ready" as const, definitionsComplete: true, requirementsKnown: true, requirements: [], issues: [], plan: null};
const inferredTask = (supervisorThreadId: string): TaskRecord => ({id: "task-inferred", threadId: "main-inferred", projectId: "project-a", sourceRunId: "run-1", sourceMessageId: "message-1",
  sourceHash: "hash-1", status: "inferred", objective: "Export CSV", reason: "Interpreted.", updatedAt: 100, requestText: "Add CSV export", supervisorThreadId,
  messageId: "notice-1", dispatchedAt: 50, replayCount: 0, supervisorRunId: "supervisor-run-1", sourceOrdinal: 1, workflow: proposedWorkflow,
  agreement: {status: "agreed", message: "Agreed.", proposalId: "proposal-1", agreedAt: 90, evidence: {kind: "supervisor_message", messageId: "supervisor-message-1"}, agentMessageId: "agent-message-1", workflow: proposedWorkflow}});
const queuedTask = (threadId: string, supervisorThreadId: string, dispatchedAt: number | null): TaskRecord => ({id: `task-${threadId}`, threadId, projectId: "project-a",
  sourceRunId: "run-2", sourceMessageId: "message-2", sourceHash: "hash-2", status: "queued", objective: null, reason: "Queued for interpretation.", updatedAt: 110,
  requestText: "Interpret this request", supervisorThreadId, messageId: `notice-${threadId}`, dispatchedAt, replayCount: 0, supervisorRunId: null, sourceOrdinal: 2,
  definitionContext: null, definitionReadAttempts: 1, revalidationAttempts: 1});

const pssBoundary = {snapshotSequence: 7, threads: [{id: "main-a", latestRunId: "run-a"}]};
// the pre-migration on-disk format of the supervision meta rows (CT-PSS-06); the guidance store's own settings row is checked apart
const pssMetaGolden: Array<[string, string]> = [
  ["supervisor_activation_baseline", "{\"snapshotSequence\":7,\"threads\":[{\"id\":\"main-a\",\"latestRunId\":\"run-a\"}],\"version\":2}"],
  ["supervisor_activation_sequence", "7"],
  ["supervisor_control:\"project-a\"", "{\"generation\":1,\"enabled\":true,\"manual\":true,\"baseline\":{\"snapshotSequence\":7,\"threads\":[{\"id\":\"main-a\",\"latestRunId\":\"run-a\"}]}}"],
  ["supervisor_control:\"project-c\"", "{\"generation\":0,\"enabled\":false,\"manual\":false,\"baseline\":{\"snapshotSequence\":7,\"threads\":[{\"id\":\"main-a\",\"latestRunId\":\"run-a\"}]}}"],
  ["supervisor_control:null", "{\"generation\":1,\"enabled\":true,\"manual\":true}"],
  ["supervisor_control_auto:\"project-c\"", "{\"status\":\"present\",\"enabled\":true,\"checkedAt\":1790000000000}"],
  ["supervisor_control_presence_unavailable:\"project-b\"", "{\"checkedAt\":1790000000000}"],
  ["supervisor_global_definitions_control", "{\"generation\":1,\"enabled\":true,\"manual\":true}"],
  ["supervisor_global_definitions_event", "{\"generation\":1,\"enabled\":true,\"changedAt\":1790000000000,\"globalFingerprint\":\"global-fingerprint\"}"],
  ["supervisor_no_project", "{\"generation\":1,\"mode\":\"automatic\",\"baseline\":{\"snapshotSequence\":7,\"threads\":[{\"id\":\"main-a\",\"latestRunId\":\"run-a\"}]}}"],
  ["supervisor_scope_version", "main-v1"],
  ["supervisor_start:main-a", "{\"threadId\":\"main-a\",\"projectId\":\"project-a\",\"operationId\":\"op-1\",\"requestHash\":\"hash-1\",\"route\":\"ui\",\"status\":\"active\",\"reason\":\"Supervision is enabled until explicit Stop. Settlement only parks the Supervisor.\",\"intentAt\":1790000000000,\"modeGeneration\":1,\"masterGeneration\":1,\"taskId\":null}"],
  ["supervisor_start_operation:[\"main-a\",\"op-1\"]", "{\"threadId\":\"main-a\",\"operationId\":\"op-1\",\"requestHash\":\"hash-1\",\"status\":\"active\",\"reason\":\"Supervision is enabled until explicit Stop. Settlement only parks the Supervisor.\"}"],
  ["supervisor_unbound_stop:main-b", "{\"route\":\"ui\",\"callerThreadId\":null,\"userMessageId\":null,\"stoppedAt\":1790000000000}"],
];
const pssDdlGolden = [
  ["supervisor_chat_enables", "CREATE TABLE supervisor_chat_enables(thread_id TEXT PRIMARY KEY,enabled_at INTEGER NOT NULL)"],
  ["supervisor_definition_user_saves", "CREATE TABLE supervisor_definition_user_saves(project_id TEXT NOT NULL,workspace_root TEXT NOT NULL,signature TEXT NOT NULL,saved_at INTEGER NOT NULL,expected_revision TEXT NOT NULL,PRIMARY KEY(project_id,workspace_root))"],
  ["supervisor_main_bindings", "CREATE TABLE supervisor_main_bindings(project_id TEXT NOT NULL,main_thread_id TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(project_id,main_thread_id))"],
  ["supervisor_owned_threads", "CREATE TABLE supervisor_owned_threads(id TEXT PRIMARY KEY)"],
  ["supervisor_project_settings", "CREATE TABLE supervisor_project_settings(project_id TEXT PRIMARY KEY,document TEXT NOT NULL)"],
  ["supervisor_task_interpretations", "CREATE TABLE supervisor_task_interpretations(thread_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,document TEXT NOT NULL,updated_at INTEGER NOT NULL)"],
  ["supervisor_tasks_project", "CREATE INDEX supervisor_tasks_project ON supervisor_task_interpretations(project_id)"],
  ["meta", "CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)"],
];
const pssDdl = (sql: SqlClient.SqlClient) => Effect.map(
  sql.unsafe<{name: string; sql: string}>("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL AND (name GLOB 'supervisor_*' OR name='meta') ORDER BY name='meta',name"),
  (rows) => rows.map((row) => [row.name, row.sql]).filter(([name]) => pssDdlGolden.some(([golden]) => golden === name)));

it.live("CT-PSS-01: a Start operation left preparing is rejected when the layer is built again and every other operation stays as stored", () => live(Effect.gen(function* () {
  const directory = yield* temporaryDataDirectory("pss-service-01-");
  const first = yield* reopenGuidanceStores(directory);
  yield* first.supervisors.saveStartOperation({threadId: "main-a", operationId: "op-pending", requestHash: "hash-pending", status: "pending", reason: "Waiting."});
  yield* first.supervisors.saveStartOperation({threadId: "main-a", operationId: "op-settled", requestHash: "hash-settled", status: "denied", reason: "Denied.", preparing: false});
  yield* first.supervisors.saveStartOperation({threadId: "main-a", operationId: "op-crash", requestHash: "hash-crash", status: "pending", reason: "Reserving.", preparing: true});
  yield* first.supervisors.saveStart({threadId: "main-b", projectId: "project-b", operationId: "op-active", requestHash: "hash-active", route: "ui", status: "active",
    reason: "Supervision is enabled until explicit Stop. Settlement only parks the Supervisor.", intentAt: 100, modeGeneration: 0, masterGeneration: 0, taskId: null});
  const crashKey = 'supervisor_start_operation:["main-a","op-crash"]';
  const untouched = (yield* metaRows(first.sql)).filter(([key]) => key !== crashKey);
  yield* first.close;

  const second = yield* reopenGuidanceStores(directory);
  const rows = yield* metaRows(second.sql);
  assert.deepEqual(rows.find(([key]) => key === crashKey), [crashKey, JSON.stringify({threadId: "main-a", operationId: "op-crash", requestHash: "hash-crash",
    status: "rejected", reason: interruptedStartReason, preparing: false})]);
  assert.deepEqual(rows.filter(([key]) => key !== crashKey), untouched, "other Start rows are unchanged");
  assert.deepEqual(yield* second.supervisors.startOperation("main-a", "op-crash"), {threadId: "main-a", operationId: "op-crash", requestHash: "hash-crash",
    status: "rejected", reason: interruptedStartReason, preparing: false});
  assert.deepEqual(yield* second.supervisors.startOperation("main-a", "op-pending"), {threadId: "main-a", operationId: "op-pending", requestHash: "hash-pending", status: "pending", reason: "Waiting."});
  assert.equal(yield* second.supervisors.start("main-a"), null, "no Start record was activated");
})), {timeout: 10_000});

it.live("CT-PSS-02: concurrent reservations of one main yield one owned root and concurrent saves at the active-task boundary admit exactly one", () => live(Effect.gen(function* () {
  const f = yield* guidanceStoresFixture("pss-service-02-");
  const [left, right] = yield* Effect.all([
    f.supervisors.reserve("project-a", "main-a", "Main", defaultSupervisorModel, 1, 100),
    f.supervisors.reserve("project-a", "main-a", "Main", defaultSupervisorModel, 1, 100),
  ], {concurrency: "unbounded"});
  assert.equal(left.threadId, right.threadId, "both callers receive the one reserved root");
  assert.deepEqual(yield* tableRows(f.sql, "supervisor_owned_threads"), [{id: left.threadId}]);
  assert.equal((yield* tableRows(f.sql, "supervisor_main_bindings")).length, 1);
  assert.deepEqual([...f.owned], [left.threadId]);

  for (let index = 0; index < 99; index++) yield* f.supervisors.saveTask(queuedTask(`main-${index}`, left.threadId, null));
  const results = yield* Effect.all([
    f.supervisors.saveTask(queuedTask("main-left", left.threadId, null)),
    f.supervisors.saveTask(queuedTask("main-right", left.threadId, null)),
  ], {concurrency: "unbounded", mode: "result"});
  const admitted = results.filter((result) => result._tag === "Success");
  const refused = results.flatMap((result) => result._tag === "Failure" ? [result.failure] : []);
  assert.equal(admitted.length, 1, "exactly one new active task is admitted at the boundary");
  assert.deepEqual(refused.map((error) => error.reason), ["supervisor_task_capacity"]);
  assert.equal((yield* f.supervisors.tasks("project-a")).filter((task) => task.status === "queued").length, 100);
})), {timeout: 10_000});

it.live("CT-PSS-03: a stale binding copy keeps the stored stop and notice, and the notice CAS honours the expected messageId", () => live(Effect.gen(function* () {
  const {ids, sql, supervisors: store} = yield* guidanceStoresFixture("pss-service-03-");
  const binding = yield* store.reserve("project-a", "main-a", "Main", defaultSupervisorModel, 1, 100);
  const stale = (yield* store.binding("project-a", "main-a"))!;
  yield* store.setBinding({...stale, manualKeepActive: true, stopObservedAt: 150});
  const stop: NonNullable<BindingRecord["supervisionStop"]> = {route: "ui", callerThreadId: null, userMessageId: null, stoppedAt: 200};
  yield* store.setSupervisionStop(binding, stop);
  const stopped = (yield* store.binding("project-a", "main-a"))!;
  assert.deepEqual(stopped.supervisionStop, stop);
  assert.equal("manualKeepActive" in stopped || "stopObservedAt" in stopped, false, "a Stop clears keep-active and the observed stop marker");

  const notice = yield* prepareStopNotice(ids, binding, 200, null);
  yield* store.setStopNotice(binding, null, notice);
  assert.deepEqual((yield* store.binding("project-a", "main-a"))!.stopNotice, notice, "expected null on an absent notice succeeds");
  assert.equal((yield* store.binding("project-a", "main-a"))!.stopNotice!.enabledAt, null);

  yield* store.setBinding({...stale, state: "ready", title: "Supervisor · Renamed"});
  const merged = (yield* store.binding("project-a", "main-a"))!;
  assert.equal(merged.state, "ready");
  assert.equal(merged.title, "Supervisor · Renamed");
  assert.deepEqual(merged.supervisionStop, stop, "the stale copy without a stop keeps the stored stop");
  assert.deepEqual(merged.stopNotice, notice, "the stale copy without a notice keeps the stored notice");
  yield* store.setBinding({...stale, supervisionStop: {...stop, stoppedAt: 1}, stopNotice: {...notice, messageId: "supervisor-notice:stop:other", state: "sent"}});
  assert.deepEqual((yield* store.binding("project-a", "main-a"))!.supervisionStop, stop, "a stale copy cannot replace the stored stop");
  assert.deepEqual((yield* store.binding("project-a", "main-a"))!.stopNotice, notice, "a stale copy cannot replace the stored notice");

  const beforeWrongCas = yield* documentOf(sql, "main-a");
  yield* store.setStopNotice(binding, "supervisor-notice:stop:wrong", {...notice, state: "sent"});
  assert.equal(yield* documentOf(sql, "main-a"), beforeWrongCas, "a wrong expected messageId is a no-op");
  yield* store.setStopNotice(binding, null, {...notice, messageId: "supervisor-notice:stop:replacement"});
  assert.equal(yield* documentOf(sql, "main-a"), beforeWrongCas, "expected null on a present notice is a no-op");
  yield* store.setStopNotice(binding, notice.messageId, {...notice, state: "accepted"});
  assert.deepEqual((yield* store.binding("project-a", "main-a"))!.stopNotice, {...notice, state: "accepted"}, "the matching expected messageId replaces the notice");

  yield* store.setSupervisionStop(binding, null);
  yield* store.setBinding({...stale, supervisionStop: stop});
  assert.equal("supervisionStop" in (yield* store.binding("project-a", "main-a"))!, false, "a stale copy cannot restore a cleared stop");
})), {timeout: 10_000});

it.live("CT-PSS-05: the layer preloads committed ownership into the shared set before any call, and a reservation joins it only after the outermost commit", () => live(Effect.gen(function* () {
  const directory = yield* temporaryDataDirectory("pss-service-05-");
  const fresh = new Set<string>();
  const first = yield* reopenGuidanceStores(directory, {owned: fresh});
  assert.deepEqual([...fresh], [], "a fresh file owns nothing");
  const a = yield* first.supervisors.reserve("project-a", "main-a", "Main A", defaultSupervisorModel, 1, 100);
  yield* first.sql`INSERT INTO supervisor_owned_threads VALUES(${"legacy-supervisor-helper"})`;

  // a reservation inside a caller's transaction that then fails leaves neither a row nor an id
  const rolledBack = yield* Effect.exit(first.sql.withTransaction(Effect.gen(function* () {
    yield* first.supervisors.reserve("project-a", "main-rolled-back", "Main R", defaultSupervisorModel, 1, 100);
    return yield* Effect.fail("caller_failed" as const);
  })));
  assert.ok(Exit.isFailure(rolledBack));
  assert.equal((yield* first.supervisors.binding("project-a", "main-rolled-back")), null);
  assert.deepEqual([...fresh].sort(), [a.threadId]);

  // inside a committing caller transaction the id is absent until the outermost commit
  let insideCommit: boolean | null = null;
  const b = yield* first.sql.withTransaction(Effect.gen(function* () {
    const reserved = yield* first.supervisors.reserve("project-a", "main-b", "Main B", defaultSupervisorModel, 1, 100);
    insideCommit = fresh.has(reserved.threadId);
    return reserved;
  }));
  assert.equal(insideCommit, false, "the id waits for the outermost commit");
  assert.equal(fresh.has(b.threadId), true);
  yield* first.close;

  const preloaded = new Set<string>(["supervisor-root:already-known"]);
  yield* reopenGuidanceStores(directory, {owned: preloaded});
  assert.deepEqual([...preloaded].sort(), [a.threadId, b.threadId, "legacy-supervisor-helper", "supervisor-root:already-known"].sort(),
    "committed rows join the shared set when the layer is built");
})), {timeout: 10_000});

it.effect("CT-PSS-06: the supervision DDL and every meta key format are golden and read back unchanged after reopen", () => live(Effect.gen(function* () {
  const directory = yield* temporaryDataDirectory("pss-service-06-");
  const writer = yield* reopenGuidanceStores(directory);
  yield* TestClock.setTime(1_790_000_000_000);
  yield* writer.supervisors.baseline(pssBoundary);
  yield* writer.supervisors.saveControl(null, 0, true, pssBoundary);
  yield* writer.supervisors.saveControl("project-a", 0, true, pssBoundary);
  yield* writer.supervisors.recordFolderPresence("project-b", {status: "unavailable", message: "denied"});
  yield* writer.supervisors.recordFolderPresence("project-c", {status: "present"}, pssBoundary);
  yield* writer.supervisors.saveNoProjectControl(0, "automatic", pssBoundary);
  yield* writer.supervisors.saveGlobalDefinitionsControl(0, true, "~/.t3-supervisor", "global-fingerprint");
  yield* writer.supervisors.saveStart({threadId: "main-a", projectId: "project-a", operationId: "op-1", requestHash: "hash-1", route: "ui", status: "active",
    reason: "Supervision is enabled until explicit Stop. Settlement only parks the Supervisor.", intentAt: 1_790_000_000_000, modeGeneration: 1, masterGeneration: 1, taskId: null});
  yield* writer.supervisors.saveUnboundStop("main-b", {route: "ui", callerThreadId: null, userMessageId: null, stoppedAt: 1_790_000_000_000});
  assert.deepEqual(yield* supervisionMetaRows(writer.sql), pssMetaGolden);
  assert.deepEqual(yield* pssDdl(writer.sql), pssDdlGolden);
  const written = yield* metaRows(writer.sql);
  // settings preserve their fields and values; harmless JSON key order is not a storage contract
  assert.deepEqual(written.filter(([key]) => key === "settings").map(([key, value]) => [key, JSON.parse(value)]), [["settings", {generation: 1, evidenceHours: 24}]]);
  yield* writer.close;

  const {sql, supervisors: store} = yield* reopenGuidanceStores(directory);
  assert.deepEqual(yield* supervisionMetaRows(sql), pssMetaGolden, "opening rewrites no meta row");
  assert.deepEqual(yield* metaRows(sql), written, "opening rewrites no meta row, the guidance settings row included");
  assert.deepEqual(yield* pssDdl(sql), pssDdlGolden);
  assert.equal(store.scopeCompatible, true);
  assert.deepEqual(yield* store.control(null), {projectId: null, generation: 1, enabled: true, manual: true, globallyEnabled: true, effectiveEnabled: true,
    detectionStatus: "not_checked", detectionError: null});
  assert.deepEqual(yield* store.control("project-a"), {projectId: "project-a", generation: 1, enabled: true, manual: true, globallyEnabled: true, effectiveEnabled: true,
    detectionStatus: "not_checked", detectionError: null});
  assert.deepEqual(yield* store.projectBoundary("project-a"), pssBoundary);
  assert.equal(yield* store.folderPresenceNeedsBoundary("project-b"), true);
  assert.deepEqual(yield* store.control("project-b"), {projectId: "project-b", generation: 0, enabled: false, manual: false, globallyEnabled: true, effectiveEnabled: false,
    detectionStatus: "not_checked", detectionError: null});
  assert.equal(yield* store.autoControlInitialized("project-c"), true);
  assert.deepEqual(yield* store.control("project-c"), {projectId: "project-c", generation: 0, enabled: true, manual: false, globallyEnabled: true, effectiveEnabled: true,
    detectionStatus: "present", detectionError: null});
  assert.deepEqual(yield* store.noProjectControl(), {generation: 1, mode: "automatic", baseline: pssBoundary, globallyEnabled: true});
  assert.deepEqual(yield* store.globalDefinitionsControl(), {generation: 1, enabled: true, manual: true, effectiveEnabled: true, homePath: "~/.t3-supervisor",
    detectionStatus: "not_checked", detectionError: null});
  assert.equal(yield* store.hasGlobalDefinitionsEvent(), true);
  assert.deepEqual(yield* store.baseline(), {...pssBoundary, version: 2});
  assert.equal(yield* store.activation(), 7);
  assert.deepEqual(yield* store.start("main-a"), JSON.parse(pssMetaGolden.find(([key]) => key === "supervisor_start:main-a")![1]));
  assert.deepEqual(yield* store.startOperation("main-a", "op-1"), {threadId: "main-a", operationId: "op-1", requestHash: "hash-1", status: "active",
    reason: "Supervision is enabled until explicit Stop. Settlement only parks the Supervisor."});
  assert.deepEqual(yield* store.chatStop("main-b"), {route: "ui", callerThreadId: null, userMessageId: null, stoppedAt: 1_790_000_000_000});
  assert.deepEqual(yield* metaRows(sql), written, "reads write nothing, the guidance settings row included");
})), {timeout: 10_000});

it.live("CC-CONTROL and CC-NOPROJECT-DEFAULT: every control has its own generation CAS, No Project defaults to On request and shared definitions never activate it", () => live(Effect.gen(function* () {
  const {supervisors: store} = yield* guidanceStoresFixture("pss-service-control-");
  assert.deepEqual(yield* store.noProjectControl(), {generation: 0, mode: "on_request", globallyEnabled: true});
  assert.deepEqual(yield* store.control(null), {projectId: null, generation: 0, enabled: true, manual: true, globallyEnabled: true, effectiveEnabled: true,
    detectionStatus: "not_checked", detectionError: null});
  assert.equal((yield* store.control("project-a")).enabled, false);
  assert.deepEqual(yield* store.globalDefinitionsControl(), {generation: 0, enabled: false, manual: false, effectiveEnabled: false, homePath: "~/.t3-supervisor",
    detectionStatus: "not_checked", detectionError: null});
  assert.equal(yield* store.useGlobalDefinitions("project-a"), false);
  yield* store.saveGlobalDefinitionsControl(0, true, "~/.t3-supervisor", "global-1");
  assert.deepEqual(yield* store.noProjectControl(), {generation: 0, mode: "on_request", globallyEnabled: true}, "shared definitions never activate No Project");

  // each control refuses a stale generation on its own counter, and leaves the others unchanged
  yield* failsWith(store.saveNoProjectControl(1, "automatic", pssBoundary), /^no_project_control_conflict$/u);
  yield* failsWith(store.saveControl(null, 1, false), /^supervision_control_conflict$/u);
  yield* failsWith(store.saveControl("project-a", 2, true, pssBoundary), /^supervision_control_conflict$/u);
  yield* failsWith(store.saveGlobalDefinitionsControl(0, false), /^global_definitions_control_conflict$/u);
  yield* failsWith(store.saveSettings("project-a", 1, defaultSupervisorModel), /^project_settings_conflict$/u);
  yield* failsWith(store.saveControl("project-a", 0, true), /^supervision_control_baseline_required$/u);
  yield* store.saveControl(null, 0, false);
  assert.deepEqual([(yield* store.control(null)).generation, (yield* store.control("project-a")).generation, (yield* store.noProjectControl()).generation,
    (yield* store.globalDefinitionsControl()).generation, (yield* store.settings("project-a")).generation], [1, 0, 0, 1, 0]);

  // a No Project mode change rejects pending Starts in its own transaction
  yield* store.saveStart({threadId: "main-x", projectId: "scratch", operationId: "op-x", requestHash: "hash-x", route: "agent", status: "pending",
    reason: "Waiting.", intentAt: 10, modeGeneration: 0, masterGeneration: 0, taskId: null});
  yield* store.saveNoProjectControl(0, "automatic", pssBoundary);
  assert.deepEqual([(yield* store.start("main-x"))?.status, (yield* store.start("main-x"))?.reason], ["rejected", "Superseded by a No Project mode change."]);
  assert.deepEqual(yield* store.startOperation("main-x", "op-x"), {threadId: "main-x", operationId: "op-x", requestHash: "hash-x", status: "rejected",
    reason: "Superseded by a No Project mode change."});

  // two saves at one generation: exactly one is admitted
  const results = yield* Effect.all([store.saveControl("project-a", 0, true, pssBoundary), store.saveControl("project-a", 0, true, pssBoundary)],
    {concurrency: "unbounded", mode: "result"});
  assert.equal(results.filter((result) => result._tag === "Success").length, 1);
  assert.deepEqual(results.flatMap((result) => result._tag === "Failure" ? [result.failure.reason] : []), ["supervision_control_conflict"]);
  assert.equal((yield* store.control("project-a")).generation, 1);
})), {timeout: 10_000});

it.effect("CC-CLOCK-WALL and CC-IDS: store times come from Clock and root identities from SupervisorIds in the persisted formats", () => live(Effect.gen(function* () {
  const {sql, supervisors: store} = yield* guidanceStoresFixture("pss-service-clock-", {ids: countingIds});
  yield* TestClock.setTime(1_800_000_000_000);
  const root = yield* store.reserve("project-a", "main-a", "Main", defaultSupervisorModel, 1, 1);
  assert.equal(root.threadId, "supervisor-root:00000000-0000-4000-8000-000000000001");
  yield* store.setBinding({...root, state: "missing"});
  yield* store.saveTask({...inferredTask(root.threadId), threadId: "main-a"});
  const replaced = yield* store.replaceMissingBinding({...root, state: "missing"}, defaultSupervisorModel);
  assert.equal(replaced.threadId, "supervisor-root:00000000-0000-4000-8000-000000000002");
  assert.equal((yield* store.task("main-a"))?.updatedAt, 1_800_000_000_000, "the staled agreement is stamped with Clock time");
  yield* store.recordFolderPresence("project-b", {status: "unavailable"});
  const [marker] = yield* sql`SELECT value FROM meta WHERE key=${'supervisor_control_presence_unavailable:"project-b"'}`;
  assert.equal(marker?.value, JSON.stringify({checkedAt: 1_800_000_000_000}));
})), {timeout: 10_000});
