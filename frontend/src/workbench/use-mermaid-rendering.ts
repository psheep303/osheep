import DOMPurify from "dompurify";
import { type RefObject, useEffect, useId, useRef } from "react";

export type MermaidColorTheme = "light" | "dark";

export type MermaidThemeVariables = Readonly<Record<string, string | boolean>>;

const MERMAID_SECURE_CONFIG = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
  "theme",
  "themeVariables",
  "themeCSS",
  "darkMode",
  "htmlLabels",
] as const;

let mermaidRenderQueue: Promise<void> = Promise.resolve();

function enqueueMermaidRender(task: () => Promise<void>): Promise<void> {
  const result = mermaidRenderQueue.then(task, task);
  mermaidRenderQueue = result.catch(() => undefined);
  return result;
}

export function mermaidThemeVariables(theme: MermaidColorTheme): MermaidThemeVariables {
  const dark = theme === "dark";
  const background = dark ? "#1f1f1f" : "#ffffff";
  const foreground = dark ? "#f4f4f5" : "#24292f";
  const line = dark ? "#a1a1aa" : "#57606a";
  const primary = dark ? "#26384a" : "#dbeafe";
  const primaryBorder = dark ? "#6aa8ff" : "#2563eb";
  const secondary = dark ? "#293c32" : "#dcfce7";
  const secondaryBorder = dark ? "#70c18a" : "#15803d";
  const tertiary = dark ? "#453b26" : "#fef3c7";
  const tertiaryBorder = dark ? "#d6a849" : "#a16207";
  const surface = dark ? "#181818" : "#f6f8fa";
  const alternateSurface = dark ? "#282828" : "#eef2f6";
  const note = dark ? "#3f3a20" : "#fff8c5";
  const noteBorder = dark ? "#d6b656" : "#9a6700";
  const critical = dark ? "#4c2c2c" : "#fee2e2";
  const criticalBorder = dark ? "#f48771" : "#b42318";

  return {
    darkMode: dark,
    background,
    primaryColor: primary,
    primaryTextColor: foreground,
    primaryBorderColor: primaryBorder,
    secondaryColor: secondary,
    secondaryTextColor: foreground,
    secondaryBorderColor: secondaryBorder,
    tertiaryColor: tertiary,
    tertiaryTextColor: foreground,
    tertiaryBorderColor: tertiaryBorder,
    lineColor: line,
    arrowheadColor: line,
    textColor: foreground,
    titleColor: foreground,
    mainBkg: primary,
    nodeBkg: primary,
    nodeBorder: primaryBorder,
    nodeTextColor: foreground,
    clusterBkg: surface,
    clusterBorder: dark ? "#52525b" : "#d0d7de",
    defaultLinkColor: line,
    edgeLabelBackground: background,

    actorBkg: primary,
    actorBorder: primaryBorder,
    actorTextColor: foreground,
    actorLineColor: line,
    signalColor: line,
    signalTextColor: foreground,
    labelBoxBkgColor: surface,
    labelBoxBorderColor: line,
    labelTextColor: foreground,
    loopTextColor: foreground,
    noteBkgColor: note,
    noteBorderColor: noteBorder,
    noteTextColor: foreground,
    activationBkgColor: secondary,
    activationBorderColor: secondaryBorder,
    sequenceNumberColor: foreground,

    sectionBkgColor: surface,
    altSectionBkgColor: alternateSurface,
    sectionBkgColor2: alternateSurface,
    excludeBkgColor: alternateSurface,
    taskBkgColor: primary,
    taskBorderColor: primaryBorder,
    activeTaskBkgColor: secondary,
    activeTaskBorderColor: secondaryBorder,
    doneTaskBkgColor: alternateSurface,
    doneTaskBorderColor: line,
    critBkgColor: critical,
    critBorderColor: criticalBorder,
    taskTextColor: foreground,
    taskTextDarkColor: foreground,
    taskTextLightColor: foreground,
    taskTextOutsideColor: foreground,
    taskTextClickableColor: foreground,
    gridColor: dark ? "#52525b" : "#d0d7de",
    vertLineColor: line,
    todayLineColor: dark ? "#ff8a7a" : "#cf222e",

    rowOdd: background,
    rowEven: surface,
    attributeBackgroundColorOdd: background,
    attributeBackgroundColorEven: surface,
    classText: foreground,
    stateBkg: primary,
    stateLabelColor: foreground,
    labelBackgroundColor: background,
    transitionColor: line,
    transitionLabelColor: foreground,
    compositeBackground: surface,
    compositeTitleBackground: primary,
    compositeBorder: primaryBorder,
    altBackground: alternateSurface,

    pieTitleTextColor: foreground,
    pieSectionTextColor: foreground,
    pieLegendTextColor: foreground,
    pieStrokeColor: background,
    pieOuterStrokeColor: line,
    vennTitleTextColor: foreground,
    vennSetTextColor: foreground,
    scaleLabelColor: foreground,
    cScaleLabel0: foreground,
    cScaleLabel1: foreground,
    cScaleLabel2: foreground,
    cScaleLabel3: foreground,
    cScaleLabel4: foreground,
    cScaleLabel5: foreground,
    cScaleLabel6: foreground,
    cScaleLabel7: foreground,
    cScaleLabel8: foreground,
    cScaleLabel9: foreground,
    cScaleLabel10: foreground,
    cScaleLabel11: foreground,

    requirementBackground: primary,
    requirementBorderColor: primaryBorder,
    requirementTextColor: foreground,
    relationColor: line,
    relationLabelBackground: background,
    relationLabelColor: foreground,
    branchLabelColor: foreground,
    tagLabelColor: foreground,
    tagLabelBackground: tertiary,
    tagLabelBorder: tertiaryBorder,
    commitLabelColor: foreground,
    commitLabelBackground: background,
  };
}

