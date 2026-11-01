import assert from "node:assert/strict";
import { it } from "vitest";
import { canonicalizeProposalDraft, interpretationRulesVersion, prepareWorkflowRequest, seededNodeIds } from "../src/supervisor-workflow.js";
import { goldenDraft, goldenSeed, goldenSnapshot, sha256 } from "./support/c1-workflow-fixture.js";

const verifySource = {origin: "project", path: ".t3-supervisor/steps/verify.md", sourceId: "project:verify"};
// authored occurrences draw the seeded sequence in traversal order; the delivery members derive their IDs from the delivery
// occurrence and their template paths, so they draw nothing
const nodeIds = [
  "bd4bde5f-85e7-4826-85a9-ca6207432064",
  "450b89ca-0d6e-46ea-b578-0de9d045bd9b",
  "8db04ce4-c9b8-8748-a37b-aa1bc5a200c3",
  "ea97f69f-0b16-8f04-b9d4-e69d920153f7",
  "d697be1c-5471-4f9c-9464-89d20c530cf3",
  "74c841d9-68cd-457a-b008-95cd60191c02",
];
const drawnNodeIds = [nodeIds[0]!, nodeIds[1]!, nodeIds[4]!, nodeIds[5]!];

const canonicalWorkflow = {
  definitionsStatus: "ready",
  definitionsComplete: true,
  requirementsKnown: true,
  requirements: [{kind: "step", id: "verify", name: "Verify behavior", source: verifySource, state: "included", reason: "The task changes behavior."}],
  issues: [],
  plan: {kind: "sequence", templatePath: null, nodes: [
    {kind: "step", nodeId: nodeIds[0], definitionId: "verify", localId: null, templatePath: null, name: "Verify behavior", description: "Check the changed behavior.",
      source: verifySource, resolution: "resolved", reason: "Check the changed behavior.", status: "planned", contributorThreadIds: []},
    {kind: "workflow", nodeId: nodeIds[1], definitionId: "delivery", templatePath: null, name: "Delivery", description: "Use the reusable delivery guidance.", fixed: false,
      source: {origin: "project", path: ".t3-supervisor/workflows/delivery.yaml", sourceId: "delivery"}, resolution: "resolved", reason: "Use the delivery guidance.",
      status: "planned", contributorThreadIds: [], omissions: [],
      plan: {kind: "sequence", templatePath: "workflow:delivery/root", nodes: [
        {kind: "step", nodeId: nodeIds[2], definitionId: null, localId: "subtotal", templatePath: "workflow:delivery/root/0", name: "Review the subtotal",
          description: "Check the subtotal.", source: null, resolution: "resolved", reason: "Declared as a local step in its workflow.", status: "planned", contributorThreadIds: []},
        {kind: "step", nodeId: nodeIds[3], definitionId: "verify", localId: null, templatePath: "workflow:delivery/root/1", name: "Verify behavior",
          description: "Check the changed behavior.", source: verifySource, resolution: "resolved", reason: "Included from workflow verify.", status: "planned", contributorThreadIds: []},
      ]}},
    {kind: "parallel", templatePath: null, nodes: [
      {kind: "step", nodeId: nodeIds[4], definitionId: null, localId: "notes", templatePath: null, name: "Write notes", description: "Record release notes.",
        source: null, resolution: "resolved", reason: "The task needs notes.", status: "planned", contributorThreadIds: []},
      {kind: "step", nodeId: nodeIds[5], definitionId: "publish", localId: null, templatePath: null, name: "Prepare handoff", description: "Write a concise handoff.",
        source: {origin: "project", path: ".t3-supervisor/steps/publish.md", sourceId: "project:publish"}, resolution: "resolved", reason: "Prepare the requested handoff.",
        status: "planned", contributorThreadIds: []},
    ]},
  ]},
};

it("CT-SW-01: canonical plan JSON, seeded node IDs and prompt digests are golden for a fixed seed and fixture", {timeout: 10_000}, () => {
  const taskText = "Check this task. token=github_pat_12345678901234567890";
  const prepared = prepareWorkflowRequest("thread-a", "message-a", taskText, goldenSnapshot);
  assert.ok(prepared.context);
  // notifications contain lookup handles; canonical policy and plan hashes remain unchanged
  assert.equal(prepared.requestText.length, 242);
  // the request names the interpretation rules' current version as a handle; the digests characterize the request around it, so a rule
  // change, which moves that version, moves none of them
  const requestDigest = (text: string): string => {
    assert.ok(text.includes(interpretationRulesVersion), text);
    return sha256(text.replace(interpretationRulesVersion, "<version>"));
  };
  assert.equal(requestDigest(prepared.requestText), "8e0f0b5b5927df58046b197fbaf9d8ea41879edde3f1f0774c9456f4d1a0c4cb");
  assert.equal(prepared.requestText.includes("github_pat_12345678901234567890"), false);
  assert.equal(sha256(JSON.stringify(prepared.context)), "4b22e3c45e9060410b2a752eea3eb602c960836021edd7c79e75d9d8d3e45f4f");
  assert.equal(sha256(JSON.stringify(prepared.workflow)), "a263f8572ef36eca2578bb7f9a3f3e0860a0690bca1f4869eba7ebf4b61d0db4");

  // reader coordinates and task identity are handles; submission pins and source bodies remain on demand.
  const reader = prepareWorkflowRequest("thread-a", "message-a", "Check this task.", goldenSnapshot,
    {reader: {supervisorThreadId: "supervisor-a", bindingGeneration: 3}});
  assert.equal(reader.requestText.length, 311);
  assert.equal(requestDigest(reader.requestText), "c7074b964ec7fc28f93862242e10f3dc88a6e517dc22eb5c6d9a90b9b5b17c29");
  assert.deepEqual(reader.context, prepared.context);
  assert.deepEqual(reader.workflow, prepared.workflow);
  const typed = prepareWorkflowRequest("thread-a", "message-a", "Check this task.", goldenSnapshot,
    {reader: {supervisorThreadId: "supervisor-a", bindingGeneration: 3},
      submission: {supervisorThreadId: "supervisor-a", bindingGeneration: 3, taskId: "task-a", attemptId: "interpretation-attempt:00000000-0000-4000-8000-000000000001",
        sourcePin: {messageId: "message-a", runId: "run-a", ordinal: 1, hash: "0".repeat(64)}, startVerdict: true}});
  assert.equal(typed.requestText.length, 329);
  assert.equal(requestDigest(typed.requestText), "bb5b3720d459e8776dc91dab36e3d925c7871c1b8398f2e8f346532b54ecd4e9");
  assert.deepEqual(typed.context, prepared.context);
  assert.deepEqual(typed.workflow, prepared.workflow);

  const canonical = canonicalizeProposalDraft(goldenDraft, prepared.context, goldenSeed);
  assert.deepEqual(canonical, {ok: true, workflow: canonicalWorkflow});
  // key order and node ID traversal order are part of the golden
  assert.equal(sha256(JSON.stringify(canonical)), "6d73739007242f09dbdd92b51eef1732b61bc6357bac722f05d28fc83f1a6e2e");
  const sequence = seededNodeIds(goldenSeed);
  assert.deepEqual(drawnNodeIds.map(() => sequence()), drawnNodeIds);
  assert.deepEqual(canonicalizeProposalDraft(goldenDraft, prepared.context, goldenSeed), canonical);
});
