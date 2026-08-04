import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { readCssWithImports } from "./read-workbench-css.mjs";

function withCssFiles(files, run) {
  const directory = mkdtempSync(resolve(tmpdir(), "osheep-css-"));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const path = resolve(directory, relativePath);
      mkdirSync(resolve(path, ".."), { recursive: true });
      writeFileSync(path, contents);
    }
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("expands nested local CSS imports in source order", () => {
  withCssFiles(
    {
      "entry.css": '.before { order: 1; }\n@import "./nested/child.css";\n.after { order: 4; }\n',
      "nested/child.css": '.child { order: 2; }\n@import url("../shared.css");\n',
      "shared.css": ".shared { order: 3; }\n",
    },
    (directory) => {
      assert.equal(
        readCssWithImports(resolve(directory, "entry.css")),
        ".before { order: 1; }\n.child { order: 2; }\n.shared { order: 3; }\n.after { order: 4; }\n",
      );
    },
  );
});

test("rejects circular local CSS imports", () => {
  withCssFiles(
    {
      "a.css": '@import "./b.css";\n',
      "b.css": '@import "./a.css";\n',
    },
    (directory) => {
      assert.throws(() => readCssWithImports(resolve(directory, "a.css")), /Circular CSS import/);
    },
  );
});
