# Connected workflow editing

The Supervisor maintains a broad editable plan for an ordinary main conversation
and a lightweight connected workflow for each native descendant. Steps can run in
parallel, overlap between children, and change as understanding improves. One
child can contribute to several parent steps and expand those into its own subflow.
Each parent occurrence's contributor thread IDs are the association source; child read
results derive their parent-step references from it. These are participation links,
not exclusive assignments or task dependencies. Child completion does not complete
parent steps automatically.

Editable plans are separate from accepted agreements. The existing native
proposal/acceptance checks import each freshly validated agreement as an immutable
historical snapshot. A first agreement seeds an empty plan; later agreements do
not overwrite an already edited plan. Structural edits clear a plan's matching
agreement pointer. A retained pointer only means the plan content matches a
historical accepted snapshot; current task-source and definition validity remain
part of the existing agreement/recovery system. Neither acceptance nor an
observation note proves execution.

## Native workflow proposal and acceptance records

Native chat negotiation uses compact top-level fenced records; they are separate from
`workflow_write` arguments and receipts, and a record quoted inside another block is
inert. The Supervisor publishes a `workflow-proposal` draft with exactly `taskId`,
`taskRevision`, `proposalId`, `revision` and `draft` (plus optional `objective`) in its
own completed message. The draft contains requirement applicability decisions and a
plan of definition IDs, local steps and groups. The service binds it to the observed
task source and definition revisions, derives workspace, names, descriptions, sources
and template paths from the trusted definitions, and canonicalizes it with
deterministic node IDs. A changed plan needs a fresh proposal ID; reusing an ID for
different content is rejected. A workflow reference in a draft may carry
`omit: [{member, reason}]`, naming members of a flexible workflow by definitionId,
localId or nodeId; the service derives their template provenance and keeps them visible
as not applicable. Fixed workflows reject omissions.

The operative main assistant records agreement only in its own completed message
after the introduction, with a `workflow-acceptance` fence of exactly
`{taskId, proposalId, digest}` naming a stored formal candidate. The digest covers the
task revision, definition pins and the whole canonical plan. A short acknowledgement,
a reduced `{taskId, mainThreadId, proposalId, accepted: true}` object, prose or extra
fields do not establish agreement. Full canonical records published before this
protocol remain evidence for their own retained agreements only. MCP transport access
and a successful `workflow_write` remain separate capabilities and cannot stand in for
native-message agreement.

The current task stores at most one bounded `workflowProtocolDiagnostic` with its role,
code, failing path, expected shape and detail. A new diagnostic replaces the previous
one. A rejected Supervisor proposal becomes focused repair work in the next wake and,
after three consecutive rejections, a visible blocker; it never changes agreement
history, authorizes an edit or proves execution.

## External contributions

Some work for a main-workflow step happens where the Supervisor cannot observe it:
an external agent, tool, service or person. The operative main records that work
in its own completed reply with an exact fenced `external-contribution` record. The
record is generic and provider-independent; it names no provider, carries no
credentials and grants no remote polling, steering or workflow-write authority.

The fence holds one single-line JSON object with exactly these fields, all present:

- `taskId`: the current task.
- `contributionId`: the main's stable ID, at most 64 characters of `A-Z a-z 0-9 . _ : -`.
- `nodeId`: an existing step or workflow node in the current main workflow plan.
- `revision`: an integer of at least 1.
- `state`: `awaiting_result`, `result` or `withdrawn`.
- `summary`: at most 2,000 characters of untrusted text.
- `references`: at most 8 `{kind, value}` objects, where `kind` is `file`, `url`,
  `source` or `text` and `value` has at most 500 characters; may be empty.
- `externalRef`: an opaque display reference of at most 200 characters, or `null`.
- `participant` (optional): who performs the work, declared generically as
  `{kind: "t3_conversation", threadId, environmentId?}`, `{kind: "external", ref}` or
  `{kind: "unknown"}`, each handle at most 200 characters, or `null`. It is untrusted
  and derives no lineage, scope membership, authority or settlement.

A message may hold up to 8 records, at most one revision per contribution: a
further record for the same contribution in that message is not imported
(`contribution_duplicate_in_message`), so the next revision belongs in a later reply.
Missing or extra fields, wrong types, exceeded caps and malformed JSON make a
record invalid.

The service imports records only from the operative main's own completed,
non-streaming assistant messages, under the same native-order rules as other main
protocol records: after the task's introduction and after any source edit, with
fail-closed attribution when no protocol anchor exists. Records are top-level
only: Supervisor, user, child, tool, streaming, quoted or indented copies, copies
inside any enclosing code block, records naming another task, and records before
the introduction are ignored. An enclosing block opens with a run of three or more
backticks or tildes indented by at most three spaces and closes only at a bare
run of the same character at least as long, so an example fenced with four
backticks or with tildes may contain three-backtick lines; an unclosed block
leaves the rest of the message inert. Scope is the main workflow only.
A local native child never records a contribution: it returns its external outcome
to the main, which relays it with its own record. No contributor thread IDs or
native descendants are created for external work.

Accepted records are stored on the main workflow document as `contributions[]`,
one entry per `contributionId` with its latest `state`, `revision`, `summary`,
`references`, `externalRef`, source thread/run/message IDs, `recordedAt` and the
current `assessment` or `null`. Each import adds `contribution_recorded` evidence
under revision CAS. The first revision is 1, as `awaiting_result` or, when the
result is already available, directly as `result`; each later one must be exactly
the current revision plus 1. An identical replay is a no-op. A same-revision
change, a gap, a lower revision, an unknown node or any change after `withdrawn` is
not imported and leaves one bounded diagnostic in the task's single
`workflowProtocolDiagnostic` slot, using fixed `contribution_*` codes. Later
observations re-evaluate the main's attributable records, so a record naming a node
that does not exist yet imports once that node is in the plan. A record in
an earlier main reply than the stored revision's reply is superseded and never
imported later. A later valid record clears a contribution diagnostic. A node
later removed from the plan keeps its contributions as history; a withdrawal may
still name it. Each document holds at most 32 contributions within the existing
document and history caps. Documents stored before this field existed read it as
empty.

The root assesses a `result` with `workflow_write` action `assess_contribution`.
It records `accepted` or `needs_more` for the contribution's current result
revision as `contribution_assessed` evidence and sets the current assessment. The
root may assess the same result revision again: the latest assessment is current
and each one stays in evidence. After
`needs_more`, ordinary dialogue follows and the main posts the next revision, which
clears the current assessment while evidence keeps the history. Receipt, assessment
and step completion stay separate: no record or assessment changes a status, and
an accepted result never completes a step automatically. The Supervisor records
completion with an ordinary `apply` and `status_changed` evidence, which may cite
the main's result message through `sourceThreadId` and `sourceMessageId`.

