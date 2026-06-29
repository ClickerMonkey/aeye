import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import type { ResolverContext, ResourceResolver } from "../types";
import { assertNotAborted, hasUriScheme, isHttpUrl, isZipEntryLocation, toFilePath } from "../utils";

function resolveFilePath(link: string, context: ResolverContext): string | undefined {
  const baseLocation = context.options.baseLocation;
  if (link.startsWith("file://")) {
    return toFilePath(link);
  }
  if (path.isAbsolute(link)) {
    return link;
  }
  return baseLocation ? path.resolve(path.dirname(toFilePath(baseLocation)), link) : undefined;
}

export const fileResolver: ResourceResolver = {
  id: "file",
  canResolve(link, context) {
    if (isHttpUrl(link) || isZipEntryLocation(link)) {
      return false;
    }

    const baseLocation = context.options.baseLocation;
    // A web-based parent means its relative/root-relative links are URLs, not local files.
    if (baseLocation && isHttpUrl(baseLocation)) {
      return false;
    }
    // A parent inside a zip archive means its relative links are other entries, not local files.
    if (baseLocation && isZipEntryLocation(baseLocation)) {
      return false;
    }

    if (path.isAbsolute(link) || link.startsWith("file://")) {
      return true;
    }

    // Relative link: resolvable only against a (non-web) base, and not if it carries its own scheme.
    return Boolean(baseLocation && !hasUriScheme(link) && !link.startsWith("//"));
  },
  async resolve(link, context) {
    assertNotAborted(context.options.signal);
    const resolvedPath = resolveFilePath(link, context);

    if (!resolvedPath) {
      return undefined;
    }

    const stats = await stat(resolvedPath).catch(() => undefined);

    // Use a factory function for lazy streaming instead of eagerly reading
    const input = (): AsyncIterable<Uint8Array> => Readable.toWeb(createReadStream(resolvedPath)) as AsyncIterable<Uint8Array>;
    return {
      location: resolvedPath,
      input,
      name: path.basename(resolvedPath),
      modifiedAt: stats?.mtimeMs,
      size: stats?.size
    };
  },
  async stat(link, context) {
    assertNotAborted(context.options.signal);
    const resolvedPath = resolveFilePath(link, context);
    if (!resolvedPath) {
      return undefined;
    }
    const stats = await stat(resolvedPath).catch(() => undefined);
    return {
      location: resolvedPath,
      modifiedAt: stats?.mtimeMs,
      size: stats?.size
    };
  }
};
