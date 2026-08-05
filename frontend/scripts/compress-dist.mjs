// Generate gzip sidecars for text assets after Vite builds the frontend.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const COMPRESSIBLE = new Set([".css", ".html", ".js", ".json", ".map", ".svg"]);
const root = fileURLToPath(new URL("../dist", import.meta.url));

let savedBytes = 0;

function walk(directory) {
  for (const name of readdirSync(directory)) {
    const filePath = join(directory, name);
    const fileStats = statSync(filePath);
    if (fileStats.isDirectory()) {
      walk(filePath);
    } else if (COMPRESSIBLE.has(extname(name).toLowerCase()) && fileStats.size > 1024) {
      const compressed = gzipSync(readFileSync(filePath), { level: 9 });
      writeFileSync(`${filePath}.gz`, compressed);
      savedBytes += fileStats.size - compressed.length;
    }
  }
}

walk(root);
console.log(`compress-dist: saved ${(savedBytes / 1024).toFixed(0)} KiB`);
