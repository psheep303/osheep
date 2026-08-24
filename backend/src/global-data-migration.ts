import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { APP_SETTINGS_DIR } from "./app-settings.js";

export interface GlobalDataMigrationOptions {
  legacyRoot?: string;
  targetRoot?: string;
  migrationId?: string;
}

export interface GlobalDataMigrationResult {
  copied: number;
  deduplicated: number;
  conflicts: number;
  removedLegacyRoot: boolean;
}

async function fileDigest(file: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(file));
  return hash.digest("hex");
}

async function filesMatch(left: string, right: string): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([fs.stat(left), fs.stat(right)]);
  if (leftStat.size !== rightStat.size) return false;
  const [leftDigest, rightDigest] = await Promise.all([fileDigest(left), fileDigest(right)]);
  return leftDigest === rightDigest;
}

async function pathExists(value: string): Promise<boolean> {
  return fs.access(value).then(
    () => true,
    () => false,
  );
}

async function copyVerified(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.osheep-migrate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await fs.copyFile(source, temporary);
    if (!(await filesMatch(source, temporary))) {
      throw new Error(`migration verification failed: ${source}`);
    }
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function removeEmptyParents(current: string, stopAt: string): Promise<void> {
  const boundary = path.resolve(stopAt);
  let directory = path.resolve(current);
  while (directory.startsWith(`${boundary}${path.sep}`)) {
    const entries = await fs.readdir(directory).catch(() => null);
    if (!entries || entries.length > 0) return;
    await fs.rmdir(directory);
    directory = path.dirname(directory);
  }
}

async function migrateDirectory(
  sourceRoot: string,
  destinationRoot: string,
  conflictRoot: string,
  result: GlobalDataMigrationResult,
): Promise<void> {
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const source = path.join(sourceRoot, entry.name);
    const destination = path.join(destinationRoot, entry.name);
    const conflict = path.join(conflictRoot, entry.name);
    if (entry.isDirectory()) {
      await migrateDirectory(source, destination, conflict, result);
      await removeEmptyParents(source, sourceRoot);
      continue;
    }
    if (!entry.isFile()) continue;

    if (!(await pathExists(destination))) {
      await copyVerified(source, destination);
      result.copied += 1;
    } else if (await filesMatch(source, destination)) {
      result.deduplicated += 1;
    } else {
      await copyVerified(source, conflict);
      result.conflicts += 1;
    }
    await fs.rm(source);
  }
}

export async function migrateLegacyGlobalData(
  options: GlobalDataMigrationOptions = {},
): Promise<GlobalDataMigrationResult> {
  const legacyRoot = path.resolve(
    options.legacyRoot ?? path.join(os.homedir() || ".", ".osheep"),
  );
  const targetRoot = path.resolve(options.targetRoot ?? APP_SETTINGS_DIR);
  const result: GlobalDataMigrationResult = {
    copied: 0,
    deduplicated: 0,
    conflicts: 0,
    removedLegacyRoot: false,
  };
  if (legacyRoot === targetRoot) return result;

  const legacyTemplates = path.join(legacyRoot, "templates");
  if (await pathExists(legacyTemplates)) {
    const migrationId = options.migrationId ?? new Date().toISOString().replace(/[:.]/g, "-");
    await migrateDirectory(
      legacyTemplates,
      path.join(targetRoot, "templates"),
      path.join(targetRoot, "migration-conflicts", `legacy-home-${migrationId}`, "templates"),
      result,
    );
    await removeEmptyParents(legacyTemplates, legacyRoot);
  }

  const remaining = await fs.readdir(legacyRoot).catch(() => null);
  if (remaining?.length === 0) {
    await fs.rmdir(legacyRoot);
    result.removedLegacyRoot = true;
  }
  return result;
}
