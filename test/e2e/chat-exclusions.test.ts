import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { repositoryRoot } from "../../scripts/local-run.js";
import type { GuidanceSnapshot } from "../../src/guidance-contract.js";
import { forgeDashboardToken } from "../../src/service-auth.js";
import { journeyPage } from "../support/browser.js";
import { httpJson } from "../support/glinint-wiring.js";
import { driveNeededWork, startupMainThreadId, startupProjectId, startupSession } from "../support/startup-gateway.js";
import { dashboard, threadPolicyPath } from "./dashboard.js";

/*
  A person excludes a supervised chat in Settings, under Exceptions for individual chats (docs/testing.md, the historical
  Settings excluded-chat edit). Each chat the form adds is a human Stop of that chat and each chat it removes an Enable. The
  exclusion survives a Supervisor restart and a reload: Settings lists it again from the restarted dashboard, and the chat's
  own view shows it stopped until the exclusion is removed and saved. A save whose outcome the page cannot know blocks Save
  until Reload chat settings reads the saved settings: a save that never arrived leaves the draft for one more explicit Save,
  and a save that was applied clears it; nothing is sent again on its own.

  The production Supervisor runs over the scripted T3 peer, and its chat is supervised through the root's needed-work
  interpretation as in production. Faults act only between the browser and the dashboard. The saved settings and the chat's
  saved state are read back through the dashboard API with the browser's own session after the visible state settled.
*/

type SavedPolicy = {readonly generation: number; readonly excludedThreadIds: ReadonlyArray<string>};
type SavedChat = {readonly stopped: boolean; readonly stoppedBy: string | null};

const chat = startupMainThreadId;
const titles = {project: "Startup", main: "Operative main"};
const exclusionSearch = "Add an exclusion";
const addExclusion = `Add exclusion for ${titles.main}`;
const removeExclusion = `Remove exclusion for ${titles.main}`;
const saveExclusions = "Save chat settings";
const reloadExclusions = "Reload chat settings";
const unsaved = "Unsaved chat exclusions";
const savedAndApplied = "Chat settings saved and applied.";
const unconfirmed = "Chat settings invalid or changed in another tab. Reload first.";

/* A supervised main and a signed-in dashboard on Settings, with reads of the saved settings and of the chat's saved state,
 * owned by the test's scope.
 */
const signedIn = (name: string) => Effect.gen(function* () {
  const supervisor = yield* startupSession({uiAssetsDirectory: join(repositoryRoot, "ui-dist"), titles});
  yield* driveNeededWork(supervisor);
  const {page} = yield* journeyPage(name);
  const ui = yield* dashboard(page, supervisor.app.origin);
  const {token} = yield* forgeDashboardToken(supervisor.app.dataDirectory).pipe(Effect.orDie);
  yield* ui.signIn(token);
  yield* ui.openSettings;
  const read = (path: string) => Effect.gen(function* () {
    const reply = yield* httpJson(`${supervisor.app.origin}${path}`, {headers: {"x-supervisor-session": yield* ui.session}});
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    return reply.body;
  });
  const savedPolicy = Effect.map(read("/api/guidance/snapshot"), (body): SavedPolicy => {
    const {generation, excludedThreadIds} = (body as GuidanceSnapshot).threadPolicy;
    return {generation, excludedThreadIds: [...excludedThreadIds]};
  });
  const savedChat = Effect.map(read(`/api/guidance/project-supervisor?${new URLSearchParams({projectId: startupProjectId, mainThreadId: chat})}`), (body): SavedChat => {
    const state = (body as {chatSupervision?: SavedChat | null}).chatSupervision;
    assert.ok(state, "the main's chat supervision");
    return {stopped: state.stopped, stoppedBy: state.stoppedBy};
  });
  return {supervisor, ui, savedPolicy, savedChat};
}).pipe(Effect.provide(NodeFileSystem.layer));

