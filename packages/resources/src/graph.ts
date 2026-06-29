import type { ResourceRegistry } from "./registry";
import type {
  LoadResourceOptions,
  ParsedResource,
  ResourceLink,
  ResourceLocation,
  ResourceSlice,
  ResourceSource,
} from "./types";
import { assertNotAborted } from "./utils";

/** Why a link's target was not loaded into the graph. */
export type GraphEdgeSkipReason =
  | "external"
  | "resource-links-disabled"
  | "filtered"
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
  /** Outgoing link edges. */
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
  /** Maximum number of nodes to load. Defaults to unlimited. Existing nodes are never re-counted. */
  maxResources?: number;
  /** Traverse child resources (zip entries, rendered PDF pages, …) as nodes. Defaults to true. */
  followChildren?: boolean;
  /** Follow external (e.g. http) links. Defaults to true. */
  followExternal?: boolean;
  /** Follow internal/relative resource links. Defaults to true. */
  followResourceLinks?: boolean;
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
 * Pass {@link BuildGraphOptions.shouldLoad} + {@link BuildGraphOptions.getCached} to perform
 * incremental rebuilds against a target system, using each resource's `modifiedAt` to detect staleness.
 */
export async function buildResourceGraph(
  registry: ResourceRegistry,
  inputs: string | ResourceSource | Array<string | ResourceSource>,
  options: BuildGraphOptions = {},
): Promise<ResourceGraph> {
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const maxResources = options.maxResources ?? Number.POSITIVE_INFINITY;
  const followChildren = options.followChildren ?? true;
  const followExternal = options.followExternal ?? true;
  const followResourceLinks = options.followResourceLinks ?? true;

  const nodes = new Map<ResourceLocation, ResourceGraphNode>();
  const roots: ResourceLocation[] = [];
  const queue: ResourceLocation[] = [];

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
    if (options.includeSlices) {
      node.slices = await registry.slice(resource, options);
    }
    nodes.set(node.location, node);
    options.onNode?.(node);
    queue.push(node.location);
    return node;
  };

  // Seed roots.
  const rootInputs = Array.isArray(inputs) ? inputs : [inputs];
  for (const input of rootInputs) {
    assertNotAborted(options.signal);
    const { resource } = await registry.parse(input, options);
    const node = await registerNode(resource, 0, false);
    if (!roots.includes(node.location)) {
      roots.push(node.location);
    }
  }

  // Breadth-first expansion.
  while (queue.length > 0) {
    assertNotAborted(options.signal);
    const location = queue.shift()!;
    const node = nodes.get(location)!;

    if (node.depth >= maxDepth) {
      continue;
    }

    if (followChildren) {
      for (const child of node.resource.children ?? []) {
        if (!nodes.has(child.location) && nodes.size >= maxResources) {
          continue;
        }
        const childNode = await registerNode(child, node.depth + 1, false);
        addParent(childNode, node.location);
        if (!node.children.includes(child.location)) {
          node.children.push(child.location);
        }
      }
    }

    for (const link of node.resource.links) {
      assertNotAborted(options.signal);
      node.edges.push(await followLink(link, node));
    }
  }

  return { roots, nodes };

  async function followLink(link: ResourceLink, from: ResourceGraphNode): Promise<ResourceGraphEdge> {
    const isExternal = link.kind === "external";
    if (isExternal && !followExternal) {
      return { link, loaded: false, reason: "external" };
    }
    if (!isExternal && !followResourceLinks) {
      return { link, loaded: false, reason: "resource-links-disabled" };
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

    if (probedLocation) {
      const known = nodes.get(probedLocation);
      if (known) {
        addParent(known, from.location);
        return { link, loaded: true, targetLocation: known.location, targetId: known.id };
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
          const node = await registerNode(cached, targetDepth, true);
          addParent(node, from.location);
          return { link, loaded: true, targetLocation: node.location, targetId: node.id };
        }
        return { link, loaded: false, reason: "skipped", targetLocation: probedLocation };
      }
    }

    if (nodes.size >= maxResources) {
      return { link, loaded: false, reason: "max-resources", targetLocation: probedLocation };
    }

    try {
      const { resource } = await registry.parse(link.value, linkOptions);
      const node = await registerNode(resource, targetDepth, false);
      addParent(node, from.location);
      return { link, loaded: true, targetLocation: node.location, targetId: node.id };
    } catch (error) {
      return {
        link,
        loaded: false,
        reason: "error",
        error: error instanceof Error ? error.message : String(error),
        targetLocation: probedLocation,
      };
    }
  }
}
