/**
 * @aeye/schema — the LLM-first schema builder. See aeye-schema.md.
 */
export * as a from './a';
export * from './schema';
export * from './module';
export * from './render';
export * from './profile';
export * from './model';
export * from './request';
export * from './measure';
export * from './template';
export * from './deferred';
export * from './errors';
export {
  DEFAULT_ERROR_FORMAT, errorFormat, mergeErrorFormats, formatErrors, issueKind, suggestionFor, modelPath, shortType,
  type ErrorDetail, type ErrorFormat, type ErrorFormatInput, type ResolvedErrorFormat, type IssueKind,
} from './feedback';
export { editDistance, suggestionBudget, rankNear, nearest, didYouMean } from './suggest';
export * from './types';
export { fromJSONSchema, type ImportReport } from './json-schema';
export { fromGin, ginNamedTypes, GIN_BUILTINS, type GinSchema, type GinTypeDef, type GinRegistryLike } from './gin/from-gin';
