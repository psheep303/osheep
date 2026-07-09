import { existsSync, readFileSync } from "node:fs";

const activityBar = readFileSync("src/workbench/ActivityBar.tsx", "utf8");
const workbench = readFileSync("src/workbench/Workbench.tsx", "utf8");
const aiSettings = readFileSync("src/workbench/AiSettingsView.tsx", "utf8");
const agentViewPath = "src/workbench/AgentSettingsView.tsx";
const agentView = existsSync(agentViewPath)
  ? readFileSync(agentViewPath, "utf8")
  : "";

function functionBlock(source, name) {
  const start = source.indexOf(`function ${name}`);
  if (start === -1) return "";
  const open = source.indexOf("{", start);
  if (open === -1) return "";
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return source.slice(start);
}

const claudeAgentBlock = functionBlock(agentView, "ClaudeCodeAgentView");
const claudeIconBlock = functionBlock(activityBar, "ClaudeCodeIcon");
const codexIconBlock = functionBlock(activityBar, "CodexIcon");

const checks = [
  {
    name: "ActivityBar exposes Claude Code and Codex as top-level agent view ids",
    pass:
      /export type ViewId =/.test(activityBar) &&
      /\|\s*"claude-code"/.test(activityBar) &&
      /\|\s*"codex"/.test(activityBar),
  },
  {
    name: "ActivityBar no longer exposes old AI settings or Codex plugin top-level ids",
    pass:
      !/\|\s*"ai-settings"/.test(activityBar) &&
      !/\|\s*"codex-plugins"/.test(activityBar) &&
      !/id: "ai-settings"/.test(activityBar) &&
      !/id: "codex-plugins"/.test(activityBar),
  },
  {
    name: "ActivityBar labels agent entries as Claude Code and Codex",
    pass:
      /id: "claude-code", label: "Claude Code"/.test(activityBar) &&
      /id: "codex", label: "Codex"/.test(activityBar),
  },
  {
    name: "ActivityBar uses official native Claude and OpenAI SVG paths",
    pass:
      /function ClaudeCodeIcon\(\)/.test(activityBar) &&
      /function CodexIcon\(\)/.test(activityBar) &&
      /<title>Claude<\/title>/.test(claudeIconBlock) &&
      /M4\.709 15\.955l4\.72-2\.647/.test(claudeIconBlock) &&
      /<title>OpenAI<\/title>/.test(codexIconBlock) &&
      /M9\.205 8\.658v-2\.26/.test(codexIconBlock) &&
      !/stroke=/.test(claudeIconBlock) &&
      !/stroke=/.test(codexIconBlock) &&
      !/function AiSettingsIcon\(\)/.test(activityBar) &&
      !/function CodexPluginsIcon\(\)/.test(activityBar),
  },
  {
    name: "Workbench renders agent-specific side views",
    pass:
      /<ClaudeCodeAgentView \/>/.test(workbench) &&
      /<CodexAgentView \/>/.test(workbench) &&
      !/<AiSettingsView \/>/.test(workbench) &&
      !/<CodexPluginsView \/>/.test(workbench),
  },
  {
    name: "AI settings view accepts a fixed app instead of owning Claude/Codex tabs",
    pass:
      /interface AiSettingsViewProps/.test(aiSettings) &&
      /app: AiSettingsApp/.test(aiSettings) &&
      /export function AiSettingsView\(\{ app \}: AiSettingsViewProps\)/.test(aiSettings) &&
      !/setApp/.test(aiSettings) &&
      !/ai-settings__tabs/.test(aiSettings),
  },
  {
    name: "Agent settings view defines the requested Claude Code and Codex subsections",
    pass:
      /ClaudeCodeAgentView/.test(agentView) &&
      /CodexAgentView/.test(agentView) &&
      /API & Model/.test(agentView) &&
      /Plugins/.test(agentView) &&
      /Hooks/.test(agentView) &&
      /MCP/.test(agentView) &&
      /Permissions/.test(agentView) &&
      /Environment/.test(agentView),
  },
  {
    name: "Codex agent combines API & Model with Plugins",
    pass:
      /<AiSettingsView app="codex" \/>/.test(agentView) &&
      /<CodexPluginsView \/>/.test(agentView),
  },
  {
    name: "Claude Code agent exposes API & Model without Codex plugin content",
    pass:
      /<AiSettingsView app="claude" \/>/.test(claudeAgentBlock) &&
      !/<CodexPluginsView \/>/.test(claudeAgentBlock),
  },
];

const failures = checks.filter((check) => !check.pass);
for (const check of checks) {
  console.log(`${check.pass ? "PASS" : "FAIL"} ${check.name}`);
}

if (failures.length > 0) {
  process.exitCode = 1;
}
