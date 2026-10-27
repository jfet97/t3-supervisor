---
"@jfet97/t3-supervisor": patch
---

Workflows can repeat earlier work as a visible new attempt with `back_to`. The destination must resolve to one earlier occurrence in the same sequential lane, and the plan must retain an exit. The Supervisor confirms affected work is paused or quiet before applying the return. The main Plan moves back while History keeps prior statuses, contributors, decisions and results in forward order.

Reviewers continue in the same conversation when their separate executions can be identified. Late results from an earlier pass cannot satisfy repeated work. Native reviewers without separate execution identities require an explicit replacement carrying their earlier findings. Connected work and History explain which case applies.

A conversation started inside a supervised chat can now read its own scoped plan through the same plan read the main uses; it still accepts nothing itself. Plan reads include task-local duties and follow the current requester scope. Repeated steps show aligned titles, attempt labels and status badges at wide and narrow widths.

Revised plans also keep the identity of work already in them. A step inside a referenced workflow keeps its existing ID across proposals, revisions and applies, so its progress, contributors and history stay attached. A step a revision adds back gets the same new ID in the proposal and in the applied plan. Workflow plans and records written before this update keep the IDs they already have.
