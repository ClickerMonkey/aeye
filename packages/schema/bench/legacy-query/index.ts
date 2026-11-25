// @ts-nocheck — frozen zod-path baseline (see ./index.ts); compiled as it was in its own package, not under this one's stricter test flags.
/**
 * FROZEN: @aeye/query's zod grammar as it was before step 2 (packages/query/src at
 * 0c4a94e~1, the files `buildSchemas`, `createRegistry` and `didYouMean` reach;
 * untouched but this index). Step 2 deleted it from @aeye/query (the model-facing grammar
 * is now `a`: llm/grammar.ts), so the corpus differentials (corpus/query.test.ts,
 * product.test.ts, feedback.test.ts) and the bench keep it here as their zod
 * baseline: the `a` ports are proven value-for-value against this, and the bench
 * times it, whatever @aeye/query's dist becomes. Do not edit; never imported by src/.
 */
export * from './schema';
export { buildSchemas, type BuildSchemasOptions } from './llm/schemas';
export { createRegistry, type Registry } from './registry';
export { didYouMean } from './aids';
