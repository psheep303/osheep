import hljs from "highlight.js";
import { Marked, Renderer } from "marked";

/**
 * Create an isolated parser so each Markdown surface can choose its own
 * line-break behavior without changing the global marked configuration.
 */
export function createMarkdownParser(breaks: boolean): Marked {
  const renderer = new Renderer();
  const renderList = renderer.list;
  const renderListItem = renderer.listitem;
  const renderCode = renderer.code;

  renderer.list = function (list) {
    const html = renderList.call(this, list);
    if (!list.items.some((item) => item.task)) return html;
    return html.replace(/^(<(?:ul|ol)(?: [^>]*)?)/, '$1 class="contains-task-list"');
  };

  renderer.listitem = function (item) {
    if (!item.task) return renderListItem.call(this, item);
    return `<li class="task-list-item">${this.parser.parse(item.tokens)}</li>\n`;
  };

  renderer.code = function (token) {
    const language = token.lang?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (language === "mermaid") {
      return `<pre class="mermaid">${escapeHtml(token.text)}</pre>\n`;
    }
    try {
      const highlighted =
        language && hljs.getLanguage(language)
          ? hljs.highlight(token.text, { language }).value
          : hljs.highlightAuto(token.text).value;
      const languageClass = language ? ` language-${escapeHtml(language)}` : "";
      return `<pre><code class="hljs${languageClass}">${highlighted}</code></pre>\n`;
    } catch {
      return renderCode.call(this, token);
    }
  };

  return new Marked({
    gfm: true,
    breaks,
    renderer,
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
