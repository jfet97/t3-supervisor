---
"@jfet97/t3-supervisor": patch
---

The fixes from the whole-project audit:

- **Definition changes:** the service owns delivery of the revised proposal. Definition reviews no longer also instruct the Supervisor to send a second copy.
- **Health endpoint:** a Supervisor started as a plain process now serves `/health` and `/live` on loopback only (`HEALTH_HOST`, default `127.0.0.1`), as the installation guide always said. The container image opens it inside its own network, so a published port, such as the template's loopback mapping, still reaches it.
- **Applying a return:** check the workflow owner's activity after its contributors, and repeat those checks after waiting for another operation. If the service stays busy, the call writes nothing and asks to be repeated unchanged. Work can still start after the final native observation.
- **Planning traffic:** an open planning pause no longer re-reads every acknowledged chat each second.
- **Other server aliases and gateways:** a deployment that registers the workflow server under another name can list it exactly in `WORKFLOW_MCP_SERVER_ALIASES`. A deployment whose agents reach tools through a gateway other than MCPX can list that gateway's exact call tool names in `WORKFLOW_MCP_GATEWAY_TOOLS`, for example `mcp__other_gateway__call_tool`. The Supervisor's workflow calls through a listed gateway are then recognised, and so are its and its helpers' reads of chats. Unlisted names stay unrecognised, and MCPX remains the default.
- **Retired reminder rules:** the dashboard snapshot no longer carries the retired reminder rules, their settings, mutes or token budget. Stored history is kept.
- **Documentation:** the docs now explain when the service settles a finished main chat and how to keep it active, and two outdated, installation-specific documents were removed.
