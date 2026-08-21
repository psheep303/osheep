import { type AgentTerminalResult, runAgentTerminal } from "../ai-terminal.js";
import { TerminalAgentAdapter } from "./agent-adapter-base.js";
import type { AdapterCapabilities, AdapterConfigSchema } from "./types.js";
export class CodexAdapter extends TerminalAgentAdapter {
  readonly id = "codex" as const;
  readonly name = "Codex CLI";
  getCapabilities(): AdapterCapabilities {
    return {
      streaming: true,
      structuredEvents: true,
      session: true,
      resume: true,
      multiTurn: false,
      approval: true,
      interruption: true,
      modelSelection: true,
      workingDirectory: true,
    };
  }
  getConfigSchema(): AdapterConfigSchema {
    return {
      fields: [
        { key: "model", label: "Model", type: "text", defaultValue: "default" },
        { key: "workingDirectory", label: "Working Directory", type: "text" },
        {
          key: "codexApproval",
          label: "Approval",
          type: "select",
          options: ["untrusted", "on-request", "never"].map((value) => ({ value, label: value })),
        },
        {
          key: "codexSandbox",
          label: "Sandbox",
          type: "select",
          options: ["read-only", "workspace-write", "danger-full-access"].map((value) => ({
            value,
            label: value,
          })),
        },
        {
          key: "effort",
          label: "Reasoning Effort",
          type: "select",
          options: ["minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({
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
      kind: "codex-cli",
      model: c.model ?? "default",
      prompt: input.prompt,
      codexApproval: c.codexApproval,
      codexSandbox: c.codexSandbox,
      effort: c.effort,
      conversationSessionId: input.nativeSessionId,
      resumeConversation: input.resume,
      signal: input.signal,
      onFrame: input.onFrame,
    });
  }
}
