# Definition patterns

This is an authoring aid. Check the current product Guide or
`docs/steps-and-workflows.md` when available; do not infer new fields from prose. These
examples illustrate composition, not a catalog every project must adopt.

## Files and references

The operative checkout contains `.t3-supervisor/project.yaml`, `steps/*.md` and
`workflows/*.yaml`. A reusable step's filename matches its lowercase hyphenated ID. Its
Markdown body is empty; put its full contract in YAML frontmatter:

```markdown
---
id: review-correctness
name: Correctness review
description: |
  An independent reviewer assesses the frozen artifact against its actual base
  and authoritative requirements, including affected shared consumers.
  Return concrete findings, reviewer-assigned severity, artifact and base identity,
  coverage limits and a verdict. Later rounds assess fixes and prior objections.
references:
  - AGENTS.md
---
```

Use checkout-relative file strings in `references`. Keep `skills` separate, with
plain strings such as `.claude/skills/project-review/SKILL.md` or
`effect-v4-development`. There is no scope or path/name wrapper. Global names come from the
consuming agent's configured catalog, including namespaces; do not invent host
paths or assume availability. Missing or ambiguous guidance stays an explicit gap.
The product Guide's References and skills section owns the full syntax, bounds and
lookup rules. References grant no access and prove neither reading nor execution.

A workflow has `name`, `description`, optional `references` and `skills` string lists and `fixed`, and one root
`sequence` or `parallel`. Its ID is its YAML filename. Members can be `step` references,
local step objects, named `workflow` references or nested groups. A workflow file has
no `steps`, `inline`, `instructions`, `outcome` or `iterative` field; `steps` is an
index key in `project.yaml` only. Steps have no structural children. Promote genuinely
shared responsibilities to reusable files, and define every referenced ID and its index
entry before claiming a valid catalog.

## Short descriptions with complete contracts

Keep the local work and its evidence in the step. A reviewer workflow owns one pass;
its caller owns reviewer count, findings accounting, acceptance and any return. Each
member need not repeat that full explanation.

Preserve decision-critical conditions inline. Link a shared procedure for mechanics,
with an explicit instruction to read it. Compare every original obligation against its
retained wording or canonical home before declaring a shorter version complete.

## One review pass and caller-owned coordination

A reusable reviewer workflow describes one reviewer assessing one frozen artifact.
Define its referenced steps separately:

```yaml
name: Single review
description: |
  One assigned reviewer assesses correctness and fit independently, then reports
  material findings, coverage limits and a verdict for the frozen artifact and base.
  On another pass, retain prior findings and responses. Do not reopen settled issues
  without new evidence or repeat optional preferences as blockers.
sequence:
  - step: review-correctness
  - step: review-fit
  - step: report-findings
```

When the project requires two reviewers, a caller composes two complete passes:

```yaml
name: Paired review
description: |
  The main assigns each occurrence to an independent reviewer under the project's
  model and reasoning policy. Each reviewer covers both lenses. Freeze one artifact
  and base, wait for both complete reports before edits or findings accounting,
  and pin every report to that artifact. Preserve each reviewer's attribution.
parallel:
  - workflow: single-review
  - workflow: single-review
```

