import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");

const checks = [
  {
    name: "startup splash reads stored and system theme before React mounts",
    pass:
      /osheep\.uiPreferences\.v1/.test(html) &&
      /prefers-color-scheme: dark/.test(html) &&
      /dataset\.theme = theme/.test(html),
  },
  {
    name: "startup splash uses the Osheep icon and a rotating indicator",
    pass:
      /id="startup-splash"/.test(html) &&
      /src="\/osheep-icon\.png"/.test(html) &&
      /startup-splash-spin/.test(html) &&
      /animation: startup-splash-spin/.test(html),
  },
  {
    name: "startup splash has no visible brand text",
    pass: !/<div id="startup-splash"[\s\S]*?>[\s\S]*?Osheep[\s\S]*?<\/div>/.test(html),
  },
];

for (const check of checks) {
  console.log(`${check.pass ? "PASS" : "FAIL"} ${check.name}`);
}

if (checks.some((check) => !check.pass)) process.exitCode = 1;
