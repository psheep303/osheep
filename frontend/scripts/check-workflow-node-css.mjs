import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const cssPath = resolve("src/workbench/workbench.css");
const css = readFileSync(cssPath, "utf8");
const cssLookup = css.replace(/\/\*[\s\S]*?\*\//g, "");
const main = readFileSync(resolve("src/main.tsx"), "utf8");
const workflowTab = readFileSync(resolve("src/workbench/WorkflowTab.tsx"), "utf8");

function lastRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]*)\\}`, "g");
  let match;
  let body = "";
  while ((match = pattern.exec(cssLookup))) body = match[1];
  if (!body) throw new Error(`Missing CSS rule for ${selector}`);
  return body;
}

function lastRuleContaining(...selectors) {
  const pattern = /(?:^|})\s*([^{}]+)\s*\{([^}]*)\}/g;
  let match;
  let body = "";
  while ((match = pattern.exec(cssLookup))) {
    const selectorSet = new Set(match[1].split(",").map((part) => part.trim()));
    if (selectors.every((selector) => selectorSet.has(selector))) body = match[2];
  }
  if (!body) throw new Error(`Missing CSS rule containing ${selectors.join(", ")}`);
  return body;
}

function declaration(body, property) {
  const pattern = new RegExp(`${property}\\s*:\\s*([^;]+);`);
  return body.match(pattern)?.[1].trim() ?? "";
}

function px(value) {
  const match = value.match(/^(-?\d+(?:\.\d+)?)px$/);
  return match ? Number(match[1]) : NaN;
}

function hasDeclaration(body, property, expected) {
  return declaration(body, property) === expected;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const node = lastRule(".workflow-node");
const name = lastRule(".workflow-node__name");
const icon = lastRule(".workflow-node__icon");
const iconSvg = lastRule(".workflow-node__icon svg");
const iconSvgParts = lastRule(".workflow-node__icon svg *");
const tab = lastRule(".workflow-tab");
const output = lastRule(".workflow-inspector__output");
const templateEditor = lastRule(".workflow-template-editor");
const templatePair = lastRuleContaining(
  ".workflow-template-editor__mirror",
  ".workflow-template-editor__control"
);
const templateControl = lastRule(".workflow-template-editor .workflow-template-editor__control");

assert(
  css.includes("/* Workflow Shadcn Graph Surface */"),
  "workflow CSS must use the single shadcn graph surface block"
);

assert(
  !css.includes("Workflow Pro Glass refinement") &&
    !css.includes("Workflow Coder Compact correction"),
  "old workflow visual override blocks must be removed"
);

assert(
  main.includes('@fontsource/geist-sans/latin-400.css') &&
    main.includes('@fontsource/geist-sans/latin-500.css') &&
    main.includes('@fontsource/geist-sans/latin-600.css') &&
    main.includes('@fontsource/geist-sans/latin-700.css') &&
    main.includes('@fontsource/geist-mono/latin-400.css') &&
    main.includes('@fontsource/geist-mono/latin-500.css') &&
    main.includes('@fontsource/geist-mono/latin-600.css'),
  "workflow latin font files must be loaded from Fontsource Geist"
);

assert(
  css.includes('--wf-font-sans: "Geist Sans"') &&
    css.includes('--wf-font-mono: "Geist Mono"'),
  "workflow CSS must define Geist Sans and Geist Mono font variables"
);

assert(
  declaration(tab, "font-family") === "var(--wf-font-sans)",
  "workflow tab should use the Geist Sans font variable"
);

assert(
  declaration(name, "font-family") === "var(--wf-font-sans)",
  "workflow node titles should use the Geist Sans font variable"
);

assert(
  declaration(output, "font-family") === "var(--wf-font-mono)",
  "workflow output panels should use the Geist Mono font variable"
);

assert(
  hasDeclaration(templatePair, "font-family", "var(--wf-font-mono)") &&
    hasDeclaration(templatePair, "font-size", "12px") &&
    hasDeclaration(templatePair, "line-height", "1.45") &&
    hasDeclaration(templatePair, "padding", "6px 8px") &&
    hasDeclaration(templatePair, "letter-spacing", "0") &&
    hasDeclaration(templatePair, "font-kerning", "normal") &&
    hasDeclaration(templatePair, "font-variant-ligatures", "none") &&
    hasDeclaration(templatePair, "tab-size", "2"),
  "workflow template mirror and textarea must share identical text metrics so the caret aligns with visible text"
);

assert(
  hasDeclaration(templateEditor, "font-family", "var(--wf-font-mono)") &&
    hasDeclaration(templateEditor, "font-size", "12px") &&
    hasDeclaration(templateEditor, "line-height", "1.45"),
  "workflow template editor host must pin the same text metrics used by its overlay layers"
);

assert(
  hasDeclaration(templateControl, "appearance", "none") &&
    hasDeclaration(templateControl, "-webkit-appearance", "none"),
  "workflow template textarea should disable browser-native appearance that can offset the caret"
);

assert(
  workflowTab.includes("Geist Mono, SFMono-Regular, Cascadia Mono"),
  "workflow xterm should prefer Geist Mono for terminal output"
);

assert(
  Number(declaration(name, "line-height")) >= 1.22,
  "workflow node text needs enough line-height so descenders like g are not clipped"
);

assert(
  px(declaration(icon, "width")) >= 22 && px(declaration(icon, "height")) >= 22,
  "workflow node icon box must be at least 22px for the shadcn-style icon slot"
);

assert(
  /translateY\(1px\)/.test(declaration(icon, "transform")),
  "workflow node icon needs a 1px optical downward offset to align with text glyphs"
);

assert(
  px(declaration(iconSvg, "width")) >= 18 && px(declaration(iconSvg, "height")) >= 18,
  "workflow node SVG must be at least 18px so zoomed icons do not look low resolution"
);

assert(
  /22px\s+minmax\(0,\s*1fr\)/.test(declaration(node, "grid-template-columns")),
  "workflow node grid should reserve a 22px icon slot aligned with the text"
);

assert(
  /0\s+25px\s+0\s+16px/.test(declaration(node, "padding")),
  "workflow node padding must reserve room for the right status dot and left rail"
);

assert(
  px(declaration(node, "border-radius")) <= 7,
  "workflow nodes should keep shadcn-like low radius"
);

assert(
  declaration(iconSvgParts, "vector-effect") !== "non-scaling-stroke",
  "workflow node icon strokes should scale as vectors when the workflow canvas zooms"
);

console.log("workflow node CSS checks passed");
