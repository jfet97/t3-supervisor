---
"@jfet97/t3-supervisor": patch
---

New requests in large instances are discovered in the first discovery cycle instead of after several rotation cycles: chats whose latest run changed are handled first, oldest request first, and unchanged chats cost nothing. Each cycle that finds fresh requests logs one `supervisor_discovery` timing event with counts only.
