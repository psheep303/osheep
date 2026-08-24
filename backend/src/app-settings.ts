import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve from the backend module location so development and packaged desktop
// launches use the same repository-relative configuration directory.
export const APP_SETTINGS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".osheep",
);

export const APP_SETTINGS_PATH = path.join(APP_SETTINGS_DIR, "settings.json");
let appSettingsWriteTail = Promise.resolve();

export async function readAppSettings<T>(fallback: T): Promise<T> {
  try {
    const text = await fs.readFile(APP_SETTINGS_PATH, "utf8");
    return JSON.parse(text) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) return fallback;
    throw error;
  }
}

export async function writeAppSettings(value: unknown): Promise<void> {
  await fs.mkdir(APP_SETTINGS_DIR, { recursive: true });
  const tempPath = path.join(APP_SETTINGS_DIR, `.settings.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, APP_SETTINGS_PATH);
}

export async function updateAppSettings<T>(
  update: (settings: Record<string, unknown>) => T | Promise<T>,
): Promise<T> {
  const operation = appSettingsWriteTail.then(async () => {
    const settings = await readAppSettings<Record<string, unknown>>({});
    const result = await update(settings);
    await writeAppSettings(settings);
    return result;
  });
  appSettingsWriteTail = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}
