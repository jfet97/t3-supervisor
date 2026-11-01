import { Effect, Redacted, type Scope } from "effect";
import type { APIResponse, BrowserContext, Dialog, Page, Request, Route } from "playwright-core";

/*
  The dashboard's page primitives for the browser journeys (docs/testing.md): what one person sees and does on a page, found
  by role and accessible name. Scenarios and their oracles stay in the specs. Waiting is Playwright's own: a click waits until
  its control is actionable, `waitFor` until its element is visible, `waitForURL` until the address bar shows a route.
  Network faults act only between this browser and the dashboard, on one change route (the chat supervision change by
  default, or another named route) or a held save. Back, Forward and an address typed into the bar are the browser's own
  history traversals; the page's dialogs are recorded and answered as the journey chose. Keyboard checks press the real Tab
  and Enter keys; widths and zoom levels are the viewport's CSS pixels and the theme is the emulated color scheme. Every call
  into the library runs as an effect of the journey's fiber, and the request and dialog listeners, a held save and another
  tab belong to the caller's scope like the adapter's (test/support/browser.ts). Page scripts are plain expressions, so no
  transpiled helper reaches the page.
*/

export const chatSupervisionPath = "/api/guidance/project-supervisor/chat-supervision";
export const supervisionControlPath = "/api/guidance/supervision-control";
export const projectSupervisorPath = "/api/guidance/project-supervisor";
export const threadPolicyPath = "/api/guidance/thread-policy";
export const projectConfigurationPath = "/api/guidance/project-configuration";
export const retryPath = "/api/guidance/project-supervisor/retry";
export const supervisionSetupPath = "/api/guidance/supervision-setup";
export const supervisionStartPath = "/api/guidance/supervision-start";

/** The body of one chat supervision change the page sent, as the request carried it. */
export type ChatSupervisionChange = {readonly enabled: boolean};

/** How the network treats the page's next changes on one route: lost before the server, answered and then lost, or sent
 * with a CSRF token the dashboard's process never issued. */
export type ChangeFault = "lost-before-server" | "reply-lost-after-apply" | "unissued-csrf-token";

/** What the dashboard answered to a change this browser forwarded itself: the status and the reason it gave, if any. */
export type ServerAnswer = {readonly status: number; readonly message: string | null};

/** A supervision switch: the master switch of the installation in Settings, or the shown project's own switch. */
export type SwitchScope = "global" | "project";

/** What a switch offers: Disable while its own setting is on, Enable while it is off. */
export type SwitchAction = "Disable supervision" | "Enable supervision";

/** The body of one supervision switch change the page sent: the project it names, null for the master switch, and the state
 * it asks for. */
export type SwitchChange = {readonly projectId: string | null; readonly enabled: boolean};

/** The body of one Supervisor settings save the page sent: the settings generation it was edited against and its helper
 * limit. */
export type SettingsSave = {readonly expectedGeneration: number | null; readonly maxHelpersPerRoot: number | null};

/** The body of one chat settings save the page sent: the policy generation it was edited against and the excluded chats. */
export type PolicySave = {readonly generation: number | null; readonly excludedThreadIds: ReadonlyArray<string>};

/** The body of one project.yaml save the page sent: the revision it was edited against and the summary of each indexed step. */
export type ConfigurationSave = {readonly expectedRevision: string | null; readonly stepSummaries: ReadonlyArray<string>};

/** The body of one native access retry the page sent: the Supervisor conversation and generation it names, and its action. */
export type RetryRequest = {readonly threadId: string | null; readonly bindingGeneration: number | null; readonly action: string | null};

/** The body of one first-time setup the page sent: the checkout it names and its action. */
export type SetupRequest = {readonly expectedWorkspaceRoot: string | null; readonly action: string | null};

/** The chat and the operation identity of one Start the page sent, or of one read of a Start's status. */
export type StartIdentity = {readonly threadId: string | null; readonly operationId: string | null};

/** The emulated color scheme, which the dashboard's System theme follows. */
export type ColorScheme = "light" | "dark";