The main owns findings accounting; do not hand that duty to the independent reviewers.
The surrounding Review workflow can select single or paired review and then account
for findings, as below. The caller of Review decides whether the requested outcome
needs another pass and uses a [return](#returns-for-repeated-rounds) to repeat earlier
members. No reviewer description restarts an outer process. A completed review pass
can have a negative verdict; missing reports remain unfinished. Acceptance and report
completion are distinct, and a completed child never completes a parent's work.
Supervisor observes and assesses; YAML does not launch those reviewers.

Choose `fixed: true` only when the original members, descriptions, references, order and
parallel relationships must survive adaptation. It permits added support work.
`project.yaml` is the index of every reusable step and workflow, not a whitelist of
task plans. A new project file is `workflows: []` and then `steps: []`:

```yaml
workflows: []
steps: []
```

Each entry has exactly `path` and `summary`, plus an optional `required` (`true` or `false`, default `false`).
`path` is `workflows/<id>.yaml` or `steps/<id>.md`; its file name is the ID. The parser accepts a summary
only when it is nonempty, at most two nonempty lines, and at most 240 characters.
Write what the definition is for and when it applies; a descriptive name can be
a fine summary, and the file description stays the policy. `required: true` is
the only inclusion flag. Optional `default_workflow` names one workflow id already
in `workflows`. Do not add a top-level `required:` key. Read the index first, then
the full definition files that apply. Keep existing flags, summaries and paths
unless the change is intentional. An unlisted file is `definition_unlisted` and
is not read. A missing indexed file is `catalog_entry_missing`; the row and its
flag stay. The referenced step files are indexed in the same edit; the fragment
below shows the workflow flag only.

```yaml
workflows:
  - path: workflows/review.yaml
    summary: Use to independently assess a frozen change or plan, and to account for the findings before the governed action.
    required: true
  - path: workflows/single-review.yaml
    summary: One independent reviewer assesses the frozen artifact.
  - path: workflows/paired-review.yaml
    summary: Two independent complete reviewer passes.
steps: []
```

Choose required review from the project's risks and requested outcomes; substantive
changes and consequential plans commonly justify it. Do not impose it universally by
copying this example. Where required, record applicability for the current main task. An
explicit request for assessment is applicable even if the artifact is small. Genuine
inapplicability is requirement accounting or a negotiated omission from a flexible workflow,
not a fabricated reviewer execution or a new execution status. A fixed commitment is never
omitted; it stays visible and planned with a typed not-applicable assessment for the current task.

## Coarse branches

A branch lets a workflow agree two substantially different pieces of work in advance
and leaves the choice to the operative when it reaches that point. A useful shape is a
review whose depth follows the change's scope and risk:

```yaml
name: Review
description: |
  The main owns review coordination and findings accounting. The branch condition
  is judged on the frozen change and its actual blast radius, not its line count.
  A light reviewer who finds the choice disproportionate says so in its findings.
sequence:
  - branch:
      if: The change is contained, well understood and low risk.
      then:
        - workflow: single-review
      else:
        - workflow: paired-review
  - step: account-for-findings
```

`account-for-findings` follows the whole branch on either path. A reviewer pass
describes one reviewer and one artifact. `paired-review` composes two such passes
with `parallel`; the caller coordinates findings and any conditional `back_to`
after they join. Reviewer count and repetition belong to that caller. Leave out `else`
when a false condition simply skips the extra work. Each path needs at least one
member, the condition is one line of at most 300 characters, and a path can hold
groups, workflow references, a further branch or a final return. There is no `elif`,
jump or `goto`, and step files never contain branches or returns.

The operative records its choice with a short concrete reason in a `branch-selection`
record; the Supervisor does not approve it and objects only to a concrete contradiction
or an explicit human instruction. A selection is a decision, not evidence that the
selected work happened, and the other path stays a visible, not-selected commitment.
Inclusion is structural: an applicable required definition must appear on every path
to count, so keep always-required duties outside the branch or in both paths. A
required workflow containing a branch is included as a whole. `fixed: true` keeps the
branch's condition, its paths and member placement, while supporting work may be added
inside a path.

## Returns for repeated rounds

When the caller requires earlier work again, such as corrections, verification and
another review, a return repeats those members as a new attempt under the agreed
plan. The return itself does not require a new agreement:

```yaml
name: Reviewed delivery
description: |
  Implement, review the frozen change and address material findings until the
  reviewers confirm none remain. A finding is material when it affects correctness,
  safety, data, security or the agreed outcome. Style preferences, optional
  refactors and speculative concerns are reported once; they never justify another
  round on their own.
sequence:
  - step: implement
  - step: verify
  - workflow: review
  - branch:
      if: The review left material findings.
      then:
        - back_to: implement
  - step: deliver
```

`back_to` names the ID of an earlier step, local step or workflow in the same sequential
lane and ends its path. Put it in a branch path so the work can also continue; a return
with no way out is rejected. When the operative reaches it, the region from `implement`
through verification, Review and the branch waits. The Supervisor applies the return at
a safe point, and the next attempt repeats that region with the same reviewer conversations; the
branch decision is recorded again for each attempt. A reusable workflow may return to a
member of the workflow that includes it. From inside a parallel lane, return only within
that lane; to repeat work before a parallel group, place the return after the group.

Write the condition so the loop ends. Name what makes a finding material and let
reviewers report everything else once without reopening the round. A return is not a
retry for flaky checks or a way to collect more opinions.

## Completion and reviewer identity

State whether the task requests findings or acceptance. "Review this change" can finish
by reporting a bug; "deliver this change" cannot finish merely by handing over the bug
list. Edit permissions do not change that requested outcome. The main owns fixes and
accounting; reviewers independently confirm or contest them. Preserve reviewer-assigned
severity. An author's downgrade is a rebuttal requiring confirmation or an explicit
requester decision, not a way to close the gate. Demonstrated regressions in behavior
promised preserved cannot be dismissed as minor or out of scope. Earlier reports and
pre-fix checks do not certify later changes; a changed base invalidates affected
evidence.

A review pass and findings accounting can finish with a negative verdict. Delivery
acceptance still needs reviewer-confirmed resolution on the final artifact, or the
requester's explicit decision on the remaining findings.

For repeated rounds, strongly prefer the same exact persistent reviewer chats per
main-owned cycle. Record IDs, actual models and reasoning, artifact and base, rounds,
findings and responses privately. Different mains own different reviewer chats. Use
supported conversation or session APIs; copied context in a new task is not conversation
persistence. Respect orchestrator lifecycle rules, including any requirement to create
new delegated tasks instead of resuming completed backing threads. Choose a supported
persistent route when the project requires identity.

Native children whose provider publishes separate review-turn identities can continue
in the same conversation after a return. If no per-execution identity is available,
replace only that reviewer slot with a managed task, carry its findings forward and
record the reason and old/new identities. Earlier results remain history and cannot
satisfy the repeated review. Do not invent a child run from its parent's run.

Define intentional new-cycle boundaries for substantial intervening work or a material
scope change, carrying forward unresolved findings. Recover temporary interruptions in
the same chats. A permanently unusable chat or unavailable model may justify replacing
only that slot after bounded supported recovery, with a recorded reason, old and new
IDs, full findings handoff, required model diversity and reasoning settings preserved.
Delays or unfavorable findings do not justify replacement. An unavailable compliant
route is an explicit gap, not a waiver.

Keep drafting, adoption and external edits separate. Follow the target-folder boundary
in SKILL.md: keep execution guidance in the definitions and explain rationale in the
response. Existing external files can be read or referenced. Propose external changes to the user and wait for
explicit approval of those specific edits. Conditional wording, catalog adoption or
Supervisor activation does not replace that approval.