it.live("a chat excluded in Settings stays excluded across a Supervisor restart and a reload, and removing the exclusion enables it again", () => Effect.gen(function* () {
  const {supervisor, ui, savedPolicy, savedChat} = yield* signedIn("exclusion-restart-remove");
  const before = yield* savedPolicy;
  assert.deepEqual(before.excludedThreadIds, []);
  assert.equal((yield* savedChat).stopped, false);

  // the person finds the supervised chat by its title and excludes it
  yield* ui.fill(exclusionSearch, "Operative");
  yield* ui.clickButton(addExclusion);
  yield* ui.textShown(unsaved);
  yield* ui.textShown("1 exclusion retained in total.");
  yield* ui.clickButton(saveExclusions);
  yield* ui.statusShown(savedAndApplied);
  yield* ui.textGone(unsaved);
  assert.deepEqual(yield* savedPolicy, {generation: before.generation + 1, excludedThreadIds: [chat]});
  assert.deepEqual(yield* savedChat, {stopped: true, stoppedBy: "ui"}, "the exclusion is the chat's Stop from the dashboard");

  /* The production application stops and starts again over the same data while the scripted T3 and its state stay up; the
   * reloaded Settings lists the saved exclusion, and the chat's own view shows it stopped.
   */
  yield* supervisor.restart;
  yield* ui.reload;
  yield* ui.buttonShown(removeExclusion);
  yield* ui.textShown("1 exclusion retained in total.");
  assert.deepEqual(yield* savedPolicy, {generation: before.generation + 1, excludedThreadIds: [chat]});
  yield* ui.openChatSupervision(startupProjectId, chat);
  yield* ui.stoppedShown(chat);
  assert.deepEqual(yield* savedChat, {stopped: true, stoppedBy: "ui"});

  // removing the exclusion and saving is the chat's Enable
  yield* ui.openSettings;
  yield* ui.clickButton(removeExclusion);
  yield* ui.textShown(unsaved);
  yield* ui.textShown("0 exclusions retained in total.");
  yield* ui.clickButton(saveExclusions);
  yield* ui.statusShown(savedAndApplied);
  yield* ui.textGone(unsaved);
  assert.deepEqual(yield* savedPolicy, {generation: before.generation + 2, excludedThreadIds: []});
  assert.equal((yield* savedChat).stopped, false);
  yield* ui.openChatSupervision(startupProjectId, chat);
  yield* ui.enabledShown;

  // one save per explicit click: the restart, the reload and the navigation sent none, and nothing asked before leaving
  assert.deepEqual(ui.policySaves(), [
    {generation: before.generation, excludedThreadIds: [chat]},
    {generation: before.generation + 1, excludedThreadIds: []},
  ]);
  assert.deepEqual(ui.dialogs(), []);
}));

it.live("an unconfirmed chat settings save is never sent again on its own, and Reload chat settings keeps a draft that was not saved and clears one that was", () => Effect.gen(function* () {
  const {ui, savedPolicy} = yield* signedIn("exclusion-unconfirmed");
  const before = yield* savedPolicy;
  yield* ui.fill(exclusionSearch, "Operative");
  yield* ui.clickButton(addExclusion);
  yield* ui.textShown(unsaved);

  // the save is lost before it reaches the dashboard: its outcome is unknown, so Save waits for a verified read
  yield* ui.injectFault("lost-before-server", 1, threadPolicyPath);
  yield* ui.clickButton(saveExclusions);
  yield* ui.statusShown(unconfirmed);
  assert.equal(yield* ui.buttonDisabled(saveExclusions), true, "Save waits for a verified read");
  assert.deepEqual(yield* savedPolicy, before, "nothing reached the dashboard");
  // the read finds the settings unchanged: the draft is kept and Save is open again
  yield* ui.clickButton(reloadExclusions);
  yield* ui.textGone(unconfirmed);
  yield* ui.textShown(unsaved);
  assert.equal(yield* ui.buttonDisabled(saveExclusions), false, "the verified read lifted the block");

  // the next explicit Save reaches the dashboard, which applies it, and its reply is lost
  yield* ui.injectFault("reply-lost-after-apply", 1, threadPolicyPath);
  yield* ui.clickButton(saveExclusions);
  yield* ui.statusShown(unconfirmed);
  assert.deepEqual(ui.answers(), [{status: 200, message: null}], "the dashboard applied the forwarded save");
  assert.deepEqual(yield* savedPolicy, {generation: before.generation + 1, excludedThreadIds: [chat]});
  // the read finds the draft saved and clears it
  yield* ui.clickButton(reloadExclusions);
  yield* ui.statusShown(savedAndApplied);
  yield* ui.textGone(unsaved);

  // one save per explicit click: the reads sent none, and a reload lists the saved exclusion and sends none either
  yield* ui.reload;
  yield* ui.buttonShown(removeExclusion);
  assert.deepEqual(ui.policySaves(), [
    {generation: before.generation, excludedThreadIds: [chat]},
    {generation: before.generation, excludedThreadIds: [chat]},
  ]);
  assert.deepEqual(yield* savedPolicy, {generation: before.generation + 1, excludedThreadIds: [chat]});
  assert.deepEqual(ui.dialogs(), []);
}));
