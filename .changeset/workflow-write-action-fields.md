---
"@jfet97/t3-supervisor": patch
---

Fix Start supervision for No Project chats so the request pinned by Start can be interpreted and, when needed, receive a workflow proposal. A Stop still waits for an earlier admitted proposal from the same activation.

Make the `workflow_write` schema match each action's accepted arguments, so clients can reject invalid field combinations before sending them.