### Participants and observation receipts

A participant is any conversation or agent that works an occurrence: a native
descendant attached to it through `contributorThreadIds` (the association source;
a linked child with no attached occurrence has no role), or the participant a
contribution declares. The root records its own observation of a declared
participant as `apply` evidence of kind `observation` with
`participantContributionId` and `observation` set to `read`, `lifecycle` or
`unsupported`. For `read` and `lifecycle` the entry cites the root's own completed
native tool item (`sourceItemId` on the root thread): the service verifies the
caller and that item with the same provenance fences as its own write proof (a
completed `dynamic_tool` item with strong and complete native identity, in a run of
the root whose provider thread it names, with neither the run nor its root node
rolled back, and its node completed inside that main run). An item a harness or gateway
nests under a parent item is the root's own only through its ancestors: each must
be an item of the same thread and run whose node lies in that main run and is not
rolled back, within a bounded depth (`participant_item_chain_mismatch` otherwise;
an unreadable ancestor is pending). The call is recorded as the configured native
routes read it: a configured gateway call tool naming exactly `{name, arguments}`
stands for that target, any other wrapper for itself, verbatim and with an input
digest; no other inner target is inferred and no foreign semantics are
interpreted. A T3 wait, list, search or queue call under any prefix, directly or
through a configured gateway call, is accepted as `lifecycle` only and refused as
`read` (`participant_item_lifecycle_only`).
The item is credited to the window it belongs to: T3's own time for the item itself,
never its run's end (`participant_item_undated` without one), must not precede the current revision's
record or the latest applied return that reopened the contribution's occurrence
(`participant_item_before_window`), so a read made before a return cannot be
recorded after it even from the same Supervisor run, while a read from an earlier
run inside the current attempt counts. `unsupported` cites no item and states that
no route exists. Each receipt is stored on the evidence with the exact participant,
contribution revision and occurrence attempt it concerns; a later revision, a
changed declaration or an applied return retires earlier receipts into history. An
identical receipt (same actor, declaration, revision, attempt, kind and tool) updates
its entry's time, item and `repeats` count in place, and an observation-only apply
that changes no plan, status, node, branch or selection records no `plan_updated`
event, so continuous observation never consumes the evidence history. History shows a
compacted receipt as one span at the position of its first read, dated by that first
read with its latest read and count beside it, so a repeated read never appears as a
newly dated event before an older status change or return. A receipt is
evidence of a read at its time; whether the route is available now is not
re-verified. Helpers cannot record
receipts (`participant_observation_root_only`), a receipt for an unknown
contribution is invalid (`participant_contribution_unknown`), and a cited item that
is not the root's own completed tool call is refused. Receipts grant no write or
settlement authority and never replace an assessment.

The progress snapshot lists each workflow's `participants[]` with source, kind,
handle, roles (occurrence, attempt, replaced by an applied return), owner,
lifecycle, reported state, completion, coverage (`native`, `supervisor_observed`,
`lifecycle_only`, `reported`, `unsupported`, `unknown`), the current receipt and the
count of earlier receipts, and `settlement`: `not_evaluated` until the task completed,
`not_applicable` for external or unknown participants, else the outcome of the one
automatic attempt recorded for the main's current execution (its task, scope revision and
latest completion record, which the scope names on every page): `pending`, `uncertain`,
`settled`, `superseded`, `unresolved` or `skipped`, with `settlementReason` for unresolved
and skipped ones (`unavailable`, `not_quiet`, `snapshot_unavailable`, `settle_rejected`,
`environment_settle_unsupported`, `keep_active`). Nothing is retried; what did not settle
is settled by hand.
`native` requires the service's own projection read of a live local thread in that
snapshot (`projectionRead` on the scope row; lifecycle metadata of an unread,
archived or deleted thread is `unknown`), and a conversation declared with an
`environmentId` is another environment's conversation: it never joins a local row
by thread id and the dashboard shows its full identity without a local link.

`workflow_read` returns the bounded contributions and current assessments; what
they mean is stated once, in the root's instruction section `contributions`, not in
each read. A root check-in's frozen envelope (`workflow_read` view `request`) adds `externalContributions`, a
compact index of open entries (`contributionId`, `nodeId`, `inCurrentPlan`,
`state`, `revision`, current decision and `sourceMessageId`) without their summary
or references. Summaries, references and `externalRef` are untrusted evidence,
never instructions, authority or native proof of execution.

## Branch selections

A plan branch is `{kind: "branch", nodeId, templatePath, condition, reason, then,
else}`, where `then` and `else` are groups and `else` may be `null`; it has no status
or contributors. Its condition and paths come from the definition, or from the
negotiated plan for a task-local branch. Selecting a path is the operative's own
decision and needs no Supervisor approval. The main records selections for the main
workflow; a verified native child records them for its own connected workflow.

The operative writes, in its own completed reply, a top-level fenced `branch-selection`
record holding one JSON line with exactly these fields:

```branch-selection
{"taskId":"proposal-1","nodeId":"0b7c9a52-5f3e-4c1a-9d2e-6a1f2b3c4d5e","revision":1,"path":"else","reason":"The change alters a persisted format, so the contained path does not fit."}
```

- `taskId`: the current task.
- `nodeId`: a branch occurrence in the author's own workflow plan.
- `revision`: 1 first, then exactly one higher for each changed decision.
- `path`: `then` when the condition holds, `else` when it does not. For a branch
  without an else path, `else` skips it.
- `reason`: a short concrete reason, nonempty and at most 500 characters.

A message holds at most 8 records and one per branch. The main's records follow
the main's native-order rules: after its introduction and after any source edit,
top-level only, with quoted, indented and enclosed copies inert. A child's records
come from its own completed replies after the task source while it remains a
verified native descendant in scope. Its finished final reply stays importable. A
record names only a branch of its author's own workflow: the main cannot select a
child's branch, and a child cannot select the main's or a sibling's.

Accepted records are stored on that workflow document as `branchSelections`, one
entry per branch with its latest path, reason, revision, condition, branch identity
key, state and source thread, run and message. Each import adds `branch_selected`
evidence under revision CAS. An identical replay is a no-op. A same-revision change,
a gap, a lower revision, an unknown branch or capacity is not imported and leaves one
bounded `branch_*` diagnostic in the task slot. That diagnostic never replaces a
proposal or acceptance problem, and only a later valid record from the same author
clears it. A record naming a branch that does not exist yet is checked again later.
Each document holds at most 64 selections.

