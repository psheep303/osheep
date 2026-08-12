import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { AgentSessionEventReducer, watchAgentSession } from "./agent-session-monitor.js";
import { buildAgentTerminalCommand } from "./ai-terminal.js";

test("interactive CLI commands receive the initial prompt without terminal readiness parsing", () => {
  assert.equal(
    buildAgentTerminalCommand("claude-cli", "default", { prompt: "analyze this project" }).command,
    "claude --permission-mode acceptEdits 'analyze this project'",
  );
  assert.equal(
    buildAgentTerminalCommand("codex-cli", "default", { prompt: "analyze this project" }).command,
    "codex --ask-for-approval on-request --sandbox workspace-write 'analyze this project'",
  );
});

test("interactive CLI prompt quoting prevents PowerShell expansion", () => {
  assert.equal(
    buildAgentTerminalCommand("claude-cli", "default", { prompt: "check $(whoami) and it's safe" })
      .command,
    "claude --permission-mode acceptEdits 'check $(whoami) and it''s safe'",
  );
});

test("Claude AskUserQuestion waits until its tool result and ignores turn completion while pending", () => {
  const reducer = new AgentSessionEventReducer("claude");
  assert.deepEqual(
    reducer.push({
      type: "assistant",
      isSidechain: false,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "ask_1", name: "AskUserQuestion", input: {} }],
      },
    }),
    [{ state: "waiting-for-choice" }],
  );
  assert.deepEqual(reducer.push({ type: "system", subtype: "turn_duration" }), []);
  assert.deepEqual(
    reducer.push({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "ask_1" }] },
    }),
    [{ state: "running" }],
  );
  assert.deepEqual(reducer.push({ type: "system", subtype: "turn_duration" }), [
    { state: "completed", outcome: "success" },
  ]);
});

test("Claude permission-gated Bash waits from tool use until its result", () => {
  const reducer = new AgentSessionEventReducer("claude");
  assert.deepEqual(reducer.push({ type: "permission-mode", permissionMode: "acceptEdits" }), []);
  assert.deepEqual(
    reducer.push({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "bash_1", name: "Bash", input: {} }],
      },
    }),
    [{ state: "waiting-for-choice" }],
  );
  assert.deepEqual(reducer.push({ type: "system", subtype: "turn_duration" }), []);
  assert.deepEqual(
    reducer.push({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bash_1" }] },
    }),
    [{ state: "running" }],
  );
  assert.deepEqual(reducer.push({ type: "system", subtype: "turn_duration" }), [
    { state: "completed", outcome: "success" },
  ]);
});

test("Claude acceptEdits and bypass modes do not invent permission waits", () => {
  const acceptEdits = new AgentSessionEventReducer("claude");
  acceptEdits.push({ type: "permission-mode", permissionMode: "acceptEdits" });
  assert.deepEqual(
    acceptEdits.push({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "edit_1", name: "Edit", input: {} }],
      },
    }),
    [],
  );

  const bypass = new AgentSessionEventReducer("claude");
  bypass.push({ type: "permission-mode", permissionMode: "bypassPermissions" });
  assert.deepEqual(
    bypass.push({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "bash_1", name: "Bash", input: {} }],
      },
    }),
    [],
  );
});

test("Claude automatic tool results do not release a pending permission tool", () => {
  const reducer = new AgentSessionEventReducer("claude");
  reducer.push({ type: "permission-mode", permissionMode: "acceptEdits" });
  assert.deepEqual(
    reducer.push({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "read_1", name: "Read", input: {} },
          { type: "tool_use", id: "bash_1", name: "Bash", input: {} },
        ],
      },
    }),
    [{ state: "waiting-for-choice" }],
  );
  assert.deepEqual(
    reducer.push({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "read_1" }] },
    }),
    [],
  );
  assert.deepEqual(
    reducer.push({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bash_1" }] },
    }),
    [{ state: "running" }],
  );
});

test("Claude ignores sidechain questions and reports structured errors", () => {
  const reducer = new AgentSessionEventReducer("claude");
  assert.deepEqual(
    reducer.push({
      isSidechain: true,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "ask", name: "AskUserQuestion" }],
      },
    }),
    [],
  );
  assert.deepEqual(
    reducer.push({ type: "result", subtype: "error", error: "provider unavailable" }),
    [{ state: "completed", outcome: "error", error: "provider unavailable" }],
  );
});

test("Claude reports the structured API error used by the interactive CLI", () => {
  const reducer = new AgentSessionEventReducer("claude");
  assert.deepEqual(
    reducer.push({
      type: "assistant",
      error: "server_error",
      isApiErrorMessage: true,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "API Error: 524 origin response timeout" }],
      },
    }),
    [
      {
        state: "completed",
        outcome: "error",
        error: "API Error: 524 origin response timeout",
      },
    ],
  );
});

