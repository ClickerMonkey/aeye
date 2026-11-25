// @ts-nocheck — frozen zod-path baseline (see ./index.ts); compiled as it was in its own package, not under this one's stricter test flags.
/**
 * FROZEN: @aeye/gin's zod grammar and value schemas as they were before step 2
 * (packages/gin/src at bae5424~1, the files `buildSchemas`, `createRegistry` and
 * `aids` reach; untouched but this index). Step 2 made gin produce `a` (Type.toA,
 * GinGrammar); its zod `buildZodSchemas` / `toValueSchema` stay only until the
 * harness moves (step 3). The corpus differentials (corpus/gin-grammar.test.ts,
 * gin-values.test.ts, feedback.test.ts) and the bench keep this copy as their zod
 * baseline so they stay valid whatever @aeye/gin's dist becomes. Do not edit;
 * never imported by src/.
 */
export { buildSchemas } from './schemas';
export { didYouMean, nearest } from './aids';
export * from './registry';
