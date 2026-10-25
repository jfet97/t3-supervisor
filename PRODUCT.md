# Supervisor

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users and purpose

Supervisor helps the operator follow work in native T3 conversations, negotiate plans,
understand progress and intervene when supervision needs attention. The interface must make that work understandable by keeping useful context,
current state and the relevant next action together.

## Operating context

The same React application runs against separate Mac and Lab Supervisor instances.
Projects contain main conversations and connected work. Each main has its own
Supervisor, task interpretation, plan and assessments. Definitions belong to the
selected operative checkout; project defaults and instance settings have distinct scopes.

## Capabilities and constraints

Keep native conversation identities, settings, controls, drafts, checkout selection,
history navigation, authentication and uncertain-operation reconciliation intact.
Plans and agreement are records; they do not establish execution. Read-only views
must not wake conversations or change supervision. Unavailable and incomplete data
must remain explicit. T3 source and its installed runtime are outside the write scope.

## Product principles

- Show current work, its meaning and the relevant next action together.
- Keep project and conversation context visible as users move between related views.
- Give detailed evidence a clear home without making it the default reading path.
- Describe uncertainty honestly and preserve drafts and operational state.
- Explain unfamiliar terms where people encounter them, with concise contextual
  help and direct links to a maintained Guide/glossary. An expert's understanding
  does not establish first-time usability.

## Accessibility and inclusion

Design for keyboard operation, readable contrast, named controls, visible focus,
responsive reflow and reduced motion. Automated checks supplement rendered and
keyboard inspection; they do not establish complete accessibility conformance.

## Workspace organization

Home prioritizes current attention items, supervised work and recent changes. Each
project has conversations, definitions and settings. A conversation has one Task view,
where the task, its single plan with assessed progress, the agreement and the evidence
live together, and a Supervision view for the Supervisor's health and controls. A pending
proposal never resets recorded progress. A PNG coordination mark identifies the
application without competing with work content.

## Operate navigation and disclosure contract

Project entry opens its conversation list. Project Conversations, Definitions and
Project settings provide an explicit Back to Projects link; the directory keeps
its search and page. The editor returns to Definitions in the same top-left slot,
and template details retain their Back to catalog control. An explicit Back to conversations link and
project breadcrumb both return to that list, retaining its search, page and scroll;
a remembered conversation is an optional Continue link. Conversations offer Task,
Supervision and Connected work as separate views.

Conversation search covers the available project collection before paging. Home search
covers the full available supervised collection through a typed server query; Activity covers retained events. All three
show bounded rows and truthful ranges. Home attention and project coverage are independent of its selected result page. Background invalidation preserves the selected page.

Definitions are selected by actual working folder, with shared conversations grouped
and branch names taken only from native checkout facts. Catalog and detail are separate;
workflow templates show sequence, parallel and branch structure without execution states.
A branch names its condition and both labelled paths in text. On a live workflow it shows the
operative's decision as pending or selected with its reason, and the other path as not selected,
never as completed or missing. Accepted and earlier plans keep their agreed alternatives.
Edit index is a deliberate destination for the shared folder's project.yaml. Its draft
and pending save identity belong to that folder and survive navigation and background reads.

Global supervision, T3 connectivity and the open project's effective state are independent
visible statuses. Global On never claims that every conversation is supervised. Conversation
engagement uses the typed current mode and availability, separately from execution and agreement.

Conversation lists read the visible conversation identities within their own project. Home search and page selection never determine their status or objective. Project attention counts cover the available project independently of Home filters.

Home retains supervised work and attention even when a working folder was confirmed
missing. It labels these rows as orphaned with the last folder-check time and path;
project cards separate the default conversation count from orphaned chats. These
are retained observations from project entry or Refresh folders, not live Home
filesystem probes. Unknown or denied folder access never establishes an orphan.