/**
 * One keyboard traversal of the shown page: Tab pressed until focus returns to a control it already reached, opening each
 * closed disclosure with Enter. `reached` names every control focused, `unreached` every control shown throughout that Tab
 * never focused, and `unfocused` every focused control without a visible focus indicator inside the viewport.
 */
export type KeyboardReach = {readonly wrapped: boolean; readonly reached: ReadonlyArray<string>; readonly unreached: ReadonlyArray<string>;
  readonly unfocused: ReadonlyArray<string>};

/** The page's horizontal extent at one viewport: its scroll width against the width it has. */
export type Reflow = {readonly width: number; readonly height: number; readonly scrollWidth: number; readonly clientWidth: number};

/** A dialog the page opened: its kind (`confirm`, `beforeunload`, ...) and its message. */
export type ShownDialog = {readonly type: string; readonly message: string};

/** A change the page sent that waits before the dashboard until `forward` sends it on. */
export type HeldChange = {readonly forward: Effect.Effect<void>};

/** Another tab of the same browser on the dashboard. */
export type OtherTab = {readonly signOut: Effect.Effect<void>};

// a POST the page sent below /api/guidance/, by path, with its body as the request carried it, and a GET with its query
type SentChange = {readonly path: string; readonly body: unknown};
type SentRead = {readonly path: string; readonly query: Readonly<Record<string, string>>};

// the dialogs the page opened, in order, and the kinds of dialog the journey chose to accept
type Prompts = {readonly accepted: Set<string>; readonly shown: Array<ShownDialog>};

const browser = <A>(run: () => Promise<A>): Effect.Effect<A> => Effect.promise(run);

// a pattern that matches `text` literally at the start of an accessible name
const startingWith = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u");

/* The page side of a keyboard traversal. It begins by keeping every node added to the page from then on, since a control
 * added during the traversal was not shown throughout it; each step records the newly focused control and whether its
 * focus indicator shows (a solid outline of at least 1 px in a visible colour, the dashboard's :focus-visible rule) on an
 * element inside the viewport; the end lists every control the Tab order holds that stayed shown and that no step reached.
 * A radio group is one stop of the Tab order, so any of its radios reaches the group.
 */
const traversalBegin = `(() => {
  const describe = (element) => {
    const label = element.getAttribute("aria-label") || (element.labels && element.labels.length ? element.labels[0].textContent : "") ||
      element.textContent || element.getAttribute("placeholder") || element.getAttribute("title") || "";
    return element.tagName.toLowerCase() + " " + label.replace(/\\s+/g, " ").trim().slice(0, 80);
  };
  const state = {describe, reached: new Set(), names: [], unfocused: [], added: new WeakSet(), observer: null};
  state.observer = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) state.added.add(node);
  });
  state.observer.observe(document, {childList: true, subtree: true});
  window.__e2eKeyboard = state;
})()`;
const traversalStep = `(() => {
  const state = window.__e2eKeyboard;
  const element = document.activeElement;
  if (!element || element === document.body || element === document.documentElement) return {wrapped: false, closedSummary: false};
  if (state.reached.has(element)) return {wrapped: true, closedSummary: false};
  state.reached.add(element);
  state.names.push(state.describe(element));
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const outlined = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 1 && style.outlineColor !== "transparent" &&
    !/^rgba\\(.*,\\s*0\\)$/.test(style.outlineColor);
  const inView = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  if (!outlined || !inView) state.unfocused.push(state.describe(element));
  return {wrapped: false, closedSummary: element.tagName === "SUMMARY" && element.parentElement instanceof HTMLDetailsElement && !element.parentElement.open};
})()`;
const traversalEnd = `(() => {
  const state = window.__e2eKeyboard;
  for (const record of state.observer.takeRecords()) for (const node of record.addedNodes) state.added.add(node);
  state.observer.disconnect();
  delete window.__e2eKeyboard;
  const addedSince = (element) => {
    for (let node = element; node; node = node.parentNode) if (state.added.has(node)) return true;
    return false;
  };
  const stop = (element) => element instanceof HTMLInputElement && element.type === "radio" && element.name ? "radio:" + element.name : element;
  const shown = (element) => element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest("[inert]") &&
    !(element instanceof HTMLInputElement && element.type === "hidden") && element.checkVisibility({visibilityProperty: true, checkVisibilityCSS: true});
  const controls = [...document.querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex]")].filter((element) => shown(element) && !addedSince(element));
  const stops = new Set([...state.reached].map(stop));
  return {reached: state.names, unreached: controls.filter((element) => !stops.has(stop(element))).map(state.describe), unfocused: state.unfocused};
})()`;
// at most this many Tab presses per traversal, far above the longest page's controls; a traversal that reaches it never wrapped
const traversalLimit = 800;
// the focused control and whether its focus indicator shows, by the same rule as a traversal step
const focusedOutline = `(() => {
  const element = document.activeElement;
  if (!element || element === document.body || element === document.documentElement) return {name: null, outlined: false};
  const style = getComputedStyle(element);
  return {name: element.tagName.toLowerCase(), outlined: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 1 &&
    style.outlineColor !== "transparent" && !/^rgba\\(.*,\\s*0\\)$/.test(style.outlineColor)};
})()`;

