import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { repositoryRoot } from "../../scripts/local-run.js";
import type { ProjectDefinitionSnapshot } from "../../src/project-definitions-contract.js";
import { forgeDashboardToken } from "../../src/service-auth.js";
import { journeyPage } from "../support/browser.js";
import { httpJson } from "../support/glinint-wiring.js";
import { startupProjectId, startupSession } from "../support/startup-gateway.js";
import { dashboard, otherTab, projectConfigurationPath, type Dashboard } from "./dashboard.js";

/*
  A person edits the checkout's project.yaml in the configuration editor (docs/testing.md, UI-STORY-01 and the configuration
  editor's part of UI-STORY-04). The draft follows the project's sections, one of its chats, Home, the Projects directory and
  the browser's Back and Forward, and survives a sign-out in another tab and the sign-in again. A save that reaches the
  dashboard only after that sign-out is refused with 401; the page cannot tell it from a resend whose first attempt applied,
  so it reports an unknown outcome, keeps the draft and blocks Save until Refresh definitions reads project.yaml again. A save
  that meets a newer revision is a conflict and blocks Save the same way, and so does a save whose reply is lost after the
  dashboard wrote the file. Nothing is ever sent again on its own; each refresh asks before it discards the draft.

  The production Supervisor runs over the scripted T3 peer with a checkout whose index lists one step and with the dedicated
  project-write credential, so T3 writes project.yaml natively. The saved index is read back through the dashboard API with
  the browser's own session after the visible state settled; another person's save goes through the same API with its own
  session; the scripted T3 records every file it wrote.
*/

type SavedIndex = {readonly revision: string | null; readonly stepSummaries: ReadonlyArray<string>};

const titles = {project: "Startup", main: "Operative main"};
const project = startupProjectId;
const step = "Inspect checkout";
const savedSummary = "Inspect the checkout.";
const draft = "Inspect the checkout and its remote.";
const checkout = {
  ".t3-supervisor/project.yaml": `workflows: []\nsteps:\n  - path: steps/inspect.md\n    summary: ${savedSummary}\n`,
  ".t3-supervisor/steps/inspect.md": "---\nid: inspect\nname: Inspect checkout\ndescription: Read the current checkout and its remote state.\n---\n",
  ".t3-supervisor/workflows/.gitkeep": "",
};
const unknownOutcome = "The save outcome could not be confirmed. Refresh and inspect project.yaml before retrying.";
const keptDraft = "Your draft is kept. Refresh project definitions and inspect project.yaml before trying again.";
const pending = "Save drafts and resolve pending changes before signing out.";
const discardQuestion = {type: "confirm", message: "Discard unsaved project-configuration changes and reload definitions?"};
const saveQuestion = (workspaceRoot: string) =>
  ({type: "confirm", message: `Save project configuration at ${workspaceRoot}/.t3-supervisor/project.yaml? This updates the selected working tree.`});

/* A signed-in dashboard over a checkout T3 can write, its browser context, new one-time tokens and the saved index, owned by
 * the test's scope.
 */
const signedIn = (name: string) => Effect.gen(function* () {
  const supervisor = yield* startupSession({uiAssetsDirectory: join(repositoryRoot, "ui-dist"), titles, checkout});
  const {page, context} = yield* journeyPage(name);
  const ui = yield* dashboard(page, supervisor.app.origin);
  const token = forgeDashboardToken(supervisor.app.dataDirectory).pipe(Effect.map(({token}) => token), Effect.orDie, Effect.provide(NodeFileSystem.layer));
  yield* ui.signIn(yield* token);
  const savedIndex = Effect.gen(function* () {
    const reply = yield* httpJson(`${supervisor.app.origin}${projectConfigurationPath}?${new URLSearchParams({projectId: project})}`,
      {headers: {"x-supervisor-session": yield* ui.session}});
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const {revision, projectConfig} = reply.body as ProjectDefinitionSnapshot;
    return {revision, stepSummaries: projectConfig?.steps.map((entry) => entry.summary) ?? []} satisfies SavedIndex;
  });
  return {supervisor, context, ui, token, savedIndex};
}).pipe(Effect.provide(NodeFileSystem.layer));

/* The editor through the dashboard's own controls: Definitions, the project folder, then Edit project.yaml, which opens it for
 * editing; the index's one step is a disclosure whose fields show once it is opened.
 */
const openEditor = (ui: Dashboard) => Effect.gen(function* () {
  yield* ui.editAddress(`#/projects/${project}/definitions`);
  yield* ui.clickButton(/^Project folder/u);
  yield* ui.headingShown("Definition catalog");
  yield* ui.clickLink("Edit project.yaml");
  yield* ui.headingShown("Edit project configuration");
  yield* ui.openDisclosure(step);
});

