import { type AgentTerminalResult, runAgentTerminal } from "../ai-terminal.js";
import { TerminalAgentAdapter } from "./agent-adapter-base.js";
import type { AdapterCapabilities, AdapterConfigSchema } from "./types.js";
export class ClaudeCodeAdapter extends TerminalAgentAdapter {
  readonly id = "claude-code" as const;
  readonly name = "Claude Code";
  readonly version = "1.0.0";
  getCapabilities(): AdapterCapabilities {
    return {
      streaming: true,
      structuredEvents: true,
      session: true,
      resume: true,
      multiTurn: false,
      approval: "manual",
      interruption: "hard",
      transport: "pty",
      modelSelection: true,
      workingDirectory: true,
      usage: true,
    };
  }
  getConfigSchema(): AdapterConfigSchema {
    return {
      fields: [
        { key: "model", label: "Model", type: "text", defaultValue: "default" },
        { key: "workingDirectory", label: "Working Directory", type: "text" },
        {
          key: "claudePermissionMode",
          label: "Permission Mode",
          type: "select",
          options: ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"].map(
            (value) => ({ value, label: value }),
          ),
        },
        {
          key: "effort",
          label: "Effort",
          type: "select",
          options: ["low", "medium", "high", "xhigh", "max"].map((value) => ({
            value,
            label: value,
          })),
        },
      ],
    };
  }
  run(input: Parameters<TerminalAgentAdapter["run"]>[0]): Promise<AgentTerminalResult> {
    const c = input.config;
    return runAgentTerminal({
      workspace: input.workspace,
      kind: "claude-cli",
      model: c.model ?? "default",
      prompt: input.prompt,
      claudePermissionMode: c.claudePermissionMode,
      effort: c.effort,
      conversationSessionId: input.nativeSessionId,
      resumeConversation: input.resume,
      signal: input.signal,
      onFrame: input.onFrame,
    });
  }
}