A selection answers the branch identity it was made for: the condition, whether an
else path exists, and the enclosing workflow occurrences and branch paths. An
`apply` that changes any of these, or removes the branch, invalidates the selection
for good with `branch_selection_invalidated` evidence. The revision and attribution
stay. Returning to the earlier identity or replaying the old record leaves the
decision pending. Only the next revision, from a message created after the
invalidation, selects again. Status changes and supporting work inside or around a
path leave a selection current. Selections are not plan structure: they never clear
the agreement pointer, change the agreement digest or alter requirement accounting.

A reached branch without a current selection is a pending decision. `workflow_read`
lists each workflow's `pendingBranchDecisions` (their meaning is in the root's
instruction section `branches`), and a root
check-in's frozen envelope (view `request`) adds `branchDecisions`, holding pending decisions and current
selections with their source message. An `apply` that assesses the workflow, or a
workflow occurrence, as newly completed while a decision on its applicable path is
pending is rejected with `branch_decision_pending` and a pointer to the branch. When
a decision changes or is invalidated after the workflow was assessed completed, the
recorded status and evidence stay, and the assessment carries a `reassessment`
reason. The dashboard then presents the completion as needing reassessment.
A completed workflow occurrence inside the plan is dated by its latest completion
record in the whole evidence, not only the recent observations. If it has decisions
inside it but no recorded completion time, it also needs reassessment.

A selection is a decision, not execution evidence. The Supervisor assesses the
selected path's steps as usual. It never marks the not-selected path completed or
removes it to tidy progress, and it never records or approves a selection itself.
When a child's connected workflow contains a branch, the Supervisor tells that child
its branch node ID, condition and paths, the task ID and this record format.

## Returns and attempts

A plan return is `{kind: "back_to", nodeId, templatePath, target, targetNodeId,
maximum, budgetId, reason}`; like a branch it has no status or contributors. `target`
is the step, local step or workflow ID of an earlier member in the same sequential
lane, and the service resolves `targetNodeId` in the composed plan, so drafts and
applies omit it. `maximum` is an integer from 1 to 99, the most successful jumps of
this return. `budgetId` identifies that return's own budget. A plan
that cannot resolve a return is rejected with `back_to_target_not_found`,
`back_to_target_ambiguous`, `back_to_unreachable_member` (a member follows it) or
`back_to_no_exit_cycle`, and a pointer to the return.

A return's region is every occurrence from its target through the member that holds
it, nested ones included. When a return is reached, on the active path with every
earlier member settled, the workflow document appends a pending entry to `returns`
with `return_requested` evidence. It carries `returnId`, `backToNodeId`,
`targetNodeId`, `regionNodeIds`, the `attempt` it closes, and the reason and source
of the selection that led to it. While it is pending, an `apply` is rejected with
`return_pending` when it changes a status in its region, enters an occurrence after
the return, or completes the task or a workflow enclosing it. Observations remain
possible. A pending entry whose return is no longer reached, or has left the plan, is
dismissed with `return_dismissed` evidence. Entries are never removed, and a workflow
holds at most 100.

The region of a return the current selections reach, its failure path selected or the
return lying on every path, is one real boundary. An `apply` that moves a status inside
that region backward (completed or underway to planned, completed to underway) is
rejected with `return_required` and a pointer to the reopened occurrence, whether it
also settles the assessing member in the same write or reopens first and settles later.
The assessing member settles alone, the service requests the return, and `apply_return`
starts the next attempt; attempts and budgets change nowhere else. With that return's
budget spent the same backward move is `return_budget_exhausted`. Off the selected
path, no failure path selected yet or the `else` path taken, a backward move inside a
region is a misrecorded status: the apply needs `repair: true` with the usual
`status_changed` evidence and a note, is rejected with `status_repair_required` without
the flag, records that evidence flagged `repair: true` (History shows "Status
corrected"), consumes no budget and starts no attempt; `repair: true` on an apply that
moves no such status is `repair_not_applicable`. Backward moves outside every return
region, and the reassessment a changed task scope requires, are unaffected. A region
whose return already waits keeps `return_pending`.

When the successful jumps reach `maximum`, the document records an `exhausted`
return and `return_budget_exhausted` evidence instead of another pending request.
An `apply` that would complete the task or enter work after that return is rejected
with `return_budget_exhausted`. `apply_return` on a pending row whose budget is
already spent returns the same reason and writes nothing. Selecting another path
sets `resolvedAt` and keeps the exhausted row. The document stores `returnBudgets`.
Each entry is `{budgetId, address, events}`, and an event is
`{kind: "consumed" | "reset", returnId, at}`. Current use is the consumed events
after the latest reset. Applying a return appends one consumed event for itself and
one reset event for each strictly nested replayed return, in the same transaction as
the new attempt. Each return occurrence has its own budget, including each expansion
of one reusable workflow. An edit that keeps a return's nodeId or budgetId keeps that
budget when the return is reordered or retitled. The executable plan's returns need
a `returnBudgets` row, and an applied return needs its consumed event. A later
accepted agreement is history: it keeps its own budget ids and does not mint a ledger
row. A missing executable row, or a missing consumed event, stays on disk and is
classified incompatible. An empty ledger is not repaired into an unused budget. Omitting
the field does not hide an applied jump after its return leaves the plan. A plan with no return and no applied jump may omit
the field. Two returns that both move and keep no nodeId or budgetId are rejected with
`return_budget_identity_ambiguous` and write nothing. Two returns that claim one
`budgetId` are rejected with `return_budget_duplicate` and write nothing.

The Supervisor applies a pending, still reached return at a safe point. Applying it
records `return_applied` evidence and keeps the closed attempt on the entry: `closed`
holds each region occurrence's status and contributors, `closedSelections` the branch
selections that were current, and `retiredRuns` the earlier child executions, at most
50 entries. AppRun entries have `kind: "run"`, `threadId` and `runId`; every known
earlier run is retired, including completed runs before the latest one. Native entries
have `kind: "provider_turns"`, `threadId`, `providerThreadId` and `providerTurnIds`,
or `kind: "thread"`, `threadId` and `reason` when separate rounds cannot be identified.
An ACK covers its acknowledged execution; newly queued or other active runs still
prevent the return, as do pending native turns with weak execution identity.
Every occurrence in the region
returns to `planned` with its contributors still linked, and each selection in the
region is invalidated, so the operative decides again with the next revision. The
plan and the agreement pointer are unchanged. The operation is idempotent by its
operation ID and checks the expected revision.

An occurrence's attempt is one more than the number of applied returns whose region
holds it. View `status` adds `attempt` to reopened occurrences and lists each
workflow's `pendingReturns`; the progress snapshot adds `returns` (with `closed`,
`closedSelections` and `retiredRuns` of each applied return) and `attempts`, which
lists every occurrence inside a return's region, attempt 1 explicit, so attempts
only ever grow and occurrences outside every region carry none. Each history event
carries the `operationId` of the write that recorded it; the dashboard groups the
consecutive events of one write and never merges records, including records that
share a timestamp.
Output of a closed attempt never counts for the next one. A branch-selection record
from a message created before an applied return reopened its branch, or from a run
that return retired, is `branch_record_outdated`. A `status_changed` or
`not_applicable` entry about a reopened occurrence that cites a retired run is
rejected with `retired_run_evidence`; it can still be recorded as an observation. When
evidence cites a native message or item without its run, the service records the run
that produced it, so the fence holds however the evidence cites it.

