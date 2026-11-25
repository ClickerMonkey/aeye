/**
 * Timings of the query grammar (`buildSchemas` on @aeye/schema), for PERFORMANCE.md.
 *   node --expose-gc --import tsx scripts/schema-bench.ts
 * Over the bundled example fixture (user / order / product, 100+ functions).
 */
import { ANTHROPIC_STRICT, GOOGLE_STRICT, LENIENT, OPENAI_STRICT } from '@aeye/schema';
import { createExampleFixture } from '../examples/schema';
import { buildSchemas, type BuildSchemasOptions } from '../src/llm/schemas';
import { buildQueryTool } from '../src/llm/tool';

const time = (f: () => unknown, n = 1): number => {
  const t = performance.now();
  for (let i = 0; i < n; i++) f();
  return (performance.now() - t) / n;
};
const LEVELS: Record<string, BuildSchemasOptions> = {
  open: {},
  names: { depth: { functions: 'names' } },
  typed: { depth: { functions: 'typed' } },
  paired: { strict: true },
  product: { strict: true, maxEnumSize: 100 },
};
const PROFILES = [LENIENT, OPENAI_STRICT, ANTHROPIC_STRICT, GOOGLE_STRICT];
const rows: unknown[] = [];
for (const [level, o] of Object.entries(LEVELS)) {
  // a fresh registry each sample: the bind (dynamic step) is new every time
  const bind = time(() => buildSchemas(createExampleFixture().engine, o).Query, 5) - time(() => createExampleFixture(), 5);
  for (const p of PROFILES) {
    const { engine } = createExampleFixture();
    const first = time(() => buildSchemas(engine, o).Query.render(p));
    const cached = time(() => buildSchemas(engine, o).Query.render(p).jsonSchema, 2000) * 1000;
    const size = JSON.stringify(buildSchemas(engine, o).Query.render(p).jsonSchema).length;
    rows.push({ level, profile: p.id, bindMs: +bind.toFixed(2), firstRenderMs: +first.toFixed(2), cachedUs: +cached.toFixed(2), jsonKB: +(size / 1024).toFixed(1) });
  }
}
console.table(rows);

// 1k-row insert decode (paired, OpenAI strict) and a rejected answer's message.
const { engine } = createExampleFixture();
const r = buildSchemas(engine, { strict: true }).Query.render(OPENAI_STRICT);
const insert = { kind: 'insert', into: 'product', rows: Array.from({ length: 1000 }, (_, i) => ({ id: i, name: 'n' + i, price: i / 4, category: 'c' })) };
const wire = r.encode(insert as never);
const ok = r.parse(structuredClone(wire)).ok;
const decode1k = time(() => r.parse(structuredClone(wire)), 20) - time(() => structuredClone(wire), 20);
console.log({ insert1kOk: ok, decode1kMs: +decode1k.toFixed(2) });

const tool = buildQueryTool(engine, { strict: true });
const bad = { query: { kind: 'select', fields: [{ expr: { kind: 'field-ref', source: 'product', field: 'nmae' } }], from: { kind: 'type', type: 'product' }, where: [{ kind: 'comparison', op: 'notlike', left: { kind: 'literal', value: 1 }, right: { kind: 'literal', value: 1 } }] } };
(async () => {
  for (const detail of ['summary', 'list', 'markers', 'full'] as const) {
    const t = buildQueryTool(engine, { strict: true, errorFormat: detail });
    let msg = '';
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) {
      try { await t.parse({}, JSON.stringify(bad)); } catch (e) { msg = (e as Error).message; }
    }
    console.log({ detail, chars: msg.length, rejectUs: +(((performance.now() - t0) / 50) * 1000).toFixed(0) });
  }
  void tool;
  try { await tool.parse({}, JSON.stringify(bad)); } catch (e) { console.log((e as Error).message); }
})();
