import assert from "node:assert/strict";
import test from "node:test";
import { mermaidThemeVariables } from "./use-mermaid-rendering";

const REQUIRED_TEXT_COLORS = [
  "textColor",
  "primaryTextColor",
  "secondaryTextColor",
  "tertiaryTextColor",
  "nodeTextColor",
  "actorTextColor",
  "signalTextColor",
  "labelTextColor",
  "loopTextColor",
  "noteTextColor",
  "taskTextColor",
  "taskTextOutsideColor",
  "classText",
  "stateLabelColor",
  "pieTitleTextColor",
  "pieSectionTextColor",
  "pieLegendTextColor",
  "requirementTextColor",
  "relationLabelColor",
] as const;

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(first: string, second: string): number {
  const lighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

test("Mermaid palettes define text colors for common diagram types", () => {
  for (const theme of ["light", "dark"] as const) {
    const variables = mermaidThemeVariables(theme);
    for (const name of REQUIRED_TEXT_COLORS) {
      assert.match(String(variables[name]), /^#[0-9a-f]{6}$/i, `${theme}.${name}`);
    }
  }
});

test("Mermaid node and label colors keep readable contrast", () => {
  for (const theme of ["light", "dark"] as const) {
    const variables = mermaidThemeVariables(theme);
    const pairs = [
      ["primaryTextColor", "primaryColor"],
      ["secondaryTextColor", "secondaryColor"],
      ["tertiaryTextColor", "tertiaryColor"],
      ["noteTextColor", "noteBkgColor"],
      ["stateLabelColor", "stateBkg"],
      ["taskTextColor", "taskBkgColor"],
      ["relationLabelColor", "relationLabelBackground"],
    ] as const;

    for (const [textColor, backgroundColor] of pairs) {
      const ratio = contrastRatio(String(variables[textColor]), String(variables[backgroundColor]));
      assert.ok(ratio >= 4.5, `${theme}.${textColor} contrast is ${ratio.toFixed(2)}`);
    }
  }
});

test("Mermaid palettes follow the selected editor theme", () => {
  const light = mermaidThemeVariables("light");
  const dark = mermaidThemeVariables("dark");

  assert.equal(light.darkMode, false);
  assert.equal(dark.darkMode, true);
  assert.equal(light.background, "#ffffff");
  assert.equal(dark.background, "#1f1f1f");
  assert.notEqual(light.primaryColor, dark.primaryColor);
  assert.notEqual(light.textColor, dark.textColor);
  assert.notEqual(light.lineColor, dark.lineColor);
  assert.notEqual(light.edgeLabelBackground, dark.edgeLabelBackground);
});