Native reviewer children with published, strongly identified provider turns keep the
same conversation across passes. Applying the return requires a terminal child and
provider turns, no pending work, and its parent's dispatch ACK. It retires the exact
earlier turn IDs. A new pass must cite a different turn started after the return;
the service resolves this identity from native evidence rather than caller input.
When a native provider exposes no per-execution identity, the return retires that
whole child. Use a fresh managed reviewer carrying its earlier findings and record
the replacement reason. Connected work and History show this distinction. Neither
case removes the earlier reports or turns a failed review into a missing report.

A revision keeps the identity of every occurrence it keeps. A proposal draft is
canonicalized against the live plan, or the latest proposal before any plan is live:
an occurrence without `nodeId` that matches exactly one existing occurrence keeps its
ID, and a referenced workflow keeps the actual IDs of its existing members. A member
new to an occurrence, such as one a revision includes again, gets an ID derived from
the occurrence and the member's template path, the same in every proposal and apply.
An `apply` still names each existing occurrence by its `nodeId`.

## MCP interface

The service provides a stateless Streamable HTTP MCP route at `/mcp/workflows`.
Register it under the exact server alias `t3-supervisor-workflows` when authorized
to configure a connection. MCPX connects directly to Supervisor; do not add HTTP
proxies or relay sidecars to adapt the connection.

A deployment that registers the server under another alias lists those exact aliases
in `WORKFLOW_MCP_SERVER_ALIASES`: a comma-separated list of letters and digits joined
by single `-` or `_`. A deployment whose agents call tools through another gateway
lists the exact native names of that gateway's call tool in
`WORKFLOW_MCP_GATEWAY_TOOLS`, one per form the providers record, such as
`mcp__other_gateway__call_tool,other_gateway.call_tool`. Each name is
`<server>.<tool>` or `mcp__<server>__<tool>`, with the server and the tool each letters
and digits joined by single `-` or `_`; the default is
`mcpx.mcpx_call_tool,mcp__mcpx__mcpx_call_tool`.
A gateway is supported only when its call tool takes the standard MCP call envelope,
exactly `{name, arguments}`, with object arguments. Any other input shape is not
recognised. A list replaces the default, and an invalid name stops startup. A
name that is not configured is denied like any unknown route.

Every MCP request requires `Authorization: Bearer <workflow-token>`. The service
creates the private token at `<DATA_DIRECTORY>/access/workflow-mcp-token` on first
startup and preserves it across restarts. Configure this header privately in MCPX;
never put its value in docs, conversation text or source control. The dashboard's
login token and short-lived session cannot authenticate MCP, and the MCP bearer
cannot authenticate dashboard APIs. Transport access grants no native write authority.

`WORKFLOW_MCP_HOSTS` is a comma-separated list of exact accepted `host:port` values
for this route, in addition to its actual loopback address. Foreign browser Origin,
cross-site requests and browser preflight are rejected. Dashboard Host/Origin/CSRF
checks remain independent, and every dashboard API also requires an authenticated
session header. The dashboard uses origin-scoped browser storage and no auth cookies.

On a host-network deployment, optional `WORKFLOW_MCP_BIND_HOST` starts another
listening socket in the same Supervisor process, serving only `/mcp/workflows`.
`WORKFLOW_MCP_PORT` defaults to the dashboard port. This lets the dashboard stay on
loopback while the actual MCP endpoint binds directly to a private Docker bridge.
Missing bind interfaces fail startup; no forwarding service or proxy is involved.
For the Lima lab the MCP listener is `172.19.0.1:19008`, with dashboard loopback
`127.0.0.1:19008`. Mac containers use their existing shared private network and
direct `http://t3-supervisor:9008/mcp/workflows`.

A successful read through the installed gateway establishes transport/permission
behavior, not a positive workflow edit or complete configured-project dialogue.

`workflow_read` takes the Supervisor thread ID and binding generation as lookup
coordinates. Its explicit document view includes bounded workflow state and native main/descendant lineage,
including child parent-step references and archive flags. Reads require the shared MCP transport token but are not
actor-authenticated to a particular T3 conversation and grant no edit authority.
`workflow_read` defaults to compact `status`. Use `view: "documents"` only when complete
records, history, evidence or accepted snapshots are needed; document and lineage pagination
remain available in that view. Other `view` values return bounded context for the verified binding instead of
workflow documents:

- `context`: compact by default: the task's identity, revision pins, objective, status,
  source and earlier unresolved request IDs, the proposal identity and digest, the
  agreement state and attention codes, the current interpretation's submission pins
  while one is in flight, the definition read's identity with an issue count, and the
  conversation sources. Each source names a message ID, kept as provenance and source-pin
  identity, and its `readItemId`: the exact native turn item T3 reads it by, joined from
  the projection's `turnItems` on `messageId` and never constructed. A message T3
  recorded no item for has no read handle: it is matched while paging that thread's
  messages, never passed as an `itemId`; no body is copied. `section` reads the rest
  on demand: `conversation` (the current conversation facts), `plan` (the live plan
  bound to this task and scope, with its revision and current acceptance flag, or the
  current proposal when no live plan matches; requirements, outline and task-local duties
  are included) and `diagnostics` (definition issues, protocol repair,
  operative record and definition review details). For a stopped chat it returns
  supervision=stopped even without a current task or enabled project; a valid pending
  Start returns supervision=pending_start.
- `definitions`: the `project.yaml` index once, one row per entry with its id,
  summary, path, required flag, non-project provenance, name and a workflow's members
  by ID; a required entry whose file is missing keeps its row. With `definitionIds`
  it returns each requested definition once, complete, with its authored composition
  (inline local steps and branches included); a referenced step or workflow is read
  by its own ID. A summary is not the definition's policy text. Add
  `includeSources` for raw definition files when diagnosing invalid definitions. By
  default it serves the approved definitions the task was interpreted under;
  `revision: "observed"` serves the checkout's current definitions, read fresh, for a
  definition review.
