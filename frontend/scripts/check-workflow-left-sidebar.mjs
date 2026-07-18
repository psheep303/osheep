import { readFileSync } from "node:fs";

const activityBar = readFileSync("src/workbench/ActivityBar.tsx", "utf8");
const workbench = readFileSync("src/workbench/Workbench.tsx", "utf8");

const checks = [
  {
    name: "ActivityBar exposes workflow as a view id",
    pass:
      /export type ViewId =/.test(activityBar) &&
      /\|\s*"workflow"/.test(activityBar),
  },
  {
    name: "workflow is the first ActivityBar item",
    pass: /const ITEMS: Item\[\] = \[\s*\{\s*id: "workflow"/m.test(activityBar),
  },
  {
    name: "ActivityBar has the node-flow Workflow icon",
    pass:
      /function WorkflowIcon\(\)/.test(activityBar) &&
      /<circle cx="6" cy="7" r="2\.2"/.test(activityBar) &&
      /<circle cx="12" cy="17" r="2\.2"/.test(activityBar),
  },
  {
    name: "Workbench renders AiPanel from the workflow left view",
    pass:
      /activeView === "workflow"/.test(workbench) &&
      /<AiPanel\s+workspaceId=\{workspaceId\}/.test(workbench),
  },
  {
    name: "Workbench opens with the workflow left view selected",
    pass: /useState<ViewId>\("workflow"\)/.test(workbench),
  },
  {
    name: "right workflow sidebar is removed",
    pass:
      !/side--right/.test(workbench) &&
      !/rightWidth/.test(workbench) &&
      !/PanelRightIcon/.test(workbench) &&
      !/toggleRight/.test(workbench),
  },
  {
    name: "titlebar project label opens the workspace picker",
    pass:
      /className="titlebar__project-btn"/.test(workbench) &&
      /onClick=\{\(\) => setPicking\(true\)\}/.test(workbench) &&
      /\{workspaceId \?\? "选择工作区"\}/.test(workbench),
  },
  {
    name: "titlebar actions only keep save",
    pass:
      /<div className="titlebar__actions">\s*<button\s+className="tb-btn"\s+onClick=\{saveActive\}/m.test(
        workbench
      ) &&
      !/<LayoutToggle/.test(workbench) &&
      !/titlebar__spacer/.test(workbench),
  },
  {
    name: "explorer empty state has no workspace picker button",
    pass:
      !/side-view__body--padded[\s\S]*setPicking\(true\)/.test(workbench),
  },
];

const failures = checks.filter((check) => !check.pass);
for (const check of checks) {
  console.log(`${check.pass ? "PASS" : "FAIL"} ${check.name}`);
}

if (failures.length > 0) {
  process.exitCode = 1;
}
