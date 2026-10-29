---
"@jfet97/t3-supervisor": patch
---

Every task participant is now explicit. An external-contribution record may declare its participant generically (a T3 conversation with an optional environment, an external handle, or unknown); the root can record its own observation of a participant as evidence backed by its own completed native tool call, with wait, list and search calls counting as lifecycle only; the progress snapshot and the task page list each participant's role and attempt, lifecycle, completion, coverage and receipt as distinct facts, and a linked child with no attached step is shown as having no role. A planning pause of a main now also holds its live native descendants with ongoing work, including children that appear later, within the existing 100-target limit; anything it cannot hold is listed explicitly and blocks adoption, and a parent's acknowledgement never counts for its child.
