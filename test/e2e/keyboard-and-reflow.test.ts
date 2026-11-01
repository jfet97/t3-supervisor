import assert from "node:assert/strict";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { repositoryRoot } from "../../scripts/local-run.js";
import { forgeDashboardToken } from "../../src/service-auth.js";
import { journeyPage } from "../support/browser.js";
import { startupMainThreadId, startupProjectId, startupSession, type StartupSessionOptions } from "../support/startup-gateway.js";
import { dashboard, type Dashboard, type KeyboardReach } from "./dashboard.js";

/*
  A keyboard user reaches every control on the pages the journeys use, sees where focus is, and each view reflows
  (docs/testing.md, UI-STORY-08). On the sign-in form, Home with its Start panel, the Projects directory, a project's
  conversations, a chat's Task and Supervision views, Project settings, its first-time setup, Definitions, the configuration
  editor and Settings, Tab from the focused control reaches every control the page shows throughout, opening each closed
  disclosure with Enter, and each focused control shows its focus indicator inside the viewport. No view scrolls
  horizontally.

  The thresholds come from the interface acceptance reference
  (skills/maintenance/contribute-supervisor/references/interface-acceptance.md), which names the 1280 and 320 px widths and
  both themes. Browser zoom is its CSS-pixel equivalent for a 1280 x 720 window, as WCAG 2.2 success criterion 1.4.10
  (Reflow) defines it: 200 % lays the page out at 640 x 360 and 400 % at 320 x 180 CSS pixels. Each page is traversed once,
  at 1280 px in the light theme, measured at all four sizes in both themes, and its focused control is checked again in the
  dark theme; one traversal per page keeps the journey's run bounded. A focus indicator is the dashboard's own
  :focus-visible outline: solid, at least 1 px and of a visible colour.

  The production Supervisor runs over the scripted T3 peer: a checkout T3 can write, so Definitions and the editor are
  available; a chat whose Supervisor conversation T3 rejects, so its Supervision view offers Retry and nothing changes while a
  page is traversed; and a scratch project whose chat Home offers to Start. A second Supervisor has a checkout without a
  .t3-supervisor folder for the first-time setup.
*/

const titles = {project: "Startup", main: "Operative main"};
const project = startupProjectId;
const chat = startupMainThreadId;
const checkout = {
  ".t3-supervisor/project.yaml": "workflows: []\nsteps:\n  - path: steps/inspect.md\n    summary: Inspect the checkout.\n",
  ".t3-supervisor/steps/inspect.md": "---\nid: inspect\nname: Inspect checkout\ndescription: Read the current checkout and its remote state.\n---\n",
  ".t3-supervisor/workflows/.gitkeep": "",
};
const scratch = {id: "scratch", title: "Scratch", available: true, scratch: true,
  conversations: [{id: "scratch-chat", title: "Scratch chat", request: "Summarize the meeting notes.", reply: "Here is the summary."}]};

// the viewports each page is measured at: the reference's 1280 and 320 px widths and the zoom levels of a 1280 x 720 window
const sizes = [
  {label: "1280 px", width: 1280, height: 720},
  {label: "320 px wide", width: 320, height: 720},
  {label: "200 % zoom", width: 640, height: 360},
  {label: "400 % zoom", width: 320, height: 180},
] as const;

const assertReach = (where: string, reach: KeyboardReach, expected: ReadonlyArray<string>) => {
  assert.equal(reach.wrapped, true, `${where}: Tab never came back to a control it reached: ${JSON.stringify(reach.reached)}`);
  assert.deepEqual(reach.unreached, [], `${where}: shown controls that Tab never reached`);
  assert.deepEqual(reach.unfocused, [], `${where}: focused controls without a visible focus indicator in the viewport`);
  for (const name of expected) assert.ok(reach.reached.includes(name), `${where}: Tab never reached ${name}: ${JSON.stringify(reach.reached)}`);
};

/* The shown page traversed at 1280 px in the light theme, measured at every size in both themes, and its focused control
 * checked in the dark theme; `expected` names controls the traversal must reach, so an empty traversal cannot pass.
 */
const checkPage = (ui: Dashboard, page: string, expected: ReadonlyArray<string>) => Effect.gen(function* () {
  yield* ui.colorScheme("light");
  yield* ui.viewport(1280, 720);
  assertReach(`${page} at 1280 px in the light theme`, yield* ui.keyboardReach, expected);
  for (const scheme of ["light", "dark"] as const) {
    yield* ui.colorScheme(scheme);
    for (const size of sizes) {
      const extent = yield* ui.reflow(size.width, size.height);
      assert.ok(extent.scrollWidth <= extent.clientWidth, `${page} scrolls horizontally at ${size.label} in the ${scheme} theme: ${JSON.stringify(extent)}`);
    }
  }
  yield* ui.viewport(1280, 720);
  const focused = yield* ui.focusShown;
  assert.ok(focused.name !== null && focused.outlined, `${page}: the focused control shows no focus indicator in the dark theme: ${JSON.stringify(focused)}`);
  yield* ui.colorScheme("light");
});

