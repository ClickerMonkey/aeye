import { createReadStream } from "node:fs";
import path from "node:path";
import type { ResourceResolver } from "../types";
import { assertNotAborted, toFilePath } from "../utils";

export const fileResolver: ResourceResolver = {
  id: "file",
  canResolve(link, context) {
    if (link.startsWith("http://") || link.startsWith("https://")) {
      return false;
    }

    if (path.isAbsolute(link) || link.startsWith("file://")) {
      return true;
    }

    return Boolean(context.options.baseLocation && !/^([a-z][a-z0-9+.-]*:)?\/\//i.test(link));
  },
  async resolve(link, context) {
    assertNotAborted(context.options.signal);
    const baseLocation = context.options.baseLocation;
    const resolvedPath = link.startsWith("file://")
      ? toFilePath(link)
      : path.isAbsolute(link)
        ? link
        : baseLocation
          ? path.resolve(path.dirname(toFilePath(baseLocation)), link)
          : undefined;

    if (!resolvedPath) {
      return undefined;
    }

    // Use a factory function for lazy streaming instead of eagerly reading
    const input = () => createReadStream(resolvedPath) as unknown as AsyncIterable<Uint8Array>;
    return {
      location: resolvedPath,
      input,
      name: path.basename(resolvedPath)
    };
  }
};
