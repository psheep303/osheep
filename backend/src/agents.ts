import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errors } from "./errors.js";

const AGENT_NAME_RE = /^[a-zA-Z0-9 _\-一-龥]{1,64}$/;

export interface AgentRecord {
  name: string;
  prompt: string;
  providerId: string;
  model: string;
}

function agentDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".osheep", "agent");
}

function agentFile(workspaceRoot: string, name: string): string {
  return path.join(agentDir(workspaceRoot), `${name}.json`);
}

function validateName(name: string): void {
  if (typeof name !== "string" || !AGENT_NAME_RE.test(name)) {
    throw errors.invalidPath("agent 名称非法（仅允许字母、数字、空格、_-、中文，1-64 字符）");
  }
}

export async function ensureAgentDir(workspaceRoot: string): Promise<void> {
  await fs.mkdir(agentDir(workspaceRoot), { recursive: true });
}

export async function listAgents(workspaceRoot: string): Promise<AgentRecord[]> {
  await ensureAgentDir(workspaceRoot);
  const dir = agentDir(workspaceRoot);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: AgentRecord[] = [];
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    const abs = path.join(dir, f);
    try {
      const text = await fs.readFile(abs, "utf-8");
      const parsed = JSON.parse(text) as Partial<AgentRecord>;
      const name = typeof parsed.name === "string" ? parsed.name : f.slice(0, -5);
      out.push({
        name,
        prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
        providerId: typeof parsed.providerId === "string" ? parsed.providerId : "",
        model: typeof parsed.model === "string" ? parsed.model : "",
      });
    } catch {
      /* skip unreadable */
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function getAgent(workspaceRoot: string, name: string): Promise<AgentRecord> {
  validateName(name);
  const abs = agentFile(workspaceRoot, name);
  let text: string;
  try {
    text = await fs.readFile(abs, "utf-8");
  } catch {
    throw errors.notFound(`agent 不存在: ${name}`);
  }
  let parsed: Partial<AgentRecord>;
  try {
    parsed = JSON.parse(text) as Partial<AgentRecord>;
  } catch {
    parsed = {};
  }
  return {
    name,
    prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
    providerId: typeof parsed.providerId === "string" ? parsed.providerId : "",
    model: typeof parsed.model === "string" ? parsed.model : "",
  };
}

export async function saveAgent(workspaceRoot: string, agent: AgentRecord): Promise<void> {
  validateName(agent.name);
  await ensureAgentDir(workspaceRoot);
  const abs = agentFile(workspaceRoot, agent.name);
  const body = JSON.stringify(
    {
      name: agent.name,
      prompt: typeof agent.prompt === "string" ? agent.prompt : "",
      providerId: typeof agent.providerId === "string" ? agent.providerId : "",
      model: typeof agent.model === "string" ? agent.model : "",
    },
    null,
    2,
  );
  const tmp = `${abs}.osheep.tmp.${Date.now()}`;
  await fs.writeFile(tmp, body, "utf-8");
  try {
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.unlink(tmp).catch(() => undefined);
    throw errors.ioError((e as Error).message);
  }
}

export async function renameAgent(
  workspaceRoot: string,
  oldName: string,
  newName: string,
): Promise<void> {
  validateName(oldName);
  validateName(newName);
  if (oldName === newName) return;
  const fromAbs = agentFile(workspaceRoot, oldName);
  const toAbs = agentFile(workspaceRoot, newName);
  try {
    await fs.access(toAbs);
    throw errors.entryExists();
  } catch (e) {
    if ((e as { statusCode?: number }).statusCode === 409) throw e;
  }
  try {
    await fs.rename(fromAbs, toAbs);
  } catch {
    throw errors.notFound(`agent 不存在: ${oldName}`);
  }
  // Re-write to update the embedded name field
  const text = await fs.readFile(toAbs, "utf-8").catch(() => "{}");
  let parsed: Partial<AgentRecord> = {};
  try {
    parsed = JSON.parse(text) as Partial<AgentRecord>;
  } catch {
    /* ignore */
  }
  await saveAgent(workspaceRoot, {
    name: newName,
    prompt: parsed.prompt ?? "",
    providerId: parsed.providerId ?? "",
    model: parsed.model ?? "",
  });
}

export async function deleteAgent(workspaceRoot: string, name: string): Promise<void> {
  validateName(name);
  const abs = agentFile(workspaceRoot, name);
  try {
    await fs.unlink(abs);
  } catch {
    throw errors.notFound(`agent 不存在: ${name}`);
  }
}
