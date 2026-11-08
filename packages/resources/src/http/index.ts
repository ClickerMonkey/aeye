export {
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  detectType,
  fetchResource,
  looksScriptRendered,
  statUrl,
} from "./loader.js";
export type { DetectedBy, HttpFetchOptions, HttpResource, TypeInference } from "./loader.js";
export { decodeText, isGenericMimeType, isUtf8Charset, looksBinary, parseContentType, sniffMagic, sniffText } from "./sniff.js";
export type { ContentType, DecodedText, Magic } from "./sniff.js";
