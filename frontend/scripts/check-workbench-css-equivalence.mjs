import { createHash } from "node:crypto";

import { readWorkbenchCss } from "./read-workbench-css.mjs";

const expectedSha256 = "d985a3c6e31a6accc38ec22c7c7636cfe1fbe588ec2b8d004ee49fc9ea4b3c86";
const expectedBytes = 196153;
const expectedBraces = 1423;
const expectedDeclarations = 5786;
const css = readWorkbenchCss();
const sha256 = createHash("sha256").update(css).digest("hex");
const bytes = Buffer.byteLength(css);
const openingBraces = css.match(/{/g)?.length ?? 0;
const closingBraces = css.match(/}/g)?.length ?? 0;
const declarations = css.match(/(^|;)\s*[-a-zA-Z][\w-]*\s*:/gm)?.length ?? 0;

if (sha256 !== expectedSha256) {
  throw new Error(`workbench CSS content or order changed: ${sha256}`);
}
if (bytes !== expectedBytes) {
  throw new Error(`workbench CSS byte count changed: ${bytes}`);
}
if (openingBraces !== expectedBraces || closingBraces !== expectedBraces) {
  throw new Error(`workbench CSS brace count changed: ${openingBraces}/${closingBraces}`);
}
if (declarations !== expectedDeclarations) {
  throw new Error(`workbench CSS declaration count changed: ${declarations}`);
}

console.log("workbench CSS equivalence checks passed");
