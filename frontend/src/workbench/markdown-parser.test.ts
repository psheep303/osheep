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
