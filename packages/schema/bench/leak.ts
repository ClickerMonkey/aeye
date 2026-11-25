/**
 * Heap kept per query `buildSchemas` call, the way a long-lived host (product)
 * calls it every turn, before and after step 2:
 *
 * - before: the frozen zod grammar (bench/legacy-query) — `buildSchemas`, and
 *   `buildSchemas` + core's old render (`toJSONSchema(strictify(z, d), d)`,
 *   bench/legacy-core) for OpenAI strict;
 * - after: today's @aeye/query — `buildSchemas(...).Query` (a cached `a` bind)
 *   rendered for OpenAI strict.
 *
 * Each on the same registry every call (a running agent) and on a fresh
 * registry every call (a catalog that changed). The zod side's id registries
 * are emptied only in the row that says so (bench/zod-registries.ts), to show
 * how much of the growth is query's `sharedIdRegistry`. A fresh-registry row
 * of the `a` path keeps query's bounded bind cache (QUERY_BIND_CACHE_SIZE
 * binds) alive: run with a bigger `--n` to see it is constant, not per call.
 *
 *   npm run bench:leak            (-- --n=30)
 */
import { releaseZodIds } from './zod-registries';
import { OPENAI_STRICT as A_OPENAI_STRICT } from '../src/index';
import * as core from './legacy-core/index';
import { buildSchemas as legacyBuild, createRegistry as legacyRegistry } from './legacy-query/index';
import { buildSchemas as newBuild, createRegistry as newRegistry } from '../../query/src/index';
import type { TypeDef } from './legacy-query/index';

const args = Object.fromEntries(process.argv.slice(2).map((s) => s.replace(/^--/, '').split('=')) as [string, string][]);
const N = Number(args.n ?? 30);
const gc = (globalThis as { gc?: () => void }).gc!;
const heap = () => { gc(); gc(); return process.memoryUsage().heapUsed; };

const typeDef = (name: string): TypeDef => ({
  name, count: 100,
  fields: [
    { name: 'id', type: { kind: 'number', whole: true } },
    { name: 'name', type: { kind: 'text', search: true } },
    { name: 'tags', type: { kind: 'array', item: { kind: 'text' } }, nullable: true },
  ],
});
/** The same catalog on either query: user, order and `extra` more types. */
function registry<R>(create: () => R, extra = 2): R {
  const r = create() as unknown as { registerType(t: unknown): void; parseType(d: TypeDef): unknown; finalize(): void };
  for (const n of ['user', 'order', ...Array.from({ length: extra }, (_, i) => `t${i}`)]) r.registerType(r.parseType(typeDef(n)));
  r.finalize();
  return r as unknown as R;
}

const opts = { strict: true, maxEnumSize: 100 } as const;
const sinks: unknown[] = [];
const paths: Record<string, (r: unknown) => unknown> = {
  'before: zod buildSchemas': (r) => legacyBuild(r as never, opts as never).Query,
  'before: zod buildSchemas + render (OpenAI strict)': (r) => {
    const q = legacyBuild(r as never, opts as never).Query;
    return core.toJSONSchema(core.strictify(q as never, core.OPENAI_STRICT), core.OPENAI_STRICT);
  },
  "before: the same, query's id registry emptied after each call": (r) => {
    const q = legacyBuild(r as never, opts as never).Query;
    const out = core.toJSONSchema(core.strictify(q as never, core.OPENAI_STRICT), core.OPENAI_STRICT);
    releaseZodIds();
    return out;
  },
  'after: a buildSchemas + render (OpenAI strict)': (r) => newBuild(r as never, opts).Query.render(A_OPENAI_STRICT).jsonSchema,
};
const registries: Record<string, () => unknown> = {
  'before: zod buildSchemas': () => registry(legacyRegistry),
  'before: zod buildSchemas + render (OpenAI strict)': () => registry(legacyRegistry),
  "before: the same, query's id registry emptied after each call": () => registry(legacyRegistry),
  'after: a buildSchemas + render (OpenAI strict)': () => registry(newRegistry),
};

function run(name: string, fresh: boolean): { keptMB: number; ms: number } {
  const fn = paths[name]!;
  const same = registries[name]!();
  for (let i = 0; i < 3; i++) fn(same);
  const regs = fresh ? Array.from({ length: N }, () => registries[name]!()) : [];
  const h0 = heap();
  const t0 = performance.now();
  for (let i = 0; i < N; i++) sinks.push(fn(fresh ? regs[i] : same));
  const ms = (performance.now() - t0) / N;
  sinks.length = 0;
  regs.length = 0;
  const keptMB = (heap() - h0) / N / 2 ** 20;
  return { keptMB: +keptMB.toFixed(3), ms: +ms.toFixed(2) };
}

const rows = ['| path | registry | MB kept / call | ms / call |', '|---|---|---|---|'];
for (const name of Object.keys(paths)) {
  for (const fresh of [false, true]) {
    const r = run(name, fresh);
    rows.push(`| ${name} | ${fresh ? 'fresh each call' : 'same'} | ${r.keptMB} | ${r.ms} |`);
    process.stderr.write(`${rows[rows.length - 1]}\n`);
  }
}
console.log(`N = ${N} calls per row\n\n${rows.join('\n')}`);
