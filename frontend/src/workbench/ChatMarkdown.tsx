// Lightweight markdown renderer for osheep code chat steps.
//
// Compared with the workspace MarkdownPreview component this one:
//   - tightens spacing so steps stay compact in the timeline
//   - styles GFM checkbox lines as visual todos with "todo / doing / done"
//     states (matching the model's `- [ ] / - [~] / - [x]` convention)
//   - reuses marked + DOMPurify so we don't pull in a second toolchain

import DOMPurify from "dompurify";
import { marked } from "marked";
import { useEffect, useMemo, useState } from "react";

interface ChatMarkdownProps {
  source: string;
  /** Compact: drop the outer margins so plan items pack tighter. */
  compact?: boolean;
  /** Append a small blinking caret at the end (used for streaming text). */
  caret?: boolean;
}

marked.setOptions({ gfm: true, breaks: true });

export function ChatMarkdown({ source, compact, caret }: ChatMarkdownProps) {
  const [html, setHtml] = useState("");

  // The marked parser handles `- [ ]` and `- [x]` natively for GFM. It does
  // NOT understand `- [~]` — pre-process it into a sentinel HTML span that we
  // then style with a "doing" attribute.
  const prepared = useMemo(() => preprocessTodos(source ?? ""), [source]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const raw = await marked.parse(prepared);
      if (cancelled) return;
      const clean = DOMPurify.sanitize(raw, {
        ADD_ATTR: ["target", "rel", "data-state"],
      });
      const decorated = decorateTodoCheckboxes(clean);
      setHtml(decorated);
    })();
    return () => {
      cancelled = true;
    };
  }, [prepared]);

  return (
    <div
      className={"chat-markdown" + (compact ? " is-compact" : "")}
      dangerouslySetInnerHTML={{
        __html: html + (caret ? '<span class="chat-markdown__caret"></span>' : ""),
      }}
    />
  );
}

/**
 * marked's GFM task-list extension only matches `[ ]` and `[x]`. Replace
 * `- [~] text` lines with a normal `- [ ] text` plus a wrapping `<span
 * data-state="doing">` so we can style it differently downstream.
 */
function preprocessTodos(src: string): string {
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i]!.match(/^(\s*[-*+]\s+)\[\s*~\s*\](.*)$/);
    if (m) {
      lines[i] = `${m[1]}[ ] {{DOING_OPEN}}${m[2]!.trimStart()}{{DOING_CLOSE}}`;
    }
  }
  return lines.join("\n");
}

/**
 * After marked + DOMPurify produce HTML, we get `<li><input ...> Text</li>`
 * for GFM checkboxes. Tag every such <li> with `data-state="todo"` when the
 * input is unchecked or `"done"` when checked. Doing-state markers placed in
 * preprocessTodos override "todo" with "doing".
 */
function decorateTodoCheckboxes(html: string): string {
  // Replace open/close sentinels with actual marker spans, then re-encode the
  // attribute. We do this via simple string ops (no jsdom) since the sentinels
  // never get HTML-escaped (`{{DOING_OPEN}}` survives marked unchanged).
  let out = html
    .replace(/\{\{DOING_OPEN\}\}/g, '<span data-doing="1">')
    .replace(/\{\{DOING_CLOSE\}\}/g, "</span>");

  // Tag <li> elements that contain a checkbox input with their state.
  out = out.replace(
    /<li([^>]*)>(\s*<input[^>]*type=["']checkbox["'][^>]*>)([\s\S]*?)<\/li>/g,
    (_match, attrs, input, body) => {
      const checked = /checked/i.test(input);
      const doing = /data-doing="1"/.test(body);
      const state = doing ? "doing" : checked ? "done" : "todo";
      return `<li${attrs} class="markdown-todo" data-state="${state}">${input}${body}</li>`;
    }
  );
  return out;
}
