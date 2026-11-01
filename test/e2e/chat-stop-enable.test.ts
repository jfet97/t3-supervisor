import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { repositoryRoot } from "../../scripts/local-run.js";
import { forgeDashboardToken } from "../../src/service-auth.js";
import { journeyPage } from "../support/browser.js";
import { httpJson } from "../support/glinint-wiring.js";
import { driveNeededWork, startupMainThreadId, startupProjectId, startupSession } from "../support/startup-gateway.js";
import { dashboard } from "./dashboard.js";

/*
  A person stops supervision of one chat in the dashboard, Supervisor restarts, the chat is still stopped, and Enable turns it
  back on (docs/testing.md, the first browser journey). The production Supervisor (runGuidanceApplication with its stores,
  controllers, dashboard and workflow MCP route) runs over the scripted T3 peer at the native boundary and serves this
  checkout's compiled dashboard to a headless Chromium in the same container. The chat becomes supervised as in production:
  the root's needed-work interpretation through the workflow MCP route; the person signs in with a real one-time token.
  Faults act only between the browser and the dashboard. Each saved state is read back through the dashboard API with the
  browser's own session, after the visible state settled.
*/

type SavedChat = {readonly stopped: boolean; readonly policyGeneration: number; readonly stoppedBy: string | null};

const chat = startupMainThreadId;

// a supervised main and a signed-in dashboard on its chat supervision view, owned by the test's scope
const signedIn = (name: string) => Effect.gen(function* () {
  const supervisor = yield* startupSession({uiAssetsDirectory: join(repositoryRoot, "ui-dist")});
  yield* driveNeededWork(supervisor);
  const {page} = yield* journeyPage(name);
  const ui = yield* dashboard(page, supervisor.app.origin);
  const {token} = yield* forgeDashboardToken(supervisor.app.dataDirectory).pipe(Effect.orDie);
  yield* ui.signIn(token);
  yield* ui.openChatSupervision(startupProjectId, chat);
  const saved = Effect.gen(function* () {
    const query = new URLSearchParams({projectId: startupProjectId, mainThreadId: chat});
    const reply = yield* httpJson(`${supervisor.app.origin}/api/guidance/project-supervisor?${query}`, {headers: {"x-supervisor-session": yield* ui.session}});
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const state = (reply.body as {chatSupervision?: SavedChat | null}).chatSupervision;
    assert.ok(state, "the main's chat supervision");
    return state;
  });
  return {supervisor, ui, saved};
}).pipe(Effect.provide(NodeFileSystem.layer));

it.live("a Stop clicked in the dashboard survives a Supervisor restart and a reload until Enable is clicked", () => Effect.gen(function* () {
  const {supervisor, ui, saved} = yield* signedIn("stop-restart-enable");
  assert.equal((yield* saved).stopped, false);
  yield* ui.clickStop;
  yield* ui.stoppedShown(chat);
  const stopped = yield* saved;
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.stoppedBy, "ui");
  // the production application stops and starts again over the same data while the scripted T3 and its state stay up
  yield* supervisor.restart;
  yield* ui.reload;
  yield* ui.stoppedShown(chat);
  assert.equal((yield* saved).stopped, true);
  yield* ui.clickEnable(chat);
  yield* ui.enabledShown;
  assert.equal((yield* saved).stopped, false);
  // one change per explicit click: the restart and the reload sent none
  assert.deepEqual(ui.changes(), [{enabled: false}, {enabled: true}]);
}));

it.live("a Stop whose reply is lost after the server applied it shows the saved stopped state and is never sent again", () => Effect.gen(function* () {
  const {ui, saved} = yield* signedIn("stop-reply-lost");
  const before = yield* saved;
  yield* ui.injectFault("reply-lost-after-apply");
  yield* ui.clickStop;
  yield* ui.unconfirmedShown;
  yield* ui.stoppedShown(chat);
  assert.deepEqual(ui.answers().map((answer) => answer.status), [200], "the dashboard applied the forwarded change");
  const after = yield* saved;
  assert.equal(after.stopped, true);
  assert.ok(after.policyGeneration > before.policyGeneration);
  yield* ui.reload;
  yield* ui.stoppedShown(chat);
  assert.deepEqual(ui.changes(), [{enabled: false}]);
}));

// the durable visible outcome only: once a change settles, the chat panel's live read reconciles the view with the saved
// state by itself, so the confirming read after an unconfirmed change belongs to the panel atom test
// (test/project-supervisor-panel-atoms.test.ts), which a missing read fails while this journey still passes
it.live("a Stop lost before it reaches the server shows the unchanged enabled state and is never sent again", () => Effect.gen(function* () {
  const {ui, saved} = yield* signedIn("stop-lost-before-server");
  const before = yield* saved;
  yield* ui.injectFault("lost-before-server");
  yield* ui.clickStop;
  yield* ui.unconfirmedShown;
  yield* ui.enabledShown;
  const after = yield* saved;
  assert.deepEqual({stopped: after.stopped, policyGeneration: after.policyGeneration}, {stopped: false, policyGeneration: before.policyGeneration});
  yield* ui.reload;
  yield* ui.enabledShown;
  assert.deepEqual(ui.changes(), [{enabled: false}]);
}));

it.live("an Enable the dashboard refuses for its CSRF token is not resent, and the next click enables the chat", () => Effect.gen(function* () {
  const {ui, saved} = yield* signedIn("enable-refused-csrf");
  yield* ui.clickStop;
  yield* ui.stoppedShown(chat);
  const stopped = yield* saved;
  yield* ui.injectFault("unissued-csrf-token");
  yield* ui.clickEnable(chat);
  yield* ui.unconfirmedShown;
  yield* ui.stoppedShown(chat);
  // the change reached the dashboard with its own Origin and a valid session, and the CSRF check refused it, not the earlier
  // loopback and origin guard ("Open the supervisor through its loopback address.") or sign-in (401)
  assert.deepEqual(ui.answers(), [{status: 403, message: "Refresh the local dashboard before changing settings."}]);
  assert.deepEqual(yield* saved, stopped, "the refused change changed nothing");
  yield* ui.clickEnable(chat);
  yield* ui.enabledShown;
  assert.equal((yield* saved).stopped, false);
  // the refusal refreshed the session's access and sent nothing until the next explicit click
  assert.deepEqual(ui.changes(), [{enabled: false}, {enabled: true}, {enabled: true}]);
}));
