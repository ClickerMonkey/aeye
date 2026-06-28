import type { ResourceResolver } from "../types";
import { assertNotAborted, basenameFromLocation, inferTypeFromLocation } from "../utils";

export const urlResolver: ResourceResolver = {
  id: "url",
  canResolve(link) {
    return /^https?:\/\//i.test(link);
  },
  async resolve(link, context) {
    assertNotAborted(context.options.signal);
    const response = await fetch(link, {
      headers: context.options.headers,
      signal: context.options.signal
    });

    if (!response.ok) {
      throw new Error(`Failed to resolve ${link}: ${response.status} ${response.statusText}`);
    }

    const mimeType = response.headers.get("content-type") ?? undefined;
    const type = inferTypeFromLocation(link, mimeType);

    // Use streaming body when available to avoid loading entire response into memory
    if (response.body) {
      return {
        location: link,
        input: response.body as ReadableStream<Uint8Array>,
        mimeType,
        type,
        name: basenameFromLocation(link)
      };
    }

    const input = new Uint8Array(await response.arrayBuffer());
    return {
      location: link,
      input,
      mimeType,
      type,
      name: basenameFromLocation(link)
    };
  }
};
