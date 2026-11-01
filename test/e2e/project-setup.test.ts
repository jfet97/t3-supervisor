import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { repositoryRoot } from "../../scripts/local-run.js";
import { forgeDashboardToken } from "../../src/service-auth.js";
import type { SupervisionControlInfo } from "../../src/supervisor-control-contract.js";
import { journeyPage } from "../support/browser.js";
import { httpJson } from "../support/glinint-wiring.js";
import { startupProjectId, startupSession } from "../support/startup-gateway.js";
import { dashboard, supervisionSetupPath } from "./dashboard.js";

/*
  A person enables supervision of a project whose checkout has no .t3-supervisor folder (docs/testing.md, UI-STORY-07, setup).
  Enabling asks for first-time setup; the person chooses the project's checkout and creates the definition files. The
  dashboard creates them through T3 and enables the project, and its reply is lost on the way back: the page cannot confirm
  the setup, so it keeps setup and the project's switch fenced and sends nothing again. Only a setup read that starts after
  the request ended lifts the fence; it finds the files T3 wrote, and reading the switch again shows the project enabled.

  The production Supervisor runs over the scripted T3 peer with a checkout that T3 writes through the dedicated project-write
  credential; detection finds no definition folder, so the project starts off. Faults act only between the browser and the
  dashboard. The saved switch is read back through the dashboard API with the browser's own session after the visible state
  settled; the scripted T3 records every file it wrote.
*/

const project = startupProjectId;
const unconfirmedSetup = "The setup outcome could not be confirmed. Reload and inspect the selected checkout before trying again.";

// a signed-in dashboard over a checkout without a .t3-supervisor folder, and the project's saved switch, owned by the test's scope
const signedIn = (name: string) => Effect.gen(function* () {
  const supervisor = yield* startupSession({uiAssetsDirectory: join(repositoryRoot, "ui-dist"), checkout: {}});
  const {page} = yield* journeyPage(name);
  const ui = yield* dashboard(page, supervisor.app.origin);
  const {token} = yield* forgeDashboardToken(supervisor.app.dataDirectory).pipe(Effect.orDie);
  yield* ui.signIn(token);
  const savedSwitch = Effect.gen(function* () {
    const reply = yield* httpJson(`${supervisor.app.origin}/api/guidance/supervision-control?${new URLSearchParams({projectId: project})}`,
      {headers: {"x-supervisor-session": yield* ui.session}});
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const {enabled, manual} = reply.body as SupervisionControlInfo;
    return {enabled, manual};
  });
  return {supervisor, ui, savedSwitch};
}).pipe(Effect.provide(NodeFileSystem.layer));

it.live("an unconfirmed first-time setup stays fenced until a later setup read, which finds the files T3 wrote, and nothing is sent again", () => Effect.gen(function* () {
  const {supervisor, ui, savedSwitch} = yield* signedIn("setup-unconfirmed");
  const checkout = `${supervisor.app.workspaceRoot} \u2014 Git branch undetected`;
  yield* ui.openProjectSettings(project);
  yield* ui.switchOffered("project", "Enable supervision");
  yield* ui.switchStatusShown("project", "Project supervision: Off");
  assert.deepEqual(yield* savedSwitch, {enabled: false, manual: false}, "detection found no definition folder");

  // enabling asks for first-time setup, whose Create waits for a chosen checkout
  yield* ui.clickSwitch("project", "Enable supervision");
  yield* ui.headingShown("First-time setup");
  assert.equal(yield* ui.buttonDisabled("Create"), true, "Create waits for a chosen checkout");
  yield* ui.choose("Checkout", checkout);
  yield* ui.textShown("Existing setup: missing.");

  // the dashboard creates the files through T3 and enables the project; the reply is lost on its way back
  yield* ui.injectFault("reply-lost-after-apply", 1, supervisionSetupPath);
  yield* ui.clickButton("Create");
  yield* ui.statusShown(unconfirmedSetup);
  assert.deepEqual(ui.answers().map((answer) => answer.status), [200], "the dashboard applied the forwarded setup");
  assert.equal(yield* ui.buttonDisabled("Create"), true, "setup stays fenced");
  assert.equal(yield* ui.switchDisabled("project", "Enable supervision"), true, "the project's switch stays fenced too");
  assert.deepEqual(supervisor.observe.checkoutWrites(), [".t3-supervisor/project.yaml", ".t3-supervisor/steps/.gitkeep", ".t3-supervisor/workflows/.gitkeep"]);
  assert.deepEqual(yield* savedSwitch, {enabled: true, manual: true}, "the setup enabled the project");

  // a setup read that starts after the request ended lifts the fence and finds the definition folder T3 wrote
  yield* ui.clickButton("Reload setup");
  yield* ui.textGone(unconfirmedSetup);
  assert.equal(yield* ui.switchDisabled("project", "Enable supervision"), false, "the later read lifted the fence");
  yield* ui.choose("Checkout", checkout);
  yield* ui.textShown("Existing setup: present.");
  yield* ui.buttonShown("Enable existing definitions");
  assert.equal(yield* ui.buttonDisabled("Create"), true, "the folder exists now");

  // reading the switch again shows the project enabled by the applied setup
  yield* ui.reloadSwitch("project");
  yield* ui.switchOffered("project", "Disable supervision");
  yield* ui.switchStatusShown("project", "Project supervision: On");

  // one setup and one switch change, each for its explicit click; the fence, the reads and the choices sent none
  assert.deepEqual(ui.setups(), [{expectedWorkspaceRoot: supervisor.app.workspaceRoot, action: "create"}]);
  assert.deepEqual(ui.switchChanges(), [{projectId: project, enabled: true}]);
  assert.deepEqual(supervisor.observe.checkoutWrites().length, 3, "T3 wrote the scaffold once");
}));
