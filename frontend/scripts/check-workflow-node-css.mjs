import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { readWorkbenchCss } from "./read-workbench-css.mjs";

const css = readWorkbenchCss();
const cssLookup = css.replace(/\/\*[\s\S]*?\*\//g, "");
const main = readFileSync(resolve("src/main.tsx"), "utf8");
const styles = readFileSync(resolve("src/styles.css"), "utf8");
const workflowTab = readFileSync(resolve("src/workbench/WorkflowTab.tsx"), "utf8");
const activityBar = readFileSync(resolve("src/workbench/ActivityBar.tsx"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const brandIconsPath = resolve("src/workbench/BrandIcons.tsx");
const brandIcons = existsSync(brandIconsPath) ? readFileSync(brandIconsPath, "utf8") : "";

function lastRule(selector) {
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  let body = "";
  while ((match = pattern.exec(cssLookup))) {
    const selectorSet = new Set(match[1].split(",").map((part) => part.trim()));
    if (selectorSet.has(selector)) body = match[2];
  }
  if (!body) throw new Error(`Missing CSS rule for ${selector}`);
  return body;
}

function declaration(body, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;]+);`);
  return body.match(pattern)?.[1].trim() ?? "";
}

function declarations(body) {
  const result = {};
  for (const part of body.split(";")) {
    const index = part.indexOf(":");
    if (index === -1) continue;
    const property = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (property && value) result[property] = value;
  }
  return result;
}

function finalDeclarations(selector) {
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  const result = {};
  while ((match = pattern.exec(cssLookup))) {
    const selectorSet = new Set(match[1].split(",").map((part) => part.trim()));
    if (selectorSet.has(selector)) Object.assign(result, declarations(match[2]));
  }
  return result;
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
const selectedIcon = lastRule(".workflow-node.is-selected .workflow-node__icon");
const iconSvg = lastRule(".workflow-node__icon svg");
const iconSvgParts = lastRule(".workflow-node__icon svg *");
const pickerItemIcon = lastRule(".workflow-block-picker__item-icon");
const tab = lastRule(".workflow-tab");
const output = lastRule(".workflow-inspector__output");
const templateEditor = lastRule(".workflow-template-editor");
const templateEditorMetrics = finalDeclarations(".workflow-template-editor");
const templateEditorFocusMetrics = finalDeclarations(".workflow-template-editor:focus-within");
const templateMirrorMetrics = finalDeclarations(".workflow-template-editor__mirror");
const templateControlMetrics = finalDeclarations(".workflow-template-editor__control");
const templateNativeControlMetrics = finalDeclarations(
  ".workflow-template-editor .workflow-template-editor__control",
);
const templateTokenMetrics = finalDeclarations(".workflow-template-token");
const templateControlFocusMetrics = finalDeclarations(
  ".workflow-template-editor .workflow-template-editor__control:focus",
);
const toolbarMetrics = finalDeclarations(".workflow-toolbar");

assert(
  css.includes("/* Workflow Shadcn Graph Surface */"),
  "workflow CSS must use the single shadcn graph surface block",
);

assert(
  styles.includes("color-scheme: dark") &&
    /scrollbar-color:\s*#[0-9a-f]{6}\s+#[0-9a-f]{6}/i.test(styles) &&
    styles.includes("::-webkit-scrollbar-thumb"),
  "global scrollbars must use a dark cross-browser color scheme",
);

assert(
  toolbarMetrics["overflow-x"] === "auto" &&
    toolbarMetrics["overflow-y"] === "hidden" &&
    toolbarMetrics["scrollbar-width"] === "none" &&
    css.includes(".workflow-toolbar::-webkit-scrollbar"),
  "workflow toolbar must keep horizontal overflow without a visible scrollbar",
);

assert(
  Boolean(packageJson.dependencies?.["@vscode/codicons"]) &&
    main.includes("@vscode/codicons/dist/codicon.css") &&
    workflowTab.includes("codicon codicon-") &&
    workflowTab.includes("WORKFLOW_CODICONS"),
  "ordinary workflow icons must use official VS Code Codicons",
);

assert(
  activityBar.includes('from "./BrandIcons"') &&
    workflowTab.includes('from "./BrandIcons"') &&
    brandIcons.includes("function ClaudeLogo") &&
    brandIcons.includes("function OpenAILogo") &&
    workflowTab.includes('name === "claude"') &&
    workflowTab.includes('name === "codex"') &&
    !workflowTab.includes("M12 4.2 14.2 9l5 .8") &&
    !workflowTab.includes('case "codex"'),
  "workflow Claude and Codex blocks must use shared official brand marks",
);

assert(
  !css.includes("Workflow Pro Glass refinement") &&
    !css.includes("Workflow Coder Compact correction"),
  "old workflow visual override blocks must be removed",
);

assert(
  main.includes("@fontsource/geist-sans/latin-400.css") &&
    main.includes("@fontsource/geist-sans/latin-500.css") &&
    main.includes("@fontsource/geist-sans/latin-600.css") &&
    main.includes("@fontsource/geist-sans/latin-700.css") &&
    main.includes("@fontsource/geist-mono/latin-400.css") &&
    main.includes("@fontsource/geist-mono/latin-500.css") &&
    main.includes("@fontsource/geist-mono/latin-600.css"),
  "workflow latin font files must be loaded from Fontsource Geist",
);

assert(
  css.includes('--wf-font-sans: "Geist Sans"') && css.includes('--wf-font-mono: "Geist Mono"'),
  "workflow CSS must define Geist Sans and Geist Mono font variables",
);

assert(
  declaration(tab, "font-family") === "var(--wf-font-sans)",
  "workflow tab should use the Geist Sans font variable",
);

assert(
  declaration(name, "font-family") === "var(--wf-font-sans)",
  "workflow node titles should use the Geist Sans font variable",
);

assert(
  declaration(output, "font-family") === "var(--wf-font-mono)",
  "workflow output panels should use the Geist Mono font variable",
);

assert(
  templateMirrorMetrics.display === "block" &&
    templateMirrorMetrics.color === "transparent" &&
    templateMirrorMetrics.background === "transparent" &&
    templateMirrorMetrics["border-color"] === "transparent",
  "workflow template mirror must paint only transparent glyph geometry behind the native control",
);

assert(
  [
    "box-sizing",
    "margin",
    "font-family",
    "font-size",
    "font-style",
    "font-weight",
    "line-height",
    "padding",
    "letter-spacing",
    "word-spacing",
    "text-align",
    "text-indent",
    "text-transform",
    "font-kerning",
    "font-variant-ligatures",
    "font-synthesis",
    "tab-size",
  ].every((property) => templateControlMetrics[property] === templateMirrorMetrics[property]) &&
    templateControlMetrics["box-sizing"] === "border-box" &&
    templateControlMetrics.margin === "0" &&
    templateControlMetrics["font-family"] === "var(--wf-font-mono)" &&
    templateControlMetrics["font-size"] === "12px" &&
    templateControlMetrics["font-style"] === "normal" &&
    templateControlMetrics["font-weight"] === "400" &&
    templateControlMetrics["line-height"] === "1.45" &&
    templateControlMetrics.padding === "6px 8px" &&
    templateControlMetrics["letter-spacing"] === "0" &&
    templateControlMetrics["word-spacing"] === "0" &&
    templateControlMetrics["text-align"] === "left" &&
    templateControlMetrics["text-indent"] === "0" &&
    templateControlMetrics["text-transform"] === "none" &&
    templateControlMetrics["font-kerning"] === "normal" &&
    templateControlMetrics["font-variant-ligatures"] === "none" &&
    templateControlMetrics["font-synthesis"] === "none" &&
    templateControlMetrics["tab-size"] === "2",
  "workflow template native input must keep stable editor text metrics",
);

assert(
  hasDeclaration(templateEditor, "font-family", "var(--wf-font-mono)") &&
    hasDeclaration(templateEditor, "font-size", "12px") &&
    hasDeclaration(templateEditor, "line-height", "1.45"),
  "workflow template editor host must pin the same text metrics used by its overlay layers",
);

assert(
  templateNativeControlMetrics.appearance === "none" &&
    templateNativeControlMetrics["-webkit-appearance"] === "none" &&
    templateNativeControlMetrics["font-family"] === "var(--wf-font-mono)" &&
    templateNativeControlMetrics["font-size"] === "12px" &&
    templateNativeControlMetrics["line-height"] === "1.45" &&
    templateNativeControlMetrics.color === "var(--wf-text-soft)" &&
    templateNativeControlMetrics["-webkit-text-fill-color"] === "currentColor" &&
    !/transparent/.test(templateNativeControlMetrics.color) &&
    !/transparent/.test(templateNativeControlMetrics["-webkit-text-fill-color"]),
  "workflow template input must render its own text so the native caret aligns",
);

assert(
  templateEditorMetrics.background === "rgba(9, 9, 11, 0.72)" &&
    templateEditorMetrics.border === "1px solid var(--wf-border)" &&
    templateEditorFocusMetrics["border-color"] === "rgba(96, 165, 250, 0.7)" &&
    Boolean(templateEditorFocusMetrics["box-shadow"]) &&
    templateNativeControlMetrics.background === "transparent" &&
    templateTokenMetrics.color === "transparent" &&
    templateTokenMetrics.background === "rgba(37, 99, 235, 0.22)" &&
    templateTokenMetrics["box-shadow"] === "inset 0 0 0 1px rgba(96, 165, 250, 0.32)",
  "workflow template host and mirror must render token backgrounds without replacing native text",
);

assert(
  templateControlFocusMetrics.outline === "none" &&
    templateControlFocusMetrics["box-shadow"] === "none" &&
    Boolean(templateEditorFocusMetrics["box-shadow"]),
  "workflow template host should own the focus ring without duplicating it on the native input",
);

assert(
  !workflowTab.includes("normalizeTemplateSpacing") &&
    (workflowTab.match(/onChange=\{\(e\) => onChange\(e\.target\.value\)\}/g)?.length ?? 0) === 2 &&
    workflowTab.includes("{match[0]}"),
  "workflow template mirror and native controls must preserve the exact input string",
);

assert(
  !workflowTab.includes('onUpdate({ model: value || "default" })') &&
    workflowTab.includes("onUpdate({ model: value })"),
  "workflow model editor must allow the model field to be cleared without immediately restoring default",
);

assert(
  workflowTab.includes("Geist Mono, SFMono-Regular, Cascadia Mono"),
  "workflow xterm should prefer Geist Mono for terminal output",
);

assert(
  Number(declaration(name, "line-height")) >= 1.22,
  "workflow node text needs enough line-height so descenders like g are not clipped",
);

assert(
  px(declaration(icon, "width")) >= 22 && px(declaration(icon, "height")) >= 22,
  "workflow node icon box must be at least 22px for the shadcn-style icon slot",
);

assert(
  /translateY\(1px\)/.test(declaration(icon, "transform")),
  "workflow node icon needs a 1px optical downward offset to align with text glyphs",
);

assert(
  !declaration(icon, "border") &&
    !declaration(icon, "border-radius") &&
    !declaration(icon, "background") &&
    !declaration(icon, "box-shadow"),
  "workflow node icon should render without a decorative frame",
);

assert(
  !declaration(selectedIcon, "border-color") && !declaration(selectedIcon, "background"),
  "selected workflow node icon should stay frameless and only change icon color",
);

assert(
  !declaration(pickerItemIcon, "border") &&
    !declaration(pickerItemIcon, "border-radius") &&
    !declaration(pickerItemIcon, "background") &&
    !declaration(pickerItemIcon, "box-shadow"),
  "workflow block picker item icon should render without a decorative frame",
);

assert(
  px(declaration(iconSvg, "width")) >= 18 && px(declaration(iconSvg, "height")) >= 18,
  "workflow node SVG must be at least 18px so zoomed icons do not look low resolution",
);

assert(
  /22px\s+minmax\(0,\s*1fr\)/.test(declaration(node, "grid-template-columns")),
  "workflow node grid should reserve a 22px icon slot aligned with the text",
);

assert(
  /0\s+25px\s+0\s+16px/.test(declaration(node, "padding")),
  "workflow node padding must reserve room for the right status dot and left rail",
);

assert(
  px(declaration(node, "border-radius")) <= 7,
  "workflow nodes should keep shadcn-like low radius",
);

assert(
  declaration(iconSvgParts, "vector-effect") !== "non-scaling-stroke",
  "workflow node icon strokes should scale as vectors when the workflow canvas zooms",
);

console.log("workflow node CSS checks passed");
