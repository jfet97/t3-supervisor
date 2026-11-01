# Development environment

Development and testing run in this repository's Docker environment. The host needs
Docker with the Compose plugin and nothing else: no Node, pnpm or Nix, no existing T3
or Supervisor, and no login or configuration from the host. `./dev` is the host entry
point; every command runs in containers built from `docker/dev/Dockerfile`, which holds
Node 24.22.1 at the production image's pinned digest, pnpm 12.14.0, Git, Codex 0.166.0
and Claude Code 2.1.316. The checkout is mounted at `/workspace`, so source edits apply
directly. Images never contain source, credentials or state.

| Command | Does |
| --- | --- |
| `./dev setup` | builds the image and installs dependencies; T3's **Setup Worktree** action runs it |
| `./dev up` | `setup`, builds the dashboard, then starts T3 and Supervisor and waits until both are healthy |
| `./dev stop`, `./dev start` | stops or starts the containers; nothing is removed |
| `./dev down` | removes the containers and their network; every volume stays |
| `./dev restart` | restarts T3 and Supervisor in their container |
| `./dev recreate` | recreates the container from the current image; every volume stays |
| `./dev rebuild` | rebuilds the image from its pinned base, then recreates; every volume stays |
| `./dev status` | containers, health and the provider CLIs' sign-in status |
| `./dev logs [-f]` | the T3 and Supervisor log |
| `./dev shell` | an interactive shell in the toolchain container |
| `./dev pnpm ARGS` | pnpm in the toolchain container, for example `./dev pnpm test test/config.test.ts` |
| `./dev login codex`, `./dev login claude` | signs in to a provider CLI |
| `./dev pair` | prints a one-time link that opens this environment's T3 in the browser |
| `./dev sign-in` | prints a one-time Supervisor dashboard sign-in token |
| `./dev fixture`, `./dev ui-fixture` | the dashboard fixtures, below |
| `./dev check` | the disposable published-T3 check, below |
| `./dev e2e [ARGS]` | the browser journeys, below; ARGS go to vitest |
| `./dev soak [ARGS]` | the scripted soaks, below; ARGS go to vitest |
| `./dev trial SCENARIO --budget-minutes N` | a provider trial in the running environment, below |
| `./dev reset` | removes test data; provider sign-ins, T3 settings and T3 provider connections stay |
| `./dev reset-auth` | signs out every provider; chats and all data stay |

`--env NAME` selects an independent environment with its own Compose project
(`t3sup-dev-NAME`) and volumes; the default is `default`. Use a separate environment for
destructive experiments. `--port-base N` (default 47700) sets the ports, which listen on
the host's loopback only: T3 on N+73, the dashboard on N+8, health on N+7, the dashboard
fixture on N+1 and the UI fixture on N+10. Inside the development container, where T3's
worktree setup runs, `./dev setup` and `./dev pnpm` use the container's own toolchain;
container management stays a host command, and no Docker client or socket ever enters a
container.

## Volumes

| Volume | Holds | Removed by |
| --- | --- | --- |
| `credentials` | T3's whole base directory in its own layout: chats, settings, provider selections, native keys and T3-managed provider connections; the provider CLIs' home and XDG configuration, data and state; `CODEX_HOME` and `CLAUDE_CONFIG_DIR` | nothing in `./dev` |
| `data` | Supervisor's data directory, the development workspaces and this environment's own records | `./dev reset` |
| `cache` | the pnpm store, the verified T3 archives and other caches | nothing in `./dev` |
| `node_modules` | the checkout's installed dependencies | nothing in `./dev` |

`stop`, `start`, `down`, `restart`, `recreate` and `rebuild` keep every volume, so T3
projects and threads keep their identities and messages, provider selections stay, and
Supervisor keeps its data. The development user owns every volume; `./dev` builds the
image with the host user's IDs, so files written into the checkout belong to the host user.

## Running T3 and Supervisor

`./dev up` runs `scripts/dev-environment.ts serve` as the container's main process:

1. downloads the pinned T3 for the container's architecture into the cache volume,
   unpacking it only when it matches the pinned SHA-256;
2. starts `t3 serve` with its base directory in the credentials volume, telemetry off,
   listening on the container's interfaces; the host reaches it on loopback only;
