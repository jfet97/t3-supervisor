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

For agents to call Supervisor directly, register the workflow MCP URL
`http://127.0.0.1:<dashboard port>/mcp/workflows` with the bearer in
`/data/supervisor/access/workflow-mcp-token` under the alias `t3-supervisor-workflows`
in the provider's configuration inside the environment ([workflow MCP](workflow-mcp.md)).
`./dev reset` creates a new bearer.

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
- a token without `orchestration:read`, a forged token and a revoked session each
  get T3's own 401 or 403 on its native shell route, checked between successful
  reads with the valid read credential, so an outage cannot pass as a refusal;
- after the stop, no port, process group or run folder remains.

It prints one result per check and a JSON summary, removes the run folder unless
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
