import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { AgentSessionEventReducer, watchAgentSession } from "./agent-session-monitor.js";
import { buildAgentTerminalCommand } from "./ai-terminal.js";

function codexUserInterruptMarker() {
  return {
    type: "response_item",
    payload: {
      type: "message",
      role: "developer",
      content: [
        {
          type: "input_text",
          text: [
            "<turn_aborted>",
            "The previous turn was interrupted on purpose.",
            "</turn_aborted>",
          ].join("\n"),
        },
      ],
    },
  };
}

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

test("interactive CLI prompt quoting prevents shell expansion", () => {
  assert.equal(
    buildAgentTerminalCommand("claude-cli", "default", { prompt: "check $(whoami) and it's safe" })
      .command,
    process.platform === "win32"
      ? "claude --permission-mode acceptEdits 'check $(whoami) and it''s safe'"
      : "claude --permission-mode acceptEdits 'check $(whoami) and it'\\''s safe'",
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

test("Claude Bash waits only after Claude emits a permission prompt", () => {
  const reducer = new AgentSessionEventReducer("claude");
  assert.deepEqual(
    reducer.push({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "bash_1", name: "Bash", input: {} }],
      },
    }),
    [],
  );
  assert.deepEqual(
    reducer.pushClaudePermission({
      osheep_event: "claude-permission-request",
      payload: { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_use_id: "bash_1" },
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

test("Claude tools do not invent permission waits in any permission mode", () => {
  for (const permissionMode of [
    "manual",
    "acceptEdits",
    "plan",
    "auto",
    "dontAsk",
    "bypassPermissions",
  ]) {
    const reducer = new AgentSessionEventReducer("claude");
    reducer.push({ type: "permission-mode", permissionMode });
    assert.deepEqual(
      reducer.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: `skill_${permissionMode}`, name: "Skill", input: {} }],
        },
      }),
      [],
    );
  }
});

test("Claude Skill permission prompt waits and its matching result resumes", () => {
  const reducer = new AgentSessionEventReducer("claude");
  assert.deepEqual(
    reducer.push({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "skill_1", name: "Skill", input: {} }],
      },
    }),
    [],
  );
  assert.deepEqual(
    reducer.pushClaudePermission({
      osheep_event: "claude-permission-request",
      payload: {
        hook_event_name: "PermissionRequest",
        tool_name: "Skill",
        tool_use_id: "skill_1",
      },
    }),
    [{ state: "waiting-for-choice" }],
  );
  assert.deepEqual(
    reducer.push({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "skill_1", is_error: true }],
      },
    }),
    [{ state: "running" }],
  );
});

test("Claude Skill permission without tool_use_id binds after session tool use", () => {
  const reducer = new AgentSessionEventReducer("claude");
  assert.deepEqual(
    reducer.pushClaudePermission({
      osheep_event: "claude-permission-request",
      payload: { hook_event_name: "PermissionRequest", tool_name: "Skill" },
    }),
    [{ state: "waiting-for-choice" }],
  );
  assert.deepEqual(
    reducer.push({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "skill_late", name: "Skill", input: {} }],
      },
    }),
    [],
  );
  assert.deepEqual(
    reducer.push({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "skill_late" }] },
    }),
    [{ state: "running" }],
  );
});

test("Claude Bash permission without tool_use_id binds to an existing session tool", () => {
  const reducer = new AgentSessionEventReducer("claude");
  reducer.push({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "bash_early", name: "Bash", input: {} }],
    },
  });
  assert.deepEqual(
    reducer.pushClaudePermission({
      osheep_event: "claude-permission-request",
      payload: { hook_event_name: "PermissionRequest", tool_name: "Bash" },
    }),
    [{ state: "waiting-for-choice" }],
  );
  assert.deepEqual(
    reducer.push({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bash_early" }] },
    }),
    [{ state: "running" }],
  );
});

test("Claude PermissionRequest directly waits for tools selected by Claude's permission engine", () => {
  const reducer = new AgentSessionEventReducer("claude");
  reducer.push({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: "skill_auto", name: "Skill", input: {} }],
    },
  });
  assert.deepEqual(
    reducer.pushClaudePermission({
      osheep_event: "claude-permission-request",
      payload: {
        hook_event_name: "PermissionRequest",
        tool_name: "Skill",
        tool_use_id: "skill_auto",
      },
    }),
    [{ state: "waiting-for-choice" }],
  );
  assert.deepEqual(
    reducer.push({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "skill_auto" }] },
    }),
    [{ state: "running" }],
  );
  assert.deepEqual(reducer.push({ type: "system", subtype: "turn_duration" }), [
    { state: "completed", outcome: "success" },
  ]);
});

