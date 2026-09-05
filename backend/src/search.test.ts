import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { searchWorkspace } from "./search.js";

test("workspace search reference contract keeps filters, limits, and UTF-16 columns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "osheep-search-contract-"));
  try {
    await mkdir(path.join(root, "src", "skip"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "package"), { recursive: true });
    await writeFile(path.join(root, "src", "main.ts"), "Alpha alphabet\nemoji 😀 alpha alpha");
    await writeFile(path.join(root, "src", "skip", "ignored.ts"), "alpha");
    await writeFile(path.join(root, "src", "binary.ts"), Buffer.from([0x61, 0, 0x6c]));
    await writeFile(path.join(root, "src", "large.ts"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    await writeFile(path.join(root, "node_modules", "package", "index.ts"), "alpha");

    const result = await searchWorkspace(root, {
      query: "alpha",
      caseSensitive: false,
      wholeWord: true,
      regex: false,
      include: ["src/**/*.ts"],
      exclude: ["src/skip/**"],
      maxFiles: 5000,
      maxMatchesPerFile: 100,
    });

    assert.equal(result.filesScanned, 1);
    assert.equal(result.truncated, false);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]?.path, "src/main.ts");
    assert.deepEqual(
      result.matches[0]?.lines.map(({ line, column, matchStart, matchEnd }) => ({
        line,
        column,
        matchStart,
        matchEnd,
      })),
      [
        { line: 1, column: 1, matchStart: 0, matchEnd: 5 },
        { line: 2, column: 10, matchStart: 9, matchEnd: 14 },
        { line: 2, column: 16, matchStart: 15, matchEnd: 20 },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
