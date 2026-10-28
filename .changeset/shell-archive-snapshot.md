---
"@jfet97/t3-supervisor": patch
---

The live shell follows the installed T3 subscription. Archive membership comes from `getArchivedShellSnapshot` at the same sequence as the shell snapshot, including when that snapshot's `archivedThreads` list is empty. A reconnect resumes from the live cursor only after that archive snapshot has been stored.
