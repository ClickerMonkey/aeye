import { fetchResource, statUrl } from "../http/loader.js";
import type { ResolverContext, ResourceResolver } from "../types.js";
import { assertNotAborted, hasUriScheme, isHttpUrl, resolveAgainstUrl } from "../utils.js";

/** The absolute URL a link names: itself when absolute, else against the (web) base. */
function absoluteUrl(link: string, context: ResolverContext): string {
  const baseLocation = context.options.baseLocation;
  return isHttpUrl(link) || !baseLocation ? link : resolveAgainstUrl(link, baseLocation);
}

/**
 * Resolves http(s) URLs, and relative links found in a resource fetched from the web, by fetching them (see
 * {@link fetchResource}): type detection, charset decoding, and the page renderer for script-built html come with it.
 */
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
    return (await fetchResource(absoluteUrl(link, context), context.registry, context.options)).source;
  },
  async stat(link, context) {
    return statUrl(absoluteUrl(link, context), context.registry, context.options);
  }
};