it.live("an editor draft follows navigation, Back and Forward and a sign-in again; a save refused with 401 is not saved and blocks Save until a refresh", () => Effect.gen(function* () {
  const {supervisor, context, ui, token, savedIndex} = yield* signedIn("editor-draft-401");
  const before = yield* savedIndex;
  assert.deepEqual(before.stepSummaries, [savedSummary]);
  yield* openEditor(ui);
  assert.equal(yield* ui.fieldValue("Summary"), savedSummary);
  yield* ui.fill("Summary", draft);
  yield* ui.statusShown(pending);

  /* The project's sections, one of its chats, Home and the Projects directory keep the draft without asking, and the
   * shell's link returns to it.
   */
  yield* ui.clickLink("Project settings", "Project sections");
  yield* ui.switchOffered("project", "Disable supervision");
  yield* ui.clickLink("Conversations", "Project sections");
  yield* ui.openEntry(titles.main);
  yield* ui.headingShown(titles.main);
  yield* ui.clickLink(/^Home/u, "Supervisor sections");
  yield* ui.headingShown("Work overview");
  yield* ui.clickLink("Projects", "Supervisor sections");
  yield* ui.openEntry(titles.project);
  yield* ui.addressShown(`#/projects/${project}/conversations`);
  yield* ui.clickLink("Review project changes");
  yield* ui.headingShown("Edit project configuration");
  assert.equal(yield* ui.fieldValue("Summary"), draft, "the draft followed the sections, the chat, Home and the directory");

  // browser Back and Forward between the conversations and the editor keep it too
  yield* ui.goBack;
  yield* ui.addressShown(`#/projects/${project}/conversations`);
  yield* ui.goForward;
  yield* ui.headingShown("Edit project configuration");
  assert.equal(yield* ui.fieldValue("Summary"), draft, "the draft followed Back and Forward");
  assert.deepEqual(ui.dialogs(), [], "nothing asked before leaving");

  /* The save leaves the page with the session another tab then ends; this tab asks to sign in again and keeps its draft,
   * and only after the sign-in again does the held save reach the dashboard, which refuses the ended session.
   */
  yield* ui.answerDialogs(true);
  const other = yield* otherTab(context, supervisor.app.origin);
  const save = yield* ui.saveConfigurationHeld;
  yield* other.signOut;
  yield* ui.headingShown("Sign in again");
  yield* ui.textShown("Your open draft is kept in this tab.");
  yield* ui.signInAgain(yield* token);
  yield* save.forward;
  yield* ui.alertShown(unknownOutcome);
  assert.deepEqual(ui.answers(), [{status: 401, message: "Sign in to Supervisor."}], "the dashboard refused the ended session");
  yield* ui.textShown(keptDraft);
  assert.equal(yield* ui.fieldValue("Summary"), draft, "the draft survived the sign-in again");
  assert.equal(yield* ui.buttonDisabled("Save project configuration"), true, "Save waits for a refresh");
  assert.deepEqual(yield* savedIndex, before, "the refused save changed nothing");
  assert.deepEqual(supervisor.observe.checkoutWrites(), [], "T3 wrote nothing");

  // a definitions refresh asks before discarding the draft and reads project.yaml again; one explicit Save then saves it
  yield* ui.clickButton("Refresh definitions");
  yield* ui.textGone(keptDraft);
  yield* ui.openDisclosure(step);
  assert.equal(yield* ui.fieldValue("Summary"), savedSummary, "the refresh shows the saved index");
  yield* ui.fill("Summary", draft);
  yield* ui.clickButton("Save project configuration");
  yield* ui.statusShown("Saved project configuration to .t3-supervisor/project.yaml.");
  const saved = yield* savedIndex;
  assert.deepEqual(saved.stepSummaries, [draft]);
  assert.notEqual(saved.revision, before.revision);
  assert.deepEqual(supervisor.observe.checkoutWrites(), [".t3-supervisor/project.yaml"], "T3 wrote project.yaml once");

  // a reload shows the saved index, and the editor's own way back shows it in the catalog
  yield* ui.reload;
  yield* ui.headingShown("Edit project configuration");
  yield* ui.openDisclosure(step);
  assert.equal(yield* ui.fieldValue("Summary"), draft);
  yield* ui.clickLink("Back to Definitions");
  yield* ui.headingShown("Definition catalog");
  yield* ui.buttonShown(/^Inspect checkout.*Inspect the checkout and its remote\.$/u);

  // one save per explicit Save: the sign-out, the sign-in again, the refresh and the reload sent none
  assert.deepEqual(ui.configurationSaves(), [{expectedRevision: before.revision, stepSummaries: [draft]}, {expectedRevision: before.revision, stepSummaries: [draft]}]);
  assert.deepEqual(ui.dialogs(), [saveQuestion(supervisor.app.workspaceRoot), discardQuestion, saveQuestion(supervisor.app.workspaceRoot)]);
}));

