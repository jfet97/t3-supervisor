---
"@jfet97/t3-supervisor": patch
---

Restore helper channels on the pinned T3 nightly by reading the scheduled-task subscription's first snapshot and releasing the connection.

The guidance session now requires both orchestration:read and orchestration:operate. The Docker development environment issues these scopes automatically; existing installations must reissue an operate-only guidance session before using helpers.
