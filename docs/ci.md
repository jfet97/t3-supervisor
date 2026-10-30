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
harness and the production startup integration. Each test file runs in its native shard, with one worker per runner.
The watchdog, test deadlines, leak gate, privacy guards and cleanup stay intact.
Each container build reads and writes its own GitHub Actions layer-cache scope. The
cache only speeds up builds, so a failed cache export is logged without failing the
check.

PRs explicitly check out their head commit. A successful check remains usable
when main advances; do not update a branch solely to satisfy freshness. Changes
to the PR itself still require a successful check on its new head. Admin bypasses
remain exceptional.

While editing, run focused local cases, lint and types. Leave the final complete
main and harness suites to GitHub rather than repeating them locally.

## Release metadata fast track

The `changeset-release/main` version PR may reuse full validation of its parent
commit. Static checks, both type checks, build, package smoke and container smoke
still run on the new version. Only the four main shards and harness skip.
The production startup integration runs in full, reuse and release modes.
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
chain of lightweight verdicts.

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
  integration and aggregate `check` all succeeded in that run's latest attempt.
  Skipped jobs do not qualify.

For a merged fast-tracked version PR, main instead requires the exact same tree,
a successful latest release run with `plan`, `static`, `startup` and `check`
passed and the suites skipped, and independently rederives the release diff and
full baseline proof above. A successful release summary alone is insufficient.

Only with one of these proofs do the main shards and harness skip. The startup
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
described in [RELEASING.md](../RELEASING.md). The publication gate is unchanged:
it requires successful push-to-main CI and aggregate `check` for the exact source
commit, plus the separate stable-release approval. CI eligibility never publishes
or deploys a release.