test("Claude automatic tool results do not release a pending permission tool", () => {
  const reducer = new AgentSessionEventReducer("claude");
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
    [],
  );
  assert.deepEqual(
    reducer.pushClaudePermission({
      osheep_event: "claude-permission-request",
      payload: { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_use_id: "bash_1" },
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

test("Claude user-rejected tools wait for replacement input before the next turn completes", () => {
  for (const toolName of ["Skill", "Bash", "Write", "mcp__demo__mutate"]) {
    const reducer = new AgentSessionEventReducer("claude");
    const toolUseId = `${toolName}_1`;
    reducer.push({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: toolUseId, name: toolName }],
      },
    });
    reducer.pushClaudePermission({
      osheep_event: "claude-permission-request",
      payload: {
        hook_event_name: "PermissionRequest",
        tool_name: toolName,
        tool_use_id: toolUseId,
      },
    });

    assert.deepEqual(
      reducer.push({
        type: "user",
        subtype: "error",
        is_error: true,
        toolDenialKind: "user-rejected",
        toolUseResult: "User rejected tool use",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              is_error: true,
              content: "The user doesn't want to proceed with this tool use.",
            },
          ],
        },
      }),
      [],
      toolName,
    );
    assert.deepEqual(
      reducer.push({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
        },
      }),
      [],
      toolName,
    );
    assert.deepEqual(
      reducer.push({ type: "system", subtype: "turn_duration" }),
      [{ state: "waiting-for-choice" }],
      toolName,
    );
    assert.deepEqual(
      reducer.push({
        type: "user",
        message: { role: "user", content: "Please continue without that tool." },
      }),
      [{ state: "running" }],
      toolName,
    );
    assert.deepEqual(
      reducer.push({ type: "system", subtype: "turn_duration" }),
      [{ state: "completed", outcome: "success" }],
      toolName,
    );
  }
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

  const disabledKey = new AgentSessionEventReducer("codex");
  disabledKey.push({ type: "event_msg", payload: { type: "task_started", turn_id: "turn_3" } });
  const disabledKeyMessage =
    'unexpected status 401 Unauthorized: {"code":"API_KEY_DISABLED","message":"API key is disabled"}, url: https://aihub.top/responses, request id: request_1';
  assert.deepEqual(
    disabledKey.push({
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn_3",
        last_agent_message: "",
        error: { message: disabledKeyMessage, codex_error_info: "other" },
      },
    }),
    [{ state: "completed", outcome: "error", error: disabledKeyMessage }],
  );
});

test("Codex reports a stream error after its internal retry limit is exhausted", () => {
  const reducer = new AgentSessionEventReducer("codex");
  reducer.push({ type: "event_msg", payload: { type: "task_started", turn_id: "turn_1" } });

  assert.deepEqual(
    reducer.push({
      type: "event_msg",
      payload: {
        type: "stream_error",
        turn_id: "turn_1",
        message: "Reconnecting... 5/5",
      },
    }),
    [],
  );
  assert.deepEqual(
    reducer.push({
      type: "event_msg",
      payload: {
        type: "stream_error",
        turn_id: "turn_1",
        message: "exceeded retry limit, last status: 429 Too Many Requests, request id: request_1",
      },
    }),
    [
      {
        state: "completed",
        outcome: "error",
        error: "exceeded retry limit, last status: 429 Too Many Requests, request id: request_1",
      },
    ],
  );
});

