export {
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  detectType,
  fetchResource,
  looksScriptRendered,
  statUrl,
} from "./loader";
export type { DetectedBy, HttpFetchOptions, HttpResource, TypeInference } from "./loader";
export { decodeText, isGenericMimeType, isUtf8Charset, looksBinary, parseContentType, sniffMagic, sniffText } from "./sniff";
export type { ContentType, DecodedText, Magic } from "./sniff";
