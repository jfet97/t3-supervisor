# Local development stack

Development and testing use this repository-owned local setup only. It needs no
personal host, existing T3 installation, existing Supervisor instance or provider
login, and it never connects to one. Two entry points share one isolation rule:
every run owns a fresh private folder under the system temporary directory, and
its processes get an environment built from nothing.

| Command | T3 | Supervisor | Use for |
| --- | --- | --- | --- |
| `pnpm dev:fixture` | the repository's scripted native peer | the production application from this checkout | dashboard work and review: empty, populated and unavailable states |
| `pnpm dev:stack` | a pinned, unmodified published T3 | the `src/main.ts` process from this checkout | the real native boundary, credentials, workflow MCP and provider sessions |

Build the dashboard first with `pnpm build`; `pnpm dev:ui` rebuilds it on change.

## Evidence labels

Keep observations separate and name their source:

- **fixture**: `pnpm dev:fixture`. The Supervisor application is real; T3, the
  conversations and the root's submissions are scripted. It proves rendering and
  Supervisor behavior over that script, not T3 or provider behavior.
- **local stack**: `pnpm dev:stack`. T3 and Supervisor are real and unmodified.
  Without a provider sign-in no conversation runs, so it proves startup, native
  access, credentials, MCP transport, no-contact and cleanup, not model behavior.
- **provider**: the local stack after an intentional provider sign-in. Only these
  runs show actual model behavior.

`test/ui-fixture/` remains the UI story suites' synthetic API fixture: it answers
the dashboard API from memory and records `fixture` evidence for controlled
failures such as an expired session or a held save. T3's ACP Replay agent is not a
substitute for either: it exists only in T3's source development server, replays
recorded turns regardless of the prompt and does not exercise the native boundary
Supervisor reads.

## Dashboard fixture

```sh
pnpm dev:fixture [--scenario populated|empty|unavailable] [--port <port>] [--for <seconds>]
```

It runs the production startup chain of `test/support/startup-gateway.ts`, the
same one CI runs, and serves this checkout's `ui-dist`:

- `populated` (default): a supervised main whose root interpreted the request as
  needed work with a two-step plan, the operative's read of that proposal, a
  project with plain conversations and a project whose folder is unavailable.
- `empty`: no project and no conversation.
- `unavailable`: the populated data after T3 stopped answering, so the dashboard
  keeps its last read and shows the disconnection.

The command prints the dashboard URL and a one-time sign-in token. For another
token, run the printed `auth forge` command. Synthetic titles and messages start
with "Fixture". Ctrl-C, or the end of `--for`, stops it and removes its folder.

## Published T3 stack

```sh
pnpm dev:stack [--check] [--keep] [--for <seconds>] [--cache-dir <path>]
pnpm dev:stack clean
```

The pinned release is `t3Release` in `scripts/local-stack.ts`. The first run
downloads that release's archive for this platform into
`$XDG_CACHE_HOME/t3-supervisor/local-stack` (or `--cache-dir`) and unpacks it only
when it matches the pinned SHA-256. The archive is the one the `t3` npm launcher
installs; the stack runs it unmodified.

Each run then:

1. creates a run folder with `home/`, `t3/`, `projects/`, `supervisor/`,
   `secrets/` and `tmp/`;
2. starts `t3 serve` on a free loopback port with `--base-dir` in the run folder,
   the run's home, telemetry off and no browser;
3. issues each Supervisor credential through `t3 auth session issue` with only the
   scopes its calls need, for eight hours, into a 0600 file;
4. creates a disposable Git project and adds it with `t3 project add`;
5. starts Supervisor from `src/main.ts` with its own data directory and ports;
6. prints the URLs, the credential files, the workflow MCP bearer file and the
   commands to sign in to the dashboard or to open the isolated T3.

| Credential | T3 scopes |
| --- | --- |
| `T3_TOKEN_FILE` | `orchestration:read`, `filesystem:read` |
| `T3_GUIDANCE_TOKEN_FILE` | `orchestration:operate` |
| `T3_PROJECT_WRITE_TOKEN_FILE` | `filesystem:read`, `filesystem:write` |
| `T3_PROJECT_COMMIT_TOKEN_FILE` | `source-control:write` |
| `T3_GIT_PROBE_TOKEN_FILE` | `terminal:operate` |

Stopping, by Ctrl-C, the end of `--for`, or a child that stops on its own, stops
Supervisor, revokes every session, stops T3 and removes the run folder unless
`--keep` was given. Stop Supervisor before revoking: T3 0.1.6 refuses new
connections with a revoked session but keeps a subscription that is already open.
`pnpm dev:stack clean` removes marked folders left by runs whose process ended,
for example after a forced kill.

`--check` runs the early risky path, prints one result per check and a JSON
summary, stops the stack and exits non-zero on any failure:

- T3's descriptor reports the pinned version, and Supervisor ingests its catalog;
- the read credential reaches both shell snapshots through `scripts/probe-t3.ts`;
- the workflow MCP route answers its own bearer directly and refuses a wrong,
  empty or T3 bearer;
- a conversation in the disposable project, started through T3's thread CLI, gets
  no Supervisor contact in either system;
- a token without `orchestration:read`, a forged token and a revoked session are
  refused;
- after the stop, no port, process group or run folder remains.

## Providers

Provider sign-in is intentional and per run. Open the isolated T3 with the printed
pairing command and set up a provider there as that T3 version documents. Its
processes run with the run's home, so the login and provider configuration stay in
the run folder and are removed with it. For agents to call Supervisor directly,
register the printed workflow MCP URL and bearer under the alias
`t3-supervisor-workflows` in that same isolated provider configuration
([workflow MCP](workflow-mcp.md)). Never copy a login, credential, MCP registration
or state from another installation into a run.

Negotiation, flooding and traffic timing, Stop and ownership, and automatic
compaction depend on actual model behavior. Prove them on the local stack with an
intentionally signed-in provider and an uncoached operative request; inspect the
rendered prompts, total traffic, repeated messages, tool arguments and native event
timestamps. Timing is advisory: unmodified T3 has no barrier before a turn's first
tool. Fixture runs and the no-contact check do not establish these behaviors.

## Moving the T3 pin

Set `t3Release.version` and copy each platform's archive digest from the release's
`SHA256SUMS`. Then run `pnpm dev:stack --check`. The stack refuses to start when T3
rejects a scope or issues different ones. A release that requires other scopes for
the same calls instead leaves those Supervisor features unavailable, and only some
of them are checked; compare the release's authorization of Supervisor's native
calls and update the `credentials` table.
