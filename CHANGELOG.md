# T3 Supervisor

## 0.0.14

### Patch Changes

- fd0bbdf: Workflow returns require `back_to(n)`, a maximum of successful backward jumps. An exhausted return stays visible instead of starting another attempt, and an enclosing return resets only strictly nested replay budgets.

## 0.0.13

### Patch Changes

- 8e2fafc: The fixes from the whole-project audit:

  - **Definition changes:** the service owns delivery of the revised proposal. Definition reviews no longer also instruct the Supervisor to send a second copy.
  - **Health endpoint:** a Supervisor started as a plain process now serves `/health` and `/live` on loopback only (`HEALTH_HOST`, default `127.0.0.1`), as the installation guide always said. The container image opens it inside its own network, so a published port, such as the template's loopback mapping, still reaches it.
  - **Applying a return:** check the workflow owner's activity after its contributors, and repeat those checks after waiting for another operation. If the service stays busy, the call writes nothing and asks to be repeated unchanged. Work can still start after the final native observation.
  - **Planning traffic:** an open planning pause no longer re-reads every acknowledged chat each second.
  - **Other server aliases and gateways:** a deployment that registers the workflow server under another name can list it exactly in `WORKFLOW_MCP_SERVER_ALIASES`. A deployment whose agents reach tools through a gateway other than MCPX can list that gateway's exact call tool names in `WORKFLOW_MCP_GATEWAY_TOOLS`, for example `mcp__other_gateway__call_tool`. The Supervisor's workflow calls through a listed gateway are then recognised, and so are its and its helpers' reads of chats. Unlisted names stay unrecognised, and MCPX remains the default.
  - **Retired reminder rules:** the dashboard snapshot no longer carries the retired reminder rules, their settings, mutes or token budget. Stored history is kept.
  - **Documentation:** the docs now explain when the service settles a finished main chat and how to keep it active, and two outdated, installation-specific documents were removed.

## 0.0.12

### Patch Changes

- 2587094: Follow active operational work continuously through native T3 reads, including children under their assigned Supervisor. Add affected-scope planning pauses with actor acknowledgements, a fixed recovery deadline and bounded read-only drafting tasks. Distinguish fetched activity from recorded assessments, show planning waits and settle completed main and Supervisor conversations independently while respecting each conversation’s keep-active choice.
- 4edad18: List project conversations and chat picker results by creation time, newest first, so ongoing activity does not reshuffle them.
- 4de4a6c: A planning writer and the Supervisor now read the current plan, including duties added after it was accepted, together with its revision and whether it is still the accepted plan. The task view no longer calls a plan changed after acceptance accepted: it shows the current plan with its unaccepted steps marked and keeps the accepted plan as a separate record.
- dce344c: Supervisor coordination uses short notices with exact read references. Instructions, source messages, definitions and plans are read on demand; planning, team and guidance replies contain the action's own result. Planning writers can read intent, current duties and shared grammar before or after attachment.

  Routine `workflow_read` calls return compact progress. Request `view: "documents"` for complete history, evidence and accepted snapshots. Chat readers request one run by default, and the dashboard records native read coverage separately from assessments. Ownership, Stop, approval and uncertain-delivery safeguards remain in force.

- 2587094: Workflows can repeat earlier work as a visible new attempt with `back_to`. The destination must resolve to one earlier occurrence in the same sequential lane, and the plan must retain an exit. The Supervisor confirms affected work is paused or quiet before applying the return. The main Plan moves back while History keeps prior statuses, contributors, decisions and results in forward order.

  Reviewers continue in the same conversation when their separate executions can be identified. Late results from an earlier pass cannot satisfy repeated work. Native reviewers without separate execution identities require an explicit replacement carrying their earlier findings. Connected work and History explain which case applies.

  A conversation started inside a supervised chat can now read its own scoped plan through the same plan read the main uses; it still accepts nothing itself. Plan reads include task-local duties and follow the current requester scope. Repeated steps show aligned titles, attempt labels and status badges at wide and narrow widths.

  Revised plans also keep the identity of work already in them. A step inside a referenced workflow keeps its existing ID across proposals, revisions and applies, so its progress, contributors and history stay attached. A step a revision adds back gets the same new ID in the proposal and in the applied plan. Workflow plans and records written before this update keep the IDs they already have.

## 0.0.11

### Patch Changes

