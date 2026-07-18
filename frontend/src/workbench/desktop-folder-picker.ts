import { invoke } from "@tauri-apps/api/core";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isDesktopShell(): boolean {
  return window.__TAURI_INTERNALS__ !== undefined;
}

export async function pickWorkspaceFolder(): Promise<string | null> {
  if (!isDesktopShell()) return null;
  return await invoke<string | null>("pick_workspace_folder");
}
