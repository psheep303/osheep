import DOMPurify from "dompurify";
import { useEffect, useRef, useState } from "react";
import { useUiPreferences } from "../i18n/UiPreferences";
import { workspaceImageUrl } from "./api";
import { isDesktopShell, openExternalUrl } from "./desktop-folder-picker";
import { createMarkdownParser } from "./markdown-parser";
import { useOsheepOverlay } from "./OsheepOverlay";

interface MarkdownPreviewProps {
  source: string;
  workspaceId?: string | null;
  filePath?: string;
}

const markdownParser = createMarkdownParser(false);

export function MarkdownPreview({ source, workspaceId, filePath }: MarkdownPreviewProps) {
  const { t } = useUiPreferences();
  const { notify } = useOsheepOverlay();
  const [html, setHtml] = useState("");
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const normalizedSource = separateTaskListImages(source ?? "");
      const prepared =
        workspaceId && filePath
          ? resolveWorkspaceImages(normalizedSource, workspaceId, filePath)
          : normalizedSource;
      const raw = await markdownParser.parse(prepared);
      if (cancelled) return;
      const clean = DOMPurify.sanitize(raw, {
        ADD_ATTR: ["target", "rel"],
      });
      setHtml(clean);
    })();
    return () => {
      cancelled = true;
    };
  }, [filePath, source, workspaceId]);

  useEffect(() => {
    const root = previewRef.current;
    if (!root) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest("a") : null;
      const href = target?.getAttribute("href") ?? "";
      if (!target || !isExternalHttpUrl(href)) return;
      event.preventDefault();
      if (isDesktopShell()) {
        void openExternalUrl(href).catch((reason) => {
          notify.error(t("error.openExternalLink", { detail: (reason as Error).message }));
        });
      } else {
        window.open(href, "_blank", "noopener,noreferrer");
      }
    };
    root.addEventListener("click", handleClick);
    return () => root.removeEventListener("click", handleClick);
  }, [notify, t]);

  return (
    <div ref={previewRef} className="markdown-preview" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

function isExternalHttpUrl(value: string): boolean {
  if (!/^(?:https?:)?\/\//i.test(value)) return false;
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function resolveWorkspaceImages(source: string, workspaceId: string, filePath: string): string {
  const resolveUrl = (url: string): string => {
    if (/^(?:[a-z]+:|\/\/|#|data:)/i.test(url)) return url;
    const base = filePath.slice(0, filePath.lastIndexOf("/"));
    const parts = `${base ? `${base}/` : ""}${url}`.split("/");
    const normalized: string[] = [];
    for (const part of parts) {
      if (!part || part === ".") continue;
      if (part === "..") normalized.pop();
      else normalized.push(part);
    }
    return workspaceImageUrl(workspaceId, normalized.join("/"));
  };

  const markdownImages = source.replace(
    /(!\[[^\]]*\]\()([^\s)]+)(\))/g,
    (_all, start, url, end) => `${start}${resolveUrl(url)}${end}`,
  );
  return markdownImages.replace(
    /(<img\b[^>]*\bsrc\s*=\s*["'])([^"']+)(["'])/gi,
    (_all, start, url, end) => `${start}${resolveUrl(url)}${end}`,
  );
}

function separateTaskListImages(source: string): string {
  const lines = source.split("\n");
  const output: string[] = [];
  for (const line of lines) {
    const previous = output[output.length - 1] ?? "";
    const imageOnly = /^\s*!\[[^\]]*\]\([^\n)]*\)\s*$/.test(line);
    const taskItem = /^\s*[-+*]\s+\[[ xX~]\]/.test(previous);
    if (imageOnly && taskItem) output.push("");
    output.push(line);
  }
  return output.join("\n");
}
