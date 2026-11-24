/**
 * The zod path leaks: @aeye/query's process-local `sharedIdRegistry` (a zod
 * registry) keeps every `buildSchemas` generation's shared fragments in its id
 * map forever (~2 MB per generation; PERFORMANCE.md). Imported before
 * @aeye/query, this records the registries that receive ids so the timing
 * runs can empty them between measurements (or they run out of heap); the
 * memory runs measure the leak as it is.
 */
import { z } from 'zod';

const registries = new Set<{ _idmap: Map<string, unknown> }>();
const proto = Object.getPrototypeOf(z.registry()) as { add(this: unknown, s: unknown, m: unknown): unknown };
const add = proto.add;
proto.add = function (this: { _idmap: Map<string, unknown> }, s: unknown, m: unknown) {
  if (m && typeof m === 'object' && 'id' in m) registries.add(this);
  return add.call(this, s, m);
};

/** Empty the id maps that grew (not zod's global registry, which the corpus never fills with ids). */
export function releaseZodIds(): number {
  let n = 0;
  for (const r of registries) if (r !== (z.globalRegistry as unknown)) { n += r._idmap.size; r._idmap.clear(); }
  return n;
}
