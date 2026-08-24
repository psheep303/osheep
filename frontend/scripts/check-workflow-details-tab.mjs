import { readFileSync } from "node:fs";

const workbench = readFileSync("src/workbench/Workbench.tsx", "utf8");
const workflowTab = readFileSync("src/workbench/WorkflowTab.tsx", "utf8");
const combined = `${workbench}\n${workflowTab}`;

const checks = [
  {
    name: "workflow run details use an internal editor tab",
    pass:
      /kind: "workflow-details"/.test(workbench) &&
      /openWorkflowDetailsTab/.test(workbench) &&
      /<WorkflowRunDetailsPage\b/.test(workbench),
  },
  {
    name: "the same workflow block reuses its details tab",
    pass:
      /workflowDetailsPath\(details\.workflowId, details\.nodeId\)/.test(workbench) &&
      /prev\.find\(\(tab\) => tab\.path === path\)/.test(workbench),
  },
  {
    name: "agent inspectors delegate details navigation to Workbench",
    pass: /onOpenDetails\(\{ workspaceId, workflowId, nodeId: node\.id, title: node\.title \}\)/.test(
      workflowTab,
    ),
  },
  {
    name: "workflow details do not open a browser or Tauri window",
    pass: !/window\.open\s*\(/.test(combined) && !/WebviewWindow/.test(combined),
  },
];

for (const check of checks) {
  console.log(`${check.pass ? "PASS" : "FAIL"} ${check.name}`);
}

if (checks.some((check) => !check.pass)) process.exitCode = 1;
