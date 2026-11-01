# Testing

This guide says where a test belongs, what each kind of run can claim, how browser
journeys are written and when a test is retired. It ends with the family-level test
inventory and the classification of historical live scenarios. The commands are in
[CONTRIBUTING.md](../CONTRIBUTING.md), the [development environment](local-stack.md)
and the [CI policy](ci.md).

The aim is fewer low-value assertions, a small set of meaningful browser journeys and
replays, and a bounded, repeatable long-run tier. It is not a larger framework: there
is no test-count target and no mutation-testing platform.

## Where a test belongs

Place each invariant at the lowest boundary where it can actually fail:

| Invariant | Boundary | Form |
| --- | --- | --- |
| a pure domain rule: parsing, plan shapes, policy calculations | unit | the production function, `it` or `it.effect` |
| a Supervisor controller or store | production Layers over temporary SQLite files | `it.effect`, with `TestClock` where time is policy; `it.live` for real files and workers |
| native T3, HTTP, MCP and webhook behavior | real loopback sockets and processes with the scripted native peer (`test/support/int-native-peer.ts`) | `it.live` |
| a user journey | a browser over the real Supervisor graph | `test/e2e/`, `it.live` |

Tests import production logic. A support module builds inputs, runs the production
code and observes it; it never carries a copy of business logic.
`test/native-authority-integration.test.ts` is the model for a boundary test: a real
HTTP gate, the stateless MCP route and production-wired controllers reach a loopback T3
peer and temporary databases, and each case asserts the reply, the stored rows and the
native requests per route.

