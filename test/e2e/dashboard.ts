import { Effect, Redacted, type Scope } from "effect";
import type { APIResponse, Page, Request, Route } from "playwright-core";

/*
  The dashboard's page primitives for the browser journeys (docs/testing.md): what one person sees and does on a page, found
  by role and accessible name. Scenarios and their oracles stay in the specs. Waiting is Playwright's own: a click waits until
  its control is actionable, `waitFor` until its element is visible. Network faults act only between this browser and the
  dashboard, on the chat supervision change route. Every call into the library runs as an effect of the journey's fiber, and
  the request listener belongs to the caller's scope like the adapter's (test/support/browser.ts).
*/

export const chatSupervisionPath = "/api/guidance/project-supervisor/chat-supervision";

/** The body of one chat supervision change the page sent, as the request carried it. */
export type ChatSupervisionChange = {readonly enabled: boolean};

/** How the network treats the page's next chat supervision changes: lost before the server, answered and then lost, or sent
 * with a CSRF token the dashboard's process never issued. */
export type ChangeFault = "lost-before-server" | "reply-lost-after-apply" | "unissued-csrf-token";

/** What the dashboard answered to a change this browser forwarded itself: the status and the reason it gave, if any. */
export type ServerAnswer = {readonly status: number; readonly message: string | null};

const browser = <A>(run: () => Promise<A>): Effect.Effect<A> => Effect.promise(run);

// the operations on one page; `changes` and `answers` are the records the scoped listener and the faults keep
const operations = (page: Page, origin: string, changes: ReadonlyArray<ChatSupervisionChange>, answers: Array<ServerAnswer>) => {
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
    // a CSRF token the dashboard's process never issued, as every token of the previous process is after a restart; the page
    // receives the dashboard's own answer unchanged
    "unissued-csrf-token": async (route) => {
      await route.fulfill({response: await forward(route, {"x-csrf-token": "a-token-this-process-never-issued"})});
    },
  };
  const stop = page.getByRole("button", {name: "Stop supervision", exact: true});
  const unconfirmed = page.getByRole("status").filter({hasText: "The change could not be confirmed. The saved state is shown."});
  const enable = (threadId: string) => page.getByRole("button", {name: `Enable supervision for ${threadId}`, exact: true});
  return {
    changes: (): ReadonlyArray<ChatSupervisionChange> => [...changes],
    answers: (): ReadonlyArray<ServerAnswer> => [...answers],
    signIn: (token: Redacted.Redacted<string>) => browser(async () => {
      await page.goto(`${origin}/`);
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
  // what the dashboard answered to each change this browser forwarded itself
  const answers: Array<ServerAnswer> = [];
  return operations(page, origin, changes, answers);
});
