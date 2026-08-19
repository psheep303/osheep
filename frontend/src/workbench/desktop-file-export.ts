import { invoke, isTauri } from "@tauri-apps/api/core";

interface ExportTextFileOptions {
  suggestedName: string;
  contents: string;
  mimeType?: string;
}

export async function exportTextFile({
  suggestedName,
  contents,
  mimeType = "application/json",
}: ExportTextFileOptions): Promise<void> {
  if (isTauri()) {
    await invoke<string | null>("save_export_file", { suggestedName, contents });
    return;
  }

  const blob = new Blob([contents], { type: mimeType });
  const href = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = suggestedName;
    anchor.click();
  } finally {
    URL.revokeObjectURL(href);
  }
}
