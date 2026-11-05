# Historical persistence fixtures

Frozen inputs for the database upgrade tests: the files that published Supervisor releases left in a data directory,
keyed by persisted format and layout, never by release name. Every release up to 0.0.27 wrote no format marker, so each
of these files is format 0 (`PRAGMA user_version` 0).

| Directory | Layout | Created by |
| --- | --- | --- |
| `format0-current-unversioned/` | catalog with `shell_coverage`, guidance with the planning attempt tables and the compact settings row, thread-settings, access | 0.0.15 to 0.0.27 |
| `format0-pre-coverage-pre-planning/` | catalog without `shell_coverage`, guidance without `supervisor_planning_attempts` and with the legacy settings row; thread-settings and access as above | 0.0.2 to 0.0.11 |

Each directory holds, per database file (`catalog`, `guidance`, `thread-settings`, `access-login` for
`access/login.sqlite3`):

- `<name>.schema.sql`: the statements the released binary executed on a new file, in order, copied from the released
  source (no comments; parameters inlined as SQL literals);
- `<name>.rows.sql`: synthetic rows as literal SQL, labelled as synthetic fixture input, not old-binary output;
- `<name>.expected.json`: the file read back after the schema and the rows: `sqlite_master`, creation order,
  `PRAGMA table_info`, row counts, `user_version` and the journal mode of the file header.

`manifest.json` records the provenance of every statement (releases, commits, source lines), the assumptions, what the
synthetic rows stand for and the SHA-256 of every other file. It documents provenance and integrity, not behavior.

`test/support/persistence-fixtures.ts` materializes a directory as the old binaries left it (WAL for catalog, guidance
and thread-settings, DELETE for access; directories 0700, files 0600; no format marker), checks the hashes and dumps a
file for comparison. It and `test/persistence-fixtures.test.ts` import nothing from `src/`.

Never edit these files or regenerate them from current schema constants, serializers or factories: a new persisted layout
gets a new directory. File names must not match the repository's ignored database patterns (`*.sqlite*`, `*.db`).

The `*.expected.json` dumps and the SHA-256s were produced once by executing the frozen statements and rows with
`node:sqlite` (node 24.22.1) outside the repository's Docker environment; that run is not acceptance evidence. The
committed `test/persistence-fixtures.test.ts` checks the files against each other.

The schema text was then compared with files the published binaries themselves created, in the repository's Docker
environment (2026-11-05), each started on a new data directory with a read-only T3 session and stopped cleanly:

| Published binary | Source | Compared with | Result |
| --- | --- | --- | --- |
| `ghcr.io/jfet97/t3-supervisor:0.0.27`, ARM64 image `sha256:62b60c1746d3ab3708f714d7d7f90ec4ed9fb8e9d74a686e1fab3bffe27ba2c3` | `4ce0259` | `format0-current-unversioned/` | all four files equal in `sqlite_master` text, `PRAGMA table_info`, `user_version`, header journal mode and creation order |
| `ghcr.io/jfet97/t3-supervisor:0.0.11`, image `sha256:d87e3f729452ce9e1a4c46d54248eddb92fad53700ff57ed2d611efcb3667154` | `a378a4c` | `format0-pre-coverage-pre-planning/` | the same, all four files equal |

This confirms the schema statements only. The rows remain synthetic fixture input; the capture compared no row content.
On the pinned T3, 0.0.11 reached `supervisionState` `ready` but never connected (`t3Connected` false, last error phase
`t3_stream`), so the capture says nothing about that old runtime's compatibility. The captures used the published
images, whose dependency set is frozen: a fresh `npm install` of the 0.0.27 package resolves newer transitive Effect
packages and fails to start, so it cannot produce the files.
