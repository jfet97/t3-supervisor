---
"@jfet97/t3-supervisor": patch
---

When a supervised task is changed after its work was completed and the agent accepts the
Supervisor's revised plan, that plan now becomes the task's current plan. It starts with every
step planned and not yet assessed, so nothing completed for the earlier request counts toward it
until the Supervisor assesses it again. The earlier completion stays in History. An installation
that already accepted such a revision without switching to it catches up on its next supervision
pass, also after a restart, without asking the agent again.

The Supervisor no longer goes idle while an accepted plan is not yet in its workflow, so it
brings that plan in instead of treating the earlier completion as finished. The dashboard shows
the accepted plan instead of wrongly warning that the plan changed after acceptance, marks a
workflow that still records an earlier scope as awaiting the Supervisor, and keeps that
workflow under History.