Each invariant family has one primary owner, a layer and a test file, recorded in the
[inventory](#test-inventory). A check at another layer is complementary evidence and
stays only when it can fail differently: a browser journey catches a control that is
missing or sends the wrong request, and a controller test catches a race that no
journey reaches deterministically. A second check that cannot fail differently is a
duplicate.

## Execution types

| Type | Runs | Can claim |
| --- | --- | --- |
| 1. Unit and controller logic | the main suite, with `TestClock` where time is policy | calculations, decoding, state transitions, ordering, timing policy and the atomicity of one store |
| 2. Replays and real boundaries | the main suite: short deterministic runs over the real Supervisor graph (`test/support/startup-gateway.ts`) or the production-wired run with its dashboard and workflow MCP endpoint (`test/support/scenario-driver.ts`), with real sockets, processes and SQLite files and the scripted native peer | how Supervisor answers a given native event sequence: authority, receipts, uncertain effects, no duplicate sends, races committed at a peer hook and the native traffic per route |
| 3. Browser journeys | `./dev e2e`; CI job `browser` | that a user completes the workflow through the rendered controls, and the durable state it leaves |
| 4. Scripted soaks | wall clock over the scripted peer, no model; from increment 5 | service, resource and disconnect behavior over time |
| 5. Published-T3 compatibility | the pinned published T3 with Supervisor (`./dev check`, `./dev up`); no provider | startup, native access and scopes, credentials, MCP transport, persistence, no-contact and cleanup against the pinned T3 |
| 6. Provider trials | the signed-in local Docker profile | actual model behavior |

Types 1 to 4 never reach a real T3 or a model, so they prove nothing about either; type
5 proves nothing about a model. Observations from types 2 to 4 carry the `fixture`
label, type 5 `local stack` and type 6 `provider`
([evidence labels](local-stack.md#evidence-labels)). `TestClock` never stands in for
socket, process, browser or native delivery.

A replay cannot establish interpretation quality, protocol compliance, the message
volume a model attempts, sustained watching and pacing, when compaction happens or what
follows it, real T3 timing under load, or long-run credential expiry. Those claims
belong to types 4 to 6, the bounded long-run tier.

Provider trials:

- Run only locally, in the signed-in Docker profile with its existing private credential
  volume. Never export secrets, and never schedule a trial.
- Start from an uncoached operative request: no seeded agreement, no delayed operative
  and no protocol taught to the test agent.
- Pass only on the relevant observed native event sequence, never on elapsed time alone.
  A budget expiry or "no compaction observed" is inconclusive, and a provider outage is
  unavailable; neither is a pass.
- Record the first edit, the introduction and the completed acceptance separately.
  Inspect rendered prompts, total traffic, repeated messages, tool arguments and native
  event timestamps. Timing is advisory: unmodified T3 has no barrier before a turn's
  first tool.
- Include a trivial no-contact case.

## Where tests run

Duration and credentials are separate questions. A long scripted run needs no
credentials and can run in CI; a provider run needs a signed-in profile, and CI holds no
personal credentials, so provider runs never happen there.

| Placement | When | What | Credentials |
| --- | --- | --- | --- |
| Required PR CI | every ordinary PR, through the `check` aggregate | types 1 and 2 in the main shards, the startup integration, and the browser journeys (type 3) in the `browser` job | none |
| Extended runs | explicitly invoked before a release whose inputs they cover, or when one of those inputs changes; never scheduled | the scripted soaks (type 4) and the published-T3 compatibility runs (type 5), as a manually dispatched CI run or the same `./dev` commands locally | none |
| Provider acceptance | locally, when a change touches what a provider trial covers | provider trials (type 6) in the signed-in Docker profile, through a `./dev` command where one exists | that profile's private volume, never exported |

Extended runs and provider trials arrive with the long-run tier (increment 5). Neither
gates ordinary PRs, and neither becomes a release gate without an explicit decision.

- Inputs that call for extended runs: the T3 pin; the native adapter, envelope and
  protocol reads; restart, reconnect and credential renewal.
- Inputs that call for provider acceptance: prompts and instructions; the provider
  integration and its CLI version; monitoring, the watch and its pacing; compaction
  handling. A targeted trial covers the changed behavior; a broader long run belongs
  before a release that changes these inputs.
- The trigger is a changed contract or input, never a file type. A change of pure
  presentation or wording that agents never read needs neither kind of run; a change to
  provider instructions or to credential or runtime behavior does, wherever its file
  lives, including the dashboard and documentation that agents read.

Each extended or provider scenario reports one outcome from its own evidence: pass only
on its required observed sequence; fail when an invariant is contradicted; inconclusive
when its budget ran out or the awaited event, such as a compaction, never happened;
unavailable when the provider, its credentials or the T3 download were. Elapsed time
alone never passes. Durations and budgets come from measuring the selected scenarios,
not from fixed examples. Every outcome records its inputs (below) and expires with them.

## Isolation and provenance

Fixture tests (types 1 to 4) own their state, ports and processes: temporary folders,
ephemeral loopback ports and scoped child processes, never shared with another test, a
developer's environment or an installation. Where an identity or a time is part of the
policy under test, it comes from the injected id service and `Clock`, seeded
deterministically. `it.live` tests over sockets, processes and a browser run on real
time with identities isolated per test. Published-T3 compatibility runs start their
own disposable stack. Provider acceptance deliberately uses the existing signed-in
profile, but each trial owns disposable projects and actors; it never reuses, edits or
resets a person's everyday conversations.

Record the exact inputs with every live observation: the Supervisor commit and whether
the tree was clean, the T3 pin, the provider CLI version, the model and its settings,
the prompt version and, for a browser, the dashboard asset hashes. Evidence expires
when one of these inputs changes; run it again rather than carrying it forward.

## Browser journeys

`./dev e2e [vitest args]` runs `pnpm test:e2e`, Vitest with `vitest.e2e.config.ts`, in
the separate pinned Docker target `e2e` of `docker/dev/Dockerfile`. Journeys live in
`test/e2e/` and use `@effect/vitest` `it.live`; `test/support/browser.ts` is the scoped
Playwright-library adapter. The browser and the real Supervisor graph run in the same
container on ephemeral `127.0.0.1` ports. The adapter acquires the browser, its context,
its page and each page listener in the journey's scope and releases them in reverse
order; on a failure it first keeps a Playwright trace, a screenshot and the page's errors
under `.e2e-artifacts/` in the checkout, which contain only test-owned sessions that are
already destroyed. Every call into Playwright runs as an effect of the journey's fiber,
in the adapter or the page primitives (`test/e2e/dashboard.ts`), never in a spec's own
frame: Playwright leaves the abort guards of each completed command pending by design,
and the leak gate counts the promises a spec's frame creates. Network faults act only
between the browser and the dashboard, through Playwright routing: a request lost before
the server, a reply lost after the server applied the change, or a forwarded request
whose actual answer the journey records and hands to the page unchanged. The CI job
`browser` is required for full PR validation. The first journey, `test/e2e/chat-stop-enable.test.ts`, stops
supervision of a chat, restarts Supervisor, finds the chat still stopped and enables it
again.

- Walk each meaningful workflow through the UI once. Seed its variants through supported
  APIs: the dashboard API, the workflow MCP tools, the CLI (for example `auth forge`) or
  the scripted T3 at the native boundary.
- An API call may set up state, read state after a click or act as another session. It
  never replaces the control under test.
- Click the actual control. A visible control has not been clicked.
- Wait for the smallest durable visible postcondition, such as the saved state a
  reloaded view shows, then optionally assert backend state. An HTTP response, a toast,
  a loading state or a success message alone is not completion.
- Never fix a flaky journey with sleeps, retries, repeated clicks or broader timeouts.
  When behavior matters and the UI shows no observable state for it, the UI needs that
  state.
- Page helpers are reusable page primitives with semantic role and label locators;
  scenario logic stays in the journey. Never select by framework-generated ids or by
  position (`nth`).

Ten repetitions on each architecture calibrate a pilot journey's flakiness; they do not
guarantee reliability. Run them on native hardware only: ten consecutive `./dev e2e`
runs on a native ARM64 Docker host, and on x64 a manual **Check Supervisor** dispatch of
the branch with `browser_repetitions: 10`, which repeats the journeys in the `browser`
job without retries, stops at the first failure and records each run's duration in the
job summary. Ordinary validation runs them once.

## The synthetic UI fixture

`test/ui-fixture/` serves the compiled dashboard over synthetic API data with stand-in
semantics. It covers client rendering and error handling only and is never an
acceptance oracle for Supervisor server behavior. Journey acceptance uses the real
Supervisor graph: `./dev fixture` for inspection and `test/e2e/` for automated journeys.

## Temporary pins

Characterization and regression files (`*.characterization.test.ts`,
`*.regression.test.ts`) pin behavior across a migration or reproduce a bug. They are
temporary. Each names the durable rule it protects; that rule moves into the owning
suite under a behavior name, or the pin is retired once the rule is obsolete. The file
name is not a value judgment: several characterizations, such as the crash and abort
cases of `test/project-supervisor.characterization.test.ts` and the real-route
lifecycle of `test/workflow-mcp.characterization.test.ts`, are among the strongest
tests. The `characterizationTests` registry in `docs/effect-v4-files.json` records each
ID's original boundary and expectation.

## Pruning

- Prune in the same accepted increment as the replacement, never before it.
- For a high-risk replacement or a pilot, plant one realistic fault in the production
  path the tests protect, run the focused old and new tests, record which of them fail
  (the new ones must), and remove the fault. For the Stop/Enable pilot, a Stop kept only
  in memory and lost on restart is such a fault. The full suites stay with CI.
- Pure duplicates, obsolete prototype behavior and natural-language cosmetics may go
  with a recorded reason and the test that now owns the surviving invariant.
- Always keep the coverage of authority, persistence, uncertain effects, actor scope and
  races.

Record the reason and the surviving owner in the PR and in the inventory row.

The chat Stop/Enable pilot's comparison (native ARM64 Docker, the selected old cohort of ten
cases, each fault applied to a scratch tree and removed again) is the measured example:

| Planted fault | Selected new case | Old cases that failed | Owner of the invariant |
| --- | --- | --- | --- |
| an unconfirmed change is resent automatically | reply lost after apply: fails | 1: CT-UI-API-01 shows the duplicate POST | the API client's no-replay contract; the journey adds the end-to-end wiring |
| an unconfirmed change shows the requested state | request lost before the server: passes | 1: the panel atom test misses its confirming read | the atom test; the journey cannot see it, because the chat panel's live read reconciles the view with the saved state once the change settles |
| the policy lives only in process memory | restart and reload: fails | 3: both CT-POLICY-01 concurrent-store cases and the excluded-chat persistence case | the store tests; the journey adds the clicked, restarted and reloaded path |

Every other fault and case combination was not run. All three old owners stay; the pilot
removed only three server-rendered markup assertions that the journeys now make by role
and name.

## Prompt contracts

A prompt test may protect the composition of genuinely shared fragments; tool, action
and field names; actor boundaries; source handles; budgets; and sensitive exclusions. An
exact English sentence proves only that the text is emitted, not that an agent follows
it. Safety behavior is proven by controller and replay tests or provider trials. Do not
build a parser of English prompt or reply text.

## Running tests

CI owns the complete main, harness and browser suites ([CI policy](ci.md)); extended
runs and provider trials follow [where tests run](#where-tests-run). While editing, run
focused files in Docker, for example `./dev pnpm test test/config.test.ts` or
`./dev e2e test/e2e/chat-stop-enable.test.ts`.

## Increments

| Increment | Scope |
| --- | --- |
| 1 | this guide, the chat Stop/Enable browser pilot and the `browser` CI job |
| 2 | prompt contracts |
| 3 | real-graph UI journeys; pruning of server-rendered markup and UI assertions those journeys own |
| 4 | replay consolidation; folding migration pins into their owning suites |
| 5 | the bounded long-run tier: explicitly invoked extended runs (scripted soaks, published-T3 compatibility) and local provider acceptance |

These increments change only tests, CI, replay and contributor tooling, so none of them
carries a changeset, version or release of its own. When a new test reveals a product
bug, its fix carries a patch changeset, and the batch's fixes ship together in one patch
release at its end.

## Test inventory

One row per invariant family; files are under `test/`. A disposition is keep, migrate in
increment N or retire. "To classify" marks an owner that is not decided yet.

| Family | Invariant | Primary owner | Complementary evidence | Disposition | Notes |
| --- | --- | --- | --- | --- | --- |
| Chat Stop/Enable | A chat's Stop persists across a Supervisor restart, and only an explicit Enable resumes supervision of that chat. | browser: `e2e/chat-stop-enable.test.ts` for the clicked journey, the restart and reload, and the visible outcome of a lost reply, a lost request and a refused CSRF token; each lower invariant keeps its own owner: no automatic resend, the API client's no-replay contract (CT-UI-API-01, `project-supervisor-ui.characterization.test.ts`); the confirming read after an unconfirmed change, the panel atom test in `project-supervisor-panel-atoms.test.ts`; persistence and compare-and-set, `thread-policy.characterization.test.ts` (CT-POLICY-01) and `thread-policy.test.ts` | `project-supervisor-ui.test.ts` (the section's rendering and the stale selected-chat guard); server: `stop-linearization.test.ts` (CT-LIN-02, CT-LIN-03), `supervisor-conversation.test.ts` | keep; three duplicate markup assertions removed in increment 1 | planted-fault comparison below; UI-STORY-07 step 4 |
| Global and project supervision control | Each switch (global, project, shared definitions, No Project mode) changes only its own scope and persists; project setup captures its native boundary before writing. | controller: `supervisor-control.test.ts` | browser: `e2e/supervision-switches.test.ts` for the clicked Disable and Enable of the global and project switches, each changing only its own scope with one change per click, across a restart and a reload; `supervision-controls-atoms.test.ts` (one admitted change against the shown generation however often it is started, and a result for another project left unconfirmed); `supervision-controls-ui.test.ts`, `supervision-controls-ui.characterization.test.ts` (CT-UI-SETUP-01), `ui-ux-boundaries.test.ts` | keep; journey added in increment 3, which removed the markup assertions it now makes: the master switch's Disable label (`supervision-controls-ui.test.ts`) and the global and project status labels (`ui-ux-boundaries.test.ts`) | UI-STORY-07 steps 1, 2 and 4; no controller case drives the master switch's Enable through `saveControl`, so the journey alone sends it through its native enable boundary; setup, shared definitions and No Project mode have no journey |
| No Project Start and its fence | A dashboard Start is sent only under a persisted fence; an unknown outcome keeps the fence across reload until a status read reports a terminal result, and no Start is replayed. | client: `no-project-atoms.test.ts` (CT-UI-START-01) | `dashboard-lifecycle-atoms.test.ts`; server operation identity: `project-supervisor.characterization.test.ts` (CT-PS-04, CT-PSS-01), `project-supervisor-store.regression.test.ts` (CT-PSS-08), `project-supervisor-admission-authority.test.ts` | keep; journey in increment 3 | activation by the interpretation's verdict is in the interpretation family; UI-STORY-03, UI-STORY-07 step 3 |
| Configuration editor save | A save writes only the checkout's own `project.yaml` against the loaded revision and never retries an uncertain write; after a conflict or an unconfirmed outcome the editor keeps the draft and blocks saving until a refresh. | controller: `project-config-editor.test.ts` | `project-config-editor.characterization.test.ts` (CT-EDITOR-01, CT-EDITOR-02), `definitions-lock-order.test.ts`, `project-definitions-ui-atoms.test.ts`, `project-definitions-completion-atoms.test.ts`, `project-definitions-ui.test.ts` | keep; journey in increment 3 | CT-EDITOR-02 and TR-EDITOR-02 in `project-definitions-service.test.ts` pin the same rule; UI-STORY-01, UI-STORY-04 |
| Definitions catalog | Definitions parse strictly, within structural bounds, from the selected folder and the enabled shared scope; invalid, incomplete or unreadable collections stay explicit and never read as an empty policy. | unit: `project-definitions.test.ts` | `project-definitions-service.test.ts`, `project-definitions.characterization.test.ts`, `supervisor-global-definitions.test.ts`, `definition-references.test.ts`, `workflow-branches.test.ts`, `project-definitions-ui.test.ts` | keep | CT-PD-02 and TR-PD-01 pin the same load deadline |
| Project setup, Git probe and commit | Create writes only the scaffold files; Create plus commit stages only those paths after a fresh Git probe, and a commit with an unknown outcome stays uncertain. | controller: `project-definition-initialization.test.ts` | `git-probe.test.ts`, `git-probe.characterization.test.ts`, `project-committer.test.ts`, `project-committer.characterization.test.ts`, `native-files-service.test.ts`, `checkout-observation.test.ts` | keep | a probe through a real T3 terminal is a manual gap |
| Definition change review | A definitions change counts as authorized only with an exact native user message and a complete stored snapshot; nothing else implies approval. | unit: `supervisor-definition-review.test.ts` | `supervisor-definition-decision.test.ts`, `supervisor-conversation.test.ts`, `project-supervisor-ui.test.ts` | keep | its procedure text is a prompt contract (increment 2) |
| Dashboard sign-in, session and CSRF | The dashboard admits only its loopback Host and Origin, a valid session and a current CSRF token; the browser shares one session across tabs, signs out everywhere and never repeats a refused or unconfirmed mutation. | boundary: `guidance.characterization.test.ts` (CT-UI-01, CT-UI-02) | browser: `e2e/session-ends-during-save.test.ts` for a Supervisor settings save held while another tab signs out: this tab asks to sign in again and keeps its draft, the refused save stays unconfirmed after re-sign-in, nothing is sent again and one explicit Save saves; `guidance-ui.test.ts`, `browser-access.test.ts`, `browser-access.characterization.test.ts`, `ui-read-auth.test.ts`, `dashboard-shell-atoms.test.ts`, `project-supervisor-ui.characterization.test.ts` (CT-UI-API-01); the classification of a refusal after the browser's resend and of a server-only expiry or restart stays with `project-supervisor-panel-atoms.test.ts` | keep; journey added in increment 3, which removed the Sign out `disabled` markup assertion it now makes (`dashboard-shell-atoms.test.ts`); pins folded in increment 4 | UI-STORY-03, UI-STORY-05 |
| Dashboard reads | Snapshot and overview reads use retained state, make no native write or operate call, page within bounds and never invent completion. | controller: `dashboard-overview.test.ts` | `project-supervisor.characterization.test.ts` (CT-PS-08), `guidance.test.ts`, `guidance.characterization.test.ts` (CT-APP-01, CT-APP-03), `overview-atoms.test.ts` | keep | |
| Event stream | Each visible registry holds one authenticated stream of committed-change hints that starts with a reset and closes on revocation; reads refresh on hints, not on a timer. | boundary: `dashboard-events.test.ts` | `dashboard-stream-atoms.test.ts`, `dashboard-updates.test.ts`, `dashboard-shell-atoms.test.ts`, `overview-atoms.test.ts` | keep | UI-STORY-06; the UI fixture's stream is synthetic and proves none of this |
| Dashboard navigation and drafts | Navigation keeps exact identities, guards and restores dirty drafts and history, returns focus, and never lets a late response cross into another selection. | to classify (increment 3) | `navigation-atom.test.ts`, `workspace-navigation.test.ts`, `ui-core-atoms.test.ts`, `dashboard-integration-atoms.test.ts`, `dashboard-lifecycle-atoms.test.ts`, `candidate-search-identity-atoms.test.ts`, `project-supervisor-panel-atoms.test.ts` | migrate in increment 3 | real Back/Forward and keyboard traversal need a browser: UI-STORY-04, UI-STORY-08 |
| Dashboard presentation | Rendered views keep distinct facts distinct, escape source text and show unknown, stale and unavailable states explicitly. | to classify (increment 3) | server-rendered markup suites: `project-supervisor-ui.test.ts`, `project-definitions-ui.test.ts`, `supervision-controls-ui.test.ts`, `no-project-ui.test.ts`, `workflow-journey-ui.test.ts`, `workspace-presentation-ui.test.ts`, `ui-ux-boundaries.test.ts`, `steps-and-workflows-guide-ui.test.ts` | migrate in increment 3 | keep escaping and fact-separation checks; prune markup assertions a journey owns |
| Synthetic UI fixture | The fixture binds loopback only, never forwards, answers only from decoded synthetic data and applies its scenarios deterministically. | boundary: `ui-fixture/fixture.test.ts` (CT-UI-FIXTURE-01) | `ui-fixture/environments.test.ts`, `ui-fixture/returned.test.ts` | keep | client coverage only; never an oracle for server behavior |
| Task intake and discovery | A genuine human request, or an opted-in agent request, is discovered within bounded cycles from its exact source; owned, scheduled, service and child messages never become requests. | controller: `project-supervisor.test.ts` | `supervisor-discovery.test.ts`, `supervision-conversation.test.ts`, `domain.test.ts`, `project-supervisor-workflow.test.ts`, `project-supervisor-scope-serialization.test.ts`, `scope-locks.test.ts`, `initial-worktree-startup.test.ts` | keep | `./dev check` holds the live no-contact conversation |
| Interpretation submission and finalization | Only the bound root's own completed request run can submit a typed interpretation; it is finalized once, a source, binding or control change between proof and commit applies nothing, and final-chat JSON is ignored. | boundary: `interpretation-finalization.test.ts` | `interpretation-intake.test.ts`, `interpretation-submission.test.ts`, `interpretation-start.test.ts` (Start verdicts), `pending-start-interpretation-read.test.ts`, `interpretation-backward-identity.test.ts`, `supervisor-model-output.test.ts`, `startup-integration.test.ts` | keep; replays consolidated in increment 4 | interpretation quality is a provider trial |
| Planning pause | A pause needs its exact native owner call and keeps one identity on replay; its deadline anchors at the first delivery, and a release grants no implementation permission without an agreed proposal. | controller: `supervisor-planning-controller.test.ts` | `supervisor-planning.test.ts`, `supervisor-planning-draft-read.test.ts`, `planning-pause-prompt.test.ts`, `proportionate-planning.test.ts` | keep | `planning-pause-prompt.test.ts` is reviewed in increment 2 |
| Introductions, proposals and acceptance | A proposal reaches the operative once as a short pinned notice, the operative reads and agrees it through its own verified call, and an agreement goes stale when its source, definitions or native evidence change. | controller: `supervisor-conversation.test.ts` | `operative-proposal-read.test.ts`, `supervisor-workflow-agreement.test.ts`, `supervisor-workflow-agreement.characterization.test.ts`, `supervision-conversation.test.ts`, `conversation-prior-work.test.ts`, `supervisor-conversation-receipt.test.ts`, `supervisor-conversation-creation-receipt.test.ts`, `supervisor-conversation.characterization.test.ts`, `startup-integration.test.ts` | keep; replays consolidated in increment 4 | whether and when a real operative reaches introduction and acceptance is a provider trial |
| Monitoring and watch | Finalized native activity is batched per main once, acknowledged only for its frozen batch, kept across restart as metadata without bodies, and saturation never hides a sibling. | controller: `supervisor-monitor.test.ts` | `supervisor-monitor.characterization.test.ts` (CT-MSTORE-01), `supervisor-child-observation.test.ts`, `supervisor-awareness.test.ts`, `supervisor-native-read-routes.test.ts`, `project-monitoring-settings.test.ts`, `workflow-liveness.test.ts` | keep | sustained watching and pacing are provider trials |
| Compaction | A completed root compaction gets one guarded short native steer and invalidates the role acknowledgement; other traffic causes no reminder. | controller: `supervisor-compaction.test.ts` | its production-graph case (`it.live`) | keep | when compaction happens, and what follows, are provider trials |
| Supervisor lifecycle and settlement | Each main has one owned Supervisor; creation and settlement keep their native command identities, a durable rejection waits for an explicit retry, and settlement waits until the whole scope is quiet. | controller: `supervisor-scope-lifecycle.test.ts` | `supervisor-scope-lifecycle.characterization.test.ts`, `project-supervisor.test.ts`, `supervisor-ownership.test.ts`, `supervisor-state-reset-service.test.ts` | keep; pins folded in increment 4 | parking on a real T3 is a provider trial |
| Stop linearization and send admission | A Stop or Enable is published by its commit: every send's final guard reads the committed policy, an admitted send keeps its identity, a queued one admits nothing, and nothing is resent after an unknown outcome. | boundary: `stop-linearization.test.ts`, including the helper's Stop cases and a Stop while a root check-in's reply is held | `supervision-gate.test.ts` (CT-LIN-05), `supervision-gate-transaction.test.ts` (CT-LIN-07), `workflow-team-admission.test.ts` (CT-LIN-08), `supervisor-conversation-admission.test.ts` (S6b-CONV-02, -03), `project-supervisor-admission-authority.test.ts` | keep; replays consolidated on the scenario driver in increment 4 | a Stop during a real turn, with exactly one operative notice, is a provider trial |
| Native authority and `workflow_write` | A workflow write commits only with an exact, strong proof from the owner's main run, rechecks Stop and binding generation at commit, answers a replay from its receipt and never reserves while pending. | boundary: `native-authority-integration.test.ts` (CT-INT-01) | `workflow-write-controller.test.ts`, `workflow-write-controller.characterization.test.ts`, `workflow-write-evidence-clock.test.ts`, `workflow-tool-routes.test.ts`, `workflow-native-turns.test.ts`, `domain.test.ts` | keep; controller duplicates consolidated in increment 4 | a real root's tool arguments against the evidence window are a provider trial |
| Workflow MCP route | The endpoint is stateless, checks Host, Origin and bearer before any controller, bounds bodies and call deadlines, and answers outcome-unknown with the operation id when a call outlives its deadline. | boundary: `workflow-mcp-lifecycle.test.ts` | `workflow-mcp.test.ts`, `workflow-mcp.characterization.test.ts`, `workflow-mcp-route.test.ts`, `workflow-mcp-services.test.ts`, `workflow-context-view-cancel.test.ts`, `supervision-live.test.ts`, `guidance-ui.test.ts` (GUI-01, GUI-02); `./dev check` | migrate in increment 4 | the five `workflow-mcp*` files overlap on close, disconnect and deadlines; confirm the owner when consolidating |
| Workflow state store | A document changes only through a revision-checked apply with one receipt; an exact replay returns the byte-identical receipt, and incompatible rows are reported, never rewritten. | store: `workflow-state.test.ts` | `workflow-state.characterization.test.ts` (CT-WSC-01, CT-WSS-01 to CT-WSS-04), `workflow-state-schema.test.ts`, `workflow-state-store.regression.test.ts` | keep; pins folded in increment 4 | |
| Workflow progress reads | Progress is read through the owner-bound reader, pages with independent bounded offsets, keeps scope limitations visible and refuses an oversized response without partial data. | controller: `workflow-progress.test.ts` | `workflow-progress.characterization.test.ts` (CT-WP-01, CT-WP-02), `workflow-participants.test.ts`, `project-supervisor-panel-atoms.test.ts` | keep | |
| Plan semantics | Plans keep fixed members and their order, omit a flexible member only after negotiation, keep branch and node identities, and complete only when every applicable member settles. | controller: `workflow-progress-semantics.test.ts` | `workflow-branches.test.ts`, `supervisor-workflow.test.ts`, `supervisor-workflow.characterization.test.ts` (CT-SW-01), `workflow-node-ids.test.ts`, `workflow-liveness.test.ts`, `proportionate-planning.test.ts`, `review-outcome.test.ts`, `workflow-journey-ui.test.ts` | keep | |
| Returns and budgets | A return targets only an earlier member of its lane, waits for the Supervisor and stays within its maximum; an enclosing replay resets only the nested budgets in its region. | store: `workflow-return-budget.test.ts` | `workflow-return-boundary.test.ts`, `workflow-back-to.test.ts`, `workflow-write-controller.test.ts` | keep | |
| `supervision_team` and helpers | A team mutation needs exact native root proof and current member and assignment authority and commits one receipt atomically; a Stop of the main fences every team and guide effect, but not reads. | controller: `supervisor-team-controller.test.ts` | `supervisor-team-store.test.ts`, `supervisor-team-store.regression.test.ts`, `supervisor-team-controller.characterization.test.ts`, `native-authority-integration.test.ts` (CT-INT-02), `workflow-team-admission.test.ts`, `supervisor-team-member-loss.test.ts` | keep; pins folded in increment 4 | a guide into a running delegated child is a provider trial |
| Helper runtime, transport and webhook | A helper delivery is posted at most once per identity; a lost or unreadable reply stays uncertain and is reconciled from its exact body or rendering, never re-posted; a Stop or quarantine committed before the POST is admitted fences it. | boundary: `helper-webhook-integration.test.ts` (CT-INT-03); its Stop cases are in `stop-linearization.test.ts` | `helper-transport-admission.test.ts`, `supervisor-helper-transport.test.ts`, `supervisor-helper-transport.characterization.test.ts`, `supervisor-team-runtime.test.ts`, `supervisor-team-runtime.characterization.test.ts` | keep; replays consolidated in increment 4 | T3's rendering of a real helper frame needs a provider trial |
| SQL client and database worker | An interruption, a failed COMMIT or a worker exit never leaves a partial commit or a held lock, compare-and-set holds across processes, and a busy query in the worker never blocks HTTP. | store: `sql-semantics.test.ts` (CT-SQL-01 to CT-SQL-04) | `access-sql-semantics.test.ts`, `db-worker.test.ts`, `db.test.ts`, `harness/lint-guards.test.ts` | keep | contention under sustained load is a soak candidate |
| Catalog store and native ingestion | Shell and archive snapshots ingest atomically, a cursor advances only after durable ingestion, and the store files stay private. | store: `store.test.ts` | `store.characterization.test.ts`, `store-permissions.test.ts`, `supervisor.test.ts`, `t3-client-port.test.ts` | keep; pins folded in increment 4 | |
| Guidance and supervision stores | Bindings, tasks, Start records, receipts and notices commit together, an uncertain record is recovered once on reopen, and an undecodable row is a typed failure, never absent. | to classify (increment 4) | `guidance-store-service.test.ts`, `supervisor-conversation-store-service.test.ts`, `project-supervisor-store.regression.test.ts`, `project-supervisor.characterization.test.ts` (CT-PSS), `guidance.characterization.test.ts` (CT-GDB), `supervisor-conversation.characterization.test.ts` (CT-CSTORE), `rollout-scan.test.ts` | migrate in increment 4 | some IDs run twice, as the baseline pin and its post-port variant: CT-PSS in `project-supervisor.characterization.test.ts` and `project-supervisor-store.regression.test.ts`, CT-CSTORE in `supervisor-conversation.characterization.test.ts` and `supervisor-conversation-store-service.test.ts` |
| Identities and clocks | Identities come only from the injected id service and times from `Clock`, so a test can seed both. | unit: `ids.test.ts` | `workflow-state-store.regression.test.ts`, `supervisor-team-store.regression.test.ts`, `workflow-node-ids.test.ts` | keep; pins folded in increment 4 | |
| T3 watch and reads | Native reads are read-only, authenticated and on protocol 2; a watch acknowledges a chunk only after durable ingestion, keeps its heartbeat and deadlines, and bounds frames and bodies. | boundary: `t3-client-port.test.ts` | `t3.test.ts`, `t3.characterization.test.ts`, `t3-projection-stream.test.ts`, `t3-projection-stream.characterization.test.ts`, `probe-t3.test.ts`, `probe-t3-runmain.test.ts`, `supervisor.test.ts` | keep; pins folded in increment 4 | idle heartbeat over time and reconnect after a T3 restart are soak and local-stack candidates |
| Native RPC and send classification | A native request is definite only when T3 answered it; once its frame may have reached T3, a cut, timeout or interruption is uncertain and nothing is sent again. | boundary: `native-rpc.test.ts` | `native-envelope.test.ts`, `supervisor-native.test.ts`, `supervisor-native.characterization.test.ts`, `native-files-service.test.ts`, `workflow-native.test.ts` | migrate in increment 4 | CT-NATIVE-01 and NRPC-03 pin the same deadlines; confirm the owner when consolidating |
| CLI and service auth | `auth forge` prints only the token, on stdout, and writes no partial grant; the service fails closed on malformed, oversized or foreign auth state, and sessions keep their expiry under a clock rollback. | boundary: `service-auth.test.ts` | `service-auth.characterization.test.ts`, `service-auth-layer.test.ts`, `auth-cli.test.ts`, `auth-cli.characterization.test.ts`, `cli-bin.test.ts` | keep; pins folded in increment 4 | CT-AUTH-03 and the `TestClock` case in `service-auth-layer.test.ts` pin the same expiry rule |
| Service process, health and configuration | The service starts only with a valid configuration, answers `/health` and `/live` with the exact status matrix, restarts a failed part after its fixed delay, and on SIGTERM closes every listener and database and exits 130. | boundary: `cli-bin.test.ts` | `supervisor.characterization.test.ts` (CT-HEALTH-01, CT-MAIN-04, CT-MAIN-05), `main-release-order.test.ts`, `config.test.ts`, `config.characterization.test.ts`, `guidance.characterization.test.ts` (CT-APP-02), `guidance-ui.test.ts` (GUI-04, GUI-08), `logging.test.ts` | keep | recovery after a real T3 restart is a manual gap |
| Production startup chain | The production graph launches a root, serves its own controllers through the MCP gateway and carries a needed-work startup through interpretation to the operative's read of the proposal. | replay: `startup-integration.test.ts` | `supervision-live.test.ts`, `initial-worktree-startup.test.ts`, `dev-fixture.test.ts` | keep | the existing real-graph replay; `./dev fixture` runs the same chain |
| Logging privacy | Logs, errors and responses carry fixed messages, codes and classifications, never tokens, native bodies, webhook URLs or raw causes. | boundary: `log-privacy.test.ts` (CT-REDACT-01) | `logging.test.ts`, `harness/private-assert.test.ts`, `service-auth-layer.test.ts`, `interpretation-submission.test.ts` (CT-ISUB-18), `supervisor-helper-transport.characterization.test.ts` (CT-HTX-04), `guidance-ui.test.ts` (GUI-03), `workflow-mcp-lifecycle.test.ts` (MCP-LIFE-08) | keep | |
| Prompt texts | Rendered prompts compose shared fragments once, name the right tools, fields and actors, stay within their budgets and exclude sensitive or pushed data. | unit: `prompt-contracts.test.ts` | `supervisor-read-traffic.test.ts`, `exchange-audit.test.ts`, `workflow-write-controller.characterization.test.ts` (CT-WWC-06), `supervisor-workflow.characterization.test.ts` (CT-SW-01), payload-bound cases in `supervisor-conversation.test.ts` and `supervisor-helper-transport.test.ts` | keep | shared composition, tool/schema references, actor boundaries, budgets and sensitive exclusions; requests compare decoded handles instead of prose lengths or hashes; canonical plan and seeded-ID goldens remain; model behavior belongs to provider trials |
| Release and CI policy | Verdict reuse and the release fast track accept only exact, directly proven full evidence; images build natively per architecture, and a version is never published from another source. | unit: `ci-evidence.test.ts` | `ci-proof.test.ts`, `release-ci-proof.test.ts`, `release-policy.test.ts`, `release-trigger.test.ts`, `release-arm64-gate.test.ts`, `native-arm64-ci.test.ts`, `image-build-cache.test.ts`, `release-smoke.test.ts` | keep | the `browser` job joins full validation in increment 1 |
| Development environment | The Docker environment issues least-scope revocable T3 sessions, installs only the pinned T3 digest, keeps provider logins in its own volume and removes only its own marked run folders. | unit: `dev-environment.test.ts` | `local-stack.test.ts`, `local-run.test.ts`, `dev-fixture.test.ts`; `./dev check` | keep | the suite holds the guard rails; `./dev check` is the live boundary |
| Runner harness and test support | The runner fails on async leaks, unbounded tests and blocked workers, keeps tokens out of reports, and the test peers and processes release what they hold. | harness: `harness/*.test.ts` (`pnpm test:harness`) | `fake-t3-wait.test.ts`, `process-output-limit.test.ts` | keep | |
| Operational scans and cut-overs | The rollout scan reads stored rows without writing; a one-off cut-over is rehearsed on a SQLite copy and keeps unknown fields. | store: `rollout-scan.test.ts` | `conversation-cutover.test.ts` | keep the scan; the cut-over test to classify | a one-off cut-over's test leaves with its script |

## Historical scenarios

The Effect v4 migration named live checks for a coordinator to run by hand. Each is
classified here as automated (the test or command that owns it now), a retired one-off
migration (a completed comparison or cut-over check with nothing to repeat) or a manual
gap (a live run that no automation covers yet). A file path in the source column names
that file's `liveProofTrigger` in `docs/effect-v4-files.json`; UI-STORY-01 to UI-STORY-08
are defined in section 7 of [the migration plan](effect-v4-migration.md) and in the
[UI fixture README](../test/ui-fixture/README.md). Tiers are the
[execution types](#execution-types); test files are under `test/`. The primary reviewer
holds older testing reports, whose scenarios are classified the same way.

| Scenario | Invariant | Source | Primary tier | Complementary evidence | Disposition |
| --- | --- | --- | --- | --- | --- |
| T3 watch smoke check | The read credential verifies T3's descriptor, live shell and paired archive snapshot. | `scripts/probe-t3.ts` | 5 | `probe-t3.test.ts`, `probe-t3-runmain.test.ts` | automated: `./dev check` |
| Real native read RPC | A read RPC and a coherent read succeed against the pinned T3. | `src/supervisor-native.ts` | 5 | `supervisor-native.test.ts`, `native-rpc.test.ts` | automated: `./dev check` |
| `auth forge` in an installation | Forge prints only the token, exits with fixed codes, and the token signs in. | `src/cli.ts` | 2 | `auth-cli.characterization.test.ts`, `cli-bin.test.ts`, `dev-fixture.test.ts` | automated |
| Listeners after the S2 port | The deployed configuration yields the same listeners as before the port. | `src/config.ts` | none | `config.characterization.test.ts` keeps the configuration golden | retired one-off migration |
| Startup with real credentials | Supervisor starts with least-scope credentials, ingests the T3 catalog and serves the workflow MCP route. | `src/guidance-application.ts` | 5 | `startup-integration.test.ts`, `supervision-live.test.ts` | automated: `./dev check` |
| Recovery after a T3 restart | The service degrades, reconnects its watch with cursor continuity and becomes ready again. | `src/guidance-application.ts`, `src/supervisor.ts`, `src/t3.ts` | 5 | `supervisor.characterization.test.ts` (CT-MAIN-04), `t3-client-port.test.ts`, `supervisor.test.ts` | manual gap (increment 5) |
| Idle watch heartbeat | A watch idle for over a minute keeps its heartbeat. | `src/t3.ts` | 4 | `t3-client-port.test.ts` (heartbeat on the Effect clock) | manual gap (increment 5) |
| Production-size projection | A projection of tens of MiB is read within the HTTP deadline. | `src/t3-projection-stream.ts`, `src/t3.ts` | 2 | `t3.test.ts` (over 32 MiB on the wire), `t3-projection-stream.test.ts` | automated; the post-port comparison on deployment data is retired |
| Health contract | The container health check stays healthy and `/health` keeps its JSON shape. | `src/supervisor.ts` | 2 | `supervisor.characterization.test.ts` (CT-HEALTH-01); `./dev up` waits for health | automated |
| Stop and restart of an installation | SIGTERM closes listeners and databases and exits 130; a restart keeps the state. | `src/main.ts` | 2 | `cli-bin.test.ts` (CT-MAIN-01); `./dev check` leaves no port, process or run folder | automated; checking a deployed revision belongs to the deployment owner |
| Git probe on a real checkout | A probe returns fresh status, deletes its terminal history and leaves no pending entry. | `src/git-probe.ts` | 5 | `git-probe.test.ts`, `git-probe.characterization.test.ts`, `native-files-service.test.ts` | manual gap (increment 5) |
| `project.yaml` save through the native writer | A save on a real checkout preserves comments and reads back as saved. | `src/project-config-editor.ts`, `src/project-files.ts` | 5 | `project-config-editor.test.ts`, `native-files-service.test.ts` | manual gap (increment 5) |
| Definitions revision after the port | An unchanged tree keeps its pre-port revision string. | `src/project-definitions.ts` | none | `project-definitions.characterization.test.ts` (CT-PD-03) | retired one-off migration |
| Create on a scratch checkout | Create without commit writes only the scaffold files. | `src/project-definitions.ts` | 1 | `project-definition-initialization.test.ts`, `project-definitions.characterization.test.ts` (CT-PD-01) | automated |
| Restart with an in-flight notice or introduction | Reopen recovers each uncertain record once, sends no duplicate and shows it as uncertain. | `src/guidance-store.ts` | 2 | `guidance.characterization.test.ts` (CT-GDB-01), `supervisor-conversation.characterization.test.ts` (CT-CONV-01, CT-CONV-02) | automated; the check on live deployment data is retired |
| Supervision data after the database cut-over | Existing bindings, tasks, controls, No Project mode and owned IDs read back unchanged. | `src/project-supervisor-store.ts` | none | `project-supervisor-store.regression.test.ts` (CT-PSS-06) | retired one-off migration |
| Uncertain task after a restart | A dispatching or uncertain task keeps its original message identity across a restart and is never sent fresh. | `src/project-supervisor-store.ts`, `src/project-supervisor.ts` | 2 | `project-supervisor.characterization.test.ts` (CT-PS-01, CT-PS-02), `project-supervisor.test.ts` | automated |
| Concurrent writes under the supervision cycle | Concurrent MCP writes and the supervision cycle meet no SQLITE_BUSY and no self-contention. | `src/project-supervisor-store.ts` | 4 | `db-worker.test.ts`, `sql-semantics.test.ts` (CT-SQL-04) | manual gap (increment 5) |
| Uncoached No Project Start and Stop | A Start runs one interpretation and activates on a positive verdict; a Stop during the interpretation sends one notice and nothing again. | `src/project-supervisor.ts` | 6 | `interpretation-start.test.ts`, `stop-linearization.test.ts` (CT-LIN-04, CT-LIN-06), `project-supervisor.test.ts` | manual gap (increment 5) |
| No-contact reads | Dashboard snapshot and overview reads make no native write. | `src/project-supervisor.ts` | 2 | `project-supervisor.characterization.test.ts` (CT-PS-08), `dashboard-overview.test.ts`; `./dev check` (no-contact conversation) | automated |
| Auth state after the port | Existing sessions still authenticate, the login database keeps its journal mode and schema, and the workflow token is unchanged. | `src/service-auth.ts` | none | `service-auth.characterization.test.ts` (CT-AUTH-01), `db.test.ts` | retired one-off migration |
| Catalog after the port | The existing catalog opens without a schema change, its cursor continues and its file modes stay private. | `src/store.ts` | none | `store.characterization.test.ts` (CT-STORE-03, CT-FILES-MODE-01), `store.test.ts` | retired one-off migration |
| Monitor schema PRAGMA comparisons | Recorded column layouts decided whether legacy ALTER guards could go. | `src/supervisor-conversation-store.ts`, `src/supervisor-monitor-store.ts` | none | `supervisor-monitor.test.ts` (older monitor schema) | retired one-off migration |
| Scope version on every installation | Each installation's database carried the current scope version, which decided whether the reset branch could go. | `src/supervisor-state-reset.ts` | none | `supervisor-state-reset-service.test.ts` | retired one-off migration |
| Uncoached operative request | A real operative reaches the introduction and, if it happens naturally, acceptance; rendered prompts stay bounded and free of duplication. | `src/supervisor-conversation.ts` | 6 | `supervisor-conversation.test.ts` (payload bounds, exchange audit), `exchange-audit.test.ts` | manual gap (increment 5) |
| Kill between sending and receipt | After a restart no native message is duplicated and the original identity is reconciled. | `src/supervisor-conversation.ts` | 2 | `supervisor-conversation.characterization.test.ts` (CT-CONV-01, CT-CONV-02), `stop-linearization.test.ts` (CT-LIN-06) | automated over the scripted peer |
| Human Stop during supervised work | A Stop gives exactly one operative notice and prompt Supervisor settlement. | `src/supervisor-conversation.ts` | 6 | `supervisor-conversation.test.ts`, `supervisor-scope-lifecycle.test.ts` | manual gap (increment 5) |
| Idle parking | A completed main with quiet children parks its Supervisor once after the quiet period, and a later human message reuses the same Supervisor. | `src/supervisor-lifecycle.ts` | 6 | `supervisor-scope-lifecycle.characterization.test.ts` (CT-LIFE-03), `supervisor-scope-lifecycle.test.ts` | manual gap (increment 5) |
| Helper check-in through the published frame | A helper check-in is rendered and attributed through T3's published frame, and a lost reply stays uncertain without a second POST. | `src/supervisor-helper-transport.ts` | 6 | `helper-webhook-integration.test.ts` (CT-INT-03), `supervisor-helper-transport.test.ts` | manual gap (increment 5) |
| Helper recruitment and one check-in | Readiness completes over the real webhook channel, one assigned child activity gives exactly one check-in, and a restart during it gives no second POST. | `src/supervisor-team-runtime.ts` | 6 | `supervisor-team-runtime.test.ts`, `supervisor-team-runtime.characterization.test.ts` (CT-TRUN-01), `helper-webhook-integration.test.ts` | manual gap (increment 5) |
| Guide into a running delegated child | A guide through the MCP endpoint is steered natively once, its receipt keeps its identity across a restart, and a definite rejection routes to one ancestor. | `src/supervisor-team-controller.ts` | 6 | `supervisor-team-controller.characterization.test.ts` (CT-TCTRL-01, CT-TCTRL-02), `stop-linearization.test.ts` | manual gap (increment 5) |
| MCP gateway call after a deploy | A gateway connected directly to `/mcp/workflows` lists the tools and makes a bounded `workflow_read`. | `src/workflow-mcp.ts` | 2 | `workflow-mcp.characterization.test.ts` (CT-MCP-02), `startup-integration.test.ts`; `./dev check` | automated; the check right after a deploy is retired |
| Workflow documents after the cut-over | Existing documents and receipts read through `workflow_read`; incompatible rows are reported, not rewritten. | `src/workflow-state-store.ts` | none | `workflow-state.characterization.test.ts` (CT-WSC-01, CT-WSS-03) | retired one-off migration |
| A real root's `workflow_write` | A first write may be pending, the identical retry applies once and a replay returns the same receipt; the tool arguments and native timestamps fit the evidence window. | `src/workflow-write-controller.ts` | 6 | `native-authority-integration.test.ts` (CT-INT-01), `workflow-write-evidence-clock.test.ts` | manual gap (increment 5) |
| Dashboard sign-in, CSRF and MCP Host checks | Sign-in, a CSRF-checked change and the MCP Host, Origin and bearer checks hold on the real listeners. | `src/guidance-ui.ts` | 2 | `guidance.characterization.test.ts` (CT-UI-01, CT-UI-02, CT-MCP-01), `guidance-ui.test.ts`, `native-authority-integration.test.ts`; `./dev check` | automated; cross-tab sign-out is UI-STORY-05 |
| Settings excluded-chat edit | A chat excluded in Settings stays excluded across a restart. | `src/thread-policy.ts` | 3 | `thread-policy.test.ts`, `supervisor-conversation.test.ts`; the pilot covers the chat's own control | manual gap (increment 3) |
| UI-STORY-01: editor drafts, 401, conflict, uncertain | A dirty editor draft survives navigation and re-sign-in, a save after a 401 is not saved, and a conflict or uncertain save blocks saving until a refresh. | UI-STORY-01 | 3 | `project-definitions-ui-atoms.test.ts`, `project-config-editor.test.ts` | manual gap (increment 3) |
| UI-STORY-02: project panel drafts | Model, monitoring and team drafts survive navigation and re-sign-in; only an explicit Save or Retry sends. | UI-STORY-02 | 3 | `e2e/session-ends-during-save.test.ts` (a team settings draft across a sign-out and re-sign-in, and only an explicit Save sends), `project-supervisor-panel-atoms.test.ts` | re-sign-in automated in increment 3; navigation with a dirty draft and Retry remain a manual gap |
| UI-STORY-03: session expiry during a pending Save or Start | The outcome stays unconfirmed, the fence is kept and nothing is replayed after re-sign-in. | UI-STORY-03 | 3 for a Save, 1 for a Start | `e2e/session-ends-during-save.test.ts`, `no-project-atoms.test.ts` (CT-UI-START-01), `project-supervisor-panel-atoms.test.ts`, `dashboard-lifecycle-atoms.test.ts` | the Save automated by a journey in increment 3; the Start stays automated in client atoms |
| UI-STORY-04: Back/Forward with a dirty draft | Browser history traversal and manual hash edits keep the draft or discard it explicitly. | UI-STORY-04 | 3 | `navigation-atom.test.ts`, `workspace-navigation.test.ts` | manual gap (increment 3) |
| UI-STORY-05: two tabs | Signing out in one tab signs out the other; an open draft stays in its tab and no pending change is replayed after sign-in. | UI-STORY-05 | 3 | `e2e/session-ends-during-save.test.ts`, `browser-access.test.ts`, `browser-access.characterization.test.ts` (CT-UI-AUTH-01) | automated in increment 3: Sign out in another tab signs the tab with the draft out, which keeps its draft, signs in again and sends nothing on its own; a server-only revocation stays with `project-supervisor-panel-atoms.test.ts` |
| UI-STORY-06: stream ownership and idle traffic | Each visible registry holds one event stream, idle pages make no periodic reads and hidden tabs hold none. | UI-STORY-06 | 2 | `dashboard-events.test.ts`, `dashboard-stream-atoms.test.ts`, `overview-atoms.test.ts` | automated; the original poll-interval and StrictMode wording is superseded by the event stream |
| UI-STORY-07: chat Stop/Enable | A chat's Stop and Enable apply through their controls, and the saved state shows after a reload. | UI-STORY-07 | 3 | `e2e/chat-stop-enable.test.ts`, `e2e/supervision-switches.test.ts`, `project-supervisor-panel-atoms.test.ts` | automated: the chat's Stop and the stop notice's Enable, which is the control the pilot clicks, in increment 1; the global and project switches in increment 3; opening a stopped chat from its Home row remains manual |
| UI-STORY-07: setup race, reload and cut Start | An unconfirmed setup stays fenced until a later read, and a cut Start POST keeps its fence across a reload. | UI-STORY-07 | 1 | `supervision-controls-atoms.test.ts`, `supervision-controls-ui.characterization.test.ts` (CT-UI-SETUP-01), `no-project-atoms.test.ts`, `supervisor-control.test.ts` | automated in client atoms; journeys in increment 3 |
| UI-STORY-08: keyboard, focus, zoom and reflow | Every control is reachable by keyboard with visible focus, and the views reflow at 320 px and at 200 % and 400 % zoom. | UI-STORY-08 | 3 | `workspace-navigation.test.ts`; the [interface acceptance reference](../skills/maintenance/contribute-supervisor/references/interface-acceptance.md) | manual gap (increment 3) |