const jsonBody = (text: string | null): unknown => {
  try {
    return JSON.parse(text ?? "null") as unknown;
  } catch {
    return null;
  }
};

/* The operations on one page; `changes`, `answers`, `sent` and `prompts` are the records the scoped listeners and the faults
 * keep.
 */
const operations = (page: Page, origin: string, changes: ReadonlyArray<ChatSupervisionChange>, answers: Array<ServerAnswer>,
  sent: ReadonlyArray<SentChange>, reads: ReadonlyArray<SentRead>, prompts: Prompts) => {
  // each forwarded change carries the dashboard's own Origin explicitly, so only the fault itself can make the dashboard refuse it
  const forward = async (route: Route, headers: Record<string, string> = {}): Promise<APIResponse> => {
    const reply = await route.fetch({headers: {...route.request().headers(), origin, ...headers}});
    const body: unknown = await reply.json().catch(() => null);
    const message = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string" ? body.message : null;
    answers.push({status: reply.status(), message});
    return reply;
  };
  const faults: Record<ChangeFault, (route: Route) => Promise<void>> = {
    "lost-before-server": (route) => route.abort("connectionreset"),
    "reply-lost-after-apply": async (route) => {
      await forward(route);
      await route.abort("connectionreset");
    },
    /* A CSRF token the dashboard's process never issued, as every token of the previous process is after a restart; the page
     * receives the dashboard's own answer unchanged.
     */
    "unissued-csrf-token": async (route) => {
      await route.fulfill({response: await forward(route, {"x-csrf-token": "a-token-this-process-never-issued"})});
    },
  };
  const stop = page.getByRole("button", {name: "Stop supervision", exact: true});
  const unconfirmed = page.getByRole("status").filter({hasText: "The change could not be confirmed. The saved state is shown."});
  const enable = (threadId: string) => page.getByRole("button", {name: `Enable supervision for ${threadId}`, exact: true});
  // a button by its exact accessible name, or one whose name starts with a text
  const button = (name: string | RegExp) => page.getByRole("button", typeof name === "string" ? {name, exact: true} : {name});
  const field = (label: string) => page.getByLabel(label, {exact: true});
  // a native disclosure by the visible title its summary starts with; a summary has no ARIA role, so it is found by its element
  const disclosure = (title: string) => page.locator("summary").filter({hasText: startingWith(title)}).filter({visible: true});
  /* A link by its exact accessible name, or one matching a pattern, anywhere on the page or within the navigation landmark
   * named `within`.
   */
  const link = (name: string | RegExp, within?: string) => {
    const options: {name: string | RegExp; exact?: boolean} = typeof name === "string" ? {name, exact: true} : {name};
    return within === undefined ? page.getByRole("link", options) : page.getByRole("navigation", {name: within, exact: true}).getByRole("link", options);
  };
  // each supervision switch is a region named for its scope, with its own switch button and status
  const switchRegion = (scope: SwitchScope) => page.getByRole("region", {name: scope === "global" ? "Global supervision" : "Project supervision", exact: true});
  const switchButton = (scope: SwitchScope, action: SwitchAction) => switchRegion(scope).getByRole("button", {name: action, exact: true});
  const bodies = (path: string): ReadonlyArray<Record<string, unknown>> => sent.flatMap((change) =>
    change.path === path && typeof change.body === "object" && change.body !== null ? [change.body as Record<string, unknown>] : []);
  const stringOf = (value: unknown): string | null => typeof value === "string" ? value : null;
  const evaluate = <A>(script: string) => page.evaluate(script) as Promise<A>;
  /* Clicks `name` and holds the change it sends to `path` once it left the page, with the headers it carries, before it reaches
   * the dashboard; `forward` sends it on unchanged and hands the page the dashboard's own answer. A confirm dialog the click
   * opens is answered first, as the journey chose. The caller's scope aborts a held change that was never forwarded.
   */
  const clickHeld = (name: string, path: string) => Effect.acquireRelease(browser(async () => {
    let hold: (route: Route) => void = () => undefined;
    const held = new Promise<Route>((resolve) => {
      hold = resolve;
    });
    await page.route(`${origin}${path}`, (route) => {
      hold(route);
    }, {times: 1});
    // the change leaves the page with its headers fixed; its route is the next event for the same request
    await Promise.all([
      page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === path),
      button(name).click(),
    ]);
    return {route: await held, forwarded: false};
  }), (change) => change.forwarded ? Effect.void : Effect.tryPromise(() => change.route.abort()).pipe(Effect.ignore)).pipe(
    Effect.map((change): HeldChange => ({
      forward: browser(async () => {
        change.forwarded = true;
        await change.route.fulfill({response: await forward(change.route)});
      }),
    })));
  return {
    changes: (): ReadonlyArray<ChatSupervisionChange> => [...changes],
    answers: (): ReadonlyArray<ServerAnswer> => [...answers],
    /* Every supervision switch change and every Supervisor settings save the page sent, in order, including attempts the
     * network then held.
     */
    switchChanges: (): ReadonlyArray<SwitchChange> => bodies(supervisionControlPath).map((body) =>
      ({projectId: typeof body.projectId === "string" ? body.projectId : null, enabled: body.enabled === true})),
    settingsSaves: (): ReadonlyArray<SettingsSave> => bodies(projectSupervisorPath).map((body) => {
      const team = body.teamSettings;
      const limit = typeof team === "object" && team !== null && "maxHelpersPerRoot" in team && typeof team.maxHelpersPerRoot === "number" ? team.maxHelpersPerRoot : null;
      return {expectedGeneration: typeof body.expectedGeneration === "number" ? body.expectedGeneration : null, maxHelpersPerRoot: limit};
    }),
    // every chat settings save the page sent, in order, including attempts the network then lost
    policySaves: (): ReadonlyArray<PolicySave> => bodies(threadPolicyPath).map((body) => ({
      generation: typeof body.generation === "number" ? body.generation : null,
      excludedThreadIds: Array.isArray(body.excludedThreadIds) ? body.excludedThreadIds.filter((id): id is string => typeof id === "string") : [],
    })),
    /* Every dialog the page opened, in order, and how the next dialogs of one kind (`confirm` unless named, or
     * `beforeunload`) are answered: dismissed unless the journey chose to accept that kind.
     */
    dialogs: (): ReadonlyArray<ShownDialog> => [...prompts.shown],
    answerDialogs: (accept: boolean, type = "confirm") => Effect.sync(() => {
      if (accept) prompts.accepted.add(type);
      else prompts.accepted.delete(type);
    }),
    signIn: (token: Redacted.Redacted<string>) => browser(async () => {
      await page.goto(`${origin}/`);
      await page.getByLabel("Sign-in token").fill(Redacted.value(token));
      await page.getByRole("button", {name: "Sign in", exact: true}).click();
      await page.getByRole("button", {name: "Sign out", exact: true}).waitFor();
    }),
    // signs in again in the sign-in form this tab shows after its session ended, with the open dashboard kept behind it
    signInAgain: (token: Redacted.Redacted<string>) => browser(async () => {
      await page.getByLabel("Sign-in token").fill(Redacted.value(token));
      await page.getByRole("button", {name: "Sign in", exact: true}).click();
      await page.getByRole("button", {name: "Sign out", exact: true}).waitFor();
    }),
    // the session this browser signed in with, so a read after a click is the same person's supported API call
    session: browser(async () => {
      const stored: unknown = await page.evaluate("window.localStorage.getItem('supervisor-session')");
      return typeof stored === "string" ? stored : "";
    }),
    openChatSupervision: (projectId: string, threadId: string) => browser(async () => {
      await page.goto(`${origin}/#/projects/${encodeURIComponent(projectId)}/supervision?main=${encodeURIComponent(threadId)}`);
      await page.getByRole("heading", {name: "Chat supervision", exact: true}).waitFor();
    }),
    openSettings: browser(async () => {
      await page.goto(`${origin}/#/settings`);
      await page.getByRole("heading", {name: "Instance settings", exact: true}).waitFor();
    }),
    // a project's settings: its own supervision switch and the Supervisor settings form, shown once the project is read
    openProjectSettings: (projectId: string) => browser(async () => {
      await page.goto(`${origin}/#/projects/${encodeURIComponent(projectId)}/settings`);
      await page.getByRole("form", {name: "Supervisor settings", exact: true}).waitFor();
    }),
    reload: browser(async () => {
      await page.reload();
    }),
    // the browser's own Back and Forward, and an address typed into the bar: `hash` is the dashboard route after its origin
    goBack: browser(async () => {
      await page.goBack();
    }),
    goForward: browser(async () => {
      await page.goForward();
    }),
    editAddress: (hash: string) => browser(async () => {
      await page.goto(`${origin}/${hash}`);
    }),
    // the address bar shows exactly the route `hash`
    addressShown: (hash: string) => browser(() => page.waitForURL((url) => url.hash === hash)),
    // a link by its exact name, or matching a pattern, optionally within the navigation landmark named `within`
    clickLink: (name: string | RegExp, within?: string) => browser(() => link(name, within).click()),
    // a listed entry, such as a project card or a conversation row, whose link names `title` first
    openEntry: (title: string) => browser(() => link(startingWith(title)).click()),
    clickStop: browser(() => stop.click()),
    clickEnable: (threadId: string) => browser(() => enable(threadId).click()),
    // the durable states: a stopped chat offers its stop notice's Enable, an enabled chat offers Stop supervision
    stoppedShown: (threadId: string) => browser(() => enable(threadId).waitFor()),
    enabledShown: browser(() => stop.waitFor()),
    unconfirmedShown: browser(() => unconfirmed.waitFor()),
    // the page's next change on `path`, the chat supervision change route unless named, meets `fault`; `times` changes in all
    injectFault: (fault: ChangeFault, times = 1, path = chatSupervisionPath) => browser(() => page.route(`${origin}${path}`, faults[fault], {times})),
    // the durable state of a supervision switch is the action it offers for its own setting
    switchOffered: (scope: SwitchScope, action: SwitchAction) => browser(() => switchButton(scope, action).waitFor()),
    clickSwitch: (scope: SwitchScope, action: SwitchAction) => browser(() => switchButton(scope, action).click()),
    switchStatusShown: (scope: SwitchScope, label: string) => browser(() => switchRegion(scope).getByText(label, {exact: true}).waitFor()),
    // fields and buttons by their label or accessible name, and the page's visible messages by their text
    fill: (label: string, value: string) => browser(() => field(label).fill(value)),
    fieldValue: (label: string) => browser(async () => {
      await field(label).waitFor();
      return await field(label).inputValue();
    }),
    clickButton: (name: string | RegExp) => browser(() => button(name).click()),
    buttonShown: (name: string | RegExp) => browser(() => button(name).waitFor()),
    linkShown: (name: string | RegExp) => browser(() => link(name).waitFor()),
    // waits until a control of `role` named `name` is shown and enabled, as a click would, without acting on it
    controlReady: (role: "button" | "link" | "radio" | "textbox", name: string | RegExp) =>
      browser(() => page.getByRole(role, typeof name === "string" ? {name, exact: true} : {name}).click({trial: true})),
    buttonDisabled: (name: string | RegExp) => browser(() => button(name).isDisabled()),
    headingShown: (name: string | RegExp) => browser(() => page.getByRole("heading", typeof name === "string" ? {name, exact: true} : {name}).waitFor()),
    textShown: (text: string, heading?: string) => browser(() => (heading === undefined ? page :
      page.getByRole("heading", {name: heading, exact: true}).locator("..")).getByText(text, {exact: true}).waitFor()),
    textGone: (text: string) => browser(() => page.getByText(text, {exact: true}).waitFor({state: "hidden"})),
    statusShown: (text: string) => browser(() => page.getByRole("status").filter({hasText: text}).waitFor()),
    alertShown: (text: string) => browser(() => page.getByRole("alert").filter({hasText: text}).waitFor()),
    // holds a Supervisor settings save or a project.yaml save between the page and the dashboard (clickHeld)
    saveSettingsHeld: clickHeld("Save Supervisor settings", projectSupervisorPath),
    saveConfigurationHeld: clickHeld("Save project configuration", projectConfigurationPath),
    /* Every project.yaml save, native access retry, first-time setup and Start the page sent, in order, including attempts the
     * network then held or lost, and every read of a Start's status.
     */
    configurationSaves: (): ReadonlyArray<ConfigurationSave> => bodies(projectConfigurationPath).map((body) => {
      const config = body.config;
      const steps = typeof config === "object" && config !== null && "steps" in config && Array.isArray(config.steps) ? config.steps as ReadonlyArray<unknown> : [];
      return {expectedRevision: stringOf(body.expectedRevision),
        stepSummaries: steps.flatMap((step) => typeof step === "object" && step !== null && "summary" in step && typeof step.summary === "string" ? [step.summary] : [])};
    }),
    retries: (): ReadonlyArray<RetryRequest> => bodies(retryPath).map((body) =>
      ({threadId: stringOf(body.threadId), bindingGeneration: typeof body.bindingGeneration === "number" ? body.bindingGeneration : null, action: stringOf(body.action)})),
    setups: (): ReadonlyArray<SetupRequest> => bodies(supervisionSetupPath).map((body) =>
      ({expectedWorkspaceRoot: stringOf(body.expectedWorkspaceRoot), action: stringOf(body.action)})),
    starts: (): ReadonlyArray<StartIdentity> => bodies(supervisionStartPath).map((body) => ({threadId: stringOf(body.threadId), operationId: stringOf(body.operationId)})),
    startStatusReads: (): ReadonlyArray<StartIdentity> => reads.flatMap((read) => read.path === supervisionStartPath
      ? [{threadId: read.query.threadId ?? null, operationId: read.query.operationId ?? null}] : []),
    // opens a closed disclosure by the title its summary starts with, as a click on the summary does
    openDisclosure: (title: string) => browser(async () => {
      const summary = disclosure(title);
      if (!(await summary.evaluate((element) => element.parentElement instanceof HTMLDetailsElement && element.parentElement.open))) await summary.click();
    }),
    // chooses an option of a select by its label
    choose: (label: string, option: string) => browser(async () => {
      await field(label).selectOption({label: option});
    }),
    // a switch's offered action is disabled, and its region's Reload status reads the switch again
    switchDisabled: (scope: SwitchScope, action: SwitchAction) => browser(() => switchButton(scope, action).isDisabled()),
    reloadSwitch: (scope: SwitchScope) => browser(() => switchRegion(scope).getByRole("button", {name: "Reload status", exact: true}).click()),
    // the emulated color scheme and the viewport in CSS pixels
    colorScheme: (scheme: ColorScheme) => browser(() => page.emulateMedia({colorScheme: scheme})),
    viewport: (width: number, height: number) => browser(() => page.setViewportSize({width, height})),
    // the page's horizontal extent once the viewport is `width` by `height` CSS pixels
    reflow: (width: number, height: number) => browser(async (): Promise<Reflow> => {
      await page.setViewportSize({width, height});
      const extent = await evaluate<{scrollWidth: number; clientWidth: number}>(
        "({scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth})");
      return {width, height, ...extent};
    }),
    // the control that has focus now, and whether it shows its focus indicator
    focusShown: browser(() => evaluate<{name: string | null; outlined: boolean}>(focusedOutline)),
    // use Tab until focus returns to a control it already reached, opening each closed disclosure with Enter
    keyboardReach: browser(async (): Promise<KeyboardReach> => {
      await evaluate<void>(traversalBegin);
      let wrapped = false;
      for (let presses = 0; presses < traversalLimit && !wrapped; presses++) {
        await page.keyboard.press("Tab");
        const step = await evaluate<{wrapped: boolean; closedSummary: boolean}>(traversalStep);
        if (step.closedSummary) await page.keyboard.press("Enter");
        wrapped = step.wrapped;
      }
      return {wrapped, ...await evaluate<Omit<KeyboardReach, "wrapped">>(traversalEnd)};
    }),
  };
};

