import { join } from "node:path";
import { Console, Effect, Exit, FileSystem, type Scope } from "effect";
import { chromium, type BrowserContext, type ConsoleMessage, type Page } from "playwright-core";
import { repositoryRoot } from "../../scripts/local-run.js";

/*
  The browser journeys' Playwright adapter (docs/testing.md): the library is a browser boundary with promises of its own, so
  every call into it runs here or in the page primitives (test/e2e/dashboard.ts) as an effect of the journey's fiber, never in
  a spec's own frame. One headless Chromium, its context, its page and the page's listeners are each acquired in the caller's
  scope and released in reverse order: listeners off, page closed, context closed, browser closed. The context records a
  Playwright trace from its start; when the scope closes with a failure, the trace, a screenshot and the page's errors are
  kept under .e2e-artifacts/<name> for Playwright's trace viewer before anything closes, and a passing journey keeps nothing.
  Sessions in them belong to the journey's own Supervisor, which is gone with its scope. Waiting is Playwright's own: actions
  wait until their element is actionable and `Locator.waitFor` until a state holds.

  Every completed Playwright command leaves the abort guards of its server-side ProgressControllers pending by design (each
  `_forceAbortPromise` settles only on an abort or a timeout), and no public API settles them, so the leak gate's promise
  accounting can see them whenever a spec's own frame starts a command. Release order and explicit `off` keep the actual
  resources (listeners, page, context, browser process) owned and closed.
*/

export type JourneyPage = {readonly page: Page; readonly context: BrowserContext};

export const artifactsDirectory = join(repositoryRoot, ".e2e-artifacts");

export const journeyPage = (name: string): Effect.Effect<JourneyPage, never, Scope.Scope | FileSystem.FileSystem> => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const browser = yield* Effect.acquireRelease(Effect.promise(() => chromium.launch({headless: true})), (opened) => Effect.promise(() => opened.close()));
  const context = yield* Effect.acquireRelease(Effect.promise(() => browser.newContext()), (opened) => Effect.promise(() => opened.close()));
  yield* Effect.promise(() => context.tracing.start({name, screenshots: true, snapshots: true}));
  const page = yield* Effect.acquireRelease(Effect.promise(() => context.newPage()),
    (opened) => Effect.tryPromise(() => opened.close()).pipe(Effect.ignore));
  const errors: Array<string> = [];
  const pageError = (error: Error) => {
    errors.push(`page error: ${error.message}`);
  };
  const consoleError = (message: ConsoleMessage) => {
    if (message.type() === "error") errors.push(`console error: ${message.text()}`);
  };
  yield* Effect.acquireRelease(Effect.sync(() => page.on("pageerror", pageError)), () => Effect.sync(() => page.off("pageerror", pageError)));
  yield* Effect.acquireRelease(Effect.sync(() => page.on("console", consoleError)), () => Effect.sync(() => page.off("console", consoleError)));
  const directory = join(artifactsDirectory, name);
  const keep = Effect.gen(function* () {
    yield* fs.makeDirectory(directory, {recursive: true});
    yield* Effect.tryPromise(() => page.screenshot({path: join(directory, "page.png"), fullPage: true})).pipe(Effect.ignore);
    yield* Effect.tryPromise(() => context.tracing.stop({path: join(directory, "trace.zip")})).pipe(Effect.ignore);
    yield* fs.writeFileString(join(directory, "page-errors.txt"), errors.join("\n") + "\n");
    yield* Console.error(`journey ${name} failed: its trace, screenshot and page errors are in ${directory}`);
  }).pipe(Effect.ignore);
  // registered last, so it runs first: the failed page is captured before its listeners go and it closes
  yield* Effect.addFinalizer((exit) => Exit.isSuccess(exit) ? Effect.tryPromise(() => context.tracing.stop()).pipe(Effect.ignore) : keep);
  return {page, context};
});
