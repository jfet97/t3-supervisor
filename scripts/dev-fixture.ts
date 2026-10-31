import { join } from "node:path";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Console, Data, Effect, FileSystem, Redacted } from "effect";
import { forgeDashboardToken } from "../src/service-auth.js";
import { driveNeededWork, startupSession, type ExtraProject } from "../test/support/startup-gateway.js";
import { createRun, repositoryRoot, shellQuote } from "./local-run.js";

/*
  `pnpm dev:fixture`: the production Supervisor application (runGuidanceApplication with its stores, controllers, dashboard
  and workflow MCP route) over the repository's scripted native T3 peer, serving this checkout's compiled dashboard for
  browser inspection (docs/local-stack.md). It is the startup chain the CI suite runs (test/support/startup-gateway.ts).
  Its T3 and its operative are simulated: label evidence from it `fixture`; actual T3 and provider behavior needs
  `pnpm dev:stack`.
*/

export type FixtureScenario = "populated" | "empty" | "unavailable";
export const fixtureScenarios: ReadonlyArray<FixtureScenario> = ["populated", "empty", "unavailable"];

export class FixtureError extends Data.TaggedError("FixtureError")<{readonly message: string}> {}

// projects and conversations beside the supervised main; their titles and messages start with "Fixture"
export const fixtureProjects: ReadonlyArray<ExtraProject> = [
  {id: "fixture-docs", title: "Fixture: documentation", available: true, conversations: [
    {id: "fixture-docs-readme", title: "Fixture: refresh the README", request: "Fixture: refresh the install section of the README.",
      reply: "Fixture: the install section now describes the package and the container."},
    {id: "fixture-docs-typo", title: "Fixture: fix a typo", request: "Fixture: fix the typo in CONTRIBUTING.", reply: "Fixture: fixed the typo."},
  ]},
  {id: "fixture-missing", title: "Fixture: folder unavailable", available: false, conversations: [
    {id: "fixture-missing-chat", title: "Fixture: earlier work", request: "Fixture: summarize the earlier work.", reply: "Fixture: summary written."},
  ]},
];

export interface FixtureSession {
  readonly scenario: FixtureScenario;
  readonly url: string;
  readonly dataDirectory: string;
  readonly runFolder: string;
  readonly signInToken: Redacted.Redacted<string>;
  // the private (0600) file holding that token, so it never needs to appear in output
  readonly signInTokenFile: string;
}

/**
 * One fixture in the caller's scope, in a fresh marked run folder removed with the scope. `populated` has a supervised main
 * whose root interpreted the request as needed work with a two-step plan the operative has read, plus plain and unavailable
 * projects; `unavailable` is the same data after T3 stopped answering; `empty` lists nothing.
 */
export const fixtureSession = (options: {readonly scenario: FixtureScenario; readonly port?: number; readonly assets?: string; readonly runRoot?: string}) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const assets = options.assets ?? join(repositoryRoot, "ui-dist");
  if (!(yield* fs.exists(join(assets, "index.html")))) return yield* new FixtureError({message: "the dashboard is not built; run `pnpm build` first"});
  const run = yield* createRun("fixture", options.runRoot === undefined ? {} : {root: options.runRoot});
  const directory = run.dir("supervisor");
  yield* fs.makeDirectory(directory);
  const availability = {up: true};
  const populated = options.scenario !== "empty";
  const session = yield* startupSession({directory, uiAssetsDirectory: assets, ...(options.port === undefined ? {} : {uiPort: options.port}),
    catalog: populated ? "startup" : "empty", titles: {project: "Fixture: startup project", main: "Fixture: checkout status"},
    projects: populated ? fixtureProjects : [], availability});
  if (populated) yield* driveNeededWork(session);
  if (options.scenario === "unavailable") availability.up = false;
  const issued = yield* forgeDashboardToken(directory).pipe(Effect.mapError(() => new FixtureError({message: "could not issue a sign-in token"})));
  const signInTokenFile = run.dir("sign-in-token");
  yield* fs.writeFileString(signInTokenFile, `${Redacted.value(issued.token)}\n`, {mode: 0o600});
  return {scenario: options.scenario, url: session.app.origin, dataDirectory: directory, runFolder: run.path, signInToken: issued.token,
    signInTokenFile} satisfies FixtureSession;
});

export const fixtureSummary = (session: FixtureSession): string => [
  `Supervisor fixture (${session.scenario}) at ${session.url}/`,
  "  production Supervisor application, simulated T3 and operative: label observations `fixture`",
  `  run folder ${session.runFolder}`,
  `Sign in with the one-time token (five minutes) in the private file ${shellQuote(session.signInTokenFile)}`,
  `  another token: node --import tsx src/cli.ts auth forge --data-dir ${shellQuote(session.dataDirectory)}`,
  "Rebuild the dashboard with `pnpm dev:ui` in another terminal and reload; stop with Ctrl-C, which removes the run folder.",
].join("\n");

const usage = `usage: pnpm dev:fixture [--scenario ${fixtureScenarios.join("|")}] [--port <port>] [--for <seconds>]`;

const main = Effect.gen(function* () {
  const args = process.argv.slice(2);
  const value = (name: string) => {const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined;};
  const unknown = args.filter((arg, index) => !["--scenario", "--port", "--for"].includes(arg) && !["--scenario", "--port", "--for"].includes(args[index - 1] ?? ""));
  if (unknown.length) return yield* new FixtureError({message: `unknown argument ${unknown[0]}\n${usage}`});
  const scenario = (value("--scenario") ?? "populated") as FixtureScenario;
  if (!fixtureScenarios.includes(scenario)) return yield* new FixtureError({message: `unknown scenario ${scenario}\n${usage}`});
  const port = value("--port") === undefined ? undefined : Number(value("--port"));
  const seconds = value("--for") === undefined ? undefined : Number(value("--for"));
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) return yield* new FixtureError({message: `--port needs a TCP port\n${usage}`});
  if (seconds !== undefined && !(seconds > 0)) return yield* new FixtureError({message: `--for needs a positive number of seconds\n${usage}`});
  yield* Effect.scoped(Effect.gen(function* () {
    const session = yield* fixtureSession({scenario, ...(port === undefined ? {} : {port})});
    yield* Console.log(fixtureSummary(session));
    yield* seconds === undefined ? Effect.never : Effect.sleep(`${seconds} seconds`);
  }));
});

if (import.meta.main) NodeRuntime.runMain(main.pipe(Effect.tapError((error) => Console.error(error.message)), Effect.provide(NodeFileSystem.layer)),
  {disableErrorReporting: true});
