import assert from "node:assert/strict";
import { it } from "vitest";
import { defaultWorkflowToolRoutes, recognisedThreadReadArguments, recognisedWorkflowCallArguments, workflowToolNames, workflowToolRoutes } from "../src/workflow-write-evidence.js";

// one reading of native tool routes serves evidence, re-validated receipts and read coverage; nothing is trusted on equal arguments alone
const args = {supervisorThreadId: "root", bindingGeneration: 1, attemptId: "attempt-1"};
const item = (toolName: string, input: unknown) => ({id: "item", type: "dynamic_tool", toolName, input});

it("a workflow call counts on its direct names and through a recognised MCP call naming it, and on no other route", () => {
  for (const toolName of ["t3-supervisor-workflows.supervision_interpretation_submit", "mcp__t3-supervisor-workflows__supervision_interpretation_submit"])
    assert.deepEqual(recognisedWorkflowCallArguments(item(toolName, args), "interpretation"), args, toolName);
  const call = {name: "t3-supervisor-workflows__supervision_interpretation_submit", arguments: args};
  for (const toolName of ["mcpx.mcpx_call_tool", "mcp__mcpx__mcpx_call_tool"])
    assert.deepEqual(recognisedWorkflowCallArguments(item(toolName, call), "interpretation"), args, toolName);
  for (const [label, toolName, input] of [
    ["a renamed client alias", "mcp__supervisor__supervision_interpretation_submit", args],
    ["an unrecognised gateway with the MCP call shape", "gateway.call_tool", call],
    ["another workflow tool with equal arguments", "mcp__t3-supervisor-workflows__workflow_write", args],
    ["a recognised MCP call naming another tool", "mcpx.mcpx_call_tool", {...call, name: "t3-supervisor-workflows__workflow_write"}],
    ["a recognised MCP call with an extra key", "mcpx.mcpx_call_tool", {...call, extra: true}],
    ["a bare tool name", "supervision_interpretation_submit", args],
  ] as const) assert.equal(recognisedWorkflowCallArguments(item(toolName, input), "interpretation"), null, label);
});

it("a T3 thread read counts on its own server's routes, including a recognised MCP call, and never on another server's same-named tool", () => {
  const read = {threadId: "child", view: "activity"};
  for (const toolName of ["t3_thread_read", "mcp__t3_code__t3_thread_read", "mcp__t3-code__t3_thread_read", "t3-code.t3_thread_read"])
    assert.deepEqual(recognisedThreadReadArguments(item(toolName, read)), read, toolName);
  for (const toolName of ["mcpx.mcpx_call_tool", "mcp__mcpx__mcpx_call_tool"])
    assert.deepEqual(recognisedThreadReadArguments(item(toolName, {name: "t3-code__t3_thread_read", arguments: read})), read, toolName);
  for (const toolName of ["other__t3_thread_read", "mcp__other__t3_thread_read", "mcpx_call_tool"])
    assert.equal(recognisedThreadReadArguments(item(toolName, toolName === "mcpx_call_tool" ? {name: "t3-code__t3_thread_read", arguments: read} : read)), null, toolName);
});

// audit F7: a deployment that registers the server under other aliases, or calls it through another gateway, configures exactly those names
it("configured server aliases and gateway call tools replace the documented ones and are matched exactly, never by shape", () => {
  for (const tool of ["read", "write", "team", "guide", "stop", "start", "plan", "interpretation", "planning"] as const) {
    assert.deepEqual(defaultWorkflowToolRoutes.direct[tool], workflowToolNames[tool].direct, tool);
    assert.deepEqual(defaultWorkflowToolRoutes.targets[tool], [workflowToolNames[tool].mcpxTarget], tool);
  }
  assert.deepEqual(defaultWorkflowToolRoutes.gatewayCalls, ["mcpx.mcpx_call_tool", "mcp__mcpx__mcpx_call_tool"]);
  const routes = workflowToolRoutes(["supervisor"], ["mcp__other_gateway__call_tool", "gateway.invoke"]);
  const call = {name: "supervisor__supervision_interpretation_submit", arguments: args};
  for (const [toolName, input] of [["supervisor.supervision_interpretation_submit", args], ["mcp__supervisor__supervision_interpretation_submit", args],
    ["mcp__other_gateway__call_tool", call], ["gateway.invoke", call]] as const)
    assert.deepEqual(recognisedWorkflowCallArguments(item(toolName, input), "interpretation", routes), args, toolName);
  for (const [label, toolName, input] of [
    ["the documented alias, not configured", "mcp__t3-supervisor-workflows__supervision_interpretation_submit", args],
    ["the documented gateway, not configured", "mcpx.mcpx_call_tool", call],
    ["the documented gateway in its other form, not configured", "mcp__mcpx__mcpx_call_tool", call],
    ["an alias with a prefix", "mcp__my-supervisor__supervision_interpretation_submit", args],
    ["an alias with a suffix", "mcp__supervisor2__supervision_interpretation_submit", args],
    ["the configured operation on another server", "mcp__another_gateway__call_tool", call],
    ["the configured server's other form, not configured", "other_gateway.call_tool", call],
    ["a configured name with a suffix", "gateway.invoke_tool", call],
    ["a configured name with a prefix", "my_gateway.invoke", call],
    ["a bare operation", "invoke", call],
    ["a configured gateway naming the documented server", "gateway.invoke", {...call, name: "t3-supervisor-workflows__supervision_interpretation_submit"}],
    ["a configured gateway naming another tool", "gateway.invoke", {...call, name: "supervisor__workflow_write"}],
    ["a configured gateway with an extra key", "gateway.invoke", {...call, extra: true}],
    ["a configured gateway with another envelope", "mcp__other_gateway__call_tool", {tool: call.name, args}],
    ["a configured gateway with text arguments", "mcp__other_gateway__call_tool", {name: call.name, arguments: JSON.stringify(args)}],
  ] as const) assert.equal(recognisedWorkflowCallArguments(item(toolName, input), "interpretation", routes), null, label);
  // t3's own thread read is called through the same configured gateway call tools, and only through them
  const read = {threadId: "child", view: "activity"};
  for (const toolName of ["mcp__other_gateway__call_tool", "gateway.invoke"])
    assert.deepEqual(recognisedThreadReadArguments(item(toolName, {name: "t3-code__t3_thread_read", arguments: read}), routes), read, toolName);
  assert.deepEqual(recognisedThreadReadArguments(item("t3-code.t3_thread_read", read), routes), read, "T3's own direct read");
  for (const [label, toolName, input] of [
    ["the documented gateway, not configured", "mcpx.mcpx_call_tool", {name: "t3-code__t3_thread_read", arguments: read}],
    ["a configured gateway naming another server's read", "gateway.invoke", {name: "other__t3_thread_read", arguments: read}],
    ["a configured gateway naming a workflow tool", "gateway.invoke", {name: "supervisor__workflow_read", arguments: read}],
  ] as const) assert.equal(recognisedThreadReadArguments(item(toolName, input), routes), null, label);
});