test("Codex API error events are not treated as user interruptions", () => {
  const reducer = new AgentSessionEventReducer("codex");
  reducer.push({ type: "event_msg", payload: { type: "task_started", turn_id: "turn_1" } });

  assert.deepEqual(
    reducer.push({
      type: "event_msg",
      payload: {
        type: "error",
        turn_id: "turn_1",
        message:
          'unexpected status 401 Unauthorized: {"code":"API_KEY_DISABLED","message":"API key is disabled"}',
      },
    }),
    [
      {
        state: "completed",
        outcome: "error",
        error:
          'unexpected status 401 Unauthorized: {"code":"API_KEY_DISABLED","message":"API key is disabled"}',
      },
    ],
  );

  const aborted = new AgentSessionEventReducer("codex");
  aborted.push({ type: "event_msg", payload: { type: "task_started", turn_id: "turn_2" } });
  assert.deepEqual(
    aborted.push({
      type: "event_msg",
      payload: {
        type: "turn_aborted",
        turn_id: "turn_2",
        reason: "last status: 429 Too Many Requests",
      },
    }),
    [{ state: "completed", outcome: "error", error: "last status: 429 Too Many Requests" }],
  );

  const genericAbort = new AgentSessionEventReducer("codex");
  genericAbort.push({ type: "event_msg", payload: { type: "task_started", turn_id: "turn_3" } });
  assert.deepEqual(
    genericAbort.push(
      {
        type: "event_msg",
        payload: { type: "turn_aborted", turn_id: "turn_3", reason: "interrupted" },
      },
      100,
    ),
    [],
  );
  assert.deepEqual(genericAbort.poll(350), [
    { state: "completed", outcome: "error", error: "interrupted" },
  ]);
});

test("Codex user input and approval events do not directly drive waiting state", () => {
  const reducer = new AgentSessionEventReducer("codex");
  reducer.push({ type: "event_msg", payload: { type: "task_started", turn_id: "turn_1" } }, 0);
  assert.deepEqual(
    reducer.push({
      type: "event_msg",
      payload: { type: "request_user_input", turn_id: "turn_1" },
    }),
    [],
  );
  assert.deepEqual(
    reducer.push({
      type: "event_msg",
      payload: { type: "user_input", turn_id: "turn_1" },
    }),
    [],
  );
  assert.deepEqual(reducer.push(codexUserInterruptMarker()), []);
  assert.deepEqual(
    reducer.push(
      {
        type: "event_msg",
        payload: { type: "turn_aborted", turn_id: "turn_1", reason: "interrupted" },
      },
      100,
    ),
    [],
  );
  assert.deepEqual(reducer.poll(349), []);
  assert.deepEqual(reducer.poll(350), [
    { state: "completed", outcome: "cancelled", error: "interrupted" },
  ]);
});

test("Codex declined approval does not directly drive waiting state", () => {
  const reducer = new AgentSessionEventReducer("codex");
  reducer.push({ type: "event_msg", payload: { type: "task_started", turn_id: "turn_1" } }, 0);
  assert.deepEqual(
    reducer.push(
      {
        type: "event_msg",
        payload: { type: "turn_aborted", turn_id: "turn_1" },
      },
      100,
    ),
    [],
  );
  assert.deepEqual(
    reducer.push(
      {
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn_1",
          item: {
            type: "CommandExecution",
            status: "declined",
            stderr: "approval request aborted",
            exit_code: -1,
          },
        },
      },
      106,
    ),
    [],
  );
  assert.deepEqual(reducer.poll(1_000), []);
  assert.deepEqual(
    reducer.push({ type: "event_msg", payload: { type: "task_started", turn_id: "turn_2" } }),
    [{ state: "running" }],
  );
  assert.deepEqual(
    reducer.push({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn_2" } }),
    [{ state: "completed", outcome: "success" }],
  );
});

test("Codex declined approval retains rejected-turn completion handling", () => {
  const reducer = new AgentSessionEventReducer("codex");
  reducer.push({ type: "event_msg", payload: { type: "task_started", turn_id: "turn_1" } });
  assert.deepEqual(
    reducer.push({
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn_1",
        item: { type: "CommandExecution", status: "declined" },
      },
    }),
    [],
  );
  assert.deepEqual(
    reducer.push({
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn_1",
        error: { message: "approval request aborted" },
      },
    }),
    [],
  );
});

test("Codex function calls do not directly drive waiting state", () => {
  const reducer = new AgentSessionEventReducer("codex");
  reducer.push({ type: "event_msg", payload: { type: "task_started", turn_id: "turn_1" } });
  assert.deepEqual(
    reducer.push({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "request_user_input",
        call_id: "call_1",
        internal_chat_message_metadata_passthrough: { turn_id: "model_turn_2" },
      },
    }),
    [],
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
    [],
  );
});

