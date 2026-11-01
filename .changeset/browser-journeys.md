---
"@jfet97/t3-supervisor": patch
---

Contributors can run the dashboard's browser journeys with `./dev e2e`. A separate pinned `e2e` image drives this checkout's dashboard in headless Chromium over the scripted T3 peer, needs no credentials or provider sign-ins, and keeps a failed journey's trace, screenshot and page errors under `.e2e-artifacts/`. The first journeys show that a chat's Stop survives a Supervisor restart and a page reload until Enable, and that a lost reply, a connection dropped before the Supervisor or a refused change shows the saved state rather than an assumed one. Pull request checks now run these journeys in a required `browser` job, and a manual check run can repeat them up to 20 times with `browser_repetitions` to measure their flakiness. New testing guidance records which kind of test runs in pull request checks, in explicitly started extended runs, or as local acceptance with signed-in providers.
