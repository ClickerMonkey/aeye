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
    const maxBytes = context.options.maxBytes ?? DEFAULT_MAX_BYTES;
    const response = await fetch(url, {
      headers: context.options.headers,
      signal: withTimeout(context.options.signal, context.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new Error(`Failed to resolve ${url}: ${response.status} ${response.statusText}`);
    }

    const declaredSize = parseContentLength(response.headers.get("content-length"));
    if (maxBytes > 0 && declaredSize !== undefined && declaredSize > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Resource at ${url} is ${declaredSize} bytes, over the ${maxBytes}-byte limit`);
    }

    const mimeType = response.headers.get("content-type") ?? undefined;
    const type = context.registry.inferType(url, mimeType);
    const modifiedAt = parseLastModified(response.headers.get("last-modified"));
    const size = declaredSize;

    // Use streaming body when available to avoid loading entire response into memory
    if (response.body) {
      return {
        location: url,
        input: maxBytes > 0 ? limitStream(response.body as ReadableStream<Uint8Array>, maxBytes, url) : response.body as ReadableStream<Uint8Array>,
        mimeType,
        type,
        modifiedAt,
        size,
        name: basenameFromLocation(url)
      };
    }

    const input = new Uint8Array(await response.arrayBuffer());
    if (maxBytes > 0 && input.length > maxBytes) {
      throw new Error(`Resource at ${url} is over the ${maxBytes}-byte limit`);
    }
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
        signal: withTimeout(context.options.signal, context.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
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
    } catch (error) {
      if (context.options.signal?.aborted) throw error;
      // Network/HEAD failure: still return the canonical location so callers can de-duplicate.
      return { location: url };
    }
  }
};

/** Default URL fetch timeout (headers and body), in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Default maximum bytes downloaded per URL. */
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Combines the caller's signal with a timeout. The timer is unref'd and never cleared, so it also
 * covers reading the response body after `resolve` returns.
 */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0) {
    return signal;
  }
  const controller = new AbortController();
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  if (signal) {
    if (signal.aborted) abort(signal.reason);
    else signal.addEventListener("abort", () => abort(signal.reason), { once: true });
  }
  const timer = setTimeout(() => abort(new DOMException(`Timed out after ${timeoutMs}ms`, "TimeoutError")), timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  return controller.signal;
}

/** Passes a stream through, erroring once more than `maxBytes` have been read. */
function limitStream(body: ReadableStream<Uint8Array>, maxBytes: number, url: string): ReadableStream<Uint8Array> {
  let total = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.error(new Error(`Resource at ${url} is over the ${maxBytes}-byte limit`));
        return;
      }
      controller.enqueue(chunk);
    }
  }));
}

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
