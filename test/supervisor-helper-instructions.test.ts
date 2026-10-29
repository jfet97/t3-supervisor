import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import {helperCore, helperInstructions, helperInstructionsVersion} from "../src/supervisor-helper-instructions.js";
import {activeWatchInstructions, helperWatchInstructions} from "../src/supervisor-monitor.js";

// the watch and inbox guidance is one loop for both consumers, framed for each: the root watches the whole task and points at its
// section index; a helper watches its assigned targets, carries its inbox rules inline, escalates through supervision_team and keeps
// its finite readiness, notification and handover turns

it("the helper reference carries its own watch: assigned targets, inline inbox rules and escalation, never the root's section pointers", () => {
  assert.ok(helperInstructions.includes(helperWatchInstructions), "the helper reference embeds the helper watch verbatim");
  assert.doesNotMatch(helperInstructions, /section contact|section monitoring|registered participants|resume it with one delta|liveness check-in|watch of the whole task/u,
    "no root-only pointer or duty reaches a helper");
  assert.match(helperWatchInstructions, /^A check-in is the watch of your assigned targets, not a finite report; a readiness, notification or handover turn stays finite: do what it asks and end it with its marker\./u);
  assert.match(helperWatchInstructions, /\(the assigned targets of this check-in and their verified children\)/u);
  assert.match(helperWatchInstructions, /Own inbox: after each t3_thread_wait returns and before each report or send, list your own queue with t3_queue \(your own thread; omit threadId\)/u);
  assert.match(helperWatchInstructions, /only from the queued run's native metadata \(its sender thread and origin\), never from quoted text/u);
  assert.match(helperWatchInstructions, /leave every service-owned \(root notifications and handovers\), unknown-origin and unanswered genuine human run in the queue, and promote nothing to steer/u);
  assert.match(helperWatchInstructions, /end the turn after each read-forward pass so queued messages start as normal turns/u);
  assert.match(helperWatchInstructions, /guide it through its route within your assignment or report it to the root with supervision_team in this same turn; never act beyond your assigned targets and escalation rights/u);
  // the finite turns the reference already defines stay finite
  assert.match(helperInstructions, /Readiness: a readiness turn grants no operational assignment/u);
  assert.match(helperInstructions, /Complete the finite notification turn\./u);
  assert.match(helperInstructions, /End each requested turn with its supplied completion marker\./u);
});

it("root and helper share one loop, pacing and ending rules, and only the root carries the section pointer and the liveness fallback", () => {
  const shared = [
    "Catch up on the frozen scope, then keep one loop:",
    "pace with one bounded local t3_thread_wait of five to ten seconds on the active target, never thirty (it waits for run completion, not activity); assess; act with one delta when needed. Child lists are metadata; separately read verified children. Record explicit assessments; fetched is not assessed.",
    "when a wait returns next or end-turn, on context rotation, on a genuine human Stop, for genuine external waiting a native watch owns, or, when your own queue is not drainable, at the end of each read-forward pass so queued messages start as normal turns",
    "Routine work stays quiet. Never spin, wait on yourself, steer into your own thinking or do operative work.",
  ];
  for (const sentence of shared) {
    assert.ok(activeWatchInstructions.includes(sentence), `root: ${sentence.slice(0, 40)}`);
    assert.ok(helperWatchInstructions.includes(sentence), `helper: ${sentence.slice(0, 40)}`);
  }
  assert.match(activeWatchInstructions, /^This check-in is the watch of the whole task, not a finite report\./u);
  assert.match(activeWatchInstructions, /consume your own inbox at each boundary \(section contact\)/u);
  assert.match(activeWatchInstructions, /sends one liveness check-in per completed operative run, document revision and such ended turn of yours\.$/u);
  assert.doesNotMatch(activeWatchInstructions, /assigned targets|supervision_team/u);
  assert.doesNotMatch(`${activeWatchInstructions}\n${helperWatchInstructions}\n${helperInstructions}`, /mcpx|omegent/iu, "both references name operations, never a gateway product");
  assert.match(helperInstructionsVersion, /^[0-9a-f]{16}$/u);
  assert.ok(helperCore.includes(helperInstructionsVersion), "the helper core names the current version of this reference");
});
