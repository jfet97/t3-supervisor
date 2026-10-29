---
"@jfet97/t3-supervisor": patch
---

A Supervisor check-in is now one continuous watch of the task: it reads covered work forward, drains its own queued messages at the boundaries it chooses and paces with bounded waits, ending only on completion, an explicit standby, a yield, a human Stop or context rotation. When a turn still ends with the operative's run completed and agreed work unfinished, the service sends one liveness check-in per run and workflow revision, queued behind any active turn and never steered into it. The operative is told its queued questions are read at those boundaries.
