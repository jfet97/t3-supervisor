import { Effect, Redacted, type Scope } from "effect";
import type { APIResponse, BrowserContext, Page, Request, Route } from "playwright-core";

/*
  The dashboard's page primitives for the browser journeys (docs/testing.md): what one person sees and does on a page, found
  by role and accessible name. Scenarios and their oracles stay in the specs. Waiting is Playwright's own: a click waits until
  its control is actionable, `waitFor` until its element is visible. Network faults act only between this browser and the
  dashboard, on the chat supervision change route or a held Supervisor settings save. Every call into the library runs as an
  effect of the journey's fiber, and the request listeners, a held save and another tab belong to the caller's scope like the
  adapter's (test/support/browser.ts).
*/

export const chatSupervisionPath = "/api/guidance/project-supervisor/chat-supervision";
export const supervisionControlPath = "/api/guidance/supervision-control";
export const projectSupervisorPath = "/api/guidance/project-supervisor";

/** The body of one chat supervision change the page sent, as the request carried it. */
export type ChatSupervisionChange = {readonly enabled: boolean};

/** How the network treats the page's next chat supervision changes: lost before the server, answered and then lost, or sent
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

/** A change the page sent that waits before the dashboard until `forward` sends it on. */
export type HeldChange = {readonly forward: Effect.Effect<void>};

/** Another tab of the same browser on the dashboard. */
export type OtherTab = {readonly signOut: Effect.Effect<void>};

// a POST the page sent below /api/guidance/, by path, with its body as the request carried it
type SentChange = {readonly path: string; readonly body: unknown};

const browser = <A>(run: () => Promise<A>): Effect.Effect<A> => Effect.promise(run);

const jsonBody = (text: string | null): unknown => {
  try {
    return JSON.parse(text ?? "null") as unknown;
  } catch {
    return null;
  }
};

// the operations on one page; `changes`, `answers` and `sent` are the records the scoped listeners and the faults keep
const operations = (page: Page, origin: string, changes: ReadonlyArray<ChatSupervisionChange>, answers: Array<ServerAnswer>,
  sent: ReadonlyArray<SentChange>) => {
  const changeRoute = `${origin}${chatSupervisionPath}`;
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
  const button = (name: string) => page.getByRole("button", {name, exact: true});
  const field = (label: string) => page.getByLabel(label, {exact: true});
  // each supervision switch is a region named for its scope, with its own switch button and status
  const switchRegion = (scope: SwitchScope) => page.getByRole("region", {name: scope === "global" ? "Global supervision" : "Project supervision", exact: true});
  const switchButton = (scope: SwitchScope, action: SwitchAction) => switchRegion(scope).getByRole("button", {name: action, exact: true});
  const bodies = (path: string): ReadonlyArray<Record<string, unknown>> => sent.flatMap((change) =>
    change.path === path && typeof change.body === "object" && change.body !== null ? [change.body as Record<string, unknown>] : []);
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
    clickStop: browser(() => stop.click()),
    clickEnable: (threadId: string) => browser(() => enable(threadId).click()),
    // the durable states: a stopped chat offers its stop notice's Enable, an enabled chat offers Stop supervision
    stoppedShown: (threadId: string) => browser(() => enable(threadId).waitFor()),
    enabledShown: browser(() => stop.waitFor()),
    unconfirmedShown: browser(() => unconfirmed.waitFor()),
    // the page's next chat supervision change meets `fault`; `times` changes in all
    injectFault: (fault: ChangeFault, times = 1) => browser(() => page.route(changeRoute, faults[fault], {times})),
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
    clickButton: (name: string) => browser(() => button(name).click()),
    buttonDisabled: (name: string) => browser(() => button(name).isDisabled()),
    headingShown: (name: string) => browser(() => page.getByRole("heading", {name, exact: true}).waitFor()),
    textShown: (text: string) => browser(() => page.getByText(text, {exact: true}).waitFor()),
    textGone: (text: string) => browser(() => page.getByText(text, {exact: true}).waitFor({state: "hidden"})),
    statusShown: (text: string) => browser(() => page.getByRole("status").filter({hasText: text}).waitFor()),
    alertShown: (text: string) => browser(() => page.getByRole("alert").filter({hasText: text}).waitFor()),
    /* Clicks Save Supervisor settings and holds the save once it left the page, with the headers it carries, before it reaches
     * the dashboard; `forward` sends it on unchanged and hands the page the dashboard's own answer. The caller's scope aborts a
     * held save that was never forwarded.
     */
    saveSettingsHeld: Effect.acquireRelease(browser(async () => {
      let hold: (route: Route) => void = () => undefined;
      const held = new Promise<Route>((resolve) => {
        hold = resolve;
      });
      await page.route(`${origin}${projectSupervisorPath}`, (route) => {
        hold(route);
      }, {times: 1});
      // the save leaves the page with its headers fixed; its route is the next event for the same request
      await Promise.all([
        page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === projectSupervisorPath),
        button("Save Supervisor settings").click(),
      ]);
      return {route: await held, forwarded: false};
    }), (change) => change.forwarded ? Effect.void : Effect.tryPromise(() => change.route.abort()).pipe(Effect.ignore)).pipe(
      Effect.map((change): HeldChange => ({
        forward: browser(async () => {
          change.forwarded = true;
          await change.route.fulfill({response: await forward(change.route)});
        }),
      }))),
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
  // every change the page sends below /api/guidance/, in order, including attempts the network then holds or loses
  const sent: Array<SentChange> = [];
  const recordSent = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() !== "POST" || !path.startsWith("/api/guidance/")) return;
    sent.push({path, body: jsonBody(request.postData())});
  };
  yield* Effect.acquireRelease(Effect.sync(() => page.on("request", recordSent)), () => Effect.sync(() => page.off("request", recordSent)));
  // what the dashboard answered to each change this browser forwarded itself
  const answers: Array<ServerAnswer> = [];
  return operations(page, origin, changes, answers, sent);
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
