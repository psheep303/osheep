import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
export const workbenchCssPath = resolve(scriptsDir, "../src/workbench/workbench.css");

const localImportPattern =
  /^[\t ]*@import[\t ]+(?:url\([\t ]*)?["'](\.\.?\/[^"']+\.css)["'](?:[\t ]*\))?[\t ]*;[\t ]*(?:\r?\n|$)/gm;

export function readCssWithImports(entryPath, stack = []) {
  const absolutePath = resolve(entryPath);
  if (stack.includes(absolutePath)) {
    throw new Error(`Circular CSS import: ${[...stack, absolutePath].join(" -> ")}`);
  }

  const css = readFileSync(absolutePath, "utf8");
  const nextStack = [...stack, absolutePath];
  return css.replace(localImportPattern, (_statement, importPath) =>
    readCssWithImports(resolve(dirname(absolutePath), importPath), nextStack),
  );
}

export function normalizeCssLineEndings(css) {
  return css.replace(/\r\n?/g, "\n");
}

export function readWorkbenchCss() {
  return readCssWithImports(workbenchCssPath);
}
