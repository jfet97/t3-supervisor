---
"@jfet97/t3-supervisor": patch
---

Stop supervising a chat only when a genuine human asks for it. A new Supervisor root no longer reads its standing Stop instruction as a command to stop: it calls supervision_stop only after reading a human message that asks to stop supervising the chat, and a request to investigate or pause the task leaves supervision on for later work in the same chat. A refused or unavailable stop is still reported as not stopped, with the dashboard's Stop supervision control as the way to stop. Existing Supervisor roots receive the corrected instructions with their next message.