- `instructions`: without `section`, the root's compact core (identity, fences, permitted
  tools with the one neutral gateway reminder, reader coordinates and section pointers)
  and an index of sections, each with its id, version and purpose; with `section`, one
  section: `monitoring`, `contact`, `stop_start`, `authoring`, `workflow_edit`,
  `branches`, `contributions`, `planning`, `definitions`, and `isolation` and `team`
  when present. Each rule exists once. One version covers the core and every section,
  and each section also carries its own version, so the root rereads only what
  changed. Every root message carries this version instead of the rules. A helper
  reads its own single versioned reference here.
- `interpretation`: stage one of every interpretation: classification, the supervision
  decision and the submission rules. `section: "plan"` returns stage two, read only when
  a plan is needed: the planning pause first, then definitions, required references and
  the plan grammar. Both carry the rules' version, which the interpretation request
  names.
- `check`: a dry run of one compact `workflow-proposal` record, returning the outline,
  formal state, digest and `published`, or the first failing code, path and expected
  shape. It writes nothing and never returns acceptance coordinates. `published` is true
  only when this exact proposal is the task's current recorded candidate; until then a
  formal draft also gets `publish`, the exact block to put in the Supervisor's completed
  final answer, which is the only way to publish it.
- `status`: each current workflow's occurrences with nodeId, kind, name, definition
  reference, nesting, status, branch reach (stated only off the unconditional path) and
  visible omissions, plus pending decisions, without descriptions, accepted snapshots or
  history. Use it to reconcile statuses; the document read remains available for
  descriptions and history. `membersSettled` is true when every applicable member is settled and no
  decision is pending; with `status` still `underway` the completing apply is owed.
- `request` (with `requestId`): the frozen envelope of one of the caller's own check-ins or
  liveness wakes, exactly as prepared: the request's identity, kind, state, pins, marker and
  recorded outcome, and its envelope (per-thread rows with identities, counts, read handles,
  lifecycle and contact routes, task context, team policy, open contribution and branch
  indexes; for a liveness wake its key, generation and the unsettled occurrences). Routine
  wakes carry only identities, counts, this read and their marker. Another Supervisor's or
  helper's request is denied (`request_not_owned`); an unknown id is unavailable
  (`request_unknown`). The envelope stays readable after the turn ended and the outcome was
  acknowledged, for as long as the request record is retained.

`supervision_plan` is the operative main's read of its own current proposal. Its arguments
are `callerThreadId`, `taskId` and `proposalId`, copied from the Supervisor notice. The
service verifies the caller's own executed native tool call with exactly these arguments
in its own main run, then returns the complete current proposal: objective and authorized
scope, limits, required references, the plan with its omissions and branches, the branch
protocol and the exact acceptance record. It answers only for the caller's own interpreted
task under the ready Supervisor generation that interpreted it, while the task's request is
unchanged and fully considered and supervision of that chat is enabled and not stopped, for
exactly the current proposal whose acceptance record is still the one recorded with its
candidate, before or after its agreement. A notice names only an already recorded
proposal, so `pending` means only that the caller's own call is not visible yet. Any other
call, such as a forged, foreign, outdated or obsolete one, gets one refusal that names
nothing; the read writes nothing and grants no Supervisor, helper or write authority.

A native child of a supervised main reads its own scoped workflow with the same tool and
the same proof of its own executed call: `taskId` is the main's current task and
`proposalId` is the ID of the child's own workflow document, both from its notice. It
answers only while the child is a live descendant on a complete subagent path of a main
whose binding is ready, enabled and not stopped, under that main's current supervised
task, after a fresh main read confirms that its requester messages remain unchanged and
current. The child's linked document must be bound to that task's current scope under its
native parent. The text includes each applicable member's full recorded duty, references
and skills, relative to the named checkout root. It names each occurrence with its node ID, status, attempt and branch reach, then the returns
pending. A child accepts nothing: its scoped plan is its Supervisor's to write, and every
other call gets the same refusal.

`supervision_stop` durably stops supervision of one chat on a genuine human request.
Its arguments are `callerThreadId`, `targetThreadId`, `userMessageId` and
`operationId`. The service verifies the caller's own executed native tool call with
exactly these arguments, then requires the human's original native user message: in the
bound Supervisor conversation or its main when the caller is that chat's Supervisor, in
the main when the operative calls for itself, or in the caller's own chat, naming the
exact target chat ID, for a request from another chat in the same environment. Quoted
or relayed text, tool output, another agent's message, a foreign Supervisor's scope and
targets outside the environment are rejected. The caller judges the human's intent; the
service does not interpret the words, but the message must name no other chat (the caller's
own, a child chat or another Supervisor included; only the target's own Supervisor may be
mentioned) (denials: `target_ambiguous`, `target_not_named_by_user`); a
message older than the latest explicit Enable, from the dashboard or the Settings
excluded-chat list, is denied with `superseded_by_later_enable`, and repeating a stop
keeps the time of the human's original instruction. After a denial the caller tells the
human that supervision was not stopped and points them to the dashboard's Stop supervision
control. When the caller acts in the chat the human wrote in, its
verified call must belong to the run T3 delivered that message into, including a steer into
an already running turn (`stop_call_not_in_human_turn`); a later turn cannot borrow it.
`supervision_start` takes exactly `{callerThreadId,userMessageId,operationId}`.
It requests permission only for the caller's own ordinary No Project main on a
genuine current human request. It never enables the master or normal project
controls. Native direct/MCPX argument proof is checked before any reservation;
source provenance, turn identity and human Stop/Enable times are checked next.
The first Supervisor interpretation explicitly judges intent with startRequested,
independently from task relevance/plan validity. Pending roots may read their
interpretation/definitions but cannot write, guide, recruit or contact the agent.
A positive source- and epoch-bound verdict commits the task and permission together.
Use the same operationId on retries; pending is not activation. No extra Stop
judge is added. Read authority remains the existing same-user model, not a sandbox.
A bound Supervisor calls the same tool from its own conversation to resume its stopped
main. The cited message must be the latest genuine human message of that conversation,
in the run of the verified call, written after the Stop and the latest Enable. The
master, project and No Project controls must already supervise the chat; only its Stop
is lifted, as by the dashboard Enable, and the binding, task and history are kept.
Unlike that Enable, the resumed pair handles its retained task at once instead of
waiting for the main's next human request; nothing is sent to the operative for it.
A retry returns its receipt only while that resume is still the chat's latest control;
after a later Stop or Enable it reports `superseded_by_later_control` and changes
nothing. A stopped view `context` names this call for conversations with older
instructions.

`supervision_stop` stays callable while project supervision is disabled. The stop is the
instance thread policy the dashboard's per-chat control also edits; only a human can
enable supervision again. After a stop the chat's Supervisor and its helpers can still
read, but `workflow_write`, `supervision_team` actions and `supervision_guide` are refused
at their first and their final authority check.

`workflow_write` supports five actions:

