import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
const desktopHtml = readFileSync("../desktop/shell/index.html", "utf8");

const checks = [
  {
    name: "startup splash defaults to dark and honors stored or system theme before React mounts",
    pass:
      /osheep\.uiPreferences\.v1/.test(html) &&
      /prefers-color-scheme: dark/.test(html) &&
      /dataset\.theme = theme/.test(html) &&
      /preference === "system"/.test(html) &&
      /: "dark";/.test(html) &&
      /:root\s*\{[\s\S]*?color-scheme: dark/.test(html),
  },
  {
    name: "startup splash uses the Osheep icon and three cycling dots",
    pass:
      /id="startup-splash"/.test(html) &&
      /src="\/osheep-icon\.png"/.test(html) &&
      (html.match(/class="startup-splash__dot"/g)?.length ?? 0) === 3 &&
      /animation: startup-splash-dot/.test(html) &&
      /--startup-accent: #8c8c8c/.test(html) &&
      !/#75beff|#0078d4/.test(html) &&
      !/startup-splash__mark::before/.test(html),
  },
  {
    name: "startup splash has no visible brand text",
    pass: !/<div id="startup-splash"[\s\S]*?>[\s\S]*?Osheep[\s\S]*?<\/div>/.test(html),
  },
  {
    name: "desktop startup shell defaults to dark and honors explicit system theme",
    pass:
      /startupPreference === "system"/.test(desktopHtml) &&
      /startupPreference === "light" \? "light" : "dark"/.test(desktopHtml) &&
      /body\s*\{[\s\S]*?background: #181818/.test(desktopHtml) &&
      /\.dot\s*\{[\s\S]*?background: #8c8c8c/.test(desktopHtml) &&
      !/#75beff|#0078d4/.test(desktopHtml),
  },
];

for (const check of checks) {
  console.log(`${check.pass ? "PASS" : "FAIL"} ${check.name}`);
}

if (checks.some((check) => !check.pass)) process.exitCode = 1;
