import type { ResourceResolver } from "../types";
import { assertNotAborted, basenameFromLocation, hasUriScheme, isHttpUrl, resolveAgainstUrl } from "../utils";

export const urlResolver: ResourceResolver = {
  id: "url",
  canResolve(link, context) {
    if (isHttpUrl(link)) {
      return true;
    }
    // Relative link discovered in a resource fetched from the web resolves against its URL base.
    const baseLocation = context.options.baseLocation;
    return Boolean(baseLocation && isHttpUrl(baseLocation) && !hasUriScheme(link));
  },
  async resolve(link, context) {
    assertNotAborted(context.options.signal);
    const baseLocation = context.options.baseLocation;
    const url = isHttpUrl(link) || !baseLocation ? link : resolveAgainstUrl(link, baseLocation);
    const response = await fetch(url, {
      headers: context.options.headers,
      signal: context.options.signal
    });

    if (!response.ok) {
      throw new Error(`Failed to resolve ${url}: ${response.status} ${response.statusText}`);
    }

    const mimeType = response.headers.get("content-type") ?? undefined;
    const type = context.registry.inferType(url, mimeType);
    const modifiedAt = parseLastModified(response.headers.get("last-modified"));
    const size = parseContentLength(response.headers.get("content-length"));

    // Use streaming body when available to avoid loading entire response into memory
    if (response.body) {
      return {
        location: url,
        input: response.body as ReadableStream<Uint8Array>,
        mimeType,
        type,
        modifiedAt,
        size,
        name: basenameFromLocation(url)
      };
    }

    const input = new Uint8Array(await response.arrayBuffer());
    return {
      location: url,
      input,
      mimeType,
      type,
      modifiedAt,
      size,
      name: basenameFromLocation(url)
    };
  },
  async stat(link, context) {
    assertNotAborted(context.options.signal);
    const baseLocation = context.options.baseLocation;
    const url = isHttpUrl(link) || !baseLocation ? link : resolveAgainstUrl(link, baseLocation);
    try {
      const response = await fetch(url, {
        method: "HEAD",
        headers: context.options.headers,
        signal: context.options.signal
      });
      if (!response.ok) {
        // Many servers reject HEAD; still report the canonical location for de-duplication.
        return { location: url };
      }
      const mimeType = response.headers.get("content-type") ?? undefined;
      return {
        location: url,
        mimeType,
        type: context.registry.inferType(url, mimeType),
        modifiedAt: parseLastModified(response.headers.get("last-modified")),
        size: parseContentLength(response.headers.get("content-length"))
      };
    } catch {
      // Network/HEAD failure: still return the canonical location so callers can de-duplicate.
      return { location: url };
    }
  }
};

function parseLastModified(value: string | null): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) return undefined;
  const size = Number.parseInt(value, 10);
  return Number.isNaN(size) ? undefined : size;
}
