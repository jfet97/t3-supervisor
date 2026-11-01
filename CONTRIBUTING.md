# Development

Development runs in Docker: the host needs Docker with the Compose plugin and nothing
else. `./dev` builds the development image (Node 24.22.1, pnpm 12.14.0, Git and the
provider CLIs) and runs every command in containers over the mounted checkout; the
[development environment](docs/local-stack.md) describes it. Dependency installation
uses the committed `pnpm-lock.yaml` with `pnpm install --frozen-lockfile` and keeps
pnpm's package store in the environment's cache volume. Build-script approval is
explicit in `pnpm-workspace.yaml`; script commands never install dependencies
implicitly.

T3's **Setup Worktree** action runs `sh dev setup` (`t3.json`). On the host it builds the
image and installs dependencies; inside the development container, where the
environment's own T3 creates worktrees, it installs with the container's toolchain.
An existing T3 project may need its saved action set to the same command because saved
actions override `t3.json`.

The [usage skill](skills/usage/use-t3-supervisor/SKILL.md) describes ordinary dashboard workflows for agent sessions.
The [workflow-authoring skill](skills/usage/author-supervisor-workflows/SKILL.md) derives
reusable steps and workflows from project guidance, development history and human
corrections, with a recommendation for two distinct models using high reasoning.

Source contributors should read the repository-local
[contributor skill](skills/maintenance/contribute-supervisor/SKILL.md).
`skills/usage/` is the portable, packaged Skillshare source; `skills/maintenance/`
contains contribution standards and is never propagated globally. The
[interface acceptance reference](skills/maintenance/contribute-supervisor/references/interface-acceptance.md)
records the product's navigation, terminology and evidence requirements.

```sh
./dev setup
./dev pnpm autofix
./dev pnpm typecheck
./dev pnpm test
./dev pnpm build
```

`pnpm test` runs the [Vitest](https://vitest.dev) suites; Effect code is tested with `@effect/vitest`.

Ordinary PR CI runs lint, type checking and build once, the AMD64 and ARM64
container artifacts each on a runner of that architecture, the runner harness once,
the production startup integration once, and the complete main suite across four
native Vitest shards on separate runners.
Each shard uses one test worker so database worker startup does not compete with
another suite in the same runner. Isolation, the leak gate, per-test bounds and
the 20-minute watchdog stay the same. In full mode, the `check` status requires
every job to pass, including every shard. A generated version PR can skip only
the suites after directly proving full baseline validation; its new-version
static/build/package/container checks and the startup integration still run. Main may reuse an exact checked
tree after independently verifying its evidence. The aggregate always requires
the jobs appropriate to the proved mode; unexpected skips, failures and
cancellations fail it. See [CI policy](docs/ci.md) for eligibility and fallback.
One shared setup action caches the pnpm package store by OS, architecture, Node
major and lockfile. A changed lockfile can reuse an older store and fetch only
missing packages. Every executed validation job still validates a frozen install
and runs its checks; installed trees, build outputs and test results are never cached.
New runs cancel older runs of this workflow for the same branch or pull request,
including `main`; unrelated branches and pull requests run independently.

While editing, run focused files through the watchdog, for example
`./dev pnpm test test/config.test.ts`. Leave the final complete main and harness
suites to GitHub CI. To reproduce one CI shard locally, use
`./dev pnpm test --shard=1/4 --maxWorkers=1`. Native sharding assigns complete files
deterministically, so all four shard indices are required for full coverage.

Read [AGENTS.md](AGENTS.md) and the local knowledge base before changing the project.

## Development environment

Develop and test against the repository-owned environment only; it needs no personal
host or existing installation and never connects to one.

```sh
./dev up           # pinned unmodified published T3 nightly + Supervisor from this checkout, kept across restarts
./dev fixture      # dashboard over the production application, scripted T3 states
./dev check        # the published-T3 boundary end to end in a disposable run
./dev reset        # remove test data; provider sign-ins stay
./dev reset-auth   # sign out every provider; data stays
```

See the [development environment](docs/local-stack.md) for the volumes, provider
sign-in, resets and evidence labels.

## Releases

Add a changeset for user-visible changes. See [RELEASING.md](RELEASING.md).
