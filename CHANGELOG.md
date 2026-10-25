# T3 Supervisor

## 0.0.7

### Patch Changes

- cb4c480: Wait for T3 workspace preparation before planning supervision, and recover an unsent initial proposal when its worktree becomes ready with identical definitions. Real policy changes and stopped conversations retain their existing boundaries.

## 0.0.6

### Patch Changes

- e296fe2: Separate headings, explanations, fields and sections across the dashboard so definitions, activity, settings and expanded details are easier to read.
- 12edf03: Workflows can now choose between coarse alternatives with a `branch:` that has a one-line `if` condition, a `then` path and an optional `else` path; the next member follows the whole branch. The agent working on a workflow, including a child conversation for its own workflow, records which path applies with a short reason in a `branch-selection` record, without asking the Supervisor for approval. The dashboard, Definitions, outlines and Guide show the condition, both labelled paths, a pending decision, the selected path and the not-selected path. A selection is not evidence that work was performed: steps on an undecided or not-selected path are not counted as outstanding, a completed assessment is refused while a decision on its applicable path is pending, and a completion recorded before a decision changed is shown as needing reassessment. A required definition counts as included only when every path includes it, and fixed workflows keep their branches' conditions and paths.

## 0.0.5

### Patch Changes

- 5f71d60: Explain dashboard terminology with contextual help and direct Guide/glossary links,
  including missing-folder orphaned chats, conversation states, monitoring and team
  roles. Preserve list context and drafts when opening help. Separate portable usage
  skills from repository-only contributor guidance, and include only usage skills in
  the package and container.

## 0.0.4

### Patch Changes

- 222c1b5: Add explicit project return navigation, distinguish retained chats with missing working folders on Home and project cards, and keep search help and pagination inside the work filters.

## 0.0.3

### Patch Changes

- 2d84c12: Clarify working folder and default branch identities, hide chats whose folders are confirmed missing, and keep them accessible through an explicit orphaned-chat filter. Open project.yaml editing inside Definitions and group related settings with consistent spacing.

## 0.0.2

First public release.

### Minor Changes

- deae7b7: Introduce installable releases with the complete dashboard, CLI version reporting,
  and matching container images. Add opt-in stable, nightly, alpha and beta channels.

### Patch Changes

- b8b81bf: Point installation, package metadata and release links to the public personal repository and its container namespace.
