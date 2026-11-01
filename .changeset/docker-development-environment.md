---
"@jfet97/t3-supervisor": patch
---

Contributors now develop and test in one Docker environment entered through `./dev`; the host needs only Docker. It runs an exact pinned T3 nightly, 0.1.7-nightly.20261101.4016, with Supervisor from the checkout. A private credentials volume keeps T3's chats, settings and provider connections and the Codex and Claude sign-ins across restarts and container rebuilds. A separate data volume keeps Supervisor data and development workspaces. `./dev reset` removes test data while sign-ins stay, and `./dev reset-auth` signs every provider out while chats and data stay. The dashboard fixtures and the published-T3 check run inside the same environment, and the Nix development shell is removed. CI and releases now build and run ARM64 container images on native ARM64 runners instead of emulating them.
