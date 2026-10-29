# Project Supervisor conversations

Each ordinary main T3 conversation has one reusable Supervisor, shared by its
native descendants. Independent mains and forks have independent scopes. Project
model/reasoning defaults come from the live T3 catalog and apply to newly created
Supervisors. Existing chats keep their native controls; unavailable models are
reported rather than substituted. Project-root selection shows defaults, while a
selected main shows its actual binding, requests and recovery controls.

Initial workflow planning waits while T3 prepares the main's workspace. When a
newly bound worktree contains identical definitions, an unsent initial proposal
is refreshed in the same Supervisor conversation with a new interpretation proof.
This does not approve edited policy or replay an uncertain delivery. Automatic
checkout recovery stays held while the operative is interrupted. An interrupted
operative run does not itself disable supervision: use Stop supervision to stop
the pair. Existing agreements keep their source-change checks.

## Definitions and enable controls

Read [steps and workflows](steps-and-workflows.md) for the definition model and
[project definitions](project-definitions.md) for source selection and editing.
The master supervision switch starts on. Per-project initial defaults follow
observed `.t3-supervisor` presence; saved manual choices persist. Unreadable is not
absent. The separate global-definitions switch starts off, even when the folder
exists. Global definitions are additive and namespaced, using the T3 server user's
home. This supplies policy only and never activates No Project chats. With shared
definitions off, No Project uses task-local steps.

No Project has its own Off / On request / Automatic mode in Instance settings.
On request is the default: discovery creates no root or model work for an unstarted
chat. Start permission applies to one ordinary main and persists across service
restarts and Supervisor settlement until explicit Stop. Off pauses every No Project
scope; returning captures a fresh discovery boundary without revoking permissions.
Normal projects retain automatic folder/manual activation.

Home offers eight recent/search results or an exact native T3 link. Dashboard Start
is authenticated human intent. It pins the latest genuine request only while that
request's native run is unfinished; otherwise it starts with the next request.
The agent's supervision_start tool instead cites its own current genuine human
message. Exact native caller/tool/run proof is mandatory. The Supervisor's first
interpretation returns an independent startRequested verdict before any operative
contact, workflow writes, helpers or monitoring are permitted. A negative or stale
verdict never activates. Stop and mode/source changes fence pending interpretation;
unknown native identities are reconciled and never replaced by a fresh send.
Start operation receipts and permissions use the existing guidance database.
Settings shows relevant explicit exclusions and bounded search-to-add, retaining
hidden/unavailable exclusions. Stop provenance appears in Home and the conversation;
Home's Review and enable opens the exact scoped control.

Discovery handles the chats whose latest run changed first, oldest request first,
up to twenty per cycle; the remaining slots of the cycle come from the ordinary
rotation over the catalog. A chat anchored in the activation baseline whose latest
run has not changed costs nothing, however many such chats the instance has. A
changed chat is offered once per run lifecycle T3 reports (the run, its activity
status, its start and completion): a chat skipped because its project is off or its
Start is pending, or deferred because its workspace is still preparing, takes no
discovery slot and is offered again exactly when T3 reports that lifecycle moved on,
so a preparing chat's ready transition keeps its priority and no set of skipped chats
can starve the rest. The service logs one `supervisor_discovery` event per cycle that
found fresh requests or attempted a discovery, with counts and the cycle's duration
only.

Disabling stops new service-originated interpretation, introductions, check-ins
and recovery sends. It preserves chats, bindings, requests and agreements; a
running native turn may finish. Re-enabling captures a discovery boundary instead
of replaying all work submitted while disabled. A request to pause implementation or
return to discussion instead keeps supervision enabled and quiet on the same task.
An explicit Stop Supervisor still uses the durable disabled fence.

First setup selects an exact checkout/branch. Create writes only the new
`project.yaml` (`workflows: []`, then `steps: []`), `steps/.gitkeep` and `workflows/.gitkeep`. Create +
commit requires a clean safe Git state, no in-progress operation/lock, fresh native
Git preflight and the separate commit/probe grants. It never switches branches,
initializes Git or stages unrelated files. Native Git can reset the index, so
cleanliness must be checked immediately beforehand. Hooks/signing can change the
result or leave files staged; uncertain results require inspection, not replay.
Native filesystem/Git actions are not atomic against external changes. Enable
existing definitions adopts the selected checkout without writes or commits.

## Interpretation and working plans

A qualifying new main task is derived from bounded native web/mobile user-message
provenance. Scheduled/imported/MCP-originated requests remain outside automatic
initial interpretation. User/tool quotations, private reasoning and arbitrary
agent-selected excerpts do not establish task authority.

Project settings has one exception, **Supervise conversations created by agents**,
off by default and saved per project. When on, an ordinary main that T3 created
through its MCP server (native `creationSource: mcp`, an independent root, not a
delegated child or fork) is supervised for requests from the agent that launched
it: the sender of its opening request (`createdBy: agent`, `creationSource: mcp`,
`senderThreadId`). That sender must still be an active T3 conversation outside every
Supervisor's lineage. Only such requests written after the setting was turned on
count, so enabling it never sweeps up earlier launches; turning it off again makes
an agent-sourced task no longer current. Other agents, Supervisor roots and helpers,
anything they delegated, scheduled or service prompts and imported messages never
become tasks. The interpretation context names the launching conversation
(`requestedBy`), and the request is never presented as a human's. Human-created conversations are unchanged. While off, the chat origin remains excluded even after genuine human follow-ups.
While on, the exact launcher and genuine humans can request work in an eligible
ordinary main. The setting governs conversation eligibility: Start, Stop and definition approval still require a
genuine human message, and No Project modes and exclusions still apply.

