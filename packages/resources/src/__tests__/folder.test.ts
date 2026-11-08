import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDefaultResourceRegistry } from "../default";
import { buildResourceGraph } from "../graph";
import { FOLDER_MIME_TYPE, FOLDER_TYPE } from "../resolvers/folder";
import { folderListingSchema, versionText } from "../versions";

const registry = createDefaultResourceRegistry();
let root = "";

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "aeye-folder-"));
  await mkdir(path.join(root, "docs"));
  await mkdir(path.join(root, "lib"));
  await mkdir(path.join(root, "node_modules"));
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, "README.md"), "# Readme\n");
  await writeFile(path.join(root, ".env"), "SECRET=1");
  await writeFile(path.join(root, "app.ts"), "import { x } from './lib';\n");
  await writeFile(path.join(root, "lib", "index.ts"), "export const x = 1;\n");
  await writeFile(path.join(root, "docs", "guide.md"), "# Guide\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("folder resolver", () => {
  it("resolves a folder to its listing: folders first, hidden and ignored entries left out", async () => {
    const source = await registry.locate(root);
    expect(source).toMatchObject({ location: root, type: FOLDER_TYPE, mimeType: FOLDER_MIME_TYPE, name: path.basename(root) });
    const listing = folderListingSchema.parse(JSON.parse(typeof source.input === "string" ? source.input : ""));
    expect(listing.entries.map((entry) => [entry.name, entry.kind, entry.type])).toEqual([
      ["docs", "folder", "folder"],
      ["lib", "folder", "folder"],
      ["app.ts", "file", "typescript"],
      ["README.md", "file", "markdown"],
    ]);
    expect(listing.entries.find((entry) => entry.name === "README.md")?.size).toBe(9);
    expect(listing).toMatchObject({ truncated: false, total: 4 });
  });

  it("lists hidden and ignored entries when told, and cuts long folders", async () => {
    const all = await registry.locate(root, { folder: { includeHidden: true, ignore: [] } });
    const names = folderListingSchema.parse(JSON.parse(typeof all.input === "string" ? all.input : "")).entries.map((entry) => entry.name);
    expect(names).toEqual(expect.arrayContaining([".git", "node_modules", ".env"]));
    const cut = await registry.locate(root, { folder: { maxEntries: 1 } });
    expect(folderListingSchema.parse(JSON.parse(typeof cut.input === "string" ? cut.input : ""))).toMatchObject({ truncated: true, total: 4 });
  });

  it("resolves file URLs and relative links to folders, and stats them", async () => {
    expect((await registry.locate(pathToFileURL(path.join(root, "docs")).toString())).type).toBe(FOLDER_TYPE);
    expect((await registry.resolveLink("docs", { baseLocation: path.join(root, "README.md") })).location).toBe(path.join(root, "docs"));
    expect(await registry.statLink(root)).toMatchObject({ location: root, type: FOLDER_TYPE });
    expect(await registry.getResolverId(path.join(root, "README.md"))).toBe("file");
  });

  it("leaves a script's import of a folder to module resolution (its index file)", async () => {
    const source = await registry.resolveLink("./lib", { baseLocation: path.join(root, "app.ts") });
    expect(source.location).toBe(path.join(root, "lib", "index.ts"));
  });
});

describe("folder resources", () => {
  it("parse to a markdown listing with a link to every entry", async () => {
    const { resource, slices } = await registry.load(root);
    expect(resource.version?.kind).toBe("markdown");
    expect(resource.version && versionText(resource.version)).toBe(
      `# ${path.basename(root)}\n\nFolder: ${root}\n\n- docs/\n- lib/\n- app.ts (typescript, 27 B)\n- README.md (markdown, 9 B)`,
    );
    expect(resource.links.map((link) => [link.value, link.kind, link.targetType])).toEqual([
      [path.join(root, "docs"), "resource", "folder"],
      [path.join(root, "lib"), "resource", "folder"],
      [path.join(root, "app.ts"), "resource", "typescript"],
      [path.join(root, "README.md"), "resource", "markdown"],
    ]);
    expect(slices.length).toBeGreaterThan(0);
  });

  it("let a resource graph walk the whole tree", async () => {
    const graph = await buildResourceGraph(registry, root);
    const locations = [...graph.nodes.keys()].map((location) => path.relative(root, location).replace(/\\/g, "/")).sort();
    expect(locations).toEqual(["", "README.md", "app.ts", "docs", "docs/guide.md", "lib", "lib/index.ts"]);
  });
});
