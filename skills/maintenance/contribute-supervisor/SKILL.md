---
name: contribute-supervisor
description: Change or review T3 Supervisor source, tests and contributor documentation. Read the interface acceptance reference for frontend work. Repository-local maintenance guidance; not dashboard usage or a personal deployment procedure.
---

# Contribute to Supervisor

Read the checkout's AGENTS.md and any closer AGENTS.md or CLAUDE.md, then the
relevant product documentation and local knowledge base when present. The public
standards here must work without a contributor having the maintainer's personal
skills, machine paths or private histories.

For frontend work, read
[interface acceptance](references/interface-acceptance.md) before designing or
editing. PRODUCT.md, DESIGN.md and the matching `.impeccable/surfaces/` brief own
the retained product identity. The [development guide](../../../CONTRIBUTING.md),
[CI policy](../../../docs/ci.md) and [release guide](../../../RELEASING.md) own
their commands and gates; follow the current files rather than copying a manual
into this skill.

## Implement the actual request

Record the requested behavior and observable acceptance before editing. Include
explicit human clarifications and later corrections; a reviewer's narrower design
contract cannot silently replace them. Fix demonstrated failures in the existing
path. Remove superseded code instead of adding parallel stores, speculative
parsers, compatibility layers or extra services.

Keep Effect and every @effect package exactly aligned. Use Context.Service/Layers,
Schema at boundaries, effect/sql for persistence and Atom/AtomHttpApi for UI async
state. Pure calculations, types and JSX stay plain. Small native/browser adapters
need a recorded reason. Preserve the current ownership, cancellation, uncertain
outcome and stale-result fences when changing shared helpers or callers.

Run autofix, both type checks, relevant focused regressions and build after a
development batch. Choose cases that distinguish the actual failure. Leave the
complete main and runner harness suites to GitHub, as the CI policy specifies.
Counts of passing tests cannot establish that a rendered control exists or that
a user can complete a journey.

Prove live behavior only on the repository's
[local development stack](../../../docs/local-stack.md): `pnpm dev:fixture` for
dashboard states, `pnpm dev:stack` for the published T3 boundary. Label each
observation fixture, local stack or provider. Never test against a personal host,
an existing installation or copied credentials, logins or MCP registrations.

## Review and deliver

Keep implementation ownership explicit when collaborating. Freeze the exact
artifact, give the reviewer the real requirements and changed boundary, and collect
each terminal result. Reuse an authorized ordinary reviewer for material follow-up
rounds through supported APIs. Do not replace independent evidence with repeated
summaries or a model's confidence.

All source contributions go through a PR with the Why, What, How and Remarks
sections. Require the current head's checks; do not merge main merely for freshness
or push directly to main. A reviewer acceptance, CI result, merged source, registry
publication and a running deployment are separate facts. Include a changeset for
user-visible changes and follow the separate version/release workflow.

Complete the deployment scope the user authorized and report the actual running
revision, relevant health and bounded configured interaction. Preserve credentials,
sessions, settings, history, other owners and unrelated dirty work. Use existing
deployment instructions; never modify T3 or add integration proxies. Clean owned
disposable artifacts and reconcile every requested outcome before claiming done.

## Keep skill audiences separate

Product operation and definition authoring belong in `skills/usage/`. Only usage
skills ship or enter Skillshare. This folder is contributor guidance read from a
checkout; never copy it into global agent catalogs. Keep personal host installation,
credentials and rollout commands in the appropriate private operations guidance.