The Supervisor interprets the latest genuine request together with earlier unresolved
requests in the same main, such as an issue link that did not yet establish an
objective; a bootstrap, setup or recovery instruction is treated as a step toward
that request, not its replacement. The interpretation request is a handle: the root
notice with the instructions version, the task, the source message and the reader
coordinates. The root reads its current pins, requester attribution and message handles
with `workflow_read` view `context`, the source messages natively by each handle's exact
`readItemId` (the message's published T3 turn item; a message ID is provenance and is
matched while paging the thread's messages only when T3 has not published the item
yet), and the classification rules with view `interpretation`; only when a plan
is needed does it read the plan rules (section `plan`), the `project.yaml` index (each
entry's id, name, summary, required flag and members by ID) and the complete
definitions it selects with `definitionIds`, each once. No body, rule or catalog is
pushed into the request. A summary
is navigation, not policy. The operative's proposal read says that
`.t3-supervisor/project.yaml` is the index and to read the listed full files
it needs. The index is not a whitelist of task plans; negotiated local steps
remain available. A manifest too large for
one request keeps the reader and shrinks to member counts, then to a prefix of IDs and
names, stating what it omitted.

The existing task document retains a bounded understanding: objective, constraints,
open questions, findings with actual conversation references and draft high-level
duties. This quiet draft is separate from the operative proposal. Following sends
no routine introduction or acceptance chatter to the operative. Internal observe-only
check-ins follow actual work, including the final activity needed to assess completion.
A temporary `not_needed`
assessment does not close the task; later eligible requester messages are interpreted
on the same task. Operative activity supplies bounded context rather than a model
turn for each tool event.

Participation requires a source-verified requested outcome and prose limits.
“Investigate the incident and report the cause; do not fix it” authorizes a research
workflow. “Let's discuss causes before deciding; read what you need” stays quiet.
A direct first action request can authorize participation immediately, with no extra
confirmation. “Yes, implement that” must bind to actual earlier content in this main;
operative findings can describe the proposed fix but never grant authority. Sources
retain human or launching-agent provenance. A launching agent cannot lift a human
pause. Human-only Start, Stop and definition approval remain separate.

Plans are proportionate. Before reading the catalog, the Supervisor decides whether a
plan helps at all: quick routine work, such as bringing a checkout up to date or
rerunning a documented refresh, is `not_needed` with no workflow, so there is no
proposal, acceptance or Supervisor message, and Task shows No plan needed. Otherwise the
plan holds only the commitments the task needs. Catalog entries that do not serve it are
absent rather than listed as not applicable, even when none applies, and task-local steps
are added only where they help. A workflow is referenced only when its composition fits;
the first proposal can already omit members of a flexible workflow, each with a reason. A required definition is assessed against its own
described applicability; being required never adds it to a plan where it does not apply.
Whether files are tracked or ignored does not by itself decide that a review applies or
not. When the operative says agreed commitments are unnecessary, the Supervisor promptly
publishes a smaller revised proposal, and completed work stays recorded.
Start rejects an excluded agent-created origin before reserving pending permission;
turning that opt-in off also rejects an unprepared pending Start. Stop remains available.

The public read model derives `following|engaged` from those persisted facts and
exposes availability separately. **Following the conversation** appears only for a
current, enabled, available scope. Catching up, stale, uncertain, stopped or
unavailable states show their own truthful label. Agreement and execution assessment
remain independent. Neutral updates retain authorization; explicit pause returns to
following without deleting the agreement, occurrence IDs or valid progress. Same-scope
resume preserves acceptance. A changed outcome gets a new scope revision and realigns
affected commitments. Newer requester messages defer obsolete decisions and writes.
The original scope sources remain pinned across same-scope resume; the resume has
its own state source. A retained plan can receive its first introduction after a
pause or neutral update only with the same recorded authorization revision and
fresh, unchanged native submission evidence. A changed scope cannot reuse that
proof. Missing revision evidence stays held for explicit replanning.
Agreement acceptance rechecks the requester watermark after its evidence reads.
An active human turn in the Supervisor takes priority over service wakes; terminal
human turns, including interrupted or failed ones, release that hold. Quiet or stale
tasks still reconcile uncertain delivery identities without dispatching fresh work.

The Supervisor receives the task, source identity, readable step/workflow material,
configuration and diagnostics. Valid definitions support a source-bound proposal.
Malformed, cyclic, missing or incomplete material remains explicit; it does not
disable the Supervisor agent or become an empty valid policy. A finite provisional
plan can be discussed while unknown fixed/required commitments remain outstanding.
The agent cannot claim a broken workflow has executed merely because it names it.

Plans preserve nested sequence/parallel groups, named workflows, local/reusable
steps, descriptions and provenance. Each occurrence has a stable identity distinct
from its template ID, so repeated references retain separate status/contributions.
Requirements are accounted for once per current main task, including recursive
inclusion. Child contributions may overlap and expand several parent steps into a
personal workflow; completion does not automatically roll up to the parent.

Branches are agreed alternatives under one short condition. The introduction shows
each branch's node ID, condition and indented paths, and gives the operative a
concrete `branch-selection` record to write when work reaches the branch. The
operative decides from the actual context without asking for approval; the
Supervisor objects only to a concrete contradiction or an explicit human instruction.
A child records the decisions of its own connected workflow. Task shows a pending
decision as current work, the selected path with its reason, and the other path as
not selected; undecided and not-selected steps are not counted as outstanding.
A selection never proves work, and a completion recorded before a changed decision
is shown as needing reassessment. See [branch selections](workflow-mcp.md#branch-selections).

A return (`back_to(n)`) repeats earlier work as a new attempt. `n` is that return's
maximum number of successful jumps, an integer from 1 to 99. The first pass consumes
none. Each occurrence has its own budget, including two uses of one workflow, and a
preserved node keeps that budget when it is reordered or retitled. When the operative's work
reaches it and jumps remain, the region from its target through the member that holds it waits for the
Supervisor, which applies the return at a safe point once the closed attempt's work has
stopped. Once `n` jumps have been applied, the unresolved failure stays visible and
another jump does not start. An applied return resets only budgets whose replay region
is strictly inside the region it reopens. Right after a return every repeated member
is planned again, so the task page names the return's target (a step or a workflow)
as ready to start until work in its own region begins, beside any unrelated lane that is
already active; when a later return reopens an earlier return's target again, only the
later frontier is ready. An outcome recorded on a path that is no longer selected or
awaits a decision again is shown as earlier history without a live tone, and a pending
decision whose earlier work is not yet settled is shown as not yet reached, in neutral
tone, until it is. Each repeated occurrence and the branches inside the region keep a
collapsed "Previous attempt n", numbered per occurrence like History, with the status,
contributors and decision (revision, reason, source) the closed attempt ended with; the
decision's reason and source travel with the return record itself, so they outlive the
bounded recent branch events. History lists the records of one
write under one headline, in stored order and never merged, and a record that changed
no status is never the headline. The closed attempt keeps its statuses, contributors, decisions and retired
child runs as history; the reopened occurrences keep their contributor conversations
and show their attempt. Output of the closed attempt never counts for the new one.
See [returns and attempts](workflow-mcp.md#returns-and-attempts).

Required controls inclusion; an applicable required item must be on every path of a
branch to count as included. Fixed preserves original commitments, relative order,
parallel relationships and branches with their conditions and paths. Added work may
appear between fixed members or inside a branch path. Description
text carries applicability, instructions, expected results and whole-workflow
delegation/iteration guidance. The role distinction between main coordinator and
assigned reviewers avoids recursive delegation. No semantic keyword launches an
agent, schedules a task or proves successful execution.

## Dialogue and agreement

Startup is compact. The initialization turn only confirms the service-prepared
proposal by echoing its exact reference `{taskId, proposalId, digest}`; definitions
stay available through `workflow_read`. The introduction outline names each member once;
nested workflows without a branch are one line. It points to the `project.yaml` index
instead of copying the references and skills of the plan's definitions, because each
definition file carries its own. Every notice points to a proposal the service has
already recorded: the first one once the interpretation is recorded, and a revision the
Supervisor publishes in its completed answer once that answer is recorded as the
proposal's candidate. The service delivers each notice once, under its own message
identity, and the Supervisor sends no notice of its own. A revised proposal for a
changed scope whose plan, definitions and requirements are unchanged is noticed as such
with its new acceptance record; a revision of an agreed plan names the agreed proposal it
replaces, and its read shows each member, omission and reason. The Supervisor does not
repeat an acceptance request while the operative turn that received the proposal can
still answer it. The operative receives a short event: the proposal and task, whether it
is provisional, the step it is asked to take, the exact `supervision_plan` call and the
contact route. That call returns the complete current proposal: the agreement contract
(no approval step or authority; the Supervisor cannot block tools), the objective and
limits, the `.t3-supervisor/project.yaml` entry point, the outline with task-local
duties and the acceptance record. The operative reads it on demand, also after
agreement, and asks its Supervisor for the outline only when it cannot call the tool.
Every root message carries one notice, the binding fences and the instructions version,
never the rules: the root reads its core, the section index and the sections a message
names (check-ins name `monitoring` and `contact`), and rereads only sections whose
version changed; task context, definitions and dry-run checks are pulled on demand.
Each check-in row has one activity list with exact native read handles, a contact route
code and, once per task, its identity, revision pins, proposal identity and state,
agreement state and attention codes; digests and diagnostics are read with view
`context`. Oversized requests stop before delivery with a visible
reason in the conversation's Task view; pending activity and uncertain delivery identities remain
intact. Retry stays explicit. Blocked startup also stops automatic definition review
and renewal until Retry. Readable definition changes during healthy startup, including
invalid or missing definitions, remain pending context work.

The service initializes the Supervisor's context before introducing a validated
proposal. When the main is idle, queued delivery starts a normal new turn on the main. When
the main has a steerable running turn, the initial proposal targets it with active
steering; a definite rejection uses the existing queue fallback. If the main is preparing, starting,
or its running provider turn is not yet ready to accept steering, the proposal stays
in the existing durable Supervisor ready state until a later check. A running status
alone does not prove that steering is available. Unknown delivery is reconciled
against the original effect identity before any retry; it is never sent again under
a new identity. This is not a pre-first-tool barrier: work may already have begun
when guidance arrives. Setup scripts remain deferred.

Ordinary model guidance to the main uses T3's automatic delivery mode after fresh
reads. Delivery can still fail: an unknown result is reconciled with the original
request before retry, while a confirmed failure waits for a new read and later
reconsideration. There is no retry loop. Check-ins, objective/context introductions
and replies from the main remain separate queued Supervisor turns with separate
request identities.
When an owner question or approval is pending, potentially interrupting guidance
waits; the Supervisor never answers or resolves that native request.

The two bound chats negotiate by native messages. A saved agreement requires a
Supervisor proposal in its own completed message and the exact acceptance reference
in a completed, source-linked main assistant message after the introduction. Casual
assent, streaming text, quoted or nested records, tool output or a subagent's message
cannot establish it. Workspace and definition revision are rechecked. Formal agreement requires current, complete, valid definitions; invalid
or incomplete material supports provisional dialogue, not saved acceptance. Stale agreements remain history; changed candidates require new matching
confirmation. An agreement proves agreement, not execution, delegation or compliance.
An initial service-generated provisional record with no plan can initialize
repair dialogue only when its complete shape and current source context match
exactly. It establishes no agreement or source-bound write authority; those require
a later complete valid proposal.

### Compact dialogue records

Only top-level fences count; a record inside an enclosing code block, a blockquote or
an indented block is inert. A Supervisor proposal is a `workflow-proposal` draft:
`{taskId, taskRevision, proposalId, revision, draft}` with optional `objective`. The
draft holds requirement applicability decisions and a plan of definition IDs, local
steps and groups. `taskRevision` and `revision` are the task source and definition
revisions the author observed; a draft authored against another revision is rejected
with the current value, never rebound. The service derives workspace, names,
descriptions, sources and template paths from the trusted context and canonicalizes
deterministically, so `workflow_read` view `check` returns the same digest before
publication. Check writes nothing and gives no acceptance coordinates: a proposal is
published only as its block in the Supervisor's completed final answer, which check
returns until that exact proposal is the current recorded candidate, and only a
published proposal can be accepted. A `workflow_write` apply that changes the main plan
without an accepted proposal is refused with that same next step. A proposal ID is immutable: different content under the same ID is a
conflict. An unchanged proposal is reused by its exact `{taskId, proposalId, digest}`
from view `context`, never rebuilt (a rebuilt draft gets different node IDs); only a
changed plan gets a fresh proposal ID. `objective` restates the task from cited genuine user message IDs and
updates the dashboard objective. The initialization turn echoes the prepared proposal
as a `{taskId, proposalId, digest}` reference.

The operative accepts only with a `workflow-acceptance` fence of exactly
`{taskId, proposalId, digest}` naming a stored, formal candidate; the digest covers
the task revision, definition pins and the whole canonical plan. Short
acknowledgements, prose acceptance, extra fields or a reduced object such as
`{"taskId":"…","mainThreadId":"…","proposalId":"…","accepted":true}` do not
establish agreement. Full canonical records published before the compact protocol
remain valid evidence for their own retained agreements only.

When a completed message's record cannot be used, the task stores one bounded
`workflowProtocolDiagnostic` with role, code, the failing path, the expected shape and
a detail code. A rejected Supervisor proposal is repair work: a due wake carries it
as `protocolRepair`, and without due activity the service sends one focused repair
wake per rejection. After three consecutive rejections the Supervisor stops retrying
and tells the operative once that agreement is blocked; nothing is marked agreed.

Diagnostics follow native T3 order, not clock time. A Supervisor record counts
for the current task source only from the native run of the prompt that gave the
Supervisor that source: the context prompt, or the reinterpretation prompt after
the user edits the task request. A main record must follow the introduction and,
after an edit, belong to a later main run or a later main turn item than any
already shown with the edit. Editing the task request clears the current
diagnostic. Missing or ambiguous native order produces no diagnostic, as does a
task whose context was prepared before this rule existed; agreements are
unaffected.

### External work and returned results

Part of a main-workflow step may be handled outside any conversation the
Supervisor can observe: by an external agent, tool, service or person. The
operative main records it in its own completed reply with an exact
`external-contribution` record: first as `awaiting_result`, then, when the outcome
returns, as `result` in the next revision (or directly as `result` at revision 1
when the outcome is already available), optionally with file, URL, source or
text references. A reply carries at most one revision per contribution, and a
record inside any enclosing code block is ignored. `withdrawn` ends a
contribution. The introduction explains the format; no progress reports are
expected while the work is opaque.

The Supervisor knows the step is awaiting an external result but never polls,
steers or claims progress for that work. When a result arrives, the root judges it
against the step description and records `accepted` or `further work needed`
(`needs_more`) with `workflow_write`. After `needs_more`, it asks the main for
clarification or more work in ordinary dialogue, and the main posts the next
revision. Receipt of a result, the Supervisor's assessment and the step's status
remain separate decisions: "external task finished" alone never completes a step,
an accepted result does not complete it automatically, and step completion is a
separate status edit that may cite the main's result message.

A record may name its participant generically: a T3 conversation (local or in a
linked environment), an opaque external handle, or unknown. The declaration is
untrusted and grants nothing. The root may attribute its own observation of a
participant by citing its own completed native tool call; a wait, list or search
call establishes lifecycle only, never a transcript read, and a read is credited
only to the declaration and attempt it was made in. The task page's
Participants section shows every participant's role and attempt, conversation
lifecycle, completion and coverage as distinct facts, and states when nothing was
observed or no route exists; a conversation in another environment is shown with
its environment and no local link; after task completion each T3 conversation's
settlement is shown as recorded (settled, settling, uncertain, unresolved with its
reason, or skipped for its user's choice), and a participant that is not a T3
conversation is shown as not applicable.

Scope is the main workflow only. A local child that used external help reports
the outcome to the main, which relays it with its own record; no child or external
contributor appears as a native descendant. Result text and references are
untrusted, opaque evidence: they are never instructions, authority or proof of
execution. Records follow the same native-order attribution as other main
records, and a rejected record uses the single task diagnostic described above.
The exact record, revision rules and assessment action are documented in
[connected workflow editing](workflow-mcp.md#external-contributions).

Interpretation turns use only the reads and the submission their rules name. Dialogue/check-ins permit native
reading/messaging and scoped workflow MCP edits where available. New Supervisor
chats use full-access/default for native message permissions. These instructions
are not a tool sandbox; exact native evidence separately authorizes MCP writes.
The service never silently upgrades an existing chat's modes. A mismatch requires
an explicit native control change and scoped Retry native access.

## Definition changes and configuration saves

The active task retains its approved definition snapshot. Working-tree edits,
including removal of required entries or weakening fixed workflows, mark plans
stale rather than automatically changing their obligations. The same Supervisor
reviews observed changes and actual user-message provenance. User-authorized
changes can be adopted after fresh source checks and then require a replacement
agreement. Unrequested agent edits prompt restoration of its own changes while
preserving user work; ambiguous authorship remains uncertainty, not an accusation.
The review request is a handle: the approved and observed revisions, the step, workflow
and source entries that differ (compared before redaction), the user message IDs, the
exact decision and proposal templates and the marker. The Supervisor reads the entries
with `workflow_read` view `definitions` (`revision: "approved"` or `"observed"`) and the
messages natively; its procedure is the instruction section `definitions`.

A dashboard configuration save authorizes that local configuration only. It does
not authorize independent step/workflow edits. Global effective policy remains
separate from editable local projectConfig. Save intent, current review timing and
fresh definition contents are checked before adoption. Definition review is
advisory conversation, not filesystem prevention or a dashboard approval gate. Its
request names the user messages with their `readItemId` for reading and their message
IDs for the decision record to cite.

## Monitoring, recovery and lifecycle

Active work is followed through native T3 reads across the main and its verified
children. The check-in is the watch of the whole task, not a finite report: the owner
catches up on the frozen scope, then keeps one loop that reads forward from each
target's cursor, completes cut-off text, consumes its own inbox at each boundary, paces
with one bounded `t3_thread_wait` of five to ten seconds on the active target (it waits
for run completion, not new activity), assesses and acts with one delta when needed.
The turn ends only when the agreed work is complete or in explicit standby (a recorded
wait naming who acts next), when a wait result names the next action or tells the model to
end the turn, on context rotation, on a genuine human Stop, or for genuine external waiting
that a native watcher reports (never the operative's own running turn). A timed-out wait
while the target still runs is not an ending, however many waits timed out: the Supervisor
reads forward and waits again. An operative run that ended with agreed duties still
planned is not an ending either. Check-in and liveness wakes point at the same endings:
the watch outcome is recorded when the watch ends, not at a fixed per-wake point. Child
lists are metadata, not transcript reads. When T3 requires a yield, the service promptly
continues verified active work. Active following bypasses the idle age/count thresholds
and cooldown, and never steers into a Supervisor's ongoing thinking. One model turn runs
per owner.

The service's fallback covers only a turn that ended anyway: when the main's latest run
completed while the agreed workflow is unfinished and no current wait is recorded, the
root receives one liveness check-in per main run, document revision and parent-reported
native child lifecycle, queued behind any active root turn and never steered into it. A
root turn that again ends without a recorded wait or progress is a new recovery
generation: the check-in is re-armed once per such terminal root turn after the thirty
second cooldown, never twice within one; a recorded wait, a new run, completion, a Stop
or a settled pair keeps it quiet, and no timer or extra monitor is involved. Model
adherence to the watch itself is proved live, not by tests: the fallback bounds a yield
to one wake per generation.

Own inbox: the root reads its own queued messages at the boundaries it chooses (after
each wait, before each record or send) with `t3_queue` on its own thread. What it cancels
is decided from the queued run's native metadata (sender thread and origin), never from
quoted text: only a verified operative-origin run it actually handled with one delta or a
record; service-owned, unknown-origin and unanswered genuine human runs stay queued, a
human's message is handled first, and the service promotes nothing to steer. When
`t3_queue` is not exposed the root discovers it and otherwise states once that its own
queue is not drainable and ends its turn after each read-forward pass, so queued messages
start as normal turns while the service continues active work. A queued message is seen
at the root's next boundary: the wait between boundaries is bounded (five to ten
seconds); the latency of a long thought or tool call in progress is not, and only a human
can steer.

Idle work retains the project age/count thresholds and 30-second fallback cooldown.
Routine and no-plan work stays quiet. Helpers follow only their assigned subtrees;
forks remain separate scopes. Native child lifecycle comes from its direct parent,
not an idle mirror. Finished, failed, interrupted and cancelled runs have priority.
Read coverage records successful native pages separately from explicit assessments;
neither a read nor an assessment proves operative execution. Missing or cut-off
coverage stays visible, and a helper report does not invent an exact read watermark.

Each root monitoring check-in names its request and is pinned when it is prepared: the
binding generation and, per included task, its revision and its main workflow (or the
explicit absence of one). The Supervisor assesses the evidence against the agreed
workflow, records verified status changes, and sends the operative concise corrective
guidance when evidence demonstrates a concrete, actionable mistake or deviation; it
stays silent on routine progress and never invents a correction from uncertainty.
At the end of its turn it records exactly one outcome with `workflow_write` `record_review`
(progress updated, no change, needs attention or insufficient evidence), decided from a
fresh read of the relevant finished messages, results and current workflow: the change
index is navigation, not proof, and no change is never a default. No change never
means the task is complete: when the main has finished its turn while the agreed
workflow is unfinished, the Supervisor records needs attention naming the current
blocker, adding an explicit wait only when the requester or another party must act and
saying what resumes the work. The outcome
is confirmed only when the check-in completed with its marker, the recording call
completed in that check-in's own run and the pins are still current (for no change,
each main workflow unchanged; for progress, each cited edit still in place). Only a
confirmed outcome acknowledges the frozen batch. A missing or unconfirmed outcome is
never read as no change: the batch stays pending and the check-in counts as a miss,
so the next one follows the cooldown and the third consecutive miss requires Retry.
The dashboard's monitoring status shows the last confirmed outcome and the current one
that is recorded, unconfirmed or missing. Recording sends nothing, and an outcome or
guidance is the Supervisor's assessment, not evidence that the operative acted on it.

### Planning pauses

When planning changes what affected actors do next, `supervision_planning pause`
requests a bounded hold for those actors. Each actor must acknowledge its own pause
or be verified quiet; a parent acknowledgement holds its dispatch only. Native or
idle children use a verified parent relay. Unrelated siblings keep working. A
descendant the pause could not hold (unreadable, covered by a helper or beyond the
target limit) stays listed and blocks adoption until a fresh read finds it quiet or
holds it; one that becomes readable while busy is held, never dropped. A held
descendant whose work finished is verified quiet by the release's own fresh read,
never by its earlier reading: a finished child read busy or unreadable again is
awaited again. Its relayed hold is released as a dispatch hold only, with no
instruction to continue; a finished child held directly gets no notice at all, since
a message would start new work; and no workflow is fabricated for it. A child whose
work resumes under `continue` needs its own linked, planned workflow
(`planning_target_unscoped` otherwise); `no_plan` frees it without one.

One project-configurable deadline (default five minutes, ten seconds to one hour)
starts at the first delivery attempt and covers acknowledgement, drafting and
negotiation. Progress and later settings changes do not renew it. An independent
service watchdog releases possibly delivered unresolved holds at expiry, including
when an owner or original send is stuck. No-plan and explicit continue also release
the wait. Human Stops, pauses, limits and approvals remain binding.

The owner may start one new read-only app-owned drafting task alongside the pause,
then register its actual task/thread IDs with `attach_draft`. This worker writes
content only and has no monitoring, workflow-write, guidance or delegation authority.
Its task is the pause answer's `draftInstruction`: the coordinates of its own read
route, never a copy of the plan, rules or definitions. With `supervision_planning`
action `draft_read`, the attempt's pins and its own executed call, before and after it
is attached, it reads view `context` (compact by default; section `conversation` for
the current intent and section `plan` for the current plan: the main's live workflow
while it is bound to the task and its current scope, with its revision and whether its
content is still the accepted plan, otherwise the current proposal, each task-local duty
included), `definitions` and `plan_rules` (the shared plan authoring rules without the
root's pause coordination). No section names the root's interpretation submission
inputs, and a read changes, renews or attaches nothing. Its result queues an owner
notification without steering its thinking; the notification names the exact
`t3_thread_read` of the result's published turn item, and the message ID only as
provenance. The owner
re-reads current work before adoption; adoption waits for the relevant actors.
Ending the attempt cleans up its registered drafting task while retaining unknown
native command outcomes. Late content never renews the pause or publishes itself.

A reached `back_to` that still has jumps left is applied through `supervision_planning apply_return` after
current pause/quiescence checks. The checks use point-in-time native reads taken just
before the commit, the owner's last. A read never waits for another admitted operation
before it is used. While one is in progress, the return waits for it to end and reads
again; after a few busy passes it answers `unavailable` with `return_admission_busy`,
writes nothing, and the identical call can be repeated. Work that starts in the instant
between the last read and the commit is not seen, because nothing is atomic with T3.
The return preserves agreement and starts a new attempt;
real commitment changes still require a revised proposal. Old child runs are fenced
using actual execution IDs. When a native child exposes no independent run ID, the
return is refused rather than treating its shared parent run as an execution ID.
Use supported ordinary reviewer continuations or fresh app-owned delegated passes
carrying previous findings when execution provenance is needed.

Fresh native request state controls waiting: resolved, expired or cancelled requests
clear matching stale waiting summaries, while missing or mismatched evidence stays
explicitly unresolved. A genuinely pending owner request remains pending even if
its run has ended. A helper defers intervention on that target rather than sending
guidance to its ancestor around the owner's decision.

The Supervisor assesses adherence and progress from T3 actions, results and visible
context. Agents work normally without continual status reports. The Supervisor can
inspect a specific result to resolve uncertainty, write a short status explanation
and link supporting activity. A tool result or linked item alone does not establish
semantic completion, and child completion never completes a parent step by itself.
Clarification or changed plans are discussed and reflected in the live workflow.

Direct guidance to a delegated child is limited to a verified active child and uses
active-only steering after fresh scope, lifecycle and contact checks. Terminal or
unknown children are not contacted directly. After a definite rejection or when the
child cannot be steered, guidance goes to the nearest verified, eligible and
contactable ancestor within scope; the main is used only when it is valid and the
guidance remains relevant. Native read-only children receive guidance through their
verified ancestor path. An unknown send is reconciled before considering another
route. T3 can turn a late child steer into a started delivery, so there is no
guarantee that steering cannot wake a child. If that happens, the Supervisor stops
sending to the child and notifies the parent when relevant; it does not cancel the
turn automatically. These routing instructions are not a sandbox around the
model's other native tools.

A human can stop supervision of one chat: from the dashboard's selected-chat Stop
supervision control, by telling its Supervisor directly, by asking the operative to
relay the request with the human's original message ID, or from another ordinary chat
in the same environment whose genuine user message names the exact target chat ID.
The initial Supervisor and helper notices include portable tool-discovery guidance before
their first instruction read. No gateway implementation is assumed. The initial root
notice also requires a stopped service result before confirming Stop and gives the
dashboard fallback when that call is unavailable or denied.
A genuine human message, wherever the service requires one, is the human's own web or
mobile message or the human's answer to a runtime input request of that chat, which T3
records as a server-created message. A message an agent sent from another chat, a
scheduled or imported one, a system or Supervisor command, a service notice or a Stop the
Supervisor itself authored is never human, and the absence of a sender thread alone
proves nothing. Supervisor guidance is never a human limit: the Supervisor cites human
limits by their message, and a Stop it imposes is its own, said so. A failing check or
finding keeps its review duty unfinished: it requires the agreed check or review and the
operative's own correction, prescribes no implementation, locator, type or sanitization
strategy, and adds no hold that is not a genuine human limit or the agreed plan.
The assistant that calls `supervision_stop` judges that a genuine human asked to stop, in
any language; the service does not interpret the words. It verifies deterministically that
the cited message is that human's original native message, that the caller's own native
call belongs to it, and that the message names no second chat (the caller's own, a child
chat or another Supervisor conversation; only the target's own Supervisor conversation may
be mentioned) and, from another chat, names the exact target. When a stop is refused, the
assistant tells the human that supervision was not stopped and points them to the
dashboard's Stop supervision control. A stop dates from the human's instruction: a stop
instruction written before the latest explicit Enable supervision, including a replayed
tool call, never reverses it, and repeating an earlier stop never re-dates it.
The stop is saved in the instance thread policy (the same list as the excluded chats;
adding or removing a chat there is the same human Stop or Enable as the dashboard control),
survives restarts, and only an explicit human Enable supervision resumes it. Enable
supervises the chat's next request: a request written while supervision was stopped, or at
or before a project or global activation boundary, is not interpreted; an interpretation queued
before the Enable is closed unsent; one already sent is never applied or resent, and it closes
only once its exactly matched native run has ended, while an absent or still active native
outcome keeps its identity held (these boundaries are rechecked right before dispatch and
before a result is applied); and the Supervisor reviews nothing until the human writes in the
main again. That next request is interpreted afresh even after an interpreted task, unless the
task's introduction was attempted with an unknown outcome (sending, accepted, uncertain, or
accepted but not found), which keeps the task held; a never-attempted draft or a fallback whose
earlier attempts were definitely rejected is known unsent and does not hold it, and an earlier
request's unsent introduction is never sent after that Enable or boundary. Retry native access never resends an uncertain root check-in or introduction: it
only re-observes the retained identity, so a delivery whose native outcome stays unknown keeps
its pair held, across any Stop, Enable or activation boundary, until that outcome appears or the
Supervisor conversation is replaced. A stop
cancels never-sent check-ins, keeps sent and uncertain delivery identities, and sends no new
check-in or introduction. An explicit Stop schedules one concise operative notice per
Enable period, even before supervision first contacted that main. The notice says to
stop replying to the Supervisor while continuing the task; it never asks for a reply.
Unsent notices are fenced by Enable; accepted or uncertain identities are only observed.
Three visibility misses at least a minute apart park the notice as unconfirmed with
its exact body and IDs. Retry rechecks it without replay; known-unsent blocked notices
can be retried explicitly. Notice wording never asks the operative to resume work.
Historical exclusions are not backfilled. A crash between the separate policy save and
notice reservation can leave a stopped chat without a notice; Stop remains effective.
Notice delivery also runs while supervision is disabled and does not hold settlement.
A genuine human may ask the stopped Supervisor directly, in its own conversation, to
resume. It cites that latest message in `supervision_start`; the service lifts only
that chat's Stop, within the unchanged master and project controls, and the same
binding hands its retained task back at once. A dashboard Enable instead supervises
the main's next human request.
The owned Supervisor settles promptly on the next idle cycle, without the ordinary
60-second quiet window, once every accepted delivery, the
interpretation request included, has a confirmed native outcome; reconciliation of those
deliveries continues, without sending anything, even while project supervision is
disabled. A root check-in or interpretation whose delivery stays genuinely unknown keeps
the Supervisor active; elapsed time never resolves it. In a team the same
observation-only reconciliation matches accepted helper check-ins and notices to their
native outcome, fences requests and notices that were never posted and closes guidance
awaiting a fallback route as not sent; nothing is sent, retried or retired, and each
service cycle observes with a fresh bounded read budget. On an unsolicited wake the root reads current supervision status first;
a stopped root contacts nobody and finishes so it can settle again. The stop
then waits only for a team effect whose delivery is still genuinely unknown (an
unresolved team request, a notice being delivered, a helper request); review-only
events are superseded by the stop. The stop supersedes earlier keep-active
choices for that Supervisor (pin, disabled auto-settle, reactivation); only such a
choice made after the stop holds it. The operative main is never settled or
interrupted because supervision stopped, and other chats keep their supervision.

Quiet completion/archive/deletion can settle the owned chat once children and
pending work are quiet. When the task completed (every applicable member settled, no
pending return), the complete participant set settles with the main, each by its own
command and once: the main's lineage descendants (not forks) and the T3 conversations
the main's contributions declared, locally when a fresh read shows the conversation quiet
and not kept active by its user, or in a linked environment when the Supervisor observed
it and its result was accepted. What cannot settle is recorded with its reason (unreadable,
still working, never observed, result not accepted, or the settle command rejected for
it or its environment), an uncertain command is retried after the quiet window, and a
conversation kept active by its user is skipped. Intermediate review rounds never settle
a reviewer, so a reused reviewer stays available. Participants that are not T3
conversations have no settlement: their completion is the result the main reported. An idle main whose agreed main workflow is unfinished parks only
on an explicit current wait: the latest check-in's confirmed outcome carries a wait naming
whether the requester or an external party must act and what resumes the work, recorded
for the current task after the main's last completed run. Ordinary attention, a stale or
superseded wait, a wait for another task revision or an open external result alone does
not count, and a completed status counts only when every applicable member is settled.
Otherwise `settlementBlockedBy` is `unfinished_agreed_work` and Supervision explains it;
no check-in or message is sent for it. Following, stopped and closed scopes keep their
parking rules. A request cancelled before it started executed nothing, so the
latest executed run decides whether the main finished. The binding records the first
gate that keeps an owned Supervisor active as `settlementBlockedBy`, shown in Supervision.
A following scope may stay open until its new activity is assessed, even when no plan
is needed. An unresolved interpretation starts no check-ins. Activity retained from an
earlier request, or a replaced request's known-unsent draft, stays as history and does
not alone keep its Supervisor open. An incomplete activity scan or an introduction
with an unknown outcome still does.
The service also settles the operative main conversation itself once its work is
finished, as users asked. This happens when the current task needed no supervised
workflow, or when its agreed main workflow is completed: no pending return, and every
applicable member settled. The main, its children and any unassessed activity must
then stay quiet for 60 seconds while supervision of the main is active. A pinned main,
one whose auto-settle is turned off, or one reactivated in T3 stays active; so does a
main with pending input, active children, an incomplete scope or unassessed work. The
first such gate is recorded as `mainSettlementBlockedBy` and shown in Supervision
("Main conversation remains active"); Supervision also shows when the service settled
the main. This settlement parks the main in T3, like a Supervisor's; it is not deletion.
A stop never settles the main.

An idle main's old lifecycle-unknown child can also permit
standby after the quiet period when no known activity, attention issue or pending
input requires action. Unknown work stays unresolved. Background monitoring
continues and relevant activity reuses the same Supervisor identity and binding;
settlement is not deletion or agreement invalidation. A settled Supervisor is never
woken, and its main never contacted, to review backlog, repair old records, recover
definitions or introduce historical work, for example after re-enabling a project or a
chat, or a deployment. Agent and automated activity in the main stays pending; a genuine
human message in the main after the settle (and after a re-enabled project's activation
boundary) wakes the same Supervisor through monitoring.

## Supervisor teams

The root may recruit direct T3 child conversations as helpers when parallel
monitoring would reduce its workload or context pressure. The Supervisor team stays
flat, while each helper may cover several operational subtree roots and their
verified descendants. The root owns the main, shared policy and unassigned work;
helpers assess and guide only their assigned child workflows. Assignment is
monitoring responsibility, separate from operational task ownership and workflow
contributor links. The default helper limit is five per root; the project setting
accepts zero through twenty, with zero disabling new recruitment while preserving
existing members.

Helpers inherit the root's T3 model by default; the root may select another current
T3 catalog model per helper. A helper receives responsibility only after its native
identity and readiness are confirmed. Handover state and affected helper
notifications remain visible while outstanding effects are settled; the root keeps
responsibility until new coverage is confirmed.

The Projects view keeps the root/helpers separate from operational conversations,
and labels child rows with their effective assignee. It reports observed readiness,
lifecycle, assignments, assessments, pending handovers and issues without turning
missing data into root ownership. The [Supervisor team guide](supervisor-team.md)
explains the view and the T3 messaging semantics: direct human messages follow
T3's native behavior, while root-to-helper notes use Supervisor team operations,
not raw `t3_thread_send`.

The progress view is separate from definition authoring, proposals and saved
agreements. It reads current main/child workflows, lifecycle and recent Supervisor
observations without waking chats or changing plans. Missing child workflows,
unavailable reads and incomplete scope are shown explicitly. Activity references
are checked against fresh native scope and activity before storage; they explain
the assessment without granting write authority. Historical agreement snapshots
remain plans, not execution receipts.

Native creation/request identities and owned IDs are permanent recovery evidence.
Retry native access re-observes the original uncertain action; it never resends an uncertain
root check-in or introduction. A confirmed deleted
Supervisor exposes a distinct replacement action; an archived one is restored in
T3. Stop/restart/provider failures do not erase user history; native rollback can
invalidate source evidence. Unknown outcomes stop at the retained bounded retry
budget and do not become confirmed success.

Settings saves use generation checks. Drafts survive conflicts and connection or
authentication failures; reauthentication never automatically repeats a rejected
write. Existing private state, instance settings, ownership and supervision history
survive definition-format replacement. A saved definition snapshot in the
previous configuration shape stays history: it is not migrated or reset, and
fresh context requires a current index read. Old prototype plans are not valid
new-format plans; no migration or broad state reset is required.

Native frames, task inputs, prompt size, response size, queued/lifetime records,
owned identities and workflow documents have explicit bounds. Overflow remains
visible rather than truncating policy. Native chats use T3/provider context
management for project and workflow supervision.
See [workflow MCP](workflow-mcp.md) for exact write authorization, size limits,
receipts and mutable-plan history. Source tests, staged VM proof and actual service
deployment are separate claims; current installed revisions belong in Lab tracking.

## Dashboard updates

The visible dashboard shares one header-authenticated fetch stream at `GET /api/events`.
A connection begins with `reset`; later `invalidate` events contain at most 64 dependency
keys (`snapshot`, `overview`, `project:<id>`, `progress:<project>:<main>`), never rows.
The cursor is process-local. Reconnect and a detected subscriber gap reconcile through
the existing typed reads; no event log or polling fallback is retained.

Successful semantic SQL writes register notifications through the shared client's
`afterCommit`, including nested transactions. Rollback, reads, unchanged task documents,
collection clocks and delivery-observation counters emit nothing. Changes are coalesced
for 20 ms; snapshot-only connectivity changes also publish. Native T3 ingestion retains
its own cadence: SSE removes dashboard polling delay, not upstream collection delay.

The stream shares the dashboard registry and `sessionHttpClient`. Hide, logout, auth
changes and registry disposal release it; visible return opens a connection and reconciles
mounted readers once. Revoked or expired sessions close an already-open stream, including
revocation by another access client. An unavailable revocation watch ends SSE streams
without revoking dashboard or workflow MCP authentication; connection retries still
check the session. Session values never enter URLs. Retry reconnects
with bounded exponential backoff; a 401 clears only the requesting session. Dirty drafts,
admitted mutation IDs, loaded Home prefixes and progress offsets keep their existing
lifetimes. Manual refresh remains available.
