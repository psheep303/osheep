import { existsSync, readFileSync } from "node:fs";

const workbench = readFileSync("src/workbench/Workbench.tsx", "utf8");
const controls = readFileSync("src/workbench/DesktopWindowControls.tsx", "utf8");
const desktopPicker = readFileSync("src/workbench/desktop-folder-picker.ts", "utf8");
const desktopLib = readFileSync("../desktop/src-tauri/src/lib.rs", "utf8");
const capability = JSON.parse(
  readFileSync("../desktop/src-tauri/capabilities/default.json", "utf8"),
);

const permissions = [
  "core:window:allow-close",
  "core:window:allow-is-maximized",
  "core:window:allow-minimize",
  "core:window:allow-start-dragging",
  "core:window:allow-toggle-maximize",
];

const checks = [
  {
    name: "titlebar displays the Osheep icon before the brand name",
    pass:
      existsSync("public/osheep-icon.png") &&
      /<img className="titlebar__logo" src="\/osheep-icon\.png"[\s\S]*?<span className="titlebar__brand">Osheep<\/span>/.test(
        workbench,
      ),
  },
  {
    name: "window controls are limited to the Windows desktop shell",
    pass:
      /isWindowsDesktopShell\(\)/.test(workbench) &&
      /windowsDesktopShell && <DesktopWindowControls \/>/.test(workbench) &&
      /isDesktopShell\(\) && \/Windows\/i\.test\(navigator\.userAgent\)/.test(desktopPicker),
  },
  {
    name: "window controls expose minimize, maximize or restore, and close actions",
    pass: ["minimize", "toggleMaximize", "close", "isMaximized"].every((action) =>
      controls.includes(`appWindow.${action}(`),
    ),
  },
  {
    name: "both Windows desktop window builders disable system decorations",
    pass:
      (desktopLib.match(/#\[cfg\(target_os = "windows"\)\]/g) ?? []).length >= 2 &&
      (desktopLib.match(/builder\.decorations\(false\)/g) ?? []).length === 2,
  },
  {
    name: "desktop capability grants custom titlebar window actions",
    pass: permissions.every((permission) => capability.permissions.includes(permission)),
  },
];

for (const check of checks) {
  console.log(`${check.pass ? "PASS" : "FAIL"} ${check.name}`);
}

if (checks.some((check) => !check.pass)) process.exitCode = 1;