export type Dashboard = ReturnType<typeof operations>;

/** The dashboard of a journey's Supervisor at `origin`, used through `page` for the caller's scope. */
export const dashboard = (page: Page, origin: string): Effect.Effect<Dashboard, never, Scope.Scope> => Effect.gen(function* () {
  // every chat supervision change the page sends, in order, including attempts the network then loses
  const changes: Array<ChatSupervisionChange> = [];
  const recordChange = (request: Request) => {
    if (request.method() !== "POST" || new URL(request.url()).pathname !== chatSupervisionPath) return;
    const body = JSON.parse(request.postData() ?? "{}") as {enabled?: unknown};
    changes.push({enabled: body.enabled === true});
  };
  yield* Effect.acquireRelease(Effect.sync(() => page.on("request", recordChange)), () => Effect.sync(() => page.off("request", recordChange)));
  /* Every change the page sends below /api/guidance/, in order, including attempts the network then holds or loses, and every
   * read with its query.
   */
  const sent: Array<SentChange> = [];
  const reads: Array<SentRead> = [];
  const recordSent = (request: Request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/guidance/")) return;
    if (request.method() === "POST") sent.push({path: url.pathname, body: jsonBody(request.postData())});
    else if (request.method() === "GET") reads.push({path: url.pathname, query: Object.fromEntries(url.searchParams)});
  };
  yield* Effect.acquireRelease(Effect.sync(() => page.on("request", recordSent)), () => Effect.sync(() => page.off("request", recordSent)));
  /* Every dialog the page opens, in order. A listener takes over Playwright's own answer, so this one keeps the documented
   * default: every dialog, a beforeunload included, is dismissed unless the journey chose to accept dialogs of its kind, and
   * a dismissed beforeunload keeps the page where it is.
   */
  const prompts: Prompts = {accepted: new Set(), shown: []};
  const answerDialog = (dialog: Dialog) => {
    prompts.shown.push({type: dialog.type(), message: dialog.message()});
    (prompts.accepted.has(dialog.type()) ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
  };
  yield* Effect.acquireRelease(Effect.sync(() => page.on("dialog", answerDialog)), () => Effect.sync(() => page.off("dialog", answerDialog)));
  // what the dashboard answered to each change this browser forwarded itself
  const answers: Array<ServerAnswer> = [];
  return operations(page, origin, changes, answers, sent, reads, prompts);
});

/** Another tab of the same browser `context`, on the dashboard at `origin` and owned by the caller's scope: it shares the stored
 * session, so its explicit Sign out ends that session on the dashboard and in every tab. */
export const otherTab = (context: BrowserContext, origin: string): Effect.Effect<OtherTab, never, Scope.Scope> => Effect.gen(function* () {
  const page = yield* Effect.acquireRelease(browser(() => context.newPage()), (opened) => Effect.tryPromise(() => opened.close()).pipe(Effect.ignore));
  const signOut = page.getByRole("button", {name: "Sign out", exact: true});
  yield* browser(async () => {
    await page.goto(`${origin}/`);
    await signOut.waitFor();
  });
  return {
    signOut: browser(async () => {
      await signOut.click();
      await page.getByRole("heading", {name: "Sign in to Supervisor", exact: true}).waitFor();
    }),
  };
});
