import assert from "node:assert/strict";
import test from "node:test";
import { createMarkdownParser } from "./markdown-parser";

test("task lists receive alignment classes", async () => {
  const parser = createMarkdownParser(false);
  const html = await parser.parse("- [ ] todo\n- [x] done\n- plain");

  assert.match(html, /^<ul class="contains-task-list">/);
  assert.match(html, /<li class="task-list-item"><input disabled="" type="checkbox"> todo<\/li>/);
  assert.match(
    html,
    /<li class="task-list-item"><input checked="" disabled="" type="checkbox"> done<\/li>/,
  );
  assert.match(html, /<li>plain<\/li>/);
});

test("ordinary lists keep their default indentation", async () => {
  const parser = createMarkdownParser(false);
  const html = await parser.parse("- first\n- second");

  assert.doesNotMatch(html, /contains-task-list/);
});

test("fenced code is highlighted and Mermaid diagrams are marked for rendering", async () => {
  const parser = createMarkdownParser(false);
  const code = String(await parser.parse("```js\nconst answer = 42;\n```"));
  const diagram = String(await parser.parse("```mermaid\ngraph TD\nA --> B\n```"));

  assert.match(code, /class="hljs language-js"/);
  assert.match(code, /hljs-keyword/);
  assert.match(diagram, /<pre class="mermaid">graph TD/);
});
