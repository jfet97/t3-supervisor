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
import { startupMainThreadId, startupProjectId, startupSession } from "../support/startup-gateway.js";
import { dashboard } from "./dashboard.js";

/*
  A person leaves a Supervisor settings draft unsaved and moves around the dashboard (docs/testing.md, UI-STORY-02 and
  UI-STORY-04). The draft belongs to its project: the dashboard's own links to the project's sections, one of its chats, Home
  and the Projects directory keep it without asking, and the browser's Back and Forward keep it as well. Leaving for another
  project, by a link, by Back or by an address typed into the bar, asks to discard it first; refusing keeps the draft and the
  address, so the history after it stays usable, and only a confirmed discard drops it. Nothing is ever saved on its own.

  The production Supervisor runs over the scripted T3 peer with a second available project in its catalog. The settings
  saved for the project are read back through the dashboard API with the browser's own session after the visible state
  settled; the dialogs the page opened and the saves it sent are recorded by the page primitives.
*/

type SavedSettings = {readonly generation: number; readonly maxHelpersPerRoot: number};

const titles = {project: "Startup", main: "Operative main"};
const other = {id: "other-project", title: "Other project"};
const project = startupProjectId;
const helperLimit = "Maximum helpers per root";
const unsaved = "Unsaved Supervisor settings";
const discardQuestion = {type: "confirm", message: "Discard unsaved project configuration and Supervisor settings?"};
const settingsOf = (projectId: string) => `#/projects/${projectId}/settings`;
const conversationsOf = (projectId: string) => `#/projects/${projectId}/conversations`;

// a signed-in dashboard beside two available projects, and the saved Supervisor settings of the first, owned by the test's scope
const signedIn = (name: string) => Effect.gen(function* () {
  const supervisor = yield* startupSession({uiAssetsDirectory: join(repositoryRoot, "ui-dist"), titles,
    projects: [{...other, available: true, conversations: []}]});
  const {page} = yield* journeyPage(name);
  const ui = yield* dashboard(page, supervisor.app.origin);
  const {token} = yield* forgeDashboardToken(supervisor.app.dataDirectory).pipe(Effect.orDie);
  yield* ui.signIn(token);
  const saved = Effect.gen(function* () {
    const query = new URLSearchParams({projectId: project});
    const reply = yield* httpJson(`${supervisor.app.origin}/api/guidance/project-supervisor?${query}`, {headers: {"x-supervisor-session": yield* ui.session}});
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const {settings} = reply.body as ProjectSupervisorInfo;
    return {generation: settings.generation, maxHelpersPerRoot: (settings.teamSettings ?? defaultSupervisorTeamSettings).maxHelpersPerRoot} satisfies SavedSettings;
  });
  return {ui, saved};
}).pipe(Effect.provide(NodeFileSystem.layer));

it.live("a settings draft follows the dashboard's section, chat, Home and Projects links, and a link to another project asks before discarding it", () => Effect.gen(function* () {
  const {ui, saved} = yield* signedIn("draft-follows-links");
  const before = yield* saved;
  yield* ui.openProjectSettings(project);
  yield* ui.fill(helperLimit, "2");
  yield* ui.textShown(unsaved);

  // another section of the project, one of its chats and its explicit way back
  yield* ui.clickLink("Conversations", "Project sections");
  yield* ui.addressShown(conversationsOf(project));
  yield* ui.openEntry(titles.main);
  yield* ui.addressShown(`#/projects/${project}/task?main=${startupMainThreadId}`);
  yield* ui.headingShown(titles.main);
  yield* ui.clickLink("Back to conversations");
  yield* ui.addressShown(conversationsOf(project));
  yield* ui.clickLink("Project settings", "Project sections");
  assert.equal(yield* ui.fieldValue(helperLimit), "2", "the draft followed the project's sections and its chat");
  yield* ui.textShown(unsaved);

  // the Projects directory and Home keep the draft; a link to another project asks, and refusing stays in the directory
  yield* ui.clickLink("Back to Projects");
  yield* ui.headingShown("Projects");
  yield* ui.openEntry(other.title);
  assert.deepEqual(ui.dialogs(), [discardQuestion]);
  yield* ui.addressShown("#/projects");
  yield* ui.headingShown("Projects");
  // Home's link carries a count when work needs attention
  yield* ui.clickLink(/^Home/u, "Supervisor sections");
  yield* ui.headingShown("Work overview");
  yield* ui.clickLink("Projects", "Supervisor sections");
  yield* ui.openEntry(titles.project);
  yield* ui.addressShown(conversationsOf(project));
  yield* ui.clickLink("Project settings", "Project sections");
  assert.equal(yield* ui.fieldValue(helperLimit), "2", "the draft followed Home and the directory");
  yield* ui.textShown(unsaved);

  // nothing was saved on its own, and only the link to another project asked
  assert.deepEqual(ui.settingsSaves(), []);
  assert.deepEqual(yield* saved, before);
  assert.deepEqual(ui.dialogs(), [discardQuestion]);
}));