- `ensure_main` creates an unaccepted main draft.
- `link_child` creates a live child's workflow under its verified native parent.
- `apply` revises the editable plan with an expected revision and retains
  explicit notes for status changes and removed steps. Plans may contain branch
  nodes; keep an existing branch's `nodeId` and `templatePath`. A definition
  branch keeps its condition and path presence. Existing occurrence IDs are stable and separate from definition IDs;
  repeated reusable references remain distinct. New live steps start "planned";
  mark them underway or completed in a separate later apply with status_changed
  evidence. Adequate actual work before initial planning/agreement can satisfy any
  duty; partial evidence names the specific remaining obligations. A scope change
  retains occurrence IDs/progress but requires explicit native activity references
  when carrying non-planned assessments into that scope (`scope_assessment_required`).
  Catching up to a newer requester defers a write as retryable, without reserving its
  operation or native evidence. On rejection, read the reason, code, and path. Read
  the current document before refining it.
- `assess_contribution` records the root's `accepted` or `needs_more` decision for
  one main-workflow external contribution. It takes `operationId`, `workflowId`,
  `expectedRevision`, `contributionId`, `resultRevision`, `decision` and a `note` of
  at most 2,000 characters. It is valid only when the contribution's latest state
  is `result` at exactly `resultRevision`; otherwise it returns
  `contribution_result_stale`, `contribution_not_a_result` or
  `contribution_not_found`. A child workflow returns `contribution_main_workflow_only`.
  It never changes a status.
- `record_review` records the outcome of one root monitoring check-in, named by the
  check-in's `requestId`: `progress_updated` with `applyOperationIds` (the `apply`
  edits made in that check-in's own run), `no_change` (nothing changed and no edit was
  made in that run), `needs_attention` with a `reason`, or `insufficient_evidence` with
  a `reason` naming what is missing (at most 1,000 characters). It is root-only, bound to
  the root's own native call in the check-in's run, and refused for an unknown, settled
  or other-run check-in (`review_request_unknown`, `review_request_not_pending`,
  `review_outcome_other_run`), for progress citing another run's edits
  (`review_progress_apply_unverified`) and for `no_change` after any workflow write in
  the run that created or changed a workflow (`review_no_change_after_edit`). A later call of the same run replaces the outcome
  until the check-in completes. It sends nothing: messaging the operative is a separate
  decision, and neither the record nor delivered guidance shows that the operative
  corrected anything. An optional `wait: {waitingOn, resumesWhen, messageId?}` records an
  explicit current wait when the main has stopped with agreed work unfinished: `requester`
  or `external` must act (never the operative's own unfinished action) and `resumesWhen`
  names what continues the work. A wait on the requester cites, in `messageId`, the
  human's own message in the root or the main (a web or mobile message, or the human's
  answer to a runtime input request, the server-created message T3 names
  `async-answer:<requestId>` or `approval-feedback:<requestId>` for a resolved request);
  without one, or citing an agent's send, a service
  notice, a Supervisor command or the root's own message, it is refused
  (`wait_source_not_human`; `wait_source_read_unavailable` while neither conversation can
  be read).

A valid unaccepted draft can be edited: formal agreement is not a write gate.
During initialization the root publishes the supplied initial record unchanged and
does not contact the operative main. In later check-ins, if the current task has
no valid source-bound plan, creating an empty draft does
not repair the missing proposal and `apply` remains unavailable. The root repairs
it with a fresh compact draft proposal in its own message, sends that proposal to the
operative main, then finishes its check-in. It waits until the service exposes that valid
current proposal before retrying `apply`. Invalid definitions or unresolved
requirements keep the proposal provisional; they do not authorize weaker edits.
The controller supplies the current task's trusted canonical proposal and a fresh
matching valid definition snapshot; live edits cannot self-authorize their source
binding or weaken fixed/required commitments. Invalid/incomplete source material
supports provisional dialogue, while source-bound writes wait for a valid pin.

Stored workflow documents and immutable receipts use `formatVersion: 2`. An applied,
created or exists receipt also states `documentStatus`, the document's own status after
the write, separate from the status of its root occurrence. Plans
retain nested groups and per-occurrence `nodeId` values separately from reusable
`definitionId` or task-local `localId` values. The service derives the task ID,
task source hash and definition source binding from its current trusted proposal
and fresh definitions; public arguments cannot supply a weaker policy. Fixed commitments already accepted or
present in the live plan survive a changed proposal ID for the same task source
hash and definition pin. Editing the operative task message creates a new task
source for negotiation, even when its stored task ID is retained. A merely
unaccepted draft candidate is still negotiable. An explicitly reviewed, adopted
new source revision may replace the previous commitments.
Old prototype documents remain explicitly incompatible and are not migrated or
silently reinterpreted; their historical rows and unrelated service state remain.

Apply requires `operationId`, `workflowId`, `expectedRevision` and `note`. Status,
objective, requirements, plan, statuses, omit, evidence and repair are optional; omitted plan fields are preserved
from the current document inside the revision-checked transaction. This permits a
status or objective change without resending an entire plan. `statuses` lists up to
100 `{nodeId, status}` edits of existing occurrences, merged into the current plan
atomically under the same revision check; each changed status still needs its own
`status_changed` evidence. `omit` lists up to 100 `{nodeId, reason}` omissions of
unstarted members declared by flexible workflows; the main workflow accepts one only when
the operative has accepted the current proposal and it omits the same member of the same
occurrence. Members with recorded progress, fixed members and an omission that would
empty a workflow or branch path, directly or through a nested group, are refused.
Neither may be combined with `plan` (`plan_edit_conflict`). `repair: true` declares the
apply's backward status moves inside a return region off its selected path as the
correction of a misrecorded status (see Returns and attempts). Evidence of kind
`not_applicable` records that a planned member of a fixed workflow, with no recorded
progress inside it, does not apply to the current task scope; it changes no status, is refused for any other target
(`not_applicable_invalid`) and stops counting after a later status change or scope
change. Assessing a fixed workflow member settles that whole occurrence: its own
members and any branch decisions inside it need no further record, and neither pending
decision lists nor completion reassessment ask for those decisions.

