import type { ResourceRegistry } from "./registry";
import type {
  LoadResourceOptions,
  ParsedResource,
  ResourceLink,
  ResourceLocation,
  ResourceSlice,
  ResourceSource,
} from "./types";
import { createLimiter } from "./summaries";
import { assertNotAborted, isHttpUrl, resolveAgainstUrl } from "./utils";

/** Default cap on graph size, so a crawl can't run away. Pass `Infinity` to lift it. */
export const DEFAULT_GRAPH_MAX_RESOURCES = 1000;
/** Default number of link targets loaded at once. */
export const DEFAULT_GRAPH_CONCURRENCY = 4;

/** Why a link's target was not loaded into the graph. */
export type GraphEdgeSkipReason =
  | "external"
  | "resource-links-disabled"
  | "filtered"
  | "cross-origin"
  | "unresolved"
  | "max-depth"
  | "max-resources"
  | "skipped"
  | "error";

export interface ResourceGraphEdge {
  /** The originating link. */
  link: ResourceLink;
  /** Canonical location of the resolved target, if it could be determined. */
  targetLocation?: ResourceLocation;
  /** Node id of the target, if it was loaded into the graph. */
  targetId?: string;
  /** Whether the target is present as a node in the graph. */
  loaded: boolean;
  /** Why the target was not loaded (only set when `loaded` is false). */
  reason?: GraphEdgeSkipReason;
  /** Error message when `reason` is "error". */
  error?: string;
}

export interface ResourceGraphNode {
  id: string;
  location: ResourceLocation;
  type: string;
  /** Shortest distance (in links/children) from a root. */
  depth: number;
  /** Estimated last-modified time of the underlying source, in epoch milliseconds, if known. */
  modifiedAt?: number;
  resource: ParsedResource;
  /** Slices for this resource, if `includeSlices` was enabled. */
  slices?: ResourceSlice[];
  /** True when the resource was reused from the caller's cache rather than freshly parsed. */
  reused: boolean;
  /** Outgoing link edges, in the order the links appear in the resource. */
  edges: ResourceGraphEdge[];
  /** Locations of child resources (e.g. zip entries, rendered PDF pages) contained by this node. */
  children: ResourceLocation[];
  /** Locations of nodes that link to / contain this node. */
  parents: ResourceLocation[];
}

export interface ResourceGraph {
  /** Locations of the root nodes the graph was built from. */
  roots: ResourceLocation[];
  /** All nodes keyed by canonical location. */
  nodes: Map<ResourceLocation, ResourceGraphNode>;
}

/** Information about a prospective link target, passed to incremental-build hooks. */
export interface GraphTarget {
  location: ResourceLocation;
  modifiedAt?: number;
  link: ResourceLink;
  depth: number;
}

export interface BuildGraphOptions extends LoadResourceOptions {
  /** Maximum link/child distance from a root to traverse. Defaults to unlimited. */
  maxDepth?: number;
  /**
   * Maximum number of nodes to load. Defaults to {@link DEFAULT_GRAPH_MAX_RESOURCES} (1000); pass
   * `Infinity` for no cap. Existing nodes are never re-counted.
   */
  maxResources?: number;
  /** How many link targets to probe/load at once. Defaults to {@link DEFAULT_GRAPH_CONCURRENCY} (4). */
  concurrency?: number;
  /** Traverse child resources (zip entries, rendered PDF pages, …) as nodes. Defaults to true. */
  followChildren?: boolean;
  /**
   * Follow external links (e.g. http links from a local file, or links to another site). Defaults to
   * false. Links between pages of the same site are not external; they follow with
   * {@link BuildGraphOptions.followResourceLinks}.
   */
  followExternal?: boolean;
  /** Follow internal/relative resource links. Defaults to true. */
  followResourceLinks?: boolean;
  /**
   * Keep web crawling on one site: a link found on a web page is only followed when it points to the
   * same origin. Links from non-web resources (local files, zips) to the web are not affected, so a
   * local doc can still reach the pages it links to, which then stay on their own site. Only matters
   * with `followExternal`. Defaults to true.
   */
  sameOrigin?: boolean;
  /** Also slice each loaded resource and attach the slices to its node. Defaults to false. */
  includeSlices?: boolean;
  /** Per-link filter; return false to skip following a link. */
  shouldFollow?: (link: ResourceLink, from: ResourceGraphNode) => boolean;
  /**
   * Incremental-build hook: decide whether to (re)load a target. Return false to skip parsing; if a
   * cached resource is available via {@link BuildGraphOptions.getCached} it is reused instead, keeping
   * the graph connected. The `modifiedAt` is supplied (when known) so callers can compare against a
   * previously-stored build time.
   */
  shouldLoad?: (target: GraphTarget) => boolean | Promise<boolean>;
  /**
   * Supplies a previously-parsed resource for a location, avoiding a re-parse. Combined with
   * {@link BuildGraphOptions.shouldLoad}, enables incremental graph rebuilds: unchanged resources are
   * reused from a cache, changed ones are re-parsed.
   */
  getCached?: (location: ResourceLocation, modifiedAt?: number) => ParsedResource | undefined;
  /** Invoked whenever a node is added to the graph (freshly loaded or reused). */
  onNode?: (node: ResourceGraphNode) => void;
}

