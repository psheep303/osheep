import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeCssLineEndings, readWorkbenchCss } from "./read-workbench-css.mjs";

const expected = {
  sha256: "d985a3c6e31a6accc38ec22c7c7636cfe1fbe588ec2b8d004ee49fc9ea4b3c86",
  bytes: 196153,
  openingBraces: 1423,
  closingBraces: 1423,
  declarations: 5786,
};

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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkWorkbenchCssEquivalence();
  console.log("workbench CSS equivalence checks passed");
}
