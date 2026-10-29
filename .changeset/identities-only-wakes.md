---
"@jfet97/t3-supervisor": patch
---

Routine Supervisor wakes carry only identities, counts, the instructions version, their read route and their turn-end marker: a check-in's rows, counts, handles, contact routes, team policy and open indexes are frozen with the request and read on demand with `workflow_read` view `request` (only by the Supervisor that owns the request, during the turn and after its acknowledgement; another Supervisor's request is denied). A liveness check-in names its run, revision and repeat and exposes the unsettled occurrences the same way. The root notice with its fences, discovery route and Stop fallback is delivered once per instructions version and confirmed by a completed turn; later wakes carry a one-line pointer with the version. The core's rule for turns without a service request now continues the watch instead of framing a finite wake.
