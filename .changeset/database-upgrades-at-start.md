---
"@jfet97/t3-supervisor": patch
---

Upgrade Supervisor's databases only when the service starts. Each database now records its format, and the service brings every database to the installed version's format as it starts, before it serves the dashboard or contacts T3. Before it changes an existing database, it copies it into a new private backup set under `backups/` in the state directory and verifies the copy; a start whose databases are already current makes no backup. If a backup or an upgrade step fails, the service does not start and restores nothing by itself: correct the cause and start it again, and it continues with the remaining databases. Stop the running service before starting a new version; downgrades are not supported.

`t3-supervisor auth forge` never upgrades a database: after installing a new version, start the service once before forging a sign-in token. The one-off conversation cut-over script for older task records is removed.
