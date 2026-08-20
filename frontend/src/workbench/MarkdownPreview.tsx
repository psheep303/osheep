import DOMPurify from "dompurify";
import { useEffect, useState } from "react";
import { createMarkdownParser } from "./markdown-parser";

interface MarkdownPreviewProps {
  source: string;
}

const markdownParser = createMarkdownParser(false);

export function MarkdownPreview({ source }: MarkdownPreviewProps) {
  const [html, setHtml] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const raw = await markdownParser.parse(source ?? "");
      if (cancelled) return;
      const clean = DOMPurify.sanitize(raw, {
        ADD_ATTR: ["target", "rel"],
      });
      setHtml(clean);
    })();
    return () => {
      cancelled = true;
    };
  }, [source]);

  return <div className="markdown-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}