Recorded progress is checked, never operative work. A `status_changed` record must
change its target's status (`status_unchanged`), except the retained-progress
reassessment a changed scope requires. In any sequence, fixed or flexible, a member
may first be entered only after every earlier applicable member is settled
(`sequence_order`); parallel members, undecided or not-selected paths and rework or
review rounds inside an already entered member are unaffected. A workflow, or the task
itself, is entered together with an applicable member unless it opens with a pending
decision or has nothing left to settle, and a member is entered only inside an entered
workflow and task (`nested_status_inconsistent`). A workflow or the task is completed only
when every applicable member is settled (`completion_unfinished`): completed, or a planned
fixed member with a current `not_applicable` record. A member on a path whose decision is
still pending cannot be entered (`branch_decision_pending`). Completing a workflow never
completes its members. The order check and these rules count a settled member as done,
so a fixed member that does not apply never blocks what follows. A diagnostic names the
occurrence at fault: an edit's own `/input/statuses/N/status`, or `/current/...` for an
unedited occurrence of the current plan, such as an open member or a planned ancestor. A supplied plan replaces the nested plan, retaining stable occurrence identities.
A supplied requirement list replaces its accounting; reusable provenance, fixed
commitments and current-task policy are revalidated. Status changes still require explicit status-change evidence.
A new live node whose status is not "planned" is rejected with reason and diagnostic
code `new_node_must_start_planned`. Its path is a JSON pointer into the submitted
arguments, like the other apply diagnostics, such as `/input/plan/nodes/0/status` or
`/input/plan/nodes/1/nodes/0/status`, using only structural indexes. A node inside a
workflow that the service expanded (no submitted nested `plan`) is reported at its
nearest submitted ancestor, such as `/input/plan/nodes/1`; a node whose omitted status
the service inherited is reported at that node. A status change without
`status_changed` evidence is rejected with `missing_status_changed_evidence` and a
pointer to the changed field: `/input/status` for the workflow document, or the same
node status pointer. Other plan rejections keep `invalid_plan_or_missing_status_evidence`.
Acceptance is unchanged; only the feedback is precise. The diagnostic `expected` text
is a fixed instruction and does not echo submitted names, descriptions, or IDs.

After authorization, a malformed local step may return the existing
`pinned_definition_context_mismatch` reason with an additional `diagnostic`:
`{code, path, expected}`. The path identifies the field using fixed names and
numeric indexes, such as `/input/plan/nodes/0/definitionId`; expected guidance is
static and never echoes submitted names, descriptions, paths or IDs. Correct the
indicated shape and retry with fresh workflow state. Invalid shape attempts do not
reserve the operation ID. Unverified callers, raw request-shape failures and
unrecognized policy or pin failures retain their existing results.

An evidence entry may include optional `sourceThreadId`, `sourceRunId`,
`sourceMessageId` and `sourceItemId` references. They are exact opaque native IDs of
up to 1,024 characters, separate from the 200-character operation-ID bound; a rejected
evidence field returns `evidence_reference_invalid` or `evidence_entry_invalid` with its
position and field name, never its value. If a reference is supplied without
`sourceThreadId`, the controller uses the target workflow's thread. That thread must
be the owner's main or a verified native descendant in the fresh scope. Run and
message references must carry that exact thread identity in its current projection;
item references are checked through `orchestration.getTurnItem`. Supplied run IDs
must agree with any supplied message or item. A message and item may be combined
only when their run identities agree. A native child command can have no run ID, so omit
`sourceRunId` when the referenced item has `runId: null`. A write may include at most
16 activity references across at most 8 source threads. Reference reads that are
temporarily unavailable leave the write pending; malformed or out-of-scope
references are rejected. These references help the user navigate to observed
activity; they are optional and do not prove that a status is semantically complete.

Copy supplied activity references verbatim. For an item, use only
`{sourceThreadId, sourceItemId}`; for a message without an item reference, use
`{sourceThreadId, sourceMessageId}`. Add the evidence kind and note without copying
an optional run ID. Opaque IDs must never be decoded, re-encoded, normalized or
reconstructed. A helper check-in's frozen rows (its `workflow_read` view `request`
envelope) supply ready references for eligible records in their bounded preview;
omitted records require fresh bounded native reads.

Each write includes `supervisorThreadId`, `bindingGeneration`, a stable unique
`operationId`, and the complete action arguments. The first two fields locate the
binding to verify; they are untrusted claims. Expected revisions prevent parallel
edits from silently overwriting each other. On uncertain delivery, retry identical
arguments with the same operation ID. Different content needs a different ID.
IDs are scoped to the owning Supervisor binding and edit namespace; another owner
can use the same string independently. Validated agreement imports have a separate
namespace, so edit IDs cannot block their history.

## Write authorization

The service derives project/main scope from the current ready Supervisor binding.
It verifies an actual native `dynamic_tool` item in that Supervisor's own main run,
then reads complete input through T3's existing `orchestration.getTurnItem` API.
The run, thread, provider thread, strong native reference and own main-node graph
must match, with no parent item or non-execution marker. The supported native routes
are a closed list, read by one resolver for evidence, re-validated receipts and read
coverage: the provider-native direct names of each configured server alias, by default
`t3-supervisor-workflows` (`<alias>.<tool>` and `mcp__<alias>__<tool>`), and a call through
one of the configured gateway call tools, by default `mcpx.mcpx_call_tool` or
`mcp__mcpx__mcpx_call_tool`, with exactly `{name: "<alias>__<tool>", arguments}`. T3's
own thread reads, by the Supervisor and its helpers, are recognised on its `t3-code` direct
routes and through the same configured gateway call tools naming exactly
`t3-code__t3_thread_read`. Any other client alias, gateway call tool or envelope is
unsupported: its call is denied as unrecognised even when its arguments match. No name
is matched by prefix, suffix or argument shape, and another gateway's routing cannot
prove provenance. Portability across clients is therefore partial
until a further route is declared and reviewed; if T3 publishes a structured MCP server
identity on tool items, routes should bind to that instead of names. Instructions name
operations and tools only, with one neutral reminder that a connected gateway may expose
a tool that is not listed directly. The full structured object input must equal the
complete submitted arguments. The
provider driver is retained as bounded audit metadata; it does not decide whether
the record can prove the call. Any provider can pass the same gate when T3 exposes
the exact strong native item and its owning main-run graph. An unrecognized native
tool name is denied with a bounded observed name only after the item's complete
ownership and execution checks pass; its arguments never grant authority by
themselves. This nonretryable denial is returned after the bounded evidence wait.
Model selection still comes from T3's live catalog, and no separate
Supervisor model configuration is required. The ordinary agreement/dialogue path
remains separate. Only the root that owns the main workflow may use
`assess_contribution`; a helper or any other actor is denied with
`contribution_assessment_root_only` before its proof is considered.

Quoted JSON, ordinary messages, code-mode script text, empty placeholders,
truncated strings and tool calls in another conversation or a native child cannot
authorize an edit. Optional activity references do not change this authority gate.
Static provider credentials and gateway tags do not identify a thread. The service snapshots verified evidence and the operation outcome
atomically, with a final owner/generation/effective-enable check. Exact authorized
replays retain their original result; conflicting operation/evidence reuse fails.

