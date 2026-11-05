---
"@jfet97/t3-supervisor": patch
---

Supervisor now checks the stored fields that decide supervision every time it reads them: a
Stop's route, caller and time, the Stop notice sent to the chat, a resume, a Start and its
operation, the activation baselines, the supervision controls' generations and switches, a
project's folder detection, and the No Project mode with its generation. A damaged
record now fails with a clear error, which the rollout scan also reports, instead of steering a
decision; every other field of a record is kept exactly as stored. The rollout scan reports a
database at the current format that lacks part of its schema as a start the service will
refuse, not as tables an upgrade would create. New installations no longer create the tables
of the retired reminder rules; existing installations keep them and their data. The
installation guide no longer describes returning to an earlier version, which is not
supported.
