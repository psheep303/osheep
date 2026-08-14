import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const ONBOARDING_FIELD = "hasCompletedOnboarding";

export interface ClaudeOnboardingStatus {
  enabled: boolean;
  path: string;
}

export function resolveClaudeOnboardingPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  const configuredDirectory = env.CLAUDE_CONFIG_DIR || env.OSHEEP_CLAUDE_CONFIG_DIR;
  if (!configuredDirectory?.trim()) return path.join(homeDirectory, ".claude.json");

  const directory = path.resolve(configuredDirectory.trim());
  return path.join(path.dirname(directory), `${path.basename(directory)}.json`);
}

async function readRoot(configPath: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await fs.readFile(configPath, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${configPath} must contain a JSON object`);
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeRoot(configPath: string, value: Record<string, unknown>): Promise<void> {
  const directory = path.dirname(configPath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(configPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, configPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function getClaudeOnboardingStatus(
  configPath = resolveClaudeOnboardingPath(),
): Promise<ClaudeOnboardingStatus> {
  const root = await readRoot(configPath);
  return { enabled: root?.[ONBOARDING_FIELD] === true, path: configPath };
}

export async function setClaudeOnboardingSkip(
  enabled: boolean,
  configPath = resolveClaudeOnboardingPath(),
): Promise<ClaudeOnboardingStatus> {
  const root = (await readRoot(configPath)) ?? {};
  if (enabled) root[ONBOARDING_FIELD] = true;
  else delete root[ONBOARDING_FIELD];
  await writeRoot(configPath, root);
  return { enabled, path: configPath };
}
