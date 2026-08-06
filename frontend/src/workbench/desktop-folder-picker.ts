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
