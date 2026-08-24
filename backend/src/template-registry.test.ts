import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  installRegistryTemplate,
  loadTemplateRegistry,
  type TemplateRegistryEntry,
  templateFileUrls,
} from "./template-registry.js";

test("template registry parses entries and installs a repository template", async () => {
  const destinationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-marketspace-"));
  const entry: TemplateRegistryEntry = {
    id: "code-review",
    name: "Code Review Assistant",
    description: "Review code",
    version: "1.0.0",
    source: { type: "github", repo: "user/repository", path: "templates/code-review" },
  };
  const responses = new Map<string, Uint8Array | string>([
    ["registry", JSON.stringify({ version: "1", templates: [entry] })],
    ["workflow.json", JSON.stringify({ nodes: [], edges: [] })],
    ["README.md", "# Code review"],
  ]);
  const fetchImpl: typeof fetch = async (url) => {
    const key = String(url).endsWith("registry.json")
      ? "registry"
      : String(url).endsWith("workflow.json")
        ? "workflow.json"
        : String(url).endsWith("README.md")
          ? "README.md"
          : "missing";
    const value = responses.get(key);
    return new Response(value, { status: value === undefined ? 404 : 200 });
  };
  const registry = await loadTemplateRegistry({
    registryUrl: "https://example.test/registry.json",
    fetchImpl,
  });
  assert.deepEqual(registry.templates[0], entry);
  await installRegistryTemplate(entry, { destinationRoot, fetchImpl });
  assert.equal(
    JSON.parse(await fs.readFile(path.join(destinationRoot, entry.id, "template.json"), "utf8"))
      .title,
    entry.name,
  );
  assert.equal(
    await fs.readFile(path.join(destinationRoot, entry.id, "README.md"), "utf8"),
    "# Code review",
  );
});

test("template registry builds GitHub and CDN source URLs", () => {
  const entry: TemplateRegistryEntry = {
    id: "demo",
    name: "Demo",
    description: "",
    version: "main",
    source: { type: "github", repo: "user/repo", path: "templates/demo" },
  };
  const urls = templateFileUrls(entry, "workflow.json");
  assert.equal(
    urls[0],
    "https://raw.githubusercontent.com/user/repo/main/templates/demo/workflow.json",
  );
  assert.equal(urls[1], "https://cdn.jsdelivr.net/gh/user/repo@main/templates/demo/workflow.json");
});
