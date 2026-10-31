## Skill ownership

Portable product skills live in `skills/usage/`; only that folder is packaged and
exposed through Skillshare. Repository contributor guidance lives in
`skills/maintenance/` and stays local to the checkout. Before source work, read
[contribute-supervisor](skills/maintenance/contribute-supervisor/SKILL.md), including
its interface acceptance reference for frontend changes. Personal deployment and
installation policies stay outside this repository; neither skill group depends
on personal files to explain the product or contribution standards.

Skill/documentation-only batches use Git and Skillshare propagation; they do not
require rebuilding or restarting the application.

## Development discipline

For authorized multi-agent work, retain explicit ownership, exact review artifacts
and terminal results as described in the contributor skill. Personal orchestration
skills can supply transport details when available; the repository guidance is
self-contained.

All contributions go through a pull request. Do not push changes directly to
`main`; the repository requires a PR and a passing `check` status. An explicit
admin bypass at PR merge is an exceptional human decision, not permission for
ordinary pushes. `git push --force` does not bypass GitHub's rules.
Do not merge or rebase `main` solely to satisfy branch freshness: it is not required.
Resolve actual merge conflicts, and require passing checks on the latest PR head.

While editing, run focused local checks. Leave the final complete main and runner
harness suites to GitHub CI rather than duplicating them locally.

- Define the requested behavior and observable acceptance cases before editing.
  Fix demonstrated failures in the existing path. Remove superseded code and
  instructions instead of layering workarounds, stores, parsers or compatibility.
- Develop and test only on the repository-owned local setup
  ([local development stack](docs/local-stack.md)): `pnpm dev:fixture` for dashboard
  states and `pnpm dev:stack` for a pinned published T3. Never use or connect to a
  personal host, an existing T3 or Supervisor instance, or another installation's
  credentials, provider logins or MCP registrations for development or tests.
- Test the riskiest user journey early on the local stack, before a long implementation or
  review campaign. For negotiation and flooding, inspect actual rendered prompts,
  total traffic, repeated messages, tool arguments and native event timestamps.
  Permissive size ceilings and hundreds of passing unit tests do not prove these
  behaviors. Exercise the real controller/transport boundary under test rather than
  mocking it away. Include a trivial no-contact case and relevant failure/race cases.
- Use an uncoached operative request for live proof. Do not seed agreement, delay the
  operative, or teach the test agent the expected protocol to manufacture success.
  Record the first edit, introduction and completed acceptance separately. Report
  advisory timing honestly; unmodified T3 provides no pre-first-tool barrier.
- Iterative reviewers retain one ordinary conversation through supported authorized
  APIs. Recheck the exact changed boundary and actual message output; a delegated
  task's backing thread is not an ordinary resumable reviewer conversation.

## Effect v4 throughout

The application, CLI, tooling and tests use Effect v4 at one exactly pinned version for
`effect` and every `@effect/*` package. Write services as `Context.Service` with Layers,
decode untrusted input and stored rows with `Schema`, persist through `effect/sql`, keep UI
async state in Atom/AtomHttpApi, and test with `@effect/vitest` (`TestClock` for timing,
`it.live` for real I/O). Do not call `Effect.run*` in business code or add Promise polling,
ad hoc timers or hand-rolled async state machines. Never log raw causes, tokens or native
bodies. Third-party, native and browser integrations stay small scoped adapters with a
recorded reason; pure calculations, types and JSX stay plain.

## Knowledge Base

This project has an LLM-maintained knowledge base in `knowledge/` (git-ignored). Invoke `$knowledge` or `/knowledge` with the same subcommands and arguments.

- When a local knowledge base exists, consult `knowledge/INDEX.md` and relevant pages before reading code. Use `rg` for exact lookup and `qmd query` when available for semantic lookup.
- After meaningful development or pulling commits, use `$knowledge update`.
- Library lookup order: `knowledge/dependencies/`, installed `node_modules/`, then official upstream documentation. Dependency reference sources are read-only and must never be imported.

## Release discipline

- For now, include a patch changeset for every user-visible change, including
  features. Do not propose minor or major bumps unless Andrea explicitly changes
  this policy. Explain the impact in user terms. Ask Andrea when compatibility
  is unclear; a patch version does not establish downgrade or state safety.
- Keep the app version in `package.json`; do not hand-edit CLI/image versions or
  bump it on each push. Follow [RELEASING.md](RELEASING.md) for the separate version
  PR and changelog. Stable publication requires explicit approval of that PR or
  an explicit manual release request, and successful CI on the exact main commit.
- Never enable auto-merge on a version PR or select alpha/beta for users without
  explicit authorization. Nightly, alpha and beta remain opt-in installation
  channels. Publishing artifacts and deploying a running service are separate.
- Keep release-infrastructure work and dry runs free of registry publication,
  credential provisioning or publishing-setting changes unless explicitly requested.

## Batch completion

A source batch is complete when its pull request head passes the `check` status and
its reviewer accepted the agreed evidence. Prove live behavior on the local stack
and report fixture, local-stack and provider observations separately. Choose checks
proportionate to the change; do not replay the entire historical foundation test
campaign. Publishing a release and deploying a running service are separate steps
for their owners; personal deployment procedures stay outside this repository.
Never modify T3 source or its installed app/server.

## Standing rule: no Supervisor proxy workarounds

Do not add or retain extra HTTP proxies, reverse proxies or relay sidecars to make
Supervisor integrations work. Fix endpoint exposure, authentication, accepted hosts
and client configuration in Supervisor itself. MCP clients and gateways such as
MCPX connect directly to the Supervisor MCP endpoint; do not introduce another
intermediary. Never modify T3 source or its installed app/server as a workaround.


## Current phase: rapid development, no backward compatibility

This is an experimental project being iterated quickly.
Backward compatibility with previous prototype versions, schemas, file formats,
CLI behavior or configuration is not a requirement unless the user explicitly
requests it for a particular change. Prefer the simplest current implementation.
Do not add compatibility layers, legacy fallbacks, duplicate databases/stores or
migration frameworks solely to keep obsolete experimental versions working.
The former split grant/session databases are the concrete example to avoid.
Obsolete prototype code and tests may be replaced rather than carried forward.

Preserving current credentials, active sessions and non-disposable user data is
operational care, not a reason to retain old product formats. When necessary,
use a bounded one-off operational cut-over rather than permanent compatibility
machinery. This policy does not authorize unrelated data resets.
