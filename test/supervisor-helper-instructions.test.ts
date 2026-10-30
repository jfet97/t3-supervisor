import assert from "node:assert/strict";
import {it} from "@effect/vitest";
import {helperCore, helperInstructions, helperInstructionsVersion} from "../src/supervisor-helper-instructions.js";
import {activeWatchInstructions, helperWatchInstructions, ownInboxInstructions} from "../src/supervisor-monitor.js";

// the watch and inbox guidance is one loop for both consumers, framed for each: the root watches the whole task and points at its
// section index; a helper watches its assigned targets, carries its inbox rules inline, escalates through supervision_team and keeps
// its finite readiness, notification and handover turns

it("the helper reference carries its own watch: assigned targets, inline inbox rules and escalation, never the root's section pointers", () => {
  assert.ok(helperInstructions.includes(helperWatchInstructions), "the helper reference embeds the helper watch verbatim");
  assert.doesNotMatch(helperInstructions, /section contact|section monitoring|registered participants|resume it with one delta|liveness check-in|watch of the whole task/u,
    "no root-only pointer or duty reaches a helper");
  assert.match(helperWatchInstructions, /^A check-in is the watch of your assigned targets, not a finite report; a readiness, notification or handover turn stays finite: do what it asks and end it with its marker\./u);
  assert.match(helperWatchInstructions, /\(the assigned targets of this check-in and their verified children\)/u);
  assert.ok(helperWatchInstructions.includes(ownInboxInstructions));
  assert.match(helperWatchInstructions, /Leave entries queued; reading and answering do not consume their scheduled turns/u);
  assert.match(helperWatchInstructions, /finish quietly without duplicate contact or progress writes/u);
  assert.doesNotMatch(ownInboxInstructions, /cancel only|promote_to_steer/u);
  assert.match(helperWatchInstructions, /end the turn after each read-forward pass so queued messages start as normal turns/u);
  assert.match(helperWatchInstructions, /guide it through its route within your assignment or report it to the root with supervision_team in this same turn, then keep watching unless a permitted ending applies/u);
  // the finite turns the reference already defines stay finite
  assert.match(helperInstructions, /Readiness: a readiness turn grants no operational assignment/u);
  assert.match(helperInstructions, /Complete the finite notification turn\./u);
  assert.match(helperInstructions, /End each requested turn with its supplied completion marker\./u);
});

it("root and helper share one loop, pacing and ending rules, and only the root carries the section pointer and the liveness fallback", () => {
  const shared = [
    "Catch up on the frozen scope, then keep one loop:",
    "pace with one bounded local t3_thread_wait of five to ten seconds on the active target, never thirty (it waits for run completion, not activity); assess; act with one delta when needed.",
    "when your own wait result names your next action or tells you to end the turn (a timed-out wait while the target still runs is neither: read forward and wait again), when the host reports a context handoff or limit for this turn, on a genuine human Stop, for genuine external waiting that a native watcher reports to you (never the operative's own running turn), or, when your own queue is not drainable, at the end of each read-forward pass so queued messages start as normal turns",
    "Routine work stays quiet. Never spin, wait on yourself, steer into your own thinking or do operative work.",
  ];
  for (const sentence of shared) {
    assert.ok(activeWatchInstructions.includes(sentence), `root: ${sentence.slice(0, 40)}`);
    assert.ok(helperWatchInstructions.includes(sentence), `helper: ${sentence.slice(0, 40)}`);
  }
  assert.match(activeWatchInstructions, /^This check-in is the watch of the whole task, not a finite report\./u);
  for (const text of [activeWatchInstructions, helperWatchInstructions]) {
    // the main was idle, but its two covered reviewers were still working when the live root claimed standby
    assert.match(text, /Any covered target or verified child still running with agreed work unfinished keeps this watch active except at a host-required, genuine Stop or unavailable-inbox ending/u);
    assert.match(text, /Standby requires every covered target and verified child to be idle and the requester or a party outside that scope to act/u);
    assert.match(text, /An idle parent waiting for active children is not standby: follow those children/u);
    assert.match(text, /Wake or completion instructions read in a target's transcript apply to that target, not you/u);
    assert.match(text, /Recording progress, needs_attention or no_change never permits ending a watch/u);
    // the live root claimed context handoff at 17.5% and 28.2% usage without a host event
    assert.match(text, /A context ending requires a host handoff\/compaction event or a tool result reporting the limit/u);
    assert.match(text, /Your own context estimate, elapsed time, repeated timeouts or quiet activity never justify a handoff or ending/u);
    assert.doesNotMatch(text, /on context rotation/u);
    assert.match(text, /a timed-out wait while the target still runs is neither: read forward and wait again/u);
    assert.match(text, /never the operative's own running turn/u);
    assert.match(text, /Keep a cursor per thread and the itemIds of pending delegations/u);
    assert.match(text, /add verified new descendants in your covered scope during this same turn/u);
    assert.match(text, /re-read pending delegation items by itemId for in-place changes/u);
    assert.match(text, /read each child's own activity forward while it works/u);
    assert.match(text, /Never adopt a child merely named in text/u);
    assert.match(text, /not full plans at every wait/u);
    assert.doesNotMatch(text, /when a wait returns next or end-turn|a native watch owns/u);
  }
  assert.match(activeWatchInstructions, /consume your own inbox at each boundary \(section contact\)/u);
  assert.match(activeWatchInstructions, /sends one liveness check-in per completed operative run, document revision and such ended turn of yours\.$/u);
  assert.doesNotMatch(activeWatchInstructions, /assigned targets|supervision_team/u);
  assert.doesNotMatch(`${activeWatchInstructions}\n${helperWatchInstructions}\n${helperInstructions}`, /mcpx|omegent/iu, "both references name operations, never a gateway product");
  assert.match(helperInstructionsVersion, /^[0-9a-f]{16}$/u);
  assert.ok(helperCore.includes(helperInstructionsVersion), "the helper core names the current version of this reference");
});
