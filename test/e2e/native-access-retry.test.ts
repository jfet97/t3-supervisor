import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { repositoryRoot } from "../../scripts/local-run.js";
import type { ProjectSupervisorInfo } from "../../src/project-supervisor-contract.js";
import { forgeDashboardToken } from "../../src/service-auth.js";
import { journeyPage } from "../support/browser.js";
import { httpJson } from "../support/glinint-wiring.js";
import { startupMainThreadId, startupProjectId, startupSession } from "../support/startup-gateway.js";
import { dashboard } from "./dashboard.js";

/*
  A person retries native access after T3 rejected the creation of a chat's Supervisor conversation (docs/testing.md,
  UI-STORY-02, Retry). The project's Supervisor provider instance is disabled in T3, so T3 rejects the launch definitely and
  the binding is rejected; nothing launches it again on its own. While a Supervisor settings draft is open, Retry stays
  disabled and says why. Once the draft is discarded and the provider is enabled in T3, one explicit Retry launches the
  retained conversation identity under its next generation and the binding is ready; the page sent exactly that one retry.

  The production Supervisor runs over the scripted T3 peer; the chat's request is discovered as in production, which reserves
  the binding and launches its conversation. The saved binding is read back through the dashboard API with the browser's own
  session after the visible state settled; the scripted T3 records every launch it received.
*/

type SavedBinding = {readonly threadId: string; readonly generation: number; readonly state: string};

const titles = {project: "Startup", main: "Operative main"};
const project = startupProjectId;
const chat = startupMainThreadId;
const helperLimit = "Maximum helpers per root";
const unsaved = "Unsaved Supervisor settings";
const draftBlocksRetry = "Save or discard your settings draft before retrying native access.";
const retry = "Retry native access";

/* A signed-in dashboard over a T3 whose Supervisor provider instance is disabled until `launch.accepted`, and the main's saved
 * binding, owned by the test's scope.
 */
const signedIn = (name: string, launch: {accepted: boolean}) => Effect.gen(function* () {
  const supervisor = yield* startupSession({uiAssetsDirectory: join(repositoryRoot, "ui-dist"), titles, launch});
  const {page} = yield* journeyPage(name);
  const ui = yield* dashboard(page, supervisor.app.origin);
  const {token} = yield* forgeDashboardToken(supervisor.app.dataDirectory).pipe(Effect.orDie);
  yield* ui.signIn(token);
  const savedBinding = Effect.gen(function* () {
    const query = new URLSearchParams({projectId: project, mainThreadId: chat});
    const reply = yield* httpJson(`${supervisor.app.origin}/api/guidance/project-supervisor?${query}`, {headers: {"x-supervisor-session": yield* ui.session}});
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const {binding} = reply.body as ProjectSupervisorInfo;
    assert.ok(binding, "the main's Supervisor binding");
    return {threadId: binding.threadId, generation: binding.generation, state: binding.state} satisfies SavedBinding;
  });
  return {supervisor, ui, savedBinding};
}).pipe(Effect.provide(NodeFileSystem.layer));

it.live("after T3 rejects a chat's Supervisor conversation only one explicit Retry sends, and none while a settings draft is open", () => Effect.gen(function* () {
  const launch = {accepted: false};
  const {supervisor, ui, savedBinding} = yield* signedIn("retry-rejected-binding", launch);

  // the T3 peer rejected the launch: the chat's Supervision view shows the rejection and offers the explicit Retry
  yield* ui.openChatSupervision(project, chat);
  yield* ui.textShown("Access rejected");
  yield* ui.buttonShown(retry);
  const rejected = yield* savedBinding;
  assert.equal(rejected.state, "rejected");

  // a Supervisor settings draft of the project disables Retry and says why
  yield* ui.openProjectSettings(project);
  yield* ui.fill(helperLimit, "2");
  yield* ui.textShown(unsaved);
  yield* ui.openChatSupervision(project, chat);
  yield* ui.statusShown(draftBlocksRetry);
  assert.equal(yield* ui.buttonDisabled(retry), true, "Retry waits for the draft");

  // the discarded draft lets Retry go again; nothing was retried on its own meanwhile
  yield* ui.openProjectSettings(project);
  yield* ui.clickButton("Discard draft");
  yield* ui.textGone(unsaved);
  yield* ui.openChatSupervision(project, chat);
  yield* ui.textShown("Access rejected");
  yield* ui.textGone(draftBlocksRetry);
  assert.deepEqual(ui.retries(), []);
  assert.deepEqual(yield* savedBinding, rejected, "the rejected binding waited for the explicit Retry");

  // the provider is enabled in T3, and one explicit Retry creates the conversation under the binding's next generation
  launch.accepted = true;
  yield* ui.clickButton(retry);
  yield* ui.statusShown("Native access retried with the retained identity. Inspect the current conversation and task status.");
  yield* ui.textShown("Ready", "Supervisor health");
  yield* ui.textGone("Native Supervisor access");
  assert.deepEqual(yield* savedBinding, {threadId: rejected.threadId, generation: rejected.generation + 1, state: "ready"});

  // a reload shows the ready binding without a Retry and sends nothing
  yield* ui.reload;
  yield* ui.headingShown("Chat supervision");
  yield* ui.textShown("Ready", "Supervisor health");
  yield* ui.textGone("Native Supervisor access");

  /* The page sent exactly the one retry, naming the rejected binding; T3 received the rejected launch and the retry's, each
   * under its own generation of the same conversation identity, and no launch in between.
   */
  assert.deepEqual(ui.retries(), [{threadId: rejected.threadId, bindingGeneration: rejected.generation, action: "retry"}]);
  assert.deepEqual(supervisor.observe.launches(), [
    {threadId: rejected.threadId, commandId: `supervisor-create:${rejected.threadId}:${rejected.generation}`},
    {threadId: rejected.threadId, commandId: `supervisor-create:${rejected.threadId}:${rejected.generation + 1}`},
  ]);
  assert.deepEqual(ui.settingsSaves(), [], "the discarded draft was never saved");
}));