3. refuses a T3 whose descriptor reports another version or another orchestration
   protocol than Supervisor reads;
4. revokes every scoped session this environment issued before, found by its
   `t3-supervisor-dev:` subject, also after a crash;
5. registers the development sandbox `/data/workspaces/sandbox` with
   `t3 project add` once per data volume;
6. issues each Supervisor credential through `t3 auth session issue` with only the
   scopes its calls need, for 24 hours, into a 0600 file, and starts Supervisor from the
   mounted checkout with its own data directory.

Every 12 hours it renews the credentials: Supervisor stops, its sessions are revoked,
fresh sessions are issued and Supervisor starts again. A session is revoked as soon as
anything after its issuance fails. Stopping the container stops Supervisor, revokes its
sessions and stops T3, in that order: Supervisor stops before revocation because T3
0.1.6 kept an already open subscription after revocation. A child that stops on its
own stops the container; `./dev logs` shows why.

| Credential | T3 scopes |
| --- | --- |
| `T3_TOKEN_FILE` | `orchestration:read`, `filesystem:read` |
| `T3_GUIDANCE_TOKEN_FILE` | `orchestration:operate` |
| `T3_PROJECT_WRITE_TOKEN_FILE` | `filesystem:read`, `filesystem:write` |
| `T3_PROJECT_COMMIT_TOKEN_FILE` | `source-control:write` |
| `T3_GIT_PROBE_TOKEN_FILE` | `terminal:operate` |

## Providers

Sign in afresh inside the environment; the same account may be used again. Never copy a
login, credential, MCP registration or state from the host or another installation.

- **Codex**: `./dev login codex` runs `codex login --device-auth`. Before that, the
  environment sets `cli_auth_credentials_store = "file"` in `CODEX_HOME/config.toml`,
  keeping every other line, so the login is `auth.json` in the credentials volume.
  Device login can depend on the account's own device-login setting; this environment
  never changes account settings.
- **Claude**: `./dev login claude` runs `claude auth login`; add `--console` for a
  Claude Console account. The login lives in `CLAUDE_CONFIG_DIR`; a Console sign-in
  without an API key and `~/.claude.json` live in the container's home, which is also in
  the credentials volume.
- **T3-managed connections**, such as Connect with ChatGPT in T3's Settings > Providers
  (`./dev pair`), are kept by T3 in its own data, also in the credentials volume.

Only Codex and Claude are set up and checked by this environment. Other providers keep
their logins wherever their own tools do; as long as that is under the container's home
or T3's data, they are kept too.

