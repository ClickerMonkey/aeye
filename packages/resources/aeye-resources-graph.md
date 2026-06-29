# @aeye/resources — Resolvers, locations & the resource graph

Parent: [aeye-resources.md](./aeye-resources.md)

This covers how links become loadable resources (**resolvers**), how to know exactly how to fetch a
**location**, the `modifiedAt` staleness signal, and how to build the full **resource graph** of
everything reachable from a root.

## Resolvers

A **resolver** turns a link/location string into a `ResourceSource`.

```ts
interface ResourceResolver {
  id: string;
  canResolve: (link, ctx) => boolean | Promise<boolean>;
  resolve: (link, ctx) => Promise<ResourceSource | undefined>;
  stat?: (link, ctx) => Promise<ResourceStat | undefined>;  // cheap probe, no body
}
```

`ctx` is `{ registry, options }` where `options` includes `baseLocation`, `headers`, `signal`,
`metadata`. The registry tries resolvers in registration order; first `canResolve` wins.

### Built-in resolvers (registered in this order)

- **zipResolver** — links to zip entries. Resolves both fully-qualified zip-entry locations
  (`bundle.zip#entry/doc.md`) and links **relative to another entry** (`./other.md`, `../assets/x.png`,
  `/root.md`) within the same archive. Registered first so entry-relative links beat file/url.
- **fileResolver** — absolute paths, `file://` URLs, and relative paths against a non-web,
  non-zip `baseLocation`. Sets `modifiedAt`/`size` from `fs.stat`.
- **urlResolver** — http(s) URLs, plus relative/root-relative/protocol-relative links resolved
  against an http(s) `baseLocation` (via `new URL`). Sets `modifiedAt` (`Last-Modified`) and `size`
  (`Content-Length`); `stat` uses a `HEAD` request.

### Resolving links

```ts
// Relative link needs a base (typically the parent resource's location):
const src = await registry.resolveLink("./child.md", { baseLocation: parent.location });

// Cheap probe for dedup / staleness, without downloading:
const stat = await registry.statLink("./child.md", { baseLocation: parent.location });
// → { location, modifiedAt?, size?, mimeType?, type? } | undefined
```

## Locations: "know exactly how to get it"

Every location the system emits is **canonical and self-contained** (absolute file path, `file://`,
http(s) URL, or `zip.zip#entry/...` with an absolute archive path). Helpers classify and fetch them:

```ts
import { inferLocationScheme, isSelfContainedLocation } from "@aeye/resources";

inferLocationScheme(loc);          // "url" | "file" | "zip-entry" | "relative"
isSelfContainedLocation(loc);      // true unless "relative"

await registry.locate(loc);        // resolve a self-contained location directly (no base)
                                   // throws if loc is relative — use resolveLink + baseLocation
await registry.getResolverId(loc); // which resolver would handle it ("zip"|"file"|"url"|undefined)
```

Zip-entry helpers: `isZipEntryLocation`, `buildZipEntryLocation(zip, entry)`,
`parseZipEntryLocation(loc)`, `resolveZipEntryName(baseEntry, link)`, plus `ZIP_ENTRY_MARKER`.

> A relative location supplied manually (e.g. a hand-built `ResourceSource`) is **not**
> self-contained — `locate()` rejects it. The resolvers always emit absolute file locations so they
> round-trip across processes (on the same host/filesystem).

## `modifiedAt` — staleness & incremental rebuilds

`ResourceSource` and `ParsedResource` carry `modifiedAt` (epoch ms) and `size` when known:
filesystem mtime, HTTP `Last-Modified`, or zip entry date. A target system stores `modifiedAt`
alongside each built resource and compares it on rebuild to decide whether to reprocess.

## Building the resource graph

`buildResourceGraph(registry, inputs, options?)` walks from one or more roots, loading each link
target as a resource and recursing into its links **and** children — de-duplicated so cycles and
shared references terminate.

```ts
import { buildResourceGraph } from "@aeye/resources";

const graph = await buildResourceGraph(registry, "/docs/index.md", {
  maxDepth: 5,
  followExternal: false,   // don't fetch http links
});

graph.roots;   // ResourceLocation[]
graph.nodes;   // Map<location, ResourceGraphNode>
```

### Shapes

```ts
interface ResourceGraph { roots: string[]; nodes: Map<string, ResourceGraphNode>; }

interface ResourceGraphNode {
  id; location; type; depth;
  modifiedAt?; resource: ParsedResource;
  slices?: ResourceSlice[];   // present if includeSlices
  reused: boolean;            // true if served from cache (incremental)
  edges: ResourceGraphEdge[]; // outgoing links
  children: string[];         // contained child locations (zip entries, pdf pages)
  parents: string[];          // who links to / contains this node
}

interface ResourceGraphEdge {
  link: ResourceLink;
  targetLocation?: string; targetId?: string;
  loaded: boolean;            // is the target a node in the graph?
  reason?: "external" | "resource-links-disabled" | "filtered"
         | "unresolved" | "max-depth" | "max-resources" | "skipped" | "error";
  error?: string;
}
```

### `BuildGraphOptions` (extends `LoadResourceOptions`)

| Option | Default | Effect |
| --- | --- | --- |
| `maxDepth` | ∞ | max link/child distance from a root |
| `maxResources` | ∞ | cap on nodes loaded (existing nodes never re-counted) |
| `followChildren` | `true` | traverse children (zip entries, rendered pages) as nodes |
| `followExternal` | `true` | follow external (http) links |
| `followResourceLinks` | `true` | follow internal/relative links |
| `includeSlices` | `false` | also slice each resource → `node.slices` |
| `shouldFollow(link, from)` | — | per-link filter |
| `shouldLoad(target)` | — | incremental: return false to skip parsing (target = `{location, modifiedAt, link, depth}`) |
| `getCached(location, modifiedAt?)` | — | supply a previously-parsed resource to reuse |
| `onNode(node)` | — | called as each node is added |

De-duplication uses `statLink` to get a target's canonical location (and `modifiedAt`) **before**
loading, so a URL/file referenced many times is fetched once, and cross-zip-entry links connect to
the existing entry nodes the zip parser already produced.

### Incremental rebuild pattern

```ts
const cache = new Map<string, ParsedResource>();        // location → last build
for (const node of previous.nodes.values()) cache.set(node.location, node.resource);

const graph = await buildResourceGraph(registry, roots, {
  // skip reparse when our stored mtime matches the probed one
  shouldLoad: ({ location, modifiedAt }) => modifiedAt !== storedMtimes.get(location),
  getCached: (location) => cache.get(location),
});
// node.reused === true for resources served from cache; roots always parse fresh.
```

## Gotchas

- URL-hosted zips are not supported (zip parser/resolver read archives from disk).
- Relative links *between* zip entries resolve correctly; a link from a zip entry pointing **outside**
  the archive won't (it stays archive-relative) and surfaces as an `unresolved`/`error` edge.
- `statLink` issues a `HEAD` for URLs; servers that reject HEAD still yield a location (for dedup) but
  no `modifiedAt`.
