# Contributions and CI

Contribute through a pull request. Main requires the GitHub Actions `check`
status on the latest PR head. Branches do not need to be up to date with main;
actual merge conflicts still need resolution. Repository admins retain an explicit
bypass through a PR; ordinary direct pushes are blocked. `git push --force` cannot
override server-side rules. No additional approving reviewer is required by
the current solo-maintainer ruleset.

The active [main ruleset](https://github.com/jfet97/t3-supervisor/rules/25781536)
owns this server-side protection; local hooks are not the enforcement boundary.

## Full validation

Ordinary PRs and manual **Check Supervisor** dispatches run lint, both type checks,
build, package/container smoke checks, all four main-suite shards, the runner
harness, the production startup integration and the browser journeys. The `browser`
job runs `./dev e2e`, the same entry contributors use: the production Supervisor over
the scripted T3 peer drives this checkout's dashboard in the pinned `e2e` image's
headless Chromium ([testing](testing.md)). It needs no credentials. A failed journey
uploads its trace, screenshot and page errors, which hold only its own destroyed test
sessions, as an artifact kept for seven days. A manual dispatch can set
`browser_repetitions` (1 to 20, default 1) to calibrate the journeys' flakiness on the
x64 runner: the job repeats them without retries and stops at the first failure. The `static` job builds and runs the
AMD64 container on an x64 runner; the `arm64` job builds and runs the ARM64 container
on a native `ubuntu-24.04-arm` runner. Nothing is emulated, and each job first checks
its image's architecture. Each test file runs in its native shard, with one worker per runner.
The watchdog, test deadlines, leak gate, privacy guards and cleanup stay intact.
Each container build reads and writes its own GitHub Actions layer-cache scope. The
cache only speeds up builds, so a failed cache export is logged without failing the
check.

The package smoke installs the packed archive as a user does: plain npm into an empty
prefix, resolving every dependency afresh from the registry, with no lockfile,
override or test pin. Before starting the installed CLI, it runs node's own module
resolution inside the installation, from the application's entry and from every Effect
package it reaches, and requires one copy of `effect` and of each `@effect` package,
each at the exact version the application's manifest pins as a direct dependency. It
prints those resolutions; a split set fails with every version and path it found. The
installed CLI must then become ready against the scripted T3 peer, report its version
and revision, serve the dashboard and its hashed asset, ship only the portable skills
and exit 130 on SIGTERM. Because it resolves from the registry, an upstream release
that breaks a fresh install of this tree fails the check. The release workflow runs
the same smoke on the exact archive it publishes ([release guide](../RELEASING.md#what-the-workflow-verifies)).

PRs explicitly check out their head commit. A successful check remains usable
when main advances; do not update a branch solely to satisfy freshness. Changes
to the PR itself still require a successful check on its new head. Admin bypasses
remain exceptional.

Ordinary PRs never resolve or download published T3 builds or published Supervisor releases:
only a run of the version branch calls the [version PR gate](#version-pr-gate), and the workload
of every other PR and dispatch stays as described above.

While editing, run focused local cases, lint and types. Leave the final complete
main and harness suites to GitHub rather than repeating them locally. The main suite
includes the dashboard fixture and the local stack's guard rails; the published-T3
path itself downloads T3, so run it locally with `./dev check`
([development environment](local-stack.md)).

## Extended runs

The `extended` workflow runs only when dispatched by hand; nothing else starts it, it
is not part of the `check` aggregate and it gates no release. Its `runs` input selects
the scripted soaks (`./dev soak`), the published-T3 check of the pinned release
(`./dev setup`, `./dev pnpm build`, `./dev check`) or both, on the x64 runner, through the
same `./dev` commands contributors run locally. It holds no credentials and only reads the
repository. Dispatch it before a release whose inputs it covers, or when one of those
inputs changes ([where tests run](testing.md#where-tests-run)). Its step summary names
the commit each run tested; the checks print their own inputs. The published T3 builds
of the four target slots run in the [published-T3 compatibility](#published-t3-compatibility)
workflow instead.

## Release metadata fast track

The `changeset-release/main` version PR may reuse full validation of its parent
commit. Static checks, both type checks, build, package smoke and both container
smokes, AMD64 and native ARM64, still run on the new version. Only the four main shards,
the harness and the browser journeys skip.
The production startup integration runs in full, reuse and release modes, and every
version PR run, fast-tracked or fully validated, runs the [version PR gate](#version-pr-gate).
The required aggregate `check` always runs and requires that exact combination.

Eligibility is deliberately narrow. The head must have one parent already on main,
and its complete local Git diff may contain only:

- One increasing stable `version` line in `package.json`, with every other byte
  unchanged and the parsed manifest equal apart from that version.
- An added or modified regular `CHANGELOG.md`.
- At least one deleted pending `.changeset/*.md` note, excluding `README.md`.

Other manifest fields, dependencies, lockfiles, source, tests, workflows, file-mode
changes, symlinks, renamed files, added/edited notes, prereleases and incomplete
metadata all select full validation. A multi-commit version branch whose last
commit does not contain the complete generated change also runs full.

The parent must have a successful latest main run. The planner then verifies full
job evidence directly: either that main run actually passed every full job, or
its merged PR has an identical tree and its latest matching PR/dispatch run passed
every full job. A skipped suite never supplies full evidence. Another fast-tracked
release therefore cannot become a baseline merely by being green; there is no
chain of lightweight verdicts. The baseline must also have run every job the current
policy requires, even when its own older policy did not, so evidence from before the
native `arm64` job or the `browser` journeys never counts as a full baseline.

The release classifier is loaded from the parent's Git tree, so changing the proof
policy in a PR cannot make that PR classify itself as release metadata. The
workflow itself remains subject to normal repository review and protection.

Tests must treat the application version as opaque metadata. Version-dependent
behavior needs a corresponding change to this policy; a hard-coded test of the
current release number would invalidate the equivalence on which skipping rests.
Package and container smoke checks exercise the actual new version end to end.

**Prepare version** uses the configured [GitHub App](../RELEASING.md#version-bot-authentication)
for branch pushes and PR creation/updates. Its normal pull-request event starts CI
automatically; no duplicate dispatch or workflow approval is needed. Same-repository
version PRs request the bounded release proof above. A manual **Check Supervisor**
dispatch defaults to `validation: full`; choose `auto` only
when requesting the same bounded release proof. That input cannot fast-track
ordinary branches or changes that fail eligibility. The job summary links the full
baseline run and records the version change. The first PR implementing this policy
runs full; the next real version PR supplies its first live fast-track evidence.

If version preparation finishes before its parent's main CI, the proof selects
full validation. After main CI succeeds, a new **Check Supervisor** dispatch on
the version branch with `validation: auto` can retry the proof. There is no need
to update the branch or relax the evidence requirement.

## Lightweight main validation

After merging, main first tries to reuse GitHub's full PR verdict. Reuse requires:

- A merged PR whose resulting commit is this exact main commit, from this repo.
- Exactly the same Git file tree on main and the checked PR head. Squash/rebase
  commit IDs may differ; any difference in the actual files prevents reuse.
- The latest matching **Check Supervisor** run is completed and successful.
  It must be a PR run, or a dispatch on that PR's branch, at its exact final head.
- Static checks, each of the four main shards, the harness, the startup
  integration, the browser journeys and aggregate `check` all succeeded in that
  run's latest attempt. Skipped jobs do not qualify.
- For a run of the version branch, every job of its [version PR gate](#version-pr-gate),
  the published-T3 compatibility and the published Supervisor upgrades, succeeded as well.

For a merged fast-tracked version PR, main instead requires the exact same tree,
a successful latest release run with `plan`, `static`, `arm64`, `startup`, `check` and
every job of the version PR gate passed and the suites and browser journeys skipped, and
independently rederives the release diff and full baseline proof above. A successful
release summary alone is insufficient.

Only with one of these proofs do the main shards, the harness and the browser
journeys skip. The startup
integration still runs. The aggregate check requires the planner to succeed and
the jobs selected for that mode to have their expected results, and links the
source run and any release baseline in the job summary. No test results,
build outputs or assertions are cached.

Missing or ambiguous PR metadata, API errors, malformed/truncated responses, a
failed/pending/canceled latest run, changed attempts, fork PRs, missing jobs or a
different tree select complete validation. API metadata can briefly lag after a
merge; the conservative result is another full run. Evidence reads are bounded:
100 associated PRs (a full page is rejected), 100 runs with a complete count, and
200 latest-attempt jobs. A final run-list read checks freshness after reading jobs.

A branch merged behind a newer main will normally produce a different tree, so
main runs full validation. Integration failures between the branches can therefore
be discovered after merging even when the PR had no textual conflicts.

Newer runs still cancel superseded runs for the same source branch. If a stable
merge's main run was canceled, rerun that original run before publication as
described in [RELEASING.md](../RELEASING.md). The publication gate requires successful
push-to-main CI and aggregate `check` for the exact source commit, plus the separate
stable-release approval. A merged version PR publishes stable automatically only after
main reused its gated run ([version PR gate](#version-pr-gate)); an explicit stable dispatch
does not check that reuse. CI eligibility never publishes or deploys a release.

## Published-T3 compatibility

The **Published T3 compatibility** workflow (`compatibility.yml`) checks Supervisor against
the published T3 builds in the four slots of a frozen target lock, `stable`, `nightly`,
`nightly-1` and `nightly-2` ([published T3 targets](local-stack.md#published-t3-targets)),
through the same `./dev` commands contributors run. It runs as the daily canary, as a manual
reproduction and as the version PR's gate. Its only credential is GitHub's automatic,
read-only workflow token.

A run resolves its lock once, in its `lock` job (`./dev pnpm dev:targets resolve`), records
the lock's SHA-256 in its summary and keeps the lock as the run's `t3-lock` artifact. Every
slot downloads that artifact, checks its SHA-256 and runs only from those bytes; nothing
resolves again. The `assets` job builds the dashboard of the checked commit once
(`./dev setup`, `./dev pnpm build`) and records that commit and the SHA-256 of every file;
each slot uses that build only after checking it is its own checked commit's, file for file.
Each slot then installs its dependencies with `./dev setup` on a native runner of its own
architecture, which the job checks first; nothing is emulated. From the frozen lock it runs:

- the published-T3 check: the 12 checks of `./dev check` with their stage timings
  ([disposable published-T3 check](local-stack.md#disposable-published-t3-check));
- the cohort probe, `scripts/t3-cohort.ts --probe`.

Both runs share a runtime cache in the job's Docker cache volume. Downloads must match
the frozen archive digest, and a completed installation is reused only while its marker
names that digest. Runtimes are not saved in the repository's cross-run Actions cache.

The cohort probe exercises a provider-free set of native operations, one report step each:
`stack`, `environment`, `model-config`, `files-read`, `setup-scaffold`, `git-probe`,
`commit`, `thread-launch`, `thread-watch`, `message-dispatch`, `thread-settle`,
`thread-stop-idle`, `helper-task`, `helper-webhook`, `helper-delete` and `teardown`. It does
not cover every native function. With no provider signed in, it proves nothing about model
answers, the Stop of a running turn, the cancellation of a genuinely queued run (the idle
thread Stop step does not prove it), real check-in turn items, helper model and tool
behavior after delivery, or compaction; those stay with the provider trials
([where tests run](testing.md#where-tests-run)).

A slot passes only when both runs passed and both JSON reports name its slot, its T3
version in the lock, the lock's SHA-256 and the checked commit with a clean tree. A report
of other inputs, a missing report or an exit status that contradicts its report is a
harness failure, never a pass. A lock the run could not produce fails every slot with that
outcome instead of skipping it: `unavailable` when GitHub did not answer as needed or the
earlier run kept no readable lock, `invalid` when the releases cannot fill the slots or the
lock is malformed, `harness` when the environment could not be prepared. Every slot runs
even when another fails, and the run fails when any slot did not pass. Each slot writes a
step summary with its T3 version, its outcome, the checks and probe steps that did not pass
and the stage and step timings, and keeps its JSON reports, logs and lock as an artifact
also after a failure or a timeout. Every job and every long step has a bounded timeout.

Measured on the local stack per build, without the image build and dependency setup, the
12-check run takes about 100 to 105 s and the cohort probe about 14 to 17 s cold and 10 to
13 s warm. The cost of a cold image build and setup on GitHub's runners is not measured yet.

### Daily canary

Every day at 05:41 Europe/Rome the workflow runs the four slots on x64 from the default
branch. The canary is advisory: it is not part of the `check` aggregate, gates no release,
opens no issue and writes nothing to the repository. GitHub's ordinary notification of a
failed scheduled run is its alert.

### Manual reproduction

A dispatch runs the chosen `slots`, `all` or a comma-separated list, on `architecture`
`x64` or native `arm64`. With `lock_run`, the ID of an earlier run that kept a `t3-lock`
artifact, such as a canary or a version PR's **Check Supervisor** run, it reruns those
frozen builds from that lock unchanged instead of resolving a new one. Only the job that
reads the earlier run's artifact holds `actions: read`; every other job reads the
repository only.

### Token for release metadata

GitHub's unauthenticated API quota is shared, so on a hosted runner it could leave a
resolution `unavailable`. The resolve step alone therefore hands the automatic,
read-only workflow token to `./dev` as `T3SUP_DEV_GITHUB_TOKEN`, which `./dev` passes into
its toolchain container as `GITHUB_TOKEN`. The resolver sends it only with its two metadata
requests, for GitHub's designated latest release and for the release list, never with a
download, and never prints or writes it. The check, the probe and every other step run
without it, and no personal credential or secret is used. Local runs need no token.

### Version PR gate

Only a run of the version branch `changeset-release/main`, its PR or a dispatch on it, calls
the workflow, from the `t3-compatibility` job of **Check Supervisor**: the four slots on x64
and the `stable` and newest `nightly` slots also on native ARM64, all from one frozen lock.
The same run also calls the [published Supervisor upgrades](#published-supervisor-upgrades)
from its `supervisor-upgrades` job; both calls make up the version PR gate. The aggregate
`check` requires both to pass in both the release fast track and full validation of the
version PR. Ordinary PRs never call them, and main never calls them: main never resolves
T3 targets or Supervisor releases after the merge.

Main reuses a version branch run only when the proof finds every job of its gate passed,
each named after the calling job, such as `t3-compatibility / nightly-1 on x64` or
`supervisor-upgrades / stable journey`. Main then records that reuse in the plan step
**Reuse the version PR compatibility evidence** and links that run, whose `t3-lock` and
`upgrade-lock` artifacts are the frozen T3 target lock and release lock. A merged version PR publishes
stable automatically only when main's run recorded that reuse. An explicit stable dispatch
stays the existing manual path and does not check that record, so the gate does not cover
every stable publication. A version merge that main had to validate in full, for example
after a merge behind a newer main, publishes stable only by such a dispatch, and whoever
dispatches it first checks the version PR run's compatibility evidence.

The calling job grants `contents: read` and `actions: read`, the most any job of the
workflow declares; GitHub refuses a call that grants less, even for a job that would be
skipped. Before the first stable publication with the gate, the first real version PR runs
must verify the gate's matrix, its job names in main's proof and the reuse of the frozen
lock evidence by main and by the automatic stable publication.

## Published Supervisor upgrades

The **Published Supervisor upgrades** workflow (`upgrades.yml`) runs the provider-free
[published upgrade journeys](local-stack.md#published-upgrade-journeys) through the same
`./dev upgrade` command contributors run: `stable` and `nightly` start from the latest stable
and the latest published nightly Supervisor, each run from its official image by digest, and
`baseline` starts from a directory this checkout's candidate created itself. It runs as the
daily canary, as a manual reproduction and as the version PR's gate. Every journey runs on
the repository's published T3 pin (`t3Release` in `scripts/local-stack.ts`,
[moving the T3 pin](local-stack.md#moving-the-t3-pin)), apart from the published-T3
compatibility workflow and independent of its slots: the workflow resolves no T3 target and
keeps no T3 lock. Its only credential is GitHub's automatic, read-only workflow token, which
only the job that reads an earlier run's lock holds.

A run resolves its release lock once, in its `lock` job (`./dev pnpm dev:releases resolve`,
which reads GHCR with an anonymous pull token and npm's public record and holds no
credential), records its SHA-256 and the releases in its summary and keeps the lock as the
run's `upgrade-lock` artifact. Each journey runs on a native x64 runner, checks that it
downloaded exactly those bytes and installs the pinned T3 only from an archive with the
pinned SHA-256, as `./dev check` does. Nothing resolves again. A lock the run could not
produce fails every journey with that outcome instead of skipping it: `unavailable` when a
registry did not answer as needed or the earlier run kept no readable lock, `invalid` when
the publications cannot fill the channels or the lock is malformed, `harness` when the
environment could not be prepared.

A journey passes only when its report passed and names this journey, the release lock's
SHA-256, its Supervisor release and image digest, the T3 pin with the version and the
`linux-x64` archive digest it verified, and the checked commit with a clean tree; a report of
other inputs, a missing report or an exit status that contradicts its report is a harness
failure, never a pass. Its outcome is `passed`, `failed`
(a check contradicted), `unsupported_shape` (the published release left a persisted shape no
frozen seed set recognizes), `creator_unready` (the published image never became ready on
that T3) or `harness`. Every journey runs even when another fails, and the run fails when any
journey did not pass. Each journey writes a step summary with its inputs, the T3 build it ran,
every check and its detail, the stage timings and its separate findings, such as whether a
fresh npm install of the same version boots, which never decide its outcome. It keeps its
report, logs and release lock as an artifact also after a failure or a timeout. Every job and
every long step is bounded.

The daily canary runs every journey at 06:11 Europe/Rome from the default branch. Like the
compatibility canary it is advisory: not part of the `check` aggregate, no release gate, no
issue and nothing written to the repository. A dispatch runs the chosen `journeys`, `all` or
a comma-separated list; with `lock_run`, the ID of an earlier run that kept an `upgrade-lock`
artifact, it reruns those frozen releases unchanged, on the T3 pin of the checked commit. Only
the job that reads the earlier run's artifact holds `actions: read`. As part of the
[version PR gate](#version-pr-gate) every journey runs from a new release lock.