For agents to call Supervisor's own root works through this registration, so provider trials need it for
the Codex CLI. In `./dev shell`, where `CODEX_HOME`, `/data` and `T3SUP_DEV_UI_PORT` are
the environment's, run this setup. It backs up the current configuration for recovery
and replaces only the owned server entry, preserving other settings and MCP servers.
The bearer is read privately and never passed as a command argument or printed:

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
try {
  const alias = 't3-supervisor-workflows';
  const config = path.join(process.env.CODEX_HOME, 'config.toml');
  const port = Number(process.env.T3SUP_DEV_UI_PORT);
  const token = fs.readFileSync('/data/supervisor/access/workflow-mcp-token', 'utf8').trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) throw new Error();
  const url = 'http://127.0.0.1:' + port + '/mcp/workflows';
  const call = (args) => execFileSync('codex', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
  const servers = JSON.parse(call(['mcp', 'list', '--json']));
  if (!Array.isArray(servers)) throw new Error();
  if (fs.existsSync(config)) {
    const backup = config + '.before-workflow-mcp-' + new Date().toISOString().replaceAll(/[:.]/g, '-');
    fs.copyFileSync(config, backup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backup, 0o600);
  }
  if (servers.some((server) => server.name === alias)) call(['mcp', 'remove', alias]);
  call(['mcp', 'add', alias, '--url', url]);
  fs.appendFileSync(config, '\n[mcp_servers.' + JSON.stringify(alias) + '.http_headers]\nAuthorization = ' + JSON.stringify('Bearer ' + token) + '\n');
  fs.chmodSync(config, 0o600);
  console.log('Registered ' + alias + ' at ' + url);
} catch {
  console.error('Workflow MCP setup failed. Configuration backups, if created, remain in CODEX_HOME.');
  process.exitCode = 1;
}
JS
```

The configuration and any backup have mode 0600. After `./dev reset`, run the setup
again with the new bearer. Keep backups for recovery; restoring an old backup during a
routine update would discard later configuration changes.

A bearer may instead come from an environment variable
(`bearer_token_env_var`, or `env_http_headers` for the whole header), which must then be
set in the environment T3 runs in. A provider trial changes nothing here: before
creating anything it reads the registrations (`codex mcp list --json`, never reporting a
header value) and calls the registered endpoint once with the registered Authorization
header (`tools/list`). It ends `unavailable` unless `t3-supervisor-workflows` is enabled
at exactly that loopback URL over Streamable HTTP with a bearer and the endpoint lists
`workflow_read` and `supervision_interpretation_submit`.

## Resets

`./dev reset` removes test data. It starts the environment if needed, removes every T3
project whose folder is in `/data/workspaces`, with all of its threads, through
`t3 project remove --force`, removes the containers, and then removes only this
environment's `data` volume after checking that Compose created it for this project.
T3's settings, native keys and provider connections and the CLI logins stay. Projects
elsewhere and No Project chats stay, because T3 offers no supported operation that
deletes single threads. The next `./dev up` registers a new sandbox.

`./dev reset-auth` signs out every provider and keeps chats, settings and data. It asks
T3 to sign out each provider instance T3 offers a sign-out for, through
`provider.auth.logout` with a temporary `providers:manage` session that is revoked
afterwards: the operation behind Settings > Providers > Sign out, including T3-managed
connections. It then runs each CLI's own logout and accepts it only when that CLI's own
status reports no login. It fails, naming what remains, if any sign-out is unconfirmed.
Both resets affect only the selected environment.

## Dashboard fixtures

```sh
./dev fixture [--scenario populated|empty|unavailable] [--for <seconds>]
./dev ui-fixture [--scenario <name>]
```

`./dev fixture` runs the production startup chain of `test/support/startup-gateway.ts`,
the same one CI runs, over the repository's scripted native peer and serves this
checkout's `ui-dist`:

- `populated` (default): a supervised main whose root interpreted the request as
  needed work with a two-step plan, the operative's read of that proposal, a
  project with plain conversations and a project whose folder is unavailable.
- `empty`: no project and no conversation.
- `unavailable`: the populated data after T3 stopped answering, so the dashboard
  keeps its last read and shows the disconnection.

Both serve this checkout's built dashboard: `./dev up` builds it, `./dev pnpm build` does
too, and `./dev pnpm dev:ui` rebuilds it on change. `./dev fixture` prints the dashboard
URL and a host command that prints a one-time sign-in token; the
token itself is never printed. Project and conversation titles starting with "Fixture"
mark the synthetic data. Ctrl-C, or the end of `--for`, stops it and removes its run
folder. `./dev ui-fixture` serves the compiled dashboard over `test/ui-fixture/`, the UI
story suites' synthetic API fixture ([its README](../test/ui-fixture/README.md)). Inside
the container both listen on all of the container's interfaces; the host publishes them
on loopback only, so the browser's address stays the loopback address the fixtures check.

## Browser journeys

```sh
./dev e2e [vitest arguments]
```

`./dev e2e` builds the dashboard and runs the browser journeys of `test/e2e/`
([testing](testing.md)) in the separate `e2e` image: the development toolchain plus the
headless Chromium of the pinned `playwright-core`. That container mounts the checkout,
its dependencies and the caches, never the credentials or data volume, and publishes no
port. Each journey starts the production Supervisor over the scripted T3 peer, signs in
with a real one-time token and drives the compiled dashboard in Chromium, all on
ephemeral loopback ports inside the container. A failed journey keeps its Playwright
trace, a screenshot and the page's errors under `.e2e-artifacts/`. Playwright's trace
viewer opens a trace: `playwright-core show-trace <trace.zip>` where Node and a desktop
browser are available, or trace.playwright.dev, which reads the file in the browser.
They are fixture evidence: real Supervisor and dashboard, scripted T3.

## Scripted soaks

```sh
./dev soak [vitest arguments]
```

`./dev soak` runs the scripted soaks of `test/soak/` ([testing](testing.md), execution
type 4) in the toolchain container: each starts the Supervisor process against a
loopback fake T3 and observes it on the wall clock, with its own temporary state and
ports and no credentials. The idle-watch soak keeps the watch idle for longer than a
minute and passes only when the one subscription survived, the heartbeats continued and
health stayed ready throughout; `SOAK_IDLE_MS` asks for a longer window. The
concurrent-writes soak keeps several writers saving the master switch through the
dashboard beside the supervision cycle and passes only when every save committed or met
a newer generation, the generation advanced by exactly the saves and no statement met a
busy database; `SOAK_WRITE_MS` asks for a longer window. The resource-use soak keeps
four loops of dashboard snapshot reads, workflow MCP `tools/list` calls with
Supervisor's own bearer, dashboard event streams opened and dropped, and health reads
running for at least three minutes, and passes only when every request was answered and,
once the process idled past its keep-alive timeout, its open file descriptors (from
`/proc`) are at most four above the warmed-up baseline. Resident memory and its peak are
reported; growth above 512 MiB fails as runaway retention. This does not establish the
absence of smaller or slower memory leaks. `SOAK_RESOURCE_MS` asks for a longer window. Each soak prints its outcome
with this checkout's commit and whether the tree was clean. Soaks are extended runs:
started by hand or by the manually dispatched `extended` workflow, never by the ordinary
suites or a schedule.

## Provider trials

```sh
./dev trial no-contact|introduction|stop --budget-minutes N [--model MODEL] [--keep]
```

A provider trial ([testing](testing.md), execution type 6) runs in the running
environment with its signed-in Codex CLI and never in CI. It uses that sign-in as it is
and never signs in or out. It also needs the Codex CLI's registration of Supervisor's
workflow MCP described above, through which Supervisor's root works, and ends
`unavailable` before creating anything without it. It creates a disposable project of
its own in the development workspaces, which detection supervises, and starts one
operative chat there with an uncoached request: `no-contact` asks a quick question,
`introduction` asks for a small change to tracked content, and `stop` makes the same
request and stops the chat once with its own Stop in the dashboard, as a person does, at
the first look after the proposal reached the operative that shows the operative's run
running, so the Stop falls during model work. It never presses again: a refused press,
such as a conflict with a newer policy, ends the trial `inconclusive`, and an unanswered
one counts only once the chat's policy shows it stopped from the dashboard under a newer
generation. It passes only when one Stop notice, recorded by T3 with its creation time
as Supervisor's, reached the operative, T3 created no Supervisor message after it, and
Supervisor settled within the budget; without the creation times that order needs, it is
`inconclusive`. The chat is launched automatically, with the call T3's web app makes:
one `orchestration.launchThread` call over T3's WebSocket RPC, which T3 records as the
user's request from the web although no person typed it, as the report says. It is made
with an `orchestration:operate` session that exists only for that launch. `t3 thread
start` is not used, because T3 records a chat started through its MCP server as an
agent's, and Supervisor does not take that for a person's request. When T3 records the
request otherwise, the trial ends `unavailable` at its first look and names what T3
recorded. It reads only that chat and its Supervisor state, through a scoped T3 read
session and a dashboard sign-in of its own, both ended with the trial, and it observes
for the whole budget you give, so a late or repeated contact still shows. There is no
default budget: choose one, and use the milestone times a trial prints to settle on it.

The trial prints one JSON line: its outcome (`pass` only on the scenario's required
sequence, `fail` when an invariant is contradicted, `inconclusive` when the budget ended
first, `unavailable` when T3, Supervisor or the provider sign-in was), the reason, for
each milestone the bounds of when it happened (the last readable look before it and the
look that first showed it, as the trial looks every 10 seconds), the Supervisor messages
that reached the chat with the times T3 created them, how T3 recorded the request, what
its cleanup did, and its inputs: this checkout's commit and whether the tree was clean,
separate running Supervisor version/revision from health (a null revision is unknown),
the T3 pin, the prompt versions, how the chat was launched, the model requested, the
provider instance, model and options T3 selected for the operative chat and for the
Supervisor root, read from their own projections (`null` while T3 shows none), and the
runtime version T3's own provider status reports for each selected instance (`null` when
it reports none). The Codex CLI version found in the environment is reported apart and
labelled unverified, because it need not be the runtime T3 runs. A pass needs gapless
evidence: a readable look after the budget ended, so the verdict never rests on an older
look; the provider and runtime inputs above recorded; a clean checkout; and a completed
cleanup. Otherwise the trial reports `inconclusive` and lists its evidence gaps. Its T3
read session lasts the budget and an hour more, and the trial ends `unavailable` before
launching anything if T3 grants less than the budget and half an hour. The trial exits
non-zero unless it passed.

When the trial ends, also by a failure or an interruption, it turns supervision off for
its own project, so Supervisor starts nothing more there, and asks T3 to remove that
project with its chats, the Supervisor root among them, through `t3 project remove
--force`. On the pinned T3 that commits the project's deletion, which cascades to its
chats, whose deletion detaches their provider sessions as durable effects. The trial
reports the removal T3 acknowledged, not a physically observed end of the model work.
The project's folder stays in the workspaces until `./dev reset`. A trial that ends
without its report prints what its cleanup did on stderr. With `--keep`, the project and
its chats stay with supervision off for inspection, a turn still running finishes on its
own, and `./dev reset` removes them later with the other workspace projects. The trial
changes no other project, chat, chat Stop or setting.

## Disposable published-T3 check

```sh
./dev check [--keep]
```

The check starts the pinned T3 and Supervisor from this checkout in a fresh run folder
in the cache volume, with an environment built from nothing, then:

- T3's descriptor reports the pinned version, and Supervisor ingests its catalog;
- the read credential reaches both shell snapshots through `scripts/probe-t3.ts`;
- the workflow MCP route answers its own bearer directly and refuses a wrong,
  empty or T3 bearer;
- a conversation in a disposable project, started through T3's thread CLI, gets
  no Supervisor contact in either system;
- T3 stops and starts again over the same data and port: Supervisor reports itself
  degraded while T3 is down, is ready again over the sessions it holds, and a
  conversation started after the restart reaches its catalog once, still without
  contact;
- a token without `orchestration:read`, a forged token and a revoked session each
  get T3's own 401 or 403 on its native shell route, checked between successful
  reads with the valid read credential, so an outage cannot pass as a refusal;
- after the stop, no port, process group or run folder remains.

It prints one result per check and a JSON summary with the T3 pin and this checkout's
commit and whether its tree was clean, removes the run folder unless
`--keep` is given, and exits non-zero on any failure. `./dev pnpm dev:stack clean`
removes the marked run folders whose creating process ended; it never touches an
unmarked folder.

## Evidence labels

Keep observations separate and name their source:

- **fixture**: the dashboard fixtures. The Supervisor application or the dashboard is
  real; T3, the conversations and the root's submissions are scripted. It proves
  rendering and Supervisor behavior over that script, not T3 or provider behavior.
- **local stack**: the development environment or `./dev check`. T3 and Supervisor
  are real and unmodified. Without a provider sign-in no conversation runs, so it
  proves startup, native access, credentials, MCP transport, persistence, no-contact and
  cleanup, not model behavior.
- **provider**: the development environment after an intentional provider sign-in.
  Only these runs show actual model behavior.

Negotiation, flooding and traffic timing, Stop and ownership, and automatic compaction
depend on actual model behavior. Prove them with an intentionally signed-in provider and
an uncoached operative request; inspect the rendered prompts, total traffic, repeated
messages, tool arguments and native event timestamps. Timing is advisory: unmodified T3
has no barrier before a turn's first tool. T3's ACP Replay agent is no substitute: it
exists only in T3's source development server and replays recorded turns regardless of
the prompt.

## Moving the T3 pin

The pin is `t3Release` in `scripts/local-stack.ts`: one exact published nightly, never a
channel or a stable fallback. Set `t3Release.version` and copy the `linux-arm64` and
`linux-x64` archive digests from that release's `SHA256SUMS`. Then run `./dev check` and
`./dev up` on each architecture you can; both refuse a T3 whose descriptor reports
another version. The check refuses when T3 rejects a scope or issues different ones. A
release that requires other scopes for the same calls instead leaves those Supervisor
features unavailable, and only some of them are checked; compare the release's
authorization of Supervisor's native calls and update the `credentials` table.