// a dashboard over the given Supervisor, not yet signed in, and a one-time sign-in token, owned by the test's scope
const opened = (name: string, options: StartupSessionOptions) => Effect.gen(function* () {
  const supervisor = yield* startupSession({uiAssetsDirectory: join(repositoryRoot, "ui-dist"), titles, ...options});
  const {page} = yield* journeyPage(name);
  const ui = yield* dashboard(page, supervisor.app.origin);
  const {token} = yield* forgeDashboardToken(supervisor.app.dataDirectory).pipe(Effect.orDie);
  return {supervisor, ui, token};
}).pipe(Effect.provide(NodeFileSystem.layer));

it.live("every control on the journeys' pages is reachable by keyboard with visible focus, and each view reflows at 320 px and at 200 % and 400 % zoom", () => Effect.gen(function* () {
  const {supervisor, ui, token} = yield* opened("keyboard-and-reflow", {checkout, launch: {accepted: false}, projects: [scratch]});
  const definitions = `?checkout=${encodeURIComponent(supervisor.app.workspaceRoot)}`;
  const shared = ["a Skip to content", "button Sign out"];

  yield* ui.editAddress("");
  yield* ui.headingShown("Sign in to Supervisor");
  yield* checkPage(ui, "the sign-in form", ["summary How to get a sign-in token", "input Sign-in token", "button Sign in"]);
  yield* ui.signIn(token);

  yield* ui.editAddress("#/home");
  yield* ui.headingShown(/^Supervised work/u);
  yield* ui.openDisclosure("Start supervision for a No Project chat");
  yield* ui.controlReady("button", "Start supervision for Scratch chat");
  yield* checkPage(ui, "Home", [...shared, "summary Start supervision for a No Project chat", "button Start supervision for Scratch chat"]);

  yield* ui.editAddress("#/projects");
  yield* ui.headingShown("Projects");
  yield* ui.linkShown(/^Startup/u);
  yield* checkPage(ui, "the Projects directory", [...shared, "input Find a project"]);

  yield* ui.editAddress(`#/projects/${project}/conversations`);
  yield* ui.linkShown(/^Operative main/u);
  yield* ui.textGone("Reading conversation state\u2026");
  yield* checkPage(ui, "a project's conversations", [...shared, "input Find a conversation", "button Refresh folders"]);

  yield* ui.editAddress(`#/projects/${project}/task?main=${chat}`);
  yield* ui.linkShown("Open Supervision for recovery and controls");
  yield* checkPage(ui, "a chat's Task view", [...shared, "a Back to conversations", "a Supervision"]);

  yield* ui.editAddress(`#/projects/${project}/supervision?main=${chat}`);
  yield* ui.headingShown("Chat supervision");
  yield* ui.textShown("Access rejected");
  yield* ui.controlReady("button", "Retry native access");
  yield* checkPage(ui, "a chat's Supervision view", [...shared, "button Retry native access", "button Stop supervision"]);

  yield* ui.openProjectSettings(project);
  yield* ui.controlReady("button", "Disable supervision");
  yield* checkPage(ui, "Project settings", [...shared, "button Disable supervision", "button Reload status"]);

  yield* ui.editAddress(`#/projects/${project}/definitions${definitions}`);
  yield* ui.headingShown("Definition catalog");
  yield* ui.controlReady("button", "Refresh definitions");
  yield* checkPage(ui, "Definitions", [...shared, "a Edit project.yaml", "button Refresh definitions"]);

  yield* ui.editAddress(`#/projects/${project}/editor${definitions}`);
  yield* ui.headingShown("Edit project configuration");
  yield* ui.controlReady("button", "Cancel editing");
  yield* checkPage(ui, "the configuration editor", [...shared, "button Cancel editing", "textarea Summary"]);

  yield* ui.openSettings;
  yield* ui.switchOffered("global", "Disable supervision");
  yield* ui.controlReady("radio", /^On request/u);
  yield* ui.controlReady("button", "Enable global definitions");
  yield* checkPage(ui, "Settings", [...shared, "button Disable supervision", "button Reload mode", "input Add an exclusion"]);
  assert.deepEqual(ui.dialogs(), [], "no traversal opened a dialog");
}));

it.live("first-time setup is reachable by keyboard with visible focus and reflows at 320 px and at 200 % and 400 % zoom", () => Effect.gen(function* () {
  const {ui, token} = yield* opened("keyboard-and-reflow-setup", {checkout: {}});
  yield* ui.signIn(token);
  yield* ui.openProjectSettings(project);
  yield* ui.clickSwitch("project", "Enable supervision");
  yield* ui.headingShown("First-time setup");
  yield* ui.controlReady("button", "Reload setup");
  yield* checkPage(ui, "Project settings with first-time setup", ["a Skip to content", "button Sign out", "select Checkout", "button Reload setup"]);
  assert.deepEqual(ui.setups(), [], "no traversal sent a setup");
}));
