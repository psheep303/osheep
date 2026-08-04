import assert from "node:assert/strict";
import test from "node:test";

import { frontendManualChunk } from "../vite.config.ts";

const cases: Array<[string, string | undefined]> = [
  ["/repo/node_modules/monaco-editor/esm/vs/editor/editor.api.js", "monaco"],
  ["C:\\repo\\node_modules\\monaco-editor\\esm\\vs\\editor\\editor.api.js", "monaco"],
  ["/repo/node_modules/@monaco-editor/react/dist/index.mjs", undefined],
  ["C:\\repo\\node_modules\\@monaco-editor\\react\\dist\\index.mjs", undefined],
  ["/repo/node_modules/@xterm/xterm/lib/xterm.js", "xterm"],
  ["C:\\repo\\node_modules\\@xterm\\addon-fit\\lib\\addon-fit.js", "xterm"],
  ["/repo/node_modules/marked/lib/marked.esm.js", "markdown"],
  ["C:\\repo\\node_modules\\dompurify\\dist\\purify.es.mjs", "markdown"],
  ["/repo/src/marked/preview.ts", undefined],
  ["/repo/src/dompurify/sanitize.ts", undefined],
  ["/repo/src/@xterm/terminal.ts", undefined],
];

test("frontend manual chunks classify exact package paths across platforms", () => {
  for (const [id, expected] of cases) {
    assert.equal(frontendManualChunk(id), expected, id);
  }
});
