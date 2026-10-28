import assert from "node:assert/strict";
import { it } from "vitest";
import { recognisedThreadReadArguments, recognisedWorkflowCallArguments } from "../src/workflow-write-evidence.js";

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
