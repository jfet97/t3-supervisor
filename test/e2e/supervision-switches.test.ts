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
import { driveNeededWork, startupProjectId, startupSession } from "../support/startup-gateway.js";
import { dashboard } from "./dashboard.js";

/*
  A person turns supervision off and on again with the dashboard's two switches (docs/testing.md, UI-STORY-07 step 4): the
  master switch of the installation in Settings and the project's own switch in its Project settings. Each click changes only
  its own scope: the master switch leaves the project's own setting as it was, the project switch leaves the master switch as
  it was, and both settings survive a Supervisor restart and a reload. The production Supervisor runs over the scripted T3
  peer; its project has a .t3-supervisor folder, so detection enables it, and its chat is supervised through the root's
  needed-work interpretation as in production. Each saved switch is read back through the dashboard API with the browser's
  own session, after the visible state settled.
*/

type SavedSwitch = Pick<SupervisionControlInfo, "enabled" | "manual" | "globallyEnabled" | "effectiveEnabled">;

const project = startupProjectId;

// a supervised project and a signed-in dashboard, owned by the test's scope
const signedIn = (name: string) => Effect.gen(function* () {
  const supervisor = yield* startupSession({uiAssetsDirectory: join(repositoryRoot, "ui-dist")});
  yield* driveNeededWork(supervisor);
  const {page} = yield* journeyPage(name);
  const ui = yield* dashboard(page, supervisor.app.origin);
  const {token} = yield* forgeDashboardToken(supervisor.app.dataDirectory).pipe(Effect.orDie);
  yield* ui.signIn(token);
  // the saved switch of the installation (null) or of one project
  const saved = (projectId: string | null) => Effect.gen(function* () {
    const query = projectId === null ? "" : `?${new URLSearchParams({projectId})}`;
    const reply = yield* httpJson(`${supervisor.app.origin}/api/guidance/supervision-control${query}`, {headers: {"x-supervisor-session": yield* ui.session}});
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const {enabled, manual, globallyEnabled, effectiveEnabled} = reply.body as SupervisionControlInfo;
    return {enabled, manual, globallyEnabled, effectiveEnabled} satisfies SavedSwitch;
  });
  return {supervisor, ui, saved};
}).pipe(Effect.provide(NodeFileSystem.layer));

it.live("the master and project supervision switches each change only their own scope, once per click, and keep their state across a Supervisor restart and a reload", () => Effect.gen(function* () {
  const {supervisor, ui, saved} = yield* signedIn("supervision-switches");
  assert.deepEqual(yield* saved(null), {enabled: true, manual: true, globallyEnabled: true, effectiveEnabled: true});
  assert.deepEqual(yield* saved(project), {enabled: true, manual: false, globallyEnabled: true, effectiveEnabled: true}, "the detected folder enabled the project");

  // the master switch off: the project keeps its own setting and is off only through the master switch
  yield* ui.openSettings;
  yield* ui.clickSwitch("global", "Disable supervision");
  yield* ui.switchOffered("global", "Enable supervision");
  yield* ui.switchStatusShown("global", "Global supervision: Off");
  yield* ui.openProjectSettings(project);
  yield* ui.switchOffered("project", "Disable supervision");
  yield* ui.switchStatusShown("project", "Project supervision: Off \u2014 global supervision is off");
  assert.deepEqual(yield* saved(null), {enabled: false, manual: true, globallyEnabled: false, effectiveEnabled: false});
  assert.deepEqual(yield* saved(project), {enabled: true, manual: false, globallyEnabled: false, effectiveEnabled: false});

  // the project's own switch off, which leaves the master switch as it was
  yield* ui.clickSwitch("project", "Disable supervision");
  yield* ui.switchOffered("project", "Enable supervision");
  yield* ui.switchStatusShown("project", "Project supervision: Off");
  assert.deepEqual(yield* saved(project), {enabled: false, manual: true, globallyEnabled: false, effectiveEnabled: false});
  assert.deepEqual(yield* saved(null), {enabled: false, manual: true, globallyEnabled: false, effectiveEnabled: false});

  /* The production application stops and starts again over the same data while the scripted T3 and its state stay up; the
   * reloaded page reads both switches anew.
   */
  yield* supervisor.restart;
  yield* ui.reload;
  yield* ui.switchOffered("project", "Enable supervision");
  yield* ui.switchStatusShown("project", "Project supervision: Off");
  yield* ui.openSettings;
  yield* ui.switchOffered("global", "Enable supervision");
  yield* ui.switchStatusShown("global", "Global supervision: Off");

  // the master switch on again captures its native enable boundary; the project stays off until its own switch is clicked
  yield* ui.clickSwitch("global", "Enable supervision");
  yield* ui.switchOffered("global", "Disable supervision");
  yield* ui.switchStatusShown("global", "Global supervision: On");
  assert.deepEqual(yield* saved(null), {enabled: true, manual: true, globallyEnabled: true, effectiveEnabled: true});
  assert.deepEqual(yield* saved(project), {enabled: false, manual: true, globallyEnabled: true, effectiveEnabled: false});
  yield* ui.openProjectSettings(project);
  yield* ui.switchOffered("project", "Enable supervision");
  yield* ui.clickSwitch("project", "Enable supervision");
  yield* ui.switchOffered("project", "Disable supervision");
  yield* ui.switchStatusShown("project", "Project supervision: On");
  assert.deepEqual(yield* saved(project), {enabled: true, manual: true, globallyEnabled: true, effectiveEnabled: true});
  assert.deepEqual(yield* saved(null), {enabled: true, manual: true, globallyEnabled: true, effectiveEnabled: true});

  // one change per explicit click, each for its own scope: the restart, the reload and the navigation sent none
  assert.deepEqual(ui.switchChanges(), [
    {projectId: null, enabled: false}, {projectId: project, enabled: false},
    {projectId: null, enabled: true}, {projectId: project, enabled: true},
  ]);
}));