Fresh coherent native active/archive inventory establishes ancestry. Independent
launches and forks are separate scopes. The target workflow and any new
contributors must belong to the owner's scope. Existing participation is retained
on the same stable step ID, including after a child is archived or deleted; it is
historical association, not a claim that the child is still active. Adding a child
to another step is new participation and requires a live descendant. Archived,
nondeleted descendants retain their workflows; new links require live children.
Archiving the main suspends the scope.
Native evidence and lineage are fresh point-in-time reads before the local commit;
there is no atomic transaction with T3, so a concurrent native rollback/archive can
race those reads. Disabling
supervision or replacing the Supervisor blocks old writes while retaining workflows
and history. Settlement preserves the binding for reuse.

Tool recording can lag behind the HTTP request. Missing evidence returns a bounded
pending result and leaves the workflow unchanged; retry the same arguments later.
Unverified intake cannot reserve an authorized operation ID. Input/history limits
fail explicitly rather than silently dropping requirements or history.
Write arguments cap at 192 KiB UTF-8; native detail must remain a complete object
within its 256 KiB limit. Snapshot summary strings only locate candidates and
never authorize them. Store documents cap at 512 KiB UTF-8 and 500 history entries;
there is no history compaction in this foundation. Oversized single-document reads
fail explicitly instead of returning an empty page that cannot advance.

## Verification boundary

This mechanism assumes the integrity of T3's provider-derived history under the
existing non-hostile same-user scope. It is not an OS isolation boundary against
an actor who can alter the local T3 database. Every write requires complete per-item
evidence: missing or weak native references, incomplete/truncated inputs, or
incomplete run graphs remain pending or denied regardless of provider identity.
No T3 source, installed app/server, startup script or initial dispatch path is modified.

The workflow-editing foundation does not add automatic child check-ins, per-step
execution proofs, a task scheduler, or a pre-first-tool negotiation barrier. The
separate progress view and current delivery timing and child-routing limits are
documented in [project supervision](project-supervision.md). Initial guidance can
wait while T3 prepares a target turn, but no gate guarantees that it arrives before
a tool starts. Consult T3 Lab's three maintained tracking documents for source
checks, remote review, staged VM evidence and the installed revision.

## Supervisor team authority and messages

The Supervisor team is separate from operational workflow lineage. The root manages
membership, assignments, shared policy and its main workflow. A registered helper's
native calls are checked in that helper's own conversation and against its effective
assigned child subtrees. Root calls, supplied identities, titles and claims in
message text do not stand in for helper evidence. Helpers cannot recruit members,
change the main workflow or agreements, or edit shared policy.

The root sends helper context notes and routine check-ins through Supervisor team
operations, which record and dispatch them with durable service identities. It must
not use raw `t3_thread_send` as the routine helper route: that T3 tool can create
another root-attached delegated task. A human who writes directly to a helper in T3
gets T3's native follow-up behavior. An uncertain notification remains pending for
reconciliation; it is not treated as delivered or resent under a new identity.

See [Supervisor teams](supervisor-team.md) for subtree assignment, handovers,
readiness and dashboard presentation.

## Local access and rotation

Dashboard sign-in uses a freshly forged one-time token, valid for five minutes.
Run `t3-supervisor auth forge` as the service account, from any directory. A direct
installation uses the same user state directory for service and CLI; Docker/VM
users run it inside their deployment environment. Custom state paths use the same
DATA_DIRECTORY or `--data-dir /absolute/path` for both commands. The CLI requires initialized
private auth state. The login page shows this exact portable command. Private
SQLite stores token hashes rather than raw codes. Consumption and session creation
commit together, so a successfully used token cannot replay after restart. Independent state directories reject one
another's tokens. The long-lived workflow MCP token remains a separate0600 file
under0700 access, accepted only for MCP transport.

Dashboard grants and sessions share one private access/login.sqlite3 database.
The service and forge command require its current two-table schema. Login consumes
the grant and saves the session in one transaction; a failed session write rolls
back grant consumption too. A successful grant cannot be reused.

New sessions last 30 days and retain their original deadline across service restarts
and deployments. Existing shorter sessions keep their original deadline. Only hashes
and issue/expiry times are stored; the browser keeps the
raw session in origin-scoped localStorage, shared across tabs and browser restarts.
Mac and forwarded VM ports remain separate origins. Storage changes synchronize
sign-in and sign-out across tabs without replaying writes; open drafts stay in their
tab. Sign out durably revokes the session
across service instances and restarts. Only the service initializes a missing
auth database, with both tables together. Existing malformed or obsolete schemas
fail closed and are never overwritten, migrated or recreated automatically.
Experimental formats may change without old-CLI or rollback compatibility.

Do not use T3/provider credentials for these roles. To rotate the MCP bearer,
replace only its file with a fresh canonical32-byte base64url token, restart
Supervisor and update only the matching MCPX header. Dashboard sessions keep their
original expiry across that restart. Preserve all other service state; a volume reset is
never a login recovery method.


Team tools share the authenticated `/mcp/workflows` endpoint. `supervision_team`
reads current state or accepts root register/assign/release/retire/quarantine/note/retry
operations, root-only quarantine, and helper ready/report operations. `supervision_guide` accepts a
helper's in-scope child guidance. Helper locators use their own supervisorThreadId,
root bindingGeneration, memberEpoch and the current assignmentRootThreadId plus
assignmentEpoch. `workflow_read` exposes current per-target coverage; unrelated
assignment changes do not invalidate it. Workflow documents remain rooted at the
main binding when responsibility moves. All mutating calls require the exact
common native evidence contract in the calling actor's own AppRun. Read operations
remain same-user contextual reads, not grants of write authority.

For `supervision_guide`, the service uses a targeted active-only steer on a verified
delegated child. After T3's specific dispatch-command failure, it replays the exact
command once with the original IDs, target and run ID; only a durable definite
rejection allows a fresh route to the nearest eligible ancestor in the same helper
assignment. Accepted sends, generic server failures, timeouts and lost responses do
not change route. Cross-assignment or unavailable fallback raises root attention.

A root `retry` acknowledges definite helper check-in failures and starts a new
attempt for definitely rejected handover notices when the recipient remains a
current ready helper. Unrelated unknown guide requests stay unchanged and fenced;
failed check-in acknowledgements still wait for unresolved member requests. Retry
cannot reset unknown sends, alter their identities or bypass effect reconciliation.
Quarantine is a root-native-authorized fencing action. It advances the helper
epoch and returns coverage to the root while preserving unresolved requests and
sent notices. The root remains observe-only while those effects are unresolved. Quarantine does not
stop a native helper conversation or any turn already running there. Helper
check-ins use one genuine native T3 webhook job per helper as described in the
team guide. Its private endpoint is never returned by the dashboard or MCP.