it.live("Back, Forward and an edited address keep a settings draft until its discard is confirmed, and a refused discard restores the address and the history after it", () => Effect.gen(function* () {
  const {ui, saved} = yield* signedIn("draft-across-history");
  const before = yield* saved;
  // the history the person builds: the other project, this project's settings with a draft, then its conversations
  yield* ui.editAddress(conversationsOf(other.id));
  yield* ui.headingShown(other.title);
  yield* ui.openProjectSettings(project);
  yield* ui.fill(helperLimit, "2");
  yield* ui.textShown(unsaved);
  yield* ui.clickLink("Conversations", "Project sections");
  yield* ui.addressShown(conversationsOf(project));

  // Back within the project keeps the draft without asking
  yield* ui.goBack;
  yield* ui.addressShown(settingsOf(project));
  assert.equal(yield* ui.fieldValue(helperLimit), "2");
  assert.deepEqual(ui.dialogs(), []);

  // Back into the other project asks; refusing returns to the entry the page shows, with the draft and the entry after it
  yield* ui.goBack;
  yield* ui.addressShown(settingsOf(project));
  assert.deepEqual(ui.dialogs(), [discardQuestion]);
  assert.equal(yield* ui.fieldValue(helperLimit), "2");
  yield* ui.textShown(unsaved);
  yield* ui.goForward;
  yield* ui.addressShown(conversationsOf(project));
  yield* ui.goBack;
  yield* ui.addressShown(settingsOf(project));
  assert.equal(yield* ui.fieldValue(helperLimit), "2");

  // an address typed into the bar for the other project asks the same way and is taken back
  yield* ui.editAddress(settingsOf(other.id));
  yield* ui.addressShown(settingsOf(project));
  assert.deepEqual(ui.dialogs(), [discardQuestion, discardQuestion]);
  assert.equal(yield* ui.fieldValue(helperLimit), "2");
  yield* ui.textShown(unsaved);

  // a confirmed discard on Back leaves for the other project; Forward then shows the saved settings without a draft
  yield* ui.answerDialogs(true);
  yield* ui.goBack;
  yield* ui.addressShown(conversationsOf(other.id));
  yield* ui.headingShown(other.title);
  assert.deepEqual(ui.dialogs(), [discardQuestion, discardQuestion, discardQuestion]);
  yield* ui.goForward;
  yield* ui.addressShown(settingsOf(project));
  assert.equal(yield* ui.fieldValue(helperLimit), String(before.maxHelpersPerRoot), "the discarded draft is gone");
  yield* ui.textGone(unsaved);

  // no traversal, refusal or discard saved anything
  assert.deepEqual(ui.settingsSaves(), []);
  assert.deepEqual(yield* saved, before);
  assert.deepEqual(ui.dialogs(), [discardQuestion, discardQuestion, discardQuestion]);
}));
