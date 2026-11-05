---
"@jfet97/t3-supervisor": patch
---

Installations whose state goes back to builds from before the first release can now upgrade. A
Stop notice that was sent or superseded before notice texts were stored is kept as it is and is
never sent again, and the two tables of the early project-scoped supervision (its bindings and
its notice clock) are recognized and kept with their rows. A Stop notice that can still be sent
or checked still needs its text, and any other unknown table or declaration still stops the
upgrade before it changes anything.
