---
"@jfet97/t3-supervisor": patch
---

Workflows can now repeat earlier work as a visible new attempt. A `back_to:` member at the end of a branch path names an earlier step or workflow, for example to review again after material findings were fixed. Supervisor checks the composed plan and rejects a return whose target is missing, ambiguous, later in the plan or beyond a parallel group, and one that leaves no way to continue. When the agent reaches the return, everything after it waits and the region from the target to the return keeps its recorded state until the Supervisor applies the return at a safe point. The new attempt then plans that work again with the same reviewer conversations, and the branch is decided again. The closed attempt stays as history: its statuses, contributors, decisions and retired child runs. A late result or decision from the closed attempt never counts for the new one. The status view, the progress data and the plan show each reopened step's attempt. A return the agent no longer reaches, because it chose the other path, is dismissed and kept as history.

A conversation started inside a supervised chat can now read its own scoped plan through the same plan read the main uses; it still accepts nothing itself.

Revised plans also keep the identity of work already in them. A step inside a referenced workflow keeps its existing ID across proposals, revisions and applies, so its progress, contributors and history stay attached. A step a revision adds back gets the same new ID in the proposal and in the applied plan. Workflow plans and records written before this update keep the IDs they already have.
