// Loads every entry point of the built package under plain Node ESM (no bundler, no tsx), so a relative import
// without its `.js` extension, or any other import Node can't resolve, fails the build.
// Run: npm run smoke   (the build runs it after tsc)
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
let failed = 0;
for (const [entry, conditions] of Object.entries(pkg.exports)) {
  const target = conditions.import?.default ?? conditions.default;
  try {
    const loaded = await import(pathToFileURL(path.join(root, target)).href);
    console.log(`ok ${entry} (${Object.keys(loaded).length} exports)`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${entry} -> ${target}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failed > 0) process.exit(1);