test("Codex silent exec falls back to waiting and resumes on matching output", () => {
  const reducer = new AgentSessionEventReducer("codex");
  reducer.push({ type: "event_msg", payload: { type: "task_started", turn_id: "task_turn" } }, 0);
  reducer.push(
    {
      type: "response_item",
      payload: { type: "custom_tool_call", name: "exec", call_id: "call_1" },
    },
    100,
  );
  assert.deepEqual(reducer.poll(5_099), []);
  assert.deepEqual(reducer.poll(5_100), [{ state: "waiting-for-choice" }]);
  assert.deepEqual(reducer.poll(6_000), []);
  assert.deepEqual(
    reducer.push({
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "call_1" },
    }),
    [{ state: "running" }],
  );
});

test("Codex fast exec output cancels the silent waiting fallback", () => {
  const reducer = new AgentSessionEventReducer("codex");
  reducer.push({ type: "event_msg", payload: { type: "task_started", turn_id: "task_turn" } }, 0);
  reducer.push(
    {
      type: "response_item",
      payload: { type: "custom_tool_call", name: "exec", call_id: "call_1" },
    },
    100,
  );
  assert.deepEqual(
    reducer.push(
      {
        type: "response_item",
        payload: { type: "custom_tool_call_output", call_id: "call_1" },
      },
      500,
    ),
    [],
  );
  assert.deepEqual(reducer.poll(5_000), []);
});

