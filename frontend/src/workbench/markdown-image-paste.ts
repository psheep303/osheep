import { type ClipboardEvent, useCallback } from "react";
import { ApiClientError } from "./api";
import { findFreeImageName, writeFileBase64 } from "./fs";

const WORKSPACE_IMAGE_DIR = ".osheep/image";

interface MarkdownImagePasteOptions {
  workspaceId?: string | null;
  value: string;
  onChange: (value: string) => void;
  onError: (error: Error) => void;
}

export function useMarkdownImagePaste({
  workspaceId,
  value,
  onChange,
  onError,
}: MarkdownImagePasteOptions) {
  return useCallback(
    (event: ClipboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (!workspaceId) return;
      const items = Array.from(event.clipboardData.items);
      const file =
        items.find((item) => item.kind === "file" && item.type.startsWith("image/"))?.getAsFile() ??
        Array.from(event.clipboardData.files).find((candidate) =>
          candidate.type.startsWith("image/"),
        );
      const hasImageType =
        items.some((item) => item.type.startsWith("image/")) ||
        Array.from(event.clipboardData.types).some((type) => type.startsWith("image/"));
      if (!file && (!hasImageType || !navigator.clipboard?.read)) return;

      event.preventDefault();
      event.stopPropagation();
      const target = event.currentTarget;
      const selectionStart = target.selectionStart ?? value.length;
      const selectionEnd = target.selectionEnd ?? selectionStart;
      const insert = async (image: File) => {
        try {
          const markdown = await saveWorkspaceMarkdownImage(workspaceId, image);
          const current = target.value;
          const start = Math.min(selectionStart, current.length);
          const end = Math.max(start, Math.min(selectionEnd, current.length));
          onChange(insertMarkdownImage(current, start, end, markdown));
          requestAnimationFrame(() => {
            const cursor = start + markdown.length;
            target.setSelectionRange(cursor, cursor);
            target.focus();
          });
        } catch (reason) {
          onError(reason instanceof Error ? reason : new Error(String(reason)));
        }
      };

      if (file) {
        void insert(file);
        return;
      }
      void navigator.clipboard
        .read()
        .then(async (clipboardItems) => {
          for (const item of clipboardItems) {
            const type = item.types.find((candidate) => candidate.startsWith("image/"));
            if (!type) continue;
            const blob = await item.getType(type);
            await insert(new File([blob], `pasted-image.${imageExtension(type)}`, { type }));
            return;
          }
        })
        .catch((reason) => onError(reason instanceof Error ? reason : new Error(String(reason))));
    },
    [onChange, onError, value, workspaceId],
  );
}

export async function saveWorkspaceMarkdownImage(workspaceId: string, file: File): Promise<string> {
  const extension = imageExtension(file.type);
  const name = await findFreeImageName(workspaceId, WORKSPACE_IMAGE_DIR, extension).catch(
    (error: unknown) => {
      if (error instanceof ApiClientError && error.status === 404) return `image.${extension}`;
      throw error;
    },
  );
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  await writeFileBase64(workspaceId, `${WORKSPACE_IMAGE_DIR}/${name}`, btoa(binary));
  return `![alt text](${WORKSPACE_IMAGE_DIR}/${name})`;
}

export function insertMarkdownImage(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  markdown: string,
): string {
  return `${value.slice(0, selectionStart)}${markdown}${value.slice(selectionEnd)}`;
}

export function imageExtension(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.toLowerCase() ?? "png";
  return (
    ({ jpeg: "jpg", "svg+xml": "svg", "x-icon": "ico" } as Record<string, string>)[subtype] ??
    subtype
  );
}