/**
 * Builds a graph of resources and the links between them, starting from one or more roots, by loading
 * each link target as a resource and recursing into its links and children. Effort is de-duplicated:
 * each canonical location is loaded at most once, so cycles and shared references are handled and the
 * traversal terminates even on infinitely cross-referencing content.
 *
 * The graph is walked one depth level at a time, with up to {@link BuildGraphOptions.concurrency}
 * targets loading at once, so each node's `depth` is its true shortest distance from a root. Node
 * insertion order in `nodes` may vary between runs when concurrency is above 1.
 *
 * Pass {@link BuildGraphOptions.shouldLoad} + {@link BuildGraphOptions.getCached} to perform
 * incremental rebuilds against a target system, using each resource's `modifiedAt` to detect staleness.
 */
export async function buildResourceGraph(
  registry: ResourceRegistry,
  inputs: string | ResourceSource | Array<string | ResourceSource>,
  options: BuildGraphOptions = {},
): Promise<ResourceGraph> {
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const maxResources = options.maxResources ?? DEFAULT_GRAPH_MAX_RESOURCES;
  const followChildren = options.followChildren ?? true;
  const followExternal = options.followExternal ?? false;
  const followResourceLinks = options.followResourceLinks ?? true;
  const sameOrigin = options.sameOrigin ?? true;
  const limit = createLimiter(options.concurrency ?? DEFAULT_GRAPH_CONCURRENCY);

  const nodes = new Map<ResourceLocation, ResourceGraphNode>();
  const roots: ResourceLocation[] = [];
  /** Targets being loaded right now, so concurrent links to the same target share one load. */
  const pending = new Map<string, Promise<ResourceGraphNode>>();
  let discovered: ResourceGraphNode[] = [];

  const isFull = (): boolean => nodes.size + pending.size >= maxResources;

  const addParent = (node: ResourceGraphNode, parent: ResourceLocation): void => {
    if (parent !== node.location && !node.parents.includes(parent)) {
      node.parents.push(parent);
    }
  };

  const registerNode = async (resource: ParsedResource, depth: number, reused: boolean): Promise<ResourceGraphNode> => {
    const existing = nodes.get(resource.location);
    if (existing) {
      existing.depth = Math.min(existing.depth, depth);
      return existing;
    }
    const node: ResourceGraphNode = {
      id: resource.id,
      location: resource.location,
      type: resource.type,
      depth,
      modifiedAt: resource.modifiedAt,
      resource,
      reused,
      edges: [],
      children: [],
      parents: [],
    };
    // Claim the location before any await so concurrent loads see it.
    nodes.set(node.location, node);
    discovered.push(node);
    if (options.includeSlices) {
      node.slices = await registry.slice(resource, options);
    }
    options.onNode?.(node);
    return node;
  };

  // Seed roots (loaded concurrently, kept in input order).
  const rootInputs = Array.isArray(inputs) ? inputs : [inputs];
  const rootNodes = await Promise.all(rootInputs.map((input) => limit(async () => {
    assertNotAborted(options.signal);
    const { resource } = await registry.parse(input, options);
    return registerNode(resource, 0, false);
  })));
  for (const node of rootNodes) {
    if (!roots.includes(node.location)) {
      roots.push(node.location);
    }
  }

  // Breadth-first expansion, one depth level per wave.
  let frontier = discovered;
  discovered = [];
  while (frontier.length > 0) {
    assertNotAborted(options.signal);
    await Promise.all(frontier.map((node) => expand(node)));
    frontier = discovered;
    discovered = [];
  }

  return { roots, nodes };

  async function expand(node: ResourceGraphNode): Promise<void> {
    if (node.depth >= maxDepth) {
      return;
    }

    if (followChildren) {
      for (const child of node.resource.children ?? []) {
        if (!nodes.has(child.location) && isFull()) {
          continue;
        }
        const childNode = await registerNode(child, node.depth + 1, false);
        addParent(childNode, node.location);
        if (!node.children.includes(child.location)) {
          node.children.push(child.location);
        }
      }
    }

    node.edges = await Promise.all(node.resource.links.map((link) => limit(() => followLink(link, node))));
  }

  /** The absolute http(s) URL a link points to, if it is a web link. */
  function webTarget(link: ResourceLink, from: ResourceGraphNode): URL | undefined {
    try {
      if (isHttpUrl(link.value)) return new URL(link.value);
      if (isHttpUrl(from.location)) return new URL(resolveAgainstUrl(link.value, from.location));
    } catch {
      // Not a valid URL.
    }
    return undefined;
  }

  async function followLink(link: ResourceLink, from: ResourceGraphNode): Promise<ResourceGraphEdge> {
    assertNotAborted(options.signal);
    const target = webTarget(link, from);
    const fromWeb = isHttpUrl(from.location);
    const crossOrigin = Boolean(target && fromWeb && target.origin !== new URL(from.location).origin);
    // A link to another page of the same site is internal, however it is spelled.
    const isExternal = link.kind === "external" && !(target && fromWeb && !crossOrigin);

    if (isExternal && !followExternal) {
      return { link, loaded: false, reason: "external" };
    }
    if (!isExternal && !followResourceLinks) {
      return { link, loaded: false, reason: "resource-links-disabled" };
    }
    if (crossOrigin && sameOrigin) {
      return { link, loaded: false, reason: "cross-origin", targetLocation: target?.toString() };
    }
    if (options.shouldFollow && !options.shouldFollow(link, from)) {
      return { link, loaded: false, reason: "filtered" };
    }

    const linkOptions = { ...options, baseLocation: from.location };
    const targetDepth = from.depth + 1;

    if (!(await registry.canResolve(link.value, linkOptions))) {
      return { link, loaded: false, reason: "unresolved" };
    }

    // Probe the canonical location (and modified time) cheaply for de-duplication / incrementality.
    const stat = await registry.statLink(link.value, linkOptions).catch(() => undefined);
    const probedLocation = stat?.location;

    const connect = (node: ResourceGraphNode): ResourceGraphEdge => {
      addParent(node, from.location);
      return { link, loaded: true, targetLocation: node.location, targetId: node.id };
    };

    if (probedLocation) {
      const known = nodes.get(probedLocation);
      if (known) {
        return connect(known);
      }
      const inFlight = pending.get(probedLocation);
      if (inFlight) {
        const node = await inFlight.catch(() => undefined);
        if (node) return connect(node);
      }
    }

    if (targetDepth > maxDepth) {
      return { link, loaded: false, reason: "max-depth", targetLocation: probedLocation };
    }

    // Incremental-build hook: optionally skip (re)parsing and reuse a cached resource.
    if (options.shouldLoad) {
      const shouldLoad = await options.shouldLoad({
        location: probedLocation ?? link.value,
        modifiedAt: stat?.modifiedAt,
        link,
        depth: targetDepth,
      });
      if (!shouldLoad) {
        const cached = options.getCached?.(probedLocation ?? link.value, stat?.modifiedAt);
        if (cached) {
          return connect(await registerNode(cached, targetDepth, true));
        }
        return { link, loaded: false, reason: "skipped", targetLocation: probedLocation };
      }
    }

    if (isFull()) {
      return { link, loaded: false, reason: "max-resources", targetLocation: probedLocation };
    }

    // Without a probed location the load can't be shared; key it uniquely so it still counts as pending.
    const key = probedLocation ?? `\0link:${from.location}:${link.id}`;
    const load = (async () => {
      const { resource } = await registry.parse(link.value, linkOptions);
      // registerNode claims the location synchronously, so the node takes over from the reservation.
      pending.delete(key);
      return registerNode(resource, targetDepth, false);
    })();
    pending.set(key, load);

    try {
      return connect(await load);
    } catch (error) {
      assertNotAborted(options.signal);
      return {
        link,
        loaded: false,
        reason: "error",
        error: error instanceof Error ? error.message : String(error),
        targetLocation: probedLocation,
      };
    } finally {
      pending.delete(key);
    }
  }
}