test("Claude interruption clears a pending question so the next turn can complete", () => {
  const reducer = new AgentSessionEventReducer("claude");
  reducer.push({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "ask_1", name: "AskUserQuestion" }],
    },
  });
  assert.deepEqual(
    reducer.push({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "[Request interrupted by user]" }],
      },
    }),
    [
      {
        state: "completed",
        outcome: "cancelled",
        error: "Claude Code turn was interrupted.",
      },
    ],
  );
  assert.deepEqual(reducer.push({ type: "system", subtype: "turn_duration" }), [
    { state: "completed", outcome: "success" },
  ]);
});

test("Codex task_complete distinguishes success and error for the active turn", () => {
  const success = new AgentSessionEventReducer("codex");
  assert.deepEqual(
    success.push({ type: "event_msg", payload: { type: "task_started", turn_id: "turn_1" } }),
    [{ state: "running" }],
  );
  assert.deepEqual(
    success.push({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn_old" } }),
    [],
  );
  assert.deepEqual(
    success.push({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn_1" } }),
    [{ state: "completed", outcome: "success" }],
  );

  const failed = new AgentSessionEventReducer("codex");
  failed.push({ type: "event_msg", payload: { type: "task_started", turn_id: "turn_2" } });
  assert.deepEqual(
    failed.push({
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn_2", error: { message: "503 unavailable" } },
    }),
    [{ state: "completed", outcome: "error", error: "503 unavailable" }],
  );
});

test("Codex user input and approval events drive waiting state", () => {
  const reducer = new AgentSessionEventReducer("codex");
  reducer.push({ type: "event_msg", payload: { type: "task_started", turn_id: "turn_1" } });
  assert.deepEqual(
    reducer.push({
      type: "event_msg",
      payload: { type: "request_user_input", turn_id: "turn_1" },
    }),
    [{ state: "waiting-for-choice" }],
  );
  assert.deepEqual(
    reducer.push({
      type: "event_msg",
      payload: { type: "user_input", turn_id: "turn_1" },
    }),
    [{ state: "running" }],
  );
  assert.deepEqual(
    reducer.push({
      type: "event_msg",
      payload: { type: "turn_aborted", turn_id: "turn_1", reason: "interrupted" },
    }),
    [{ state: "completed", outcome: "cancelled", error: "interrupted" }],
  );
});

test("Codex request_user_input function calls wait for their matching output", () => {
  const reducer = new AgentSessionEventReducer("codex");
  reducer.push({ type: "event_msg", payload: { type: "task_started", turn_id: "turn_1" } });
  assert.deepEqual(
    reducer.push({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_1",
        internal_chat_message_metadata_passthrough: { turn_id: "turn_old" },
      },
    }),
    [],
  );
  assert.deepEqual(
    reducer.push({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_1",
        internal_chat_message_metadata_passthrough: { turn_id: "turn_1" },
      },
    }),
    [{ state: "waiting-for-choice" }],
  );
  assert.deepEqual(
    reducer.push({
      type: "response_item",
      payload: { type: "function_call_output", call_id: "other" },
    }),
    [],
  );
  assert.deepEqual(
    reducer.push({
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call_1" },
    }),
    [{ state: "running" }],
  );
});

test("Codex reducer continues with a new turn after an aborted turn", () => {
  const reducer = new AgentSessionEventReducer("codex");
  reducer.push({ type: "event_msg", payload: { type: "task_started", turn_id: "turn_1" } });
  assert.deepEqual(
    reducer.push({
      type: "event_msg",
      payload: { type: "turn_aborted", turn_id: "turn_1", reason: "interrupted" },
    }),
    [{ state: "completed", outcome: "cancelled", error: "interrupted" }],
  );
  assert.deepEqual(
    reducer.push({ type: "event_msg", payload: { type: "task_started", turn_id: "turn_2" } }),
    [{ state: "running" }],
  );
  assert.deepEqual(
    reducer.push({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn_2" } }),
    [{ state: "completed", outcome: "success" }],
  );
});

test("JSONL watcher can reject a paused abort and accept a later turn completion", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-session-monitor-"));
  const filePath = path.join(directory, "session.jsonl");
  await fs.writeFile(filePath, "");
  const events: string[] = [];
  let completions = 0;
  try {
    const watched = watchAgentSession({
      app: "codex",
      sessionId: "session",
      filePath,
      onEvent: (event) => events.push(`${event.state}:${event.outcome ?? ""}`),
      acceptCompletion: () => {
        completions += 1;
        return completions > 1;
      },
    });
    await appendJsonl(filePath, {
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn_1" },
    });
    await appendJsonl(filePath, {
      type: "event_msg",
      payload: { type: "turn_aborted", turn_id: "turn_1", reason: "interrupted" },
    });
    await appendJsonl(filePath, {
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn_2" },
    });
    await appendJsonl(filePath, {
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn_2" },
    });

    assert.deepEqual(await watched, { state: "completed", outcome: "success" });
    assert.deepEqual(events, ["running:", "completed:cancelled", "running:", "completed:success"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`);
  await new Promise<void>((resolve) => setTimeout(resolve, 160));
}
