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
| `./dev trial SCENARIO[,SCENARIO...] --budget-minutes N` | a provider trial in the running environment, below |
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
   mounted checkout with its own data directory and T3's scratch folder,
   `scratch` in T3's base directory, as its No Project scope
   (`T3_MANAGED_SCRATCH_ROOT`), as an installation configures it.

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

Agents call Supervisor's workflow tools, and Supervisor's own root does its work, through
the provider CLI's registration of Supervisor's workflow MCP, `t3-supervisor-workflows`,
so provider trials need that registration in the Codex CLI. In `./dev shell`, where
`CODEX_HOME`, `/data` and `T3SUP_DEV_UI_PORT` are the environment's, run this setup.
It backs up the current configuration for recovery
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
elsewhere and No Project chats stay: the reset removes whole projects, and No Project
chats belong to T3's own scratch project. The next `./dev up` registers a new sandbox.

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
./dev trial SCENARIO[,SCENARIO...] --budget-minutes N [--follow-up-minutes M] [--model MODEL] [--keep]
```

A provider trial ([testing](testing.md), execution type 6) runs in the running
environment with its signed-in Codex CLI and never in CI. It uses that sign-in as it is
and never signs in or out. It also needs the Codex CLI's registration of Supervisor's
workflow MCP described above, through which Supervisor's root works, and ends
`unavailable` before creating anything without it. It creates a disposable project of
its own in the development workspaces, which detection supervises, and starts one
operative chat there with an uncoached request: `no-contact` asks a quick question,
`introduction` asks for a small change to tracked content, and `stop` makes the shared
workload's request below in its configured library, whose implementation, tests and
review keep the operative's run going, and stops the chat once with its own Stop in the
dashboard, as a person does, while the operative's run is running after the proposal
reached it, so the Stop falls during model work. A look only nominates that moment: just
before its one press the trial reads Supervisor's state and the chat again and presses
only while those reads still show the proposal and exactly one run running. It times
those reads, the press and its answer, and reads both again at once after the answer.
The Stop counts as during model work only when T3's own start and completion times of
that run, as reads after the answer show them, span the moment Supervisor recorded for
the Stop (`stoppedAt`), or without that record the whole press from its sending to its
answer; a run that ended before or during it, or that no later read showed, leaves the
trial `inconclusive`. The trial never presses again: a refused press,
such as a conflict with a newer policy, ends the trial `inconclusive`, and an unanswered
one counts only once the chat's policy shows it stopped from the dashboard under a newer
generation. It passes only when one Stop notice, recorded by T3 with its creation time
as Supervisor's, reached the operative, T3 created no Supervisor message after it, and
Supervisor settled within the budget; without the creation times that order needs, it is
`inconclusive`. T3 records a notice Supervisor dispatches with Supervisor's `server`
source and `createdBy` user, because its WebSocket RPC stamps that creator on every
dispatched message. A proposal notice names its own proposal, so the same notice text
reaching the chat twice fails `introduction` and `stop`; a later notice with its own text
is a revision, which Supervisor sends for a new proposal of the same request, and counts
only as far as Supervisor itself was seen recording that many proposals for the request
(its `workflowProposalId` at the looks), so more such notices, or one whose text T3 did
not show, leave the trial `inconclusive`.
The chat is launched automatically, with the call T3's web app makes:
one `orchestration.launchThread` call over T3's WebSocket RPC, under a chat identity the
trial chooses as a web client does, which T3 records as the user's request from the web
although no person typed it, as the report says. It is made
with an `orchestration:operate` session that exists only for that launch. `t3 thread
start` is not used, because T3 records a chat started through its MCP server as an
agent's, and Supervisor does not take that for a person's request. When T3 records the
request otherwise, the trial ends `unavailable` at its first look and names what T3
recorded. It reads only that chat and its Supervisor state, through a scoped T3 read
session and a dashboard sign-in of its own, both ended with the trial, and it observes
for the whole budget you give, so a late or repeated contact still shows. There is no
default budget: choose one of at most a day (1440 minutes), and use the milestone times a
trial prints to settle on it.

### The shared workload

The remaining scenarios share one substantive workload, whose project and request `stop`
also uses: a small JavaScript library with its
tests and a real Supervisor configuration, whose required Change workflow implements,
tests and has a separate reviewer assess each change, and an uncoached request to make
its duration parser and formatter understand compound durations, with tests and a README
example. Neither the request nor the definitions mention Supervisor or its protocol. Each
workload scenario judges that one run by its own oracle
(`scripts/provider-trial-oracles.ts`) and
is `inconclusive` when its event did not happen within the budget: a delegated child, a
helper, a guide or a compaction is never assumed. The observing scenarios can share one
launch, for example `./dev trial negotiation,message-volume,compaction --budget-minutes
60`; the trial then prints one verdict per scenario and passes only when each passed.
Besides the operative chat, these trials read at every look the Supervisor root, the
operative's delegated children, Supervisor's helpers and its workflow progress
(`/api/guidance/workflow-progress`): at most 10 helpers and 20 descendants a look, and any
beyond that bound is reported unread, an evidence gap, never silently left out. A
descendant's lineage is in the scope, outside it, or unknown until its own projection is
read and its parent decided; unknown is never taken for outside. A provider-native child
can work with no run in T3's history (its projection's `runs` empty), so the trial also
keeps, apart from runs, each descendant's own timed work (the commands, replies, file
changes and tool calls its own projection shows with their native start) and its direct
parent's record of its lifecycle: the parent's subagent record and subagent turn item,
reconciled as Supervisor reconciles them (one status, the turn item preferred). An own
item shows that the child ran, never that it ended. The parent's record bounds the child
as a run does when it shows the child running since its native start, or ended with both
native times and no own item outside them. Without such a record, or with conflicting,
untimed or stale ones, a verdict that needs a verified child quiet, or running at a
moment, is `inconclusive` and names that child; it never passes on an empty run history.

Each of them fails on a contradiction of Supervisor's own traffic rules, whatever its
oracle: the same proposal text reaching one chat twice;
one guide or one team notification delivered twice; a Stop notice nobody asked for; a
compaction reminder outside the Supervisor's root, or twice in one root run; a check-in
reaching the root while the previous check-in's own run was still open; and a Supervisor
that parked while the operative or a delegated child had a run open. A Supervisor
model's plain message with the same text twice in one chat is reported, not failed: its
retry identity is its request and target, which T3's message does not carry, so
`message-volume` is `inconclusive` then. A text T3 did not show is unknown and never
counts as a repeat.

| Scenario | Passes when | Fails also when |
| --- | --- | --- |
| `negotiation` | the proposal reached the operative and Supervisor recorded agreement from the operative's own later reply | the recorded agreement rests on a message that is not the operative's own reply, or predates the proposal |
| `message-volume` | the supervised work and Supervisor both ended within the budget with no plain message repeated; the totals by kind and chat, and any repeated text, are printed | |
| `active-children` | a child whose own projection names the operative, or a verified child, as its subagent parent ran (a run of it started, or a timed item of its own work), and Supervisor's root or a helper read or assessed it after it started | |
| `sustained-monitoring` | the agreed work was read or assessed at least twice after the proposal and once after its last run, then Supervisor parked and stayed quiet for its monitor's age bound and cooldown with nothing pending | the parked Supervisor ran or sent anything without a new human message |
| `compaction` | the Supervisor's root completed a genuine compaction, then read its instructions again and went on with its own watch: a read or assessment Supervisor recorded for it, a check-in it completed, or workflow progress from its own write; a reminder is never required | |
| `helpers` | a helper became ready with an assignment and received a check-in | the team held more helpers than its limit |
| `guides` | a guide was steered into a delegated child's open run | a guide reached Supervisor's own thread or a descendant read and shown outside the operative's scope; one of unknown lineage, or one reaching a child with no run in T3's history, is `inconclusive` |
| `workflow-write` | a root's recognised `workflow_write` returned a successful receipt, and its operation's history was recorded within that call's native times | one operation returned two different successful receipts, or was recorded before the root run that wrote it started |

T3 often omits a tool call's output from a thread's projection. For `workflow-write`, the
trial then reads that completed `workflow_write` call's full record through the
read-scoped `orchestration.getTurnItem`, as Supervisor reads its own evidence: at most
four calls per look, ten seconds and three attempts each, keeping only the receipt's
status and digest. The result is read from the MCP result envelope or, as T3 records a
Codex `dynamic_tool` call, from its content blocks alone (`[{type: "text", text:
"<JSON>"}]`), which must be exactly one text block. A record that is another item, is not
completed, omits the output too, holds more than one block or no successful receipt gives
no receipt, and the scenario stays `inconclusive` without one.

Choose a longer budget for `sustained-monitoring` and `compaction`: the first passes only
when the whole supervised task, its parking and the quiet after it fit in the budget, and
a genuine compaction of the root needs a long watch.

### Idle parking and No Project

`idle-parking` needs `--follow-up-minutes M` and runs alone. Once Supervisor records its
root settled, with T3's settlement time, the trial waits the monitor's age bound and
cooldown, then sends one follow-up request as a person adds to finished work: one
`orchestration.dispatchCommand` `message.dispatch` over T3's WebSocket RPC with
`createdBy` user, `creationSource` web and `queue_after_active`, on an operate session of
its own. T3 records it as the user's from the web; when T3 records it otherwise, the
trial ends `unavailable`. The trial then observes M more minutes; `--budget-minutes`
bounds the wait for parking. It passes when T3's own settlement time is no sooner than
Supervisor's 60-second quiet window after the scope's last run ended (the main's, its
verified children's and the Supervisor root's own), never judged by when the trial first
saw it; a descendant of unknown lineage, a verified child with no run in T3's history or
a finished run without its completion time is `inconclusive`, while a settlement inside
the quiet window of the runs it can bound still fails. It also requires that Supervisor
stayed parked through the wait, and the follow-up woke the same Supervisor root and
generation; it fails when Supervisor settled sooner, woke without a human message or
handled the follow-up with another Supervisor.

`no-project-start` and `no-project-stop` start their chat in T3's scratch project, which
T3 opens for a chat without a project (`projects.ensureScratch`), and need Supervisor to
take that project for No Project (step 6 above) in On request mode; otherwise they end
`unavailable` and change no setting. Once a look shows the request's run open, the
trial reads the chat again and presses the dashboard's Start once, as a person does,
while that read still shows the run open. T3 may show the request before its run, so the
trial reads the request's run again at each look until it shows. `no-project-start`
passes when the Start is active, Supervisor sent one interpretation request and decided,
and a needed request's proposal reached the operative. `no-project-stop` also presses the
chat's Stop once while Supervisor's interpretation of the started request is in flight:
once a look after the Start shows it, the trial reads Supervisor's state again, presses
only while that read still shows the Start active and the interpretation in flight, and
reads the state again at once after the answer. Supervisor's task records its last
change (`updatedAt`), so the Stop counts as during the interpretation only when the read
after the answer shows the task unchanged, or changed last before the Stop with the
interpretation still in flight; a change at or after the Stop leaves the trial
`inconclusive`. It passes on the `stop` rules above: one Stop notice recorded as
Supervisor's, nothing after it, and Supervisor settled.

### Report and cleanup

The trial prints one JSON line: its outcome (`pass` only on the scenario's required
sequence, `fail` when an invariant is contradicted, `inconclusive` when the budget ended
first, `unavailable` when T3, Supervisor or the provider sign-in was), the reason, for
each milestone the bounds of when it happened (the last readable look before it and the
look that first showed it, as the trial looks right after the launch and then every 10
seconds), the Supervisor messages that reached the chat with the times T3 created them,
the proposal notices with their text digests and the proposals Supervisor recorded, why
any look was unreadable (no answer, the HTTP status, or an answer of an unexpected
shape), how T3 recorded the request, what
its cleanup did, and its inputs: this checkout's commit and whether the tree was clean,
separate running Supervisor version/revision from health (a null revision is unknown),
the T3 pin, the prompt versions, how the chat was launched, the model requested, the
provider instance, model and settings T3 selected for each actor, read from the actor's
own projection and kept to those fields: the operative chat, every Supervisor root the
binding named and, in a workload trial, each helper and descendant read (an empty list
while T3 shows none, never inferred from another actor or from the CLI), and the runtime
version T3's own provider status reports, in one read, for every instance those
selections name (`null` when it reports none). The Codex CLI version found in the
environment is reported apart and labelled unverified, because it need not be the
runtime T3 runs. A workload trial also
prints what it observed, by identity, kind, chat, run, status and native time and never
by a message body or tool arguments: Supervisor's messages with their totals, the
Supervisor roots and helpers, the children found and whether their lineage was verified,
each descendant's own timed work and the verified children T3 recorded no run of, the
agreement, compactions, the root's recognised workflow writes and their receipts'
status and where each was read, the full-record reads with why any gave no receipt, the
parking with its follow-up, and the Start. A Stop trial prints its press: the times of
the reads before it, its sending, its answer and the reads after it, Supervisor's
recorded Stop time, the run pressed in as T3 last showed it, Supervisor's task before
and after, and the phase judged from them. A pass needs gapless evidence: a readable
look after the budget ended, so the verdict never rests on an older look; the provider
and runtime inputs above recorded for the operative chat and every root and, only for
the scenarios that rest on them, for every helper (`helpers`), verified child
(`active-children`) and thread a guide reached (`guides`); a clean checkout; a completed
cleanup; and, in a workload trial, every child, helper and progress read of the last
look. Otherwise the trial reports `inconclusive` and lists its evidence gaps, those of
an actor only some scenarios rest on by scenario (`actorGaps`). Its T3 read session lasts
the budget, idle parking's wait and follow-up budget, and an hour more, and the trial
ends `unavailable` before launching anything if T3 grants less than that window and half
an hour. The trial exits non-zero unless it passed.

The trial adds its project to T3 only once its cleanup is in place, so a project T3
added without reporting it is still removed by its folder, and it launches the chat under
an identity it chose, so a launch whose outcome is unknown can still be found by it.
When the trial ends, also by a failure or an interruption, it turns supervision off for
its own project, so Supervisor starts nothing more there, and asks T3 to remove that
project with its chats, the Supervisor root among them, through `t3 project remove
--force`. On the pinned T3 that commits the project's deletion, which cascades to its
chats, whose deletion detaches their provider sessions as durable effects. The trial
reports the removal T3 acknowledged, not a physically observed end of the model work.
The project's folder stays in the workspaces until `./dev reset`. A No Project trial
leaves T3's shared scratch project alone: it reads Supervisor's state for its chat once
more, so a Supervisor root or helper made after the last look is included, and asks T3
to delete its own chat, the descendants whose lineage it verified, its Supervisor root
and that root's helpers, one
`orchestration.dispatchCommand` `thread.delete` each, which on the pinned T3 cancels each
chat's open runs and requests; a deletion T3 did not acknowledge, and a descendant it did
not verify, is an evidence gap. After an unconfirmed launch it deletes the chat under its
identity, or reports that T3 never made one; an identity T3's launch reply named instead
of the trial's own is never deleted, since it may be someone else's chat, and is reported
as left. A trial that ends without its report prints
what its
cleanup did on stderr. With `--keep`, the project and its chats stay with supervision off
for inspection, or a No Project trial's chats stay with its chat stopped, a turn still
running finishes on its own, and `./dev reset` removes a kept project later with the
other workspace projects. The trial changes no other project, chat, chat Stop or setting.

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
