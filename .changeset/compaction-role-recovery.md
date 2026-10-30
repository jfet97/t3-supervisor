---
"@jfet97/t3-supervisor": patch
---

Keep supervision active after automatic context compaction. Send one short, guarded role reminder to the running Supervisor, and refresh its instructions in the next normal wake when needed, without copying the plan or adding another scheduled wake.
