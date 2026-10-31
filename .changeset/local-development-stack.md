---
"@jfet97/t3-supervisor": patch
---

Add a repository-owned local setup for developing and testing Supervisor. `pnpm dev:fixture` serves the dashboard over the real Supervisor application with scripted T3 data for empty, populated and unavailable states. `pnpm dev:stack` runs a pinned, unmodified published T3 beside Supervisor from the checkout, with its own state, ports and scoped T3 credentials, and removes everything when it stops; `pnpm dev:stack --check` verifies that path end to end. Contributor guidance now relies only on this setup, not on personal machines.
