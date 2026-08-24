import type { WorkflowNode } from "./api";
import type { WorkflowBlockOutput } from "./workflow-behavior";

export function agentBlockOutput(node: WorkflowNode, raw: string): WorkflowBlockOutput {
  const type = node.providerKind === "claude-cli" ? "claude" : "codex";
  const trimmed = raw.trim();
  if (node.config?.parseOutputJson === true) {
    try {
      return { type, status: "success", text: JSON.parse(trimmed) as unknown };
    } catch (error) {
      throw new Error(`${node.title} output text is not valid JSON: ${(error as Error).message}`);
    }
  }

  let text = trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const output = parsed as WorkflowBlockOutput;
      const candidate = output.text ?? output.summary ?? output.content ?? output.stdout;
      if (typeof candidate === "string") text = candidate;
    }
  } catch {
    /* Keep non-JSON final messages as plain text. */
  }
  return { type, status: "success", text };
}
