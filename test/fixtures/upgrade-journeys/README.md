# Upgrade journey seed sets

Frozen synthetic rows that the published Supervisor upgrade journeys (`scripts/upgrade-journey.ts`,
[development environment](../../../docs/local-stack.md#published-upgrade-journeys)) add to a data directory after the
binary that created it stopped and before the candidate starts on it. They stand for history a published binary cannot
produce without a provider: a Supervisor root bound to a main conversation, the root's and a helper's ownership, the
helper in the root's team with its helper channel, and one workflow write receipt with its native evidence, an unknown
native key included. They are fixture input, labelled as such, never published-binary output.

`seed-sets.json` holds:

- `sets`: one entry per persisted format and structural contract. A set applies to its `file` only when that file
  records exactly its `format` (`PRAGMA user_version`), declares every object of `requires.declarations` with that stored
  text (whitespace aside) and holds every `requires.meta` row with that value. The journey picks the set from what the
  binary left, never from a release name; a file no set matches fails the journey as an unsupported shape, and nothing is
  seeded from the candidate instead.
- `statements`: the literal INSERT statements a set runs, in order, in one transaction.

The statements are copied verbatim from
`test/fixtures/persistence/format0-current-unversioned/guidance.rows.sql`, and the declarations from that layout's
`guidance.expected.json`; `test/upgrade-journey-evidence.test.ts` checks both against those frozen files and the format 1
contract against the candidate's declared schema at format 1. Guidance format 2 adds only the policy table, which no seed
statement writes, so its set carries the format 1 contract at format 2 and is checked against the candidate's format 2 schema. Never edit them or regenerate them from current schema code: a new
persisted format or layout gets a new set. File names must not match the repository's ignored database patterns.