test("Codex reducer continues with a new turn after an aborted turn", () => {
  const reducer = new AgentSessionEventReducer("codex");
  reducer.push({ type: "event_msg", payload: { type: "task_started", turn_id: "turn_1" } }, 0);
  reducer.push(codexUserInterruptMarker());
  assert.deepEqual(
    reducer.push(
      {
        type: "event_msg",
        payload: { type: "turn_aborted", turn_id: "turn_1", reason: "interrupted" },
      },
      100,
    ),
    [],
  );
  assert.deepEqual(reducer.poll(350), [
    { state: "completed", outcome: "cancelled", error: "interrupted" },
  ]);
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
    await appendJsonl(filePath, codexUserInterruptMarker());
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

test("JSONL watcher accepts an API error after continuing from an explicit user interrupt", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-codex-interrupt-error-"));
  const filePath = path.join(directory, "session.jsonl");
  await fs.writeFile(filePath, "");
  const events: string[] = [];
  const errorMessage =
    'unexpected status 401 Unauthorized: {"code":"API_KEY_DISABLED","message":"API key is disabled"}';
  try {
    const watched = watchAgentSession({
      app: "codex",
      sessionId: "session",
      filePath,
      onEvent: (event) => events.push(`${event.state}:${event.outcome ?? ""}`),
      acceptCompletion: (event) => event.outcome !== "cancelled",
    });
    await appendJsonl(filePath, {
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn_1" },
    });
    await appendJsonl(filePath, codexUserInterruptMarker());
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
      payload: {
        type: "task_complete",
        turn_id: "turn_2",
        last_agent_message: null,
        error: { message: errorMessage, codex_error_info: "other" },
      },
    });

    assert.deepEqual(await watched, { state: "completed", outcome: "error", error: errorMessage });
    assert.deepEqual(events, ["running:", "completed:cancelled", "running:", "completed:error"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a completed turn after ESC clears interruption handling for later API errors", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-codex-interrupt-next-error-"));
  const filePath = path.join(directory, "session.jsonl");
  await fs.writeFile(filePath, "");
  const errorMessage =
    'unexpected status 401 Unauthorized: {"code":"API_KEY_DISABLED","message":"API key is disabled"}';
  try {
    const watched = watchAgentSession({
      app: "codex",
      sessionId: "session",
      filePath,
      onEvent: () => {},
      // Model a workflow terminal that continues after ESC and after a manual-success turn.
      acceptCompletion: (event) => event.outcome === "error",
    });
    await appendJsonl(filePath, {
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn_1" },
    });
    await appendJsonl(filePath, codexUserInterruptMarker());
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
      payload: { type: "task_complete", turn_id: "turn_2", last_agent_message: "done" },
    });
    await appendJsonl(filePath, {
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn_3" },
    });
    await appendJsonl(filePath, {
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn_3",
        last_agent_message: null,
        error: { message: errorMessage, codex_error_info: "other" },
      },
    });

    assert.deepEqual(await watched, { state: "completed", outcome: "error", error: errorMessage });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("JSONL watcher waits after a Claude rejection and completes the replacement turn", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-claude-rejected-"));
  const filePath = path.join(directory, "session.jsonl");
  await fs.writeFile(filePath, "");
  const events: string[] = [];
  try {
    const watched = watchAgentSession({
      app: "claude",
      sessionId: "session",
      filePath,
      onEvent: (event) => events.push(`${event.state}:${event.outcome ?? ""}`),
    });
    await appendJsonl(filePath, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool_1", name: "Bash" }],
      },
    });
    await appendJsonl(filePath, {
      type: "user",
      subtype: "error",
      is_error: true,
      toolDenialKind: "user-rejected",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool_1", is_error: true }],
      },
    });
    await appendJsonl(filePath, {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
      },
    });
    await appendJsonl(filePath, { type: "system", subtype: "turn_duration" });
    assert.deepEqual(events, ["waiting-for-choice:"]);

    await appendJsonl(filePath, {
      type: "user",
      message: { role: "user", content: "Continue without running the command." },
    });
    assert.deepEqual(events, ["waiting-for-choice:", "running:"]);
    await appendJsonl(filePath, { type: "system", subtype: "turn_duration" });

    assert.deepEqual(await watched, { state: "completed", outcome: "success" });
    assert.deepEqual(events, ["waiting-for-choice:", "running:", "completed:success"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("JSONL watcher completes a Codex abort after its declined-event window", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-codex-aborted-"));
  const filePath = path.join(directory, "session.jsonl");
  await fs.writeFile(
    filePath,
    [
      JSON.stringify({
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn_1" },
      }),
      JSON.stringify(codexUserInterruptMarker()),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "turn_aborted", turn_id: "turn_1", reason: "interrupted" },
      }),
      "",
    ].join("\n"),
  );
  try {
    assert.deepEqual(
      await watchAgentSession({ app: "codex", sessionId: "session", filePath, onEvent: () => {} }),
      { state: "completed", outcome: "cancelled", error: "interrupted" },
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("JSONL watcher combines Claude permission sidecar and session results", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-claude-monitor-"));
  const filePath = path.join(directory, "session.jsonl");
  const permissionFilePath = path.join(directory, "permission.jsonl");
  await fs.writeFile(filePath, "");
  const events: string[] = [];
  try {
    const watched = watchAgentSession({
      app: "claude",
      sessionId: "session",
      filePath,
      permissionFilePath,
      onEvent: (event) => events.push(`${event.state}:${event.outcome ?? ""}`),
    });
    await appendJsonl(filePath, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "skill_1", name: "Skill" }],
      },
    });
    await appendJsonl(permissionFilePath, {
      osheep_event: "claude-permission-request",
      payload: { hook_event_name: "PermissionRequest", tool_name: "Skill", tool_use_id: "skill_1" },
    });
    await appendJsonl(filePath, {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "skill_1" }] },
    });
    await appendJsonl(filePath, { type: "system", subtype: "turn_duration" });

    assert.deepEqual(await watched, { state: "completed", outcome: "success" });
    assert.deepEqual(events, ["waiting-for-choice:", "running:", "completed:success"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("JSONL watcher falls back to waiting for a silent Codex exec", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-codex-silent-"));
  const filePath = path.join(directory, "session.jsonl");
  await fs.writeFile(filePath, "");
  const events: string[] = [];
  const controller = new AbortController();
  try {
    const watched = watchAgentSession({
      app: "codex",
      sessionId: "session",
      filePath,
      signal: controller.signal,
      onEvent: (event) => events.push(event.state),
    });
    await appendJsonl(filePath, {
      type: "event_msg",
      payload: { type: "task_started", turn_id: "task_turn" },
    });
    await appendJsonl(filePath, {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: "call_1",
        internal_chat_message_metadata_passthrough: { turn_id: "model_turn" },
      },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 5_150));
    assert.deepEqual(events, ["running", "waiting-for-choice"]);
    await appendJsonl(filePath, {
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "call_1" },
    });
    controller.abort();
    await watched;
    assert.deepEqual(events, ["running", "waiting-for-choice", "running"]);
  } finally {
    controller.abort();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`);
  await new Promise<void>((resolve) => setTimeout(resolve, 160));
}
