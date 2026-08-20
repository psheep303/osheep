import { Marked, Renderer } from "marked";

/**
 * Create an isolated parser so each Markdown surface can choose its own
 * line-break behavior without changing the global marked configuration.
 */
export function createMarkdownParser(breaks: boolean): Marked {
  const renderer = new Renderer();
  const renderList = renderer.list;
  const renderListItem = renderer.listitem;

  renderer.list = function (list) {
    const html = renderList.call(this, list);
    if (!list.items.some((item) => item.task)) return html;
    return html.replace(/^(<(?:ul|ol)(?: [^>]*)?)/, '$1 class="contains-task-list"');
  };

  renderer.listitem = function (item) {
    if (!item.task) return renderListItem.call(this, item);
    return `<li class="task-list-item">${this.parser.parse(item.tokens)}</li>\n`;
  };

  return new Marked({
    gfm: true,
    breaks,
    renderer,
  });
}
