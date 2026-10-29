---
"@jfet97/t3-supervisor": patch
---

Check-in and liveness wakes no longer frame the watch outcome as something recorded "at the end of the turn"; they point at the watch's own endings, and the shared root and helper watch rules now say that a timed-out wait while the target still runs is not an ending (read forward and wait again), that external waiting counts only when a native watcher reports it (never the operative's own running turn), and that a main still running with agreed work unfinished never ends the root's turn, however many waits timed out. This closes the observed case of a Supervisor ending its turn after several timed-out waits while the operative was still working.
