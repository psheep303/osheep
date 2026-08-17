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
});

test("Codex user input and approval events drive waiting state", () => {
  const reducer = new AgentSessionEventReducer("codex");
  reducer.push({ type: "event_msg", payload: { type: "task_started", turn_id: "turn_1" } }, 0);
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

test("Codex declined approval waits for replacement input before the next turn completes", () => {
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
    [{ state: "waiting-for-choice" }],
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

test("Codex declined approval ignores the rejected turn's later completion error", () => {
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
    [{ state: "waiting-for-choice" }],
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

test("Codex function calls are not filtered by model-internal turn metadata", () => {
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

test("Codex PermissionRequest sidecar waits until its matching tool output", () => {
  const reducer = new AgentSessionEventReducer("codex");
  reducer.push({ type: "event_msg", payload: { type: "task_started", turn_id: "turn_1" } });
  assert.deepEqual(
    reducer.pushCodexPermission({
      osheep_event: "codex-permission-request",
      payload: {
        hook_event_name: "PermissionRequest",
        tool_name: "exec",
        tool_use_id: "call_1",
      },
    }),
    [{ state: "waiting-for-choice" }],
  );
  assert.deepEqual(
    reducer.push({
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "other" },
    }),
    [],
  );
  assert.deepEqual(
    reducer.push({
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "call_1" },
    }),
    [{ state: "running" }],
  );
});

test("Codex PermissionRequest without a tool id binds before or after the rollout call", () => {
  for (const permissionFirst of [true, false]) {
    const reducer = new AgentSessionEventReducer("codex");
    reducer.push({ type: "event_msg", payload: { type: "task_started", turn_id: "turn_1" } });
    const permission = () =>
      reducer.pushCodexPermission({
        osheep_event: "codex-permission-request",
        payload: { hook_event_name: "PermissionRequest", tool_name: "exec" },
      });
    const toolCall = () =>
      reducer.push({
        type: "response_item",
        payload: { type: "custom_tool_call", name: "exec", call_id: "call_1" },
      });
    if (permissionFirst) {
      assert.deepEqual(permission(), [{ state: "waiting-for-choice" }]);
      assert.deepEqual(toolCall(), []);
    } else {
      assert.deepEqual(toolCall(), []);
      assert.deepEqual(permission(), [{ state: "waiting-for-choice" }]);
    }
    assert.deepEqual(
      reducer.push({
        type: "response_item",
        payload: { type: "custom_tool_call_output", call_id: "call_1" },
      }),
      [{ state: "running" }],
    );
  }
});

test("Codex permission binds despite a different model-internal turn id", () => {
  const reducer = new AgentSessionEventReducer("codex");
  reducer.push({ type: "event_msg", payload: { type: "task_started", turn_id: "task_turn" } });
  assert.deepEqual(
    reducer.push({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: "call_1",
        internal_chat_message_metadata_passthrough: { turn_id: "model_turn" },
      },
    }),
    [],
  );
  assert.deepEqual(
    reducer.pushCodexPermission({
      osheep_event: "codex-permission-request",
      payload: { hook_event_name: "PermissionRequest" },
    }),
    [{ state: "waiting-for-choice" }],
  );
  assert.deepEqual(
    reducer.push({
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "call_1" },
    }),
    [{ state: "running" }],
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
  assert.deepEqual(reducer.poll(4_099), []);
  assert.deepEqual(reducer.poll(4_100), [{ state: "waiting-for-choice" }]);
  assert.deepEqual(reducer.poll(5_000), []);
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

test("Codex explicit permission sidecar supersedes the silent exec fallback", () => {
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
    reducer.pushCodexPermission({
      osheep_event: "codex-permission-request",
      payload: { hook_event_name: "PermissionRequest" },
    }),
    [{ state: "waiting-for-choice" }],
  );
  assert.deepEqual(reducer.poll(5_000), []);
});

test("Codex initial task_started does not overwrite an earlier sidecar wait", () => {
  const reducer = new AgentSessionEventReducer("codex");
  assert.deepEqual(
    reducer.pushCodexPermission({
      osheep_event: "codex-permission-request",
      payload: { hook_event_name: "PermissionRequest" },
    }),
    [{ state: "waiting-for-choice" }],
  );
  assert.deepEqual(
    reducer.push({ type: "event_msg", payload: { type: "task_started", turn_id: "turn_1" } }),
    [],
  );
  assert.deepEqual(
    reducer.push({
      type: "response_item",
      payload: { type: "custom_tool_call", name: "exec", call_id: "call_1" },
    }),
    [],
  );
  assert.deepEqual(
    reducer.push({
      type: "response_item",
      payload: { type: "custom_tool_call_output", call_id: "call_1" },
    }),
    [{ state: "running" }],
  );
});

test("Codex reducer continues with a new turn after an aborted turn", () => {
  const reducer = new AgentSessionEventReducer("codex");
  reducer.push({ type: "event_msg", payload: { type: "task_started", turn_id: "turn_1" } }, 0);
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

test("JSONL watcher waits after a Codex decline and completes the replacement turn", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-codex-declined-"));
  const filePath = path.join(directory, "session.jsonl");
  await fs.writeFile(filePath, "");
  const events: string[] = [];
  try {
    const watched = watchAgentSession({
      app: "codex",
      sessionId: "session",
      filePath,
      onEvent: (event) => events.push(`${event.state}:${event.outcome ?? ""}`),
    });
    await appendJsonl(filePath, {
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn_1" },
    });
    await fs.appendFile(
      filePath,
      [
        JSON.stringify({
          type: "event_msg",
          payload: { type: "turn_aborted", turn_id: "turn_1" },
        }),
        JSON.stringify({
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
        }),
        "",
      ].join("\n"),
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(events, ["running:", "waiting-for-choice:"]);
    await appendJsonl(filePath, {
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn_2" },
    });
    await appendJsonl(filePath, {
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn_2" },
    });

    assert.deepEqual(await watched, { state: "completed", outcome: "success" });
    assert.deepEqual(events, ["running:", "waiting-for-choice:", "running:", "completed:success"]);
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

test("JSONL watcher combines Codex permission sidecar and tool output", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-codex-monitor-"));
  const filePath = path.join(directory, "session.jsonl");
  const permissionFilePath = path.join(directory, "permission.jsonl");
  await fs.writeFile(filePath, "");
  const events: string[] = [];
  const controller = new AbortController();
  try {
    const watched = watchAgentSession({
      app: "codex",
      sessionId: "session",
      filePath,
      permissionFilePath,
      signal: controller.signal,
      onEvent: (event) => events.push(`${event.state}:${event.outcome ?? ""}`),
    });
    await appendJsonl(filePath, {
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn_1" },
    });
    await appendJsonl(permissionFilePath, {
      osheep_event: "codex-permission-request",
      payload: { hook_event_name: "PermissionRequest", tool_name: "exec", tool_use_id: "call_1" },
    });
    await appendJsonl(filePath, {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call_1",
        output: "ok",
        internal_chat_message_metadata_passthrough: { turn_id: "model_turn_2" },
      },
    });
    controller.abort();
    await watched;
    assert.deepEqual(events, ["running:", "waiting-for-choice:", "running:"]);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("JSONL watcher replays Codex session state before an existing permission sidecar", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-codex-order-"));
  const filePath = path.join(directory, "session.jsonl");
  const permissionFilePath = path.join(directory, "permission.jsonl");
  await fs.writeFile(
    filePath,
    [
      JSON.stringify({
        type: "event_msg",
        payload: { type: "task_started", turn_id: "turn_1" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "call_1",
          internal_chat_message_metadata_passthrough: { turn_id: "model_turn_2" },
        },
      }),
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    permissionFilePath,
    `${JSON.stringify({
      osheep_event: "codex-permission-request",
      payload: { hook_event_name: "PermissionRequest" },
    })}\n`,
  );
  const events: string[] = [];
  const controller = new AbortController();
  try {
    const watched = watchAgentSession({
      app: "codex",
      sessionId: "session",
      filePath,
      permissionFilePath,
      signal: controller.signal,
      onEvent: (event) => events.push(event.state),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 180));
    controller.abort();
    await watched;
    assert.deepEqual(events, ["running", "waiting-for-choice"]);
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
    await new Promise<void>((resolve) => setTimeout(resolve, 4_150));
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
