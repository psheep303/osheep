import DOMPurify from "dompurify";
import { useEffect, useState } from "react";
import { workspaceImageUrl } from "./api";
import { createMarkdownParser } from "./markdown-parser";

interface MarkdownPreviewProps {
  source: string;
  workspaceId?: string | null;
  filePath?: string;
}

const markdownParser = createMarkdownParser(false);

export function MarkdownPreview({ source, workspaceId, filePath }: MarkdownPreviewProps) {
  const [html, setHtml] = useState("");

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

  return <div className="markdown-preview" dangerouslySetInnerHTML={{ __html: html }} />;
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
