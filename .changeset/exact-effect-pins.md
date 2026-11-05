---
"@jfet97/t3-supervisor": patch
---

Installing the npm package with a fresh `npm install` now starts Supervisor. Every Effect package it uses is now an exact
dependency, including `@effect/platform-node-shared`, which it reaches only through `@effect/platform-node`, so npm can no
longer pick newer Effect releases that do not work together. The published 0.0.27 package stays as it is: a fresh npm
install of it is known not to start. It stops with a `SyntaxError` before Supervisor listens or creates any state. The
0.0.27 container image is not affected.
