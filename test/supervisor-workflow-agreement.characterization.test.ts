import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { compactProposalDigest, resolveCompactProposal, workflowAgreementPlanHash } from "../src/supervisor-workflow-agreement.js";
import { canonicalizeProposalDraft, prepareWorkflowRequest } from "../src/supervisor-workflow.js";
import { goldenDraft, goldenPins, goldenProposalId, goldenSeed, goldenSnapshot } from "./support/c1-workflow-fixture.js";

// the digest and the plan hash are pure functions of a fixed fixture proposal: a plain test of their golden values

// re-recorded when workflow template members began deriving their IDs from their occurrence; the plan is otherwise unchanged
const digest = "dee7fb6683a1c2577db2854e1081d48e65512a73ee169566f54a6c3a84fd1d72";
const planHash = "0a24d526a93b40faf3ccfbcc11036242a70d1156b7daab62ecb09f21167a5673";

it("CT-SWA-01: compactProposalDigest and workflowAgreementPlanHash are golden hex values for a fixture proposal", {timeout: 10_000}, () => {
  const context = prepareWorkflowRequest("thread-a", "message-a", "Check this task.", goldenSnapshot).context;
  assert.ok(context);
  const canonical = canonicalizeProposalDraft(goldenDraft, context, goldenSeed);
  assert.ok(canonical.ok);
  const value = {workspaceRoot: "/work/project", revision: "revision-ready", workflow: canonical.workflow};
  assert.equal(compactProposalDigest(goldenPins, value), digest);
  assert.equal(workflowAgreementPlanHash(value), planHash);
  // the chat protocol path stores the same digest for the same draft
  const resolved = resolveCompactProposal({...goldenPins, proposalId: goldenProposalId, revision: "revision-ready", draft: goldenDraft}, goldenPins, context, () => null);
  assert.ok(resolved.ok);
  assert.equal(resolved.proposal.digest, digest);
  assert.equal(resolved.proposal.formal, true);
  assert.equal(workflowAgreementPlanHash(resolved.proposal), planHash);
  // each pin is bound into the digest
  assert.notEqual(compactProposalDigest({...goldenPins, taskRevision: "source-hash-2"}, value), digest);
  assert.notEqual(compactProposalDigest({...goldenPins, taskId: "task-b"}, value), digest);
  assert.equal(workflowAgreementPlanHash({...value}), planHash);
});
