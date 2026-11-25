/**
 * Heap kept per `buildSchemas` call, the way a long-lived host (product) calls
 * it every turn: build the query schema, render it for the model.
 *
 *   node --expose-gc --import tsx scripts/schema-leak.ts [N]
 *
 * Two loops: the same registry every call, and a fresh registry every call
 * (a catalog that changed). Before step 2 (zod: `buildSchemas` + `z.toJSONSchema`)
 * this kept ~2.3 MB per call in both loops (`sharedIdRegistry`, never freed).
 */
import { OPENAI_STRICT } from '@aeye/schema';
import { buildSchemas } from '../src/llm/schemas';
import { createRegistry } from '../src/index';

const gc = (globalThis as { gc?: () => void }).gc!;
const heap = () => { gc(); gc(); return process.memoryUsage().heapUsed / 1e6; };

function registry(extra: number) {
  const r = createRegistry();
  const t = (name: string) => r.registerType(r.parseType({
    count: 100,
    name,
    fields: [
      { name: 'id', type: { kind: 'number', whole: true } },
      { name: 'name', type: { kind: 'text', search: true } },
      { name: 'tags', type: { kind: 'array', item: { kind: 'text' } }, nullable: true },
    ],
  }));
  t('user'); t('order');
  for (let i = 0; i < extra; i++) t(`t${i}`);
  r.finalize();
  return r;
}

const N = Number(process.argv[2] ?? 30);
const opts = { strict: true, maxEnumSize: 100 } as const;
const turn = (r: ReturnType<typeof registry>) => buildSchemas(r, opts).Query.render(OPENAI_STRICT).jsonSchema;
const same = registry(2);
for (let i = 0; i < 3; i++) turn(same);
let h0 = heap();
let t0 = performance.now();
for (let i = 0; i < N; i++) turn(same);
const sameMs = (performance.now() - t0) / N;
const sameMb = (heap() - h0) / N;
// Fresh registries: warm past the bind LRU first, so what stays is what a process keeps.
for (let i = 0; i < 8; i++) turn(registry(i % 3));
h0 = heap();
t0 = performance.now();
for (let i = 0; i < N; i++) turn(registry(i % 3));
const freshMs = (performance.now() - t0) / N;
const freshMb = (heap() - h0) / N;
console.log(JSON.stringify({ N, sameRegistry: { mbPerCall: +sameMb.toFixed(3), msPerCall: +sameMs.toFixed(3) }, freshRegistry: { mbPerCall: +freshMb.toFixed(3), msPerCall: +freshMs.toFixed(3) } }));
