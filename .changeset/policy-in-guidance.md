---
"@jfet97/t3-supervisor": patch
---

Stop, Enable and Start now save the excluded-chat policy together with their own records, in
one transaction, so a failure can no longer leave a chat excluded while its Start still
waits, or the reverse. The policy moves from `thread-settings.sqlite3` into
`guidance.sqlite3`: the first start after the update copies the old file into its verified
backup set, imports the policy unchanged and then removes the file. If the old file comes
back with a different policy, for example because an older version ran on the upgraded
state, the service refuses to start instead of choosing one.
