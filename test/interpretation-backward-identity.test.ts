import assert from "node:assert/strict";
import {it} from "vitest";
import {interpretationPlanDigest} from "../src/interpretation-evidence.js";
import {preserveOccurrenceIds} from "../src/supervision-conversation.js";
import {planBackTos} from "../src/workflow-plan-tree.js";
import {proposalContextFromDefinitions, validateWorkflowPlan} from "../src/supervisor-workflow.js";
import type {WorkflowPlanGroupInfo} from "../src/project-supervisor-contract.js";
import {goldenSnapshot} from "./support/c1-workflow-fixture.js";

it("preserving occurrence IDs keeps interpretation evidence current for a resolved backward transition", () => {
  const context = proposalContextFromDefinitions({...goldenSnapshot, steps: [], workflows: [], config: {steps: [], workflows: []}, projectConfig: {steps: [], workflows: []}});
  const step = (id: string) => ({kind: "step", localId: id, definitionId: null, name: id, description: `Complete ${id}.`, reason: `The task needs ${id}.`});
  const draft = (target: string) => validateWorkflowPlan({requirements: [], plan: {kind: "sequence", nodes: [step("work"), step("verify"),
    {kind: "branch", condition: "Corrections are needed.", reason: "The findings determine the next work.", then: {kind: "sequence", nodes: [
      {kind: "back_to", target, maximum: 5, reason: "Repeat the affected work."}]}}]}}, context)!;
  const submitted = draft("work");
  assert.ok(submitted.plan);
  const prior = JSON.parse(JSON.stringify(submitted.plan, (key, value: unknown) => key === "nodeId" ? `retained-${String(value)}` : value)) as WorkflowPlanGroupInfo;
  const retained = {...submitted, plan: preserveOccurrenceIds(submitted.plan, prior)};
  assert.notEqual(planBackTos(retained.plan)[0]!.targetNodeId, planBackTos(submitted.plan)[0]!.targetNodeId);
  assert.equal(interpretationPlanDigest(retained), interpretationPlanDigest(submitted), "resolved occurrence pointers are representation, while the fixed target remains part of the plan");
  assert.notEqual(interpretationPlanDigest(retained), interpretationPlanDigest(draft("verify")), "changing the actual destination changes the interpretation identity");
});
