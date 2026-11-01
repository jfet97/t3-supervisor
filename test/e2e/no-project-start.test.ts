import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { repositoryRoot } from "../../scripts/local-run.js";
import { forgeDashboardToken } from "../../src/service-auth.js";
import { journeyPage } from "../support/browser.js";
import { httpJson } from "../support/glinint-wiring.js";
import { startupSession } from "../support/startup-gateway.js";
import { dashboard, supervisionStartPath, type StartIdentity } from "./dashboard.js";

/*
  A person starts supervision of No Project chats from Home (docs/testing.md, UI-STORY-07, cut Start, and UI-STORY-03's
  Start). Each Start is persisted as the tab's fence before it is sent. The first chat's Start reaches the dashboard, which
  activates it, and its reply is lost; the second chat's Start is lost before the dashboard. Each time the page reports an
  unknown outcome, holds every Start behind the fence and asks before a reload leaves it. The reloaded page keeps the fence
  with its original operation and sends no Start again; Check Start status reads that operation: active clears the fence,
  while a recorded nothing never does, since the lost request could still be running.

  The production Supervisor runs over the scripted T3 peer with a scratch project, T3's managed scratch root, whose chats are
  No Project chats in the default On request mode. Faults act only between the browser and the dashboard. Each Start's saved
  status is read back through the dashboard API with the browser's own session after the visible state settled.
*/

const chats = [
  {id: "scratch-chat-1", title: "Scratch chat one", request: "Summarize the meeting notes.", reply: "Here is the summary."},
  {id: "scratch-chat-2", title: "Scratch chat two", request: "Draft a reply to the vendor.", reply: "Here is a draft."},
] as const;
const startPanel = "Start supervision for a No Project chat";
const unknownStart = "Start outcome is unknown. Check the original operation status; no new Start will be sent.";
const startFor = (title: string) => `Start supervision for ${title}`;

// a signed-in dashboard beside a scratch project with two No Project chats, and a Start's saved status, owned by the test's scope
const signedIn = (name: string) => Effect.gen(function* () {
  const supervisor = yield* startupSession({uiAssetsDirectory: join(repositoryRoot, "ui-dist"), catalog: "empty",
    projects: [{id: "scratch", title: "Scratch", available: true, scratch: true, conversations: chats}]});
  const {page} = yield* journeyPage(name);
  const ui = yield* dashboard(page, supervisor.app.origin);
  const {token} = yield* forgeDashboardToken(supervisor.app.dataDirectory).pipe(Effect.orDie);
  yield* ui.signIn(token);
  const savedStatus = ({threadId, operationId}: StartIdentity) => Effect.gen(function* () {
    assert.ok(threadId && operationId, "the identity the page sent");
    const reply = yield* httpJson(`${supervisor.app.origin}${supervisionStartPath}?${new URLSearchParams({threadId, operationId})}`,
      {headers: {"x-supervisor-session": yield* ui.session}});
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    return (reply.body as {status?: unknown}).status;
  });
  return {ui, savedStatus};
}).pipe(Effect.provide(NodeFileSystem.layer));

it.live("a cut Start keeps its fence across a reload, no Start is sent again, and only a status read with a terminal result clears it", () => Effect.gen(function* () {
  const {ui, savedStatus} = yield* signedIn("no-project-start-cut");
  const [one, two] = chats;
  yield* ui.headingShown("Work overview");
  yield* ui.openDisclosure(startPanel);

  // the first chat's Start reaches the dashboard, which activates it, and the reply is lost: the fence holds every Start
  yield* ui.injectFault("reply-lost-after-apply", 1, supervisionStartPath);
  yield* ui.clickButton(startFor(one.title));
  yield* ui.statusShown(unknownStart);
  yield* ui.textShown(`Retained Start for ${one.id}`);
  assert.equal(yield* ui.buttonDisabled(startFor(two.title)), true, "no other Start goes while the fence holds");
  const [first] = ui.starts();
  assert.ok(first, "the first Start the page sent");
  assert.equal(yield* savedStatus(first), "active", "the dashboard activated it");

  // the reload asks before it leaves the pending Start, and the person leaves; the fence and its operation stay, nothing is sent
  yield* ui.answerDialogs(true, "beforeunload");
  yield* ui.reload;
  yield* ui.headingShown("Work overview");
  yield* ui.openDisclosure(startPanel);
  yield* ui.textShown(`Retained Start for ${one.id}`);
  assert.equal(yield* ui.buttonDisabled(startFor(two.title)), true);
  assert.deepEqual(ui.starts(), [first], "the reload sent no Start");

  // the status read of the original operation finds it active, a terminal result that clears the fence
  yield* ui.clickButton("Check Start status");
  yield* ui.statusShown("Supervision is enabled until explicit Stop. Settlement only parks the Supervisor.");
  yield* ui.textGone(`Retained Start for ${one.id}`);
  yield* ui.textShown(`${one.id} · Started`);

  // the second chat's Start is lost before the dashboard; after a reload the read finds no such operation, which keeps the fence
  yield* ui.injectFault("lost-before-server", 1, supervisionStartPath);
  yield* ui.clickButton(startFor(two.title));
  yield* ui.statusShown(unknownStart);
  yield* ui.textShown(`Retained Start for ${two.id}`);
  yield* ui.reload;
  yield* ui.headingShown("Work overview");
  yield* ui.openDisclosure(startPanel);
  yield* ui.textShown(`Retained Start for ${two.id}`);
  yield* ui.clickButton("Check Start status");
  yield* ui.statusShown("No matching Start operation is recorded. Nothing was replayed.");
  yield* ui.textShown(`Retained Start for ${two.id}`);
  const [, second] = ui.starts();
  assert.ok(second, "the second Start the page sent");
  assert.equal(yield* savedStatus(second), "denied", "the lost Start never reached the dashboard");

  // one Start per explicit click, each read only by its original operation; each reload asked before leaving a pending Start
  assert.deepEqual(ui.starts(), [{threadId: one.id, operationId: first.operationId}, {threadId: two.id, operationId: second.operationId}]);
  assert.notEqual(first.operationId, second.operationId);
  assert.deepEqual(ui.startStatusReads(), [first, second]);
  assert.deepEqual(ui.dialogs().map((dialog) => dialog.type), ["beforeunload", "beforeunload"]);
}));
