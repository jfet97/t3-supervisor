import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { repositoryRoot } from "../../scripts/local-run.js";
import { defaultSupervisorTeamSettings, type ProjectSupervisorInfo } from "../../src/project-supervisor-contract.js";
import { forgeDashboardToken } from "../../src/service-auth.js";
import { journeyPage } from "../support/browser.js";
import { httpJson } from "../support/glinint-wiring.js";
import { startupProjectId, startupSession } from "../support/startup-gateway.js";
import { dashboard, otherTab } from "./dashboard.js";

/*
  A person saves a Supervisor settings draft while another tab of the same browser signs out, and signs in again before the
  save is answered (docs/testing.md, UI-STORY-03 and UI-STORY-05). The save leaves the page with the valid session and is held
  between the browser and the dashboard. The other tab's Sign out ends the shared session on the dashboard and in every tab,
  so this tab asks to sign in again and keeps its open draft. Only after the person signed in again with a new one-time token
  does the held save reach the dashboard, with the session it was sent with, and the dashboard refuses it. The page cannot tell
  that refusal from a browser resend whose first attempt applied (test/project-supervisor-panel-atoms.test.ts), so it reports
  an unconfirmed outcome, keeps the draft, blocks Save until the saved state is read again and sends nothing on its own; a
  refresh reads the saved state and keeps the draft against it, and one explicit Save saves it. The production Supervisor runs
  over the scripted T3 peer at the native boundary; the saved settings are read through the dashboard API with the browser's
  current session after each visible state settled.
*/

type SavedSettings = {readonly generation: number; readonly maxHelpersPerRoot: number};

const helperLimit = "Maximum helpers per root";
const unconfirmed = "The operation outcome could not be confirmed. Refresh Supervisor settings before trying again.";

// a signed-in dashboard on the project's settings, its browser context and new one-time sign-in tokens, owned by the test's scope
const signedIn = (name: string) => Effect.gen(function* () {
  const supervisor = yield* startupSession({uiAssetsDirectory: join(repositoryRoot, "ui-dist")});
  const {page, context} = yield* journeyPage(name);
  const ui = yield* dashboard(page, supervisor.app.origin);
  const token = forgeDashboardToken(supervisor.app.dataDirectory).pipe(Effect.map(({token}) => token), Effect.orDie, Effect.provide(NodeFileSystem.layer));
  yield* ui.signIn(yield* token);
  yield* ui.openProjectSettings(startupProjectId);
  const saved = Effect.gen(function* () {
    const query = new URLSearchParams({projectId: startupProjectId});
    const reply = yield* httpJson(`${supervisor.app.origin}/api/guidance/project-supervisor?${query}`, {headers: {"x-supervisor-session": yield* ui.session}});
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const {settings} = reply.body as ProjectSupervisorInfo;
    return {generation: settings.generation, maxHelpersPerRoot: (settings.teamSettings ?? defaultSupervisorTeamSettings).maxHelpersPerRoot} satisfies SavedSettings;
  });
  return {origin: supervisor.app.origin, context, ui, token, saved};
}).pipe(Effect.provide(NodeFileSystem.layer));

it.live("a settings save pending when another tab signs out is never sent again after re-sign-in; the draft is kept and one explicit Save saves it", () => Effect.gen(function* () {
  const {origin, context, ui, token, saved} = yield* signedIn("save-pending-signed-out");
  const before = yield* saved;
  assert.equal(yield* ui.fieldValue(helperLimit), String(before.maxHelpersPerRoot));
  // the person's draft: at most two helpers per root, unsaved
  yield* ui.fill(helperLimit, "2");
  yield* ui.textShown("Unsaved Supervisor settings");
  // a draft or a pending change disables Sign out in its own tab, so the session ends in another tab of the same browser
  yield* ui.statusShown("Save drafts and resolve pending changes before signing out.");
  assert.equal(yield* ui.buttonDisabled("Sign out"), true);
  const other = yield* otherTab(context, origin);

  const save = yield* ui.saveSettingsHeld;
  yield* other.signOut;
  yield* ui.headingShown("Sign in again");
  yield* ui.textShown("Your open draft is kept in this tab.");
  yield* ui.signInAgain(yield* token);
  // only now the held save reaches the dashboard, with the session it was sent with and that the sign-out ended
  yield* save.forward;
  yield* ui.alertShown(unconfirmed);
  assert.deepEqual(ui.answers(), [{status: 401, message: "Sign in to Supervisor."}], "the dashboard refused the ended session");
  assert.equal(yield* ui.fieldValue(helperLimit), "2", "the draft is kept");
  assert.equal(yield* ui.buttonDisabled("Save Supervisor settings"), true, "Save waits for a fresh read of the saved state");
  assert.deepEqual(yield* saved, before, "the refused save changed nothing");
  assert.deepEqual(ui.settingsSaves(), [{expectedGeneration: before.generation, maxHelpersPerRoot: 2}], "the save was sent once and never again on its own");

  // a refresh reads the saved state and keeps the draft against it; then one explicit Save saves it
  yield* ui.clickButton("Refresh task and supervision state");
  yield* ui.statusShown("Supervisor status refreshed. Your unsaved draft was kept against the latest saved generation.");
  assert.equal(yield* ui.fieldValue(helperLimit), "2");
  assert.equal(ui.settingsSaves().length, 1, "the refresh sent nothing");
  yield* ui.clickButton("Save Supervisor settings");
  yield* ui.textGone("Unsaved Supervisor settings");
  assert.deepEqual(yield* saved, {generation: before.generation + 1, maxHelpersPerRoot: 2});
  yield* ui.reload;
  assert.equal(yield* ui.fieldValue(helperLimit), "2", "the reloaded page shows the saved limit");
  assert.deepEqual(ui.settingsSaves(), [{expectedGeneration: before.generation, maxHelpersPerRoot: 2}, {expectedGeneration: before.generation, maxHelpersPerRoot: 2}],
    "one save per explicit click: the sign-out, the re-sign-in, the refresh and the reload sent none");
}));
