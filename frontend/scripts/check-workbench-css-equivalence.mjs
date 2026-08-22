import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeCssLineEndings, readWorkbenchCss } from "./read-workbench-css.mjs";

const expected = Object.freeze({
  sha256: "d19bb40190f0652e9dcf5f0ff07de9d905f3269d0aa752919b584cac322380e2",
  bytes: 281456,
  openingBraces: 2020,
  closingBraces: 2020,
  declarations: 7620,
});

const expectedPattern = /const expected = Object\.freeze\(\{[\s\S]*?\}\);/;

export function workbenchCssMetrics(css) {
  const normalizedCss = normalizeCssLineEndings(css);
  return {
    sha256: createHash("sha256").update(normalizedCss).digest("hex"),
    bytes: Buffer.byteLength(normalizedCss),
    openingBraces: normalizedCss.match(/{/g)?.length ?? 0,
    closingBraces: normalizedCss.match(/}/g)?.length ?? 0,
    declarations: normalizedCss.match(/(^|;)\s*[-a-zA-Z][\w-]*\s*:/gm)?.length ?? 0,
  };
}

export function checkWorkbenchCssEquivalence(css = readWorkbenchCss()) {
  const actual = workbenchCssMetrics(css);
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) {
      throw new Error(`workbench CSS ${key} changed: ${actual[key]}`);
    }
  }
}

function updateWorkbenchCssBaseline(css = readWorkbenchCss()) {
  const scriptPath = fileURLToPath(import.meta.url);
  const script = readFileSync(scriptPath, "utf8");
  const actual = workbenchCssMetrics(css);
  const replacement = `const expected = Object.freeze({
  sha256: "${actual.sha256}",
  bytes: ${actual.bytes},
  openingBraces: ${actual.openingBraces},
  closingBraces: ${actual.closingBraces},
  declarations: ${actual.declarations},
});`;
  if (!expectedPattern.test(script)) {
    throw new Error("workbench CSS baseline block not found");
  }
  writeFileSync(scriptPath, script.replace(expectedPattern, replacement));
  console.log("updated workbench CSS canonical baseline", actual);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const update = process.argv.includes("--update");
  if (update && process.env.CI) {
    console.error("Refusing to update workbench CSS baseline in CI");
    process.exit(1);
  }
  if (update) {
    updateWorkbenchCssBaseline();
  } else {
    checkWorkbenchCssEquivalence();
    console.log("workbench CSS canonical baseline checks passed");
  }
}
