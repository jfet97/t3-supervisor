import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Schema } from "effect";
import { MonitoringStatus } from "../../src/project-supervisor-contract.js";
import { PlanningAttempt } from "../../src/supervisor-planning-contract.js";
import { WorkflowProgressSnapshotSchema } from "../../src/workflow-progress.js";
import { fixtureJourney } from "./journey.js";
import { returnedSupervision } from "./returned.js";

it("the returned-work scene passes the public API decoders and keeps first-attempt evidence beside reopened work", () => {
  const now = Date.UTC(2026, 9, 27, 18);
  const scene = fixtureJourney("returned", "fixture-project", "fixture-operative", "fixture-supervisor", now);
  const progress = Schema.decodeUnknownSync(WorkflowProgressSnapshotSchema)(scene.progress);
  const workflow = progress.workflows[0]!;
  assert.equal(workflow.historyComplete, true);
  assert.deepEqual(workflow.history?.map(event => event.attempt), [1, 1, 1, 2, null, 2]);
  assert.deepEqual(workflow.history?.filter(event => event.operationId === "fixture-op-return").map(event => event.kind), ["return_applied", "status_changed"], "the return and its task status share one write");
  assert.equal(workflow.returns?.[0]?.retiredRuns.length, 2);
  assert.deepEqual(workflow.returns?.[0]?.closedSelections?.map(selection => [selection.nodeId, selection.revision, selection.path, selection.sourceMessageId]), [["packing-redo-decision", 1, "then", "fixture-redo-selection-1"]]);
  assert.equal(workflow.branchSelections?.[0]?.current, false, "the closed attempt's selection is invalidated by the return");
  assert.equal(progress.scope?.threads.length, 3);
  const implement = workflow.plan?.nodes.find(node => node.kind === "step" && node.nodeId === "packing-implement");
  assert.ok(implement?.kind === "step");
  assert.equal(implement.status, "underway");
  const supervision = returnedSupervision("fixture-project", "fixture-operative", "fixture-supervisor", now);
  const monitoring = Schema.decodeUnknownSync(MonitoringStatus)(supervision.monitoringStatus);
  assert.equal(monitoring.awareness?.reads.filter(read => read.partial).length, 1);
  for (const attempt of supervision.planning ?? []) assert.equal(Schema.decodeUnknownSync(PlanningAttempt)(attempt).state, "resolved");
});