it.live("a save that meets a newer revision and a save whose reply is lost each block Save until a refresh, and neither is sent again", () => Effect.gen(function* () {
  const {supervisor, ui, savedIndex} = yield* signedIn("editor-conflict-unconfirmed");
  const origin = supervisor.app.origin;
  const before = yield* savedIndex;
  yield* openEditor(ui);
  yield* ui.answerDialogs(true);
  yield* ui.fill("Summary", draft);

  // another person signs in with their own one-time token and saves project.yaml first, against the same revision
  const theirs = "Inspect the checkout before reporting.";
  const {token} = yield* forgeDashboardToken(supervisor.app.dataDirectory).pipe(Effect.orDie, Effect.provide(NodeFileSystem.layer));
  const login = yield* httpJson(`${origin}/auth/login`, {method: "POST", headers: {origin}, body: {token: Redacted.value(token)}});
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const session = (login.body as {session: string}).session;
  const csrf = yield* httpJson(`${origin}/api/csrf`, {headers: {"x-supervisor-session": session}});
  assert.equal(csrf.status, 200);
  const loaded = yield* httpJson(`${origin}${projectConfigurationPath}?${new URLSearchParams({projectId: project})}`, {headers: {"x-supervisor-session": session}});
  const {projectConfig} = loaded.body as ProjectDefinitionSnapshot;
  assert.ok(projectConfig, "the readable index");
  const theirSave = yield* httpJson(`${origin}${projectConfigurationPath}`, {method: "POST",
    headers: {origin, "x-supervisor-session": session, "x-csrf-token": (csrf.body as {csrf: string}).csrf},
    body: {projectId: project, threadId: null, expectedRevision: before.revision, config: {...projectConfig, steps: projectConfig.steps.map((entry) => ({...entry, summary: theirs}))}}});
  assert.deepEqual([theirSave.status, (theirSave.body as {status?: unknown}).status], [200, "saved"]);
  const afterTheirs = yield* savedIndex;
  assert.deepEqual(afterTheirs.stepSummaries, [theirs]);

  // the person's Save meets the newer revision: a conflict that keeps the draft and blocks Save until a refresh
  yield* ui.clickButton("Save project configuration");
  yield* ui.alertShown("The checkout or definition sources changed. Your draft was kept; refresh before saving again.");
  yield* ui.textShown(keptDraft);
  assert.equal(yield* ui.fieldValue("Summary"), draft);
  assert.equal(yield* ui.buttonDisabled("Save project configuration"), true, "the conflict blocks Save");
  assert.deepEqual(yield* savedIndex, afterTheirs, "the conflict wrote nothing");

  // the refresh discards the draft and shows the other person's save; the next explicit Save is written and its reply lost
  yield* ui.clickButton("Refresh definitions");
  yield* ui.textGone(keptDraft);
  yield* ui.openDisclosure(step);
  assert.equal(yield* ui.fieldValue("Summary"), theirs);
  yield* ui.fill("Summary", draft);
  yield* ui.injectFault("reply-lost-after-apply", 1, projectConfigurationPath);
  yield* ui.clickButton("Save project configuration");
  yield* ui.alertShown(unknownOutcome);
  assert.deepEqual(ui.answers().map((answer) => answer.status), [200], "the dashboard wrote the forwarded save");
  assert.equal(yield* ui.buttonDisabled("Save project configuration"), true, "an unknown outcome blocks Save");
  const applied = yield* savedIndex;
  assert.deepEqual(applied.stepSummaries, [draft]);

  // the refresh reads the save that was applied: the editor shows it and has nothing left to save
  yield* ui.clickButton("Refresh definitions");
  yield* ui.textGone(keptDraft);
  yield* ui.openDisclosure(step);
  assert.equal(yield* ui.fieldValue("Summary"), draft);
  assert.equal(yield* ui.buttonDisabled("Save project configuration"), true, "nothing is left to save");

  /* One save per explicit Save, each against the revision it was edited on; T3 wrote the other person's save and the applied
   * one, and the conflict wrote nothing.
   */
  assert.deepEqual(ui.configurationSaves(), [{expectedRevision: before.revision, stepSummaries: [draft]}, {expectedRevision: afterTheirs.revision, stepSummaries: [draft]}]);
  assert.deepEqual(supervisor.observe.checkoutWrites(), [".t3-supervisor/project.yaml", ".t3-supervisor/project.yaml"]);
  assert.deepEqual(ui.dialogs(), [saveQuestion(supervisor.app.workspaceRoot), discardQuestion, saveQuestion(supervisor.app.workspaceRoot), discardQuestion]);
}));