- ed2ebed: A Supervisor can no longer mistake a checked plan for a published one. The workflow check used to return acceptance coordinates for a proposal that was never published, so an agent could accept a plan the service had not recorded and agreement silently failed. The check now writes nothing, says whether that exact proposal is published, and until it is returns the exact block the Supervisor must put in its final answer, the only way to publish. The Supervisor's standing instructions state this rule briefly on every turn, later turns no longer suggest the full instructions were already read, and an attempt to change the agreed plan through a workflow edit is answered with the same next step. Acceptance checks are unchanged. The Supervisor is also told concretely to read the conversation from the item references it is given, in small pieces and forward from its last read, instead of rereading whole conversations in large pages, and to send the agent only brief, specific changes or questions rather than copies of plans, definitions or notices the service already delivers. Its full instructions no longer contain a second copy of the short version.

  A stopped chat can also be resumed by asking its Supervisor directly in the Supervisor conversation. The Supervisor cites your latest message, only that chat's Stop is lifted, master and project switches stay as they are, and the same Supervisor continues the current task immediately without waiting for a new request in the chat. Requests written before the Stop, relayed text and older messages are refused, and retrying an old request after a newer Stop changes nothing. Supervisors started before this update learn the new action from the stopped view. The dashboard's Enable keeps its existing behavior of supervising the chat's next request.

## 0.0.10

### Patch Changes

- e926f18: A first proposal that leaves out a member of a flexible workflow now reaches the agent and can be agreed. Before, the Supervisor recorded it correctly but the service withheld it with "The interpreted proposal could not be confirmed from the Supervisor's recorded interpretation; the draft was not sent", because a stored copy listed the omission's fields in a different order. The check now compares the plan's actual values, so any real change to the plan is still refused. The Supervisor also receives much less repeated material: the definitions index is sent once instead of alongside a second copy, selected definitions arrive once each without the index or pre-expanded nested plans, the context view no longer repeats the index, the definitions reader no longer advertises a plan schema it never uses, and an interpretation request quotes each of the requester's messages once. The agent now receives a short notice instead of the whole proposal: it names the proposal and the project.yaml entry point, and the agent reads its complete current plan, including omissions, branches and the acceptance record, on demand with the new supervision_plan tool, which answers only for the agent's own current task and is refused for any other chat, an outdated or obsolete proposal (after the request was edited or the Supervisor was replaced) or a stopped chat. A revised proposal the Supervisor publishes is now delivered too: before, the service withheld its notice with the same "could not be confirmed" error and the agent could not agree it. The service now sends that notice itself, once, only after the revision is recorded, so the agent can read it immediately; the Supervisor no longer sends a notice of its own.

## 0.0.9

### Patch Changes

- 024bff9: Supervisor plans are now proportionate to the work. Before reading the step and workflow catalog, the Supervisor decides whether a plan helps at all: quick routine work, such as bringing a checkout up to date or rerunning a documented refresh, proceeds with no plan, proposal, acceptance or Supervisor message, and Task shows No plan needed instead of a plan that is unavailable or awaiting acceptance. Otherwise a plan holds only what the task needs: catalog entries that do not serve it are left out entirely rather than listed as not applicable, a workflow is referenced only when its composition fits, its useful steps can be reused directly, and task-local steps are added only where they help. The first proposal can already leave out members of a flexible workflow, with a reason for each. Required steps and workflows are still assessed against their own described applicability. When the operative says agreed commitments are unnecessary, it is asked to request a smaller plan instead of accepting, and the Supervisor publishes one promptly while completed work stays recorded.

## 0.0.8

### Patch Changes

- 6b9c8dc: Workflow progress now stays honest and cheaper to maintain. A plan's nested steps are updated together with their workflow and the task, later sequence steps are not marked started while earlier ones are open, a workflow or task is completed only when its applicable steps are, and early drafts or diagnostic runs are kept as evidence on the later step instead of advancing it. A step that does not apply is never shown as completed: a flexible workflow's step is omitted through a plan the operative accepted, and a fixed workflow's step, or a whole workflow inside it, is labelled Not applicable for the current task and holds up nothing after it. The Supervisor can update several statuses in one small edit and read a compact status view instead of resending and rereading the whole plan, and long native activity IDs no longer reject an edit. Introductions list each supporting reference once, and a scope-only change sends a short update with the new acceptance record. When the main chat is idle with unfinished agreed work, the Supervisor stays out of standby unless its last review recorded a current wait for the requester or another party.

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
