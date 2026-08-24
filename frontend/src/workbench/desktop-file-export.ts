import { invoke, isTauri } from "@tauri-apps/api/core";

interface ExportTextFileOptions {
  suggestedName: string;
  contents: string;
  mimeType?: string;
}

interface BrowserSaveFileHandle {
  createWritable(): Promise<{
    write(data: Blob): Promise<void>;
    close(): Promise<void>;
  }>;
}

type BrowserSaveFilePicker = (options: { suggestedName: string }) => Promise<BrowserSaveFileHandle>;

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
  const browserWindow = window as Window & { showSaveFilePicker?: BrowserSaveFilePicker };
  if (browserWindow.showSaveFilePicker) {
    try {
      const handle = await browserWindow.showSaveFilePicker({ suggestedName });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      throw error;
    }
    return;
  }

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
