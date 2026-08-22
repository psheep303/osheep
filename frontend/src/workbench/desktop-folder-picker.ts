import { invoke, isTauri } from "@tauri-apps/api/core";

export function isDesktopShell(): boolean {
  return isTauri();
}

export function isWindowsDesktopShell(): boolean {
  return isDesktopShell() && /Windows/i.test(navigator.userAgent);
}

export async function pickWorkspaceFolder(initialPath?: string | null): Promise<string | null> {
  try {
    return await invoke<string | null>("pick_workspace_folder", {
      initialPath: initialPath || null,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法打开桌面文件夹选择器：${detail}`);
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  if (!isDesktopShell())
    throw new Error("External URL opening is only available in the desktop shell.");
  await invoke("open_external_url", { url });
}

export async function pickSkillFolder(): Promise<string | null> {
  try {
    return await invoke<string | null>("pick_skill_folder");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法打开文件夹选择器：${detail}`);
  }
}
