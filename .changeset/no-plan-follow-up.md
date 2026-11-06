---
"@jfet97/t3-supervisor": patch
---

When a later request in a supervised chat needs no plan, such as a quick lookup after a revised
plan was accepted, the plan accepted for the earlier request now stays history. The Supervisor no
longer presents it as a new proposal, prepares no acceptance for it, does not treat it as work it
still has to bring into the workflow, and does not ask the agent about it again. A plan that was
proposed but not yet accepted when such a request arrives is likewise no longer offered.

The dashboard shows this state truthfully: no pending update and no "Awaiting reconciliation"
notice for the earlier plan, which appears under History as accepted for an earlier request.
"No plan needed" describes the last request the Supervisor interpreted; a newer request it has
not read yet, for example because supervision was stopped, is shown separately, next to the Stop.
Chats already in this state are shown correctly after the update without anyone being contacted,
and the next permitted interpretation also restores the earlier plan's own proposal identity.