export function useMermaidRendering(
  rootRef: RefObject<HTMLElement>,
  html: string,
  theme: MermaidColorTheme,
): void {
  const diagramId = useId().replace(/[^A-Za-z0-9_-]/g, "");
  const generationRef = useRef(0);

  useEffect(() => {
    if (!html) return;
    const root = rootRef.current;
    if (!root) return;
    const diagrams = Array.from(
      root.querySelectorAll<HTMLElement>("pre.mermaid, .markdown-mermaid"),
    );
    if (diagrams.length === 0) return;
    const generation = ++generationRef.current;
    let cancelled = false;

    void enqueueMermaidRender(async () => {
      if (cancelled) return;
      const { default: mermaid } = await import("mermaid");
      if (cancelled) return;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        secure: [...MERMAID_SECURE_CONFIG],
        // DOMPurify's SVG profile removes foreignObject and its HTML label content.
        htmlLabels: false,
        theme: "base",
        themeVariables: mermaidThemeVariables(theme),
      });

      for (let index = 0; index < diagrams.length; index += 1) {
        const diagram = diagrams[index];
        if (cancelled || !diagram?.isConnected) return;
        const source = diagram.matches("pre.mermaid")
          ? (diagram.textContent ?? "")
          : (diagram.dataset.mermaidSource ?? "");
        if (!source) continue;
        try {
          const { svg } = await mermaid.render(
            `osheep-${diagramId}-${generation}-${index}`,
            source,
          );
          if (cancelled || !diagram.isConnected) return;
          const wrapper = document.createElement("div");
          wrapper.className = "markdown-mermaid";
          wrapper.dataset.mermaidSource = source;
          wrapper.dataset.mermaidTheme = theme;
          wrapper.innerHTML = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
          });
          diagram.replaceWith(wrapper);
        } catch {
          diagram.classList.add("markdown-mermaid--error");
        }
      }
    }).catch(() => {
      if (cancelled) return;
      for (const diagram of diagrams) {
        if (diagram.isConnected) diagram.classList.add("markdown-mermaid--error");
      }
    });

    return () => {
      cancelled = true;
    };
  }, [diagramId, html, rootRef, theme]);
}
