/**
 * Core's request path after the integration (steps 1 and 2), next to the zod
 * path it replaced (bench/legacy-core, the old strictify + toJSONSchema).
 *
 * Per request, for every case and profile: the time and the heap KEPT of
 * - `a`: `planRequest` over the tool's bound schema for a model of that
 *   family + reading the JSON sent (`sentTools`), as openai.ts / aws.ts now
 *   do on every request (a cached bind: same catalog, as a running agent);
 * - `real`: (gin and query cases) the same through today's @aeye/gin /
 *   @aeye/query `a` grammars, bound per request as their consumers do
 *   (`GinGrammar` / `ginValue`, `QueryArgs` / `QueryGrammar`; the bind is a
 *   cache hit after the first). Step 1's `bridge` column (core's temporary
 *   zod bridge, deleted in step 2) is kept in PERFORMANCE.md;
 * - `zod`: the legacy path, `toJSONSchema(strictify(z, d), d)` per request,
 *   on the frozen gin / query zod grammars (bench/legacy-gin, legacy-query).
 *
 *   npm run bench:core            (-- --only=query, -- --n=5)
 */
import { planRequest, sentTools } from '../../core/src/schema';
import type { ModelLike } from '../src/index';
import { CASES, PROFILES, core } from './cases';
import { releaseZodIds } from './zod-registries';

const MODEL: Record<string, ModelLike> = {
  'openai-strict': { id: 'gpt-4o', provider: 'openai', capabilities: ['toolsStrict', 'structured'] },
  'anthropic-strict': { id: 'claude-sonnet-4-5', provider: 'anthropic', capabilities: ['toolsStrict', 'structured'] },
  gemini: { id: 'gemini-2.5-pro', provider: 'google', capabilities: ['toolsStrict', 'structured'] },
  lenient: { id: 'llama', provider: 'other' },
};

const args = Object.fromEntries(process.argv.slice(2).map((s) => s.replace(/^--/, '').split('=')) as [string, string][]);
const N = Number(args.n ?? 5);
const gc = (globalThis as { gc?: () => void }).gc!;
const heap = () => { gc(); gc(); return process.memoryUsage().heapUsed; };
const MB = (b: number) => +(b / 2 ** 20).toFixed(2);

function measure(n: number, fn: () => unknown): { ms: number; keptMB: number } {
  fn();
  const before = heap();
  const t0 = performance.now();
  const kept: unknown[] = [];
  for (let i = 0; i < n; i++) kept.push(fn());
  const ms = (performance.now() - t0) / n;
  const keptMB = MB((heap() - before) / n);
  kept.length = 0;
  return { ms: +ms.toFixed(3), keptMB };
}

const rows: string[] = ['| case | profile | a: ms / request | a: MB kept / request | real gin/query a: ms | real a: MB | zod path: ms | zod path: MB |', '|---|---|---|---|---|---|---|---|'];
for (const c of CASES) {
  if (args.only && !c.id.includes(args.only)) continue;
  for (const p of PROFILES) {
    const model = MODEL[p.id]!;
    const slow = (c.id.startsWith('query') || c.id.startsWith('product')) && p.id === 'anthropic-strict';
    const n = slow ? Math.min(N, 2) : N;
    const bound = c.aBound(false);
    const aRes = measure(n * 20, () => sentTools({ messages: [], tools: [{ name: 't', parameters: bound, strict: 1 }], plan: planRequest({ tools: [{ name: 't', parameters: bound, strict: 1 }] }, model) })[0]!.parameters);
    const real = c.real && measure(n * 20, () => {
      const b = c.real!();
      return sentTools({ messages: [], tools: [{ name: 't', parameters: b, strict: 1 }], plan: planRequest({ tools: [{ name: 't', parameters: b, strict: 1 }] }, model) })[0]!.parameters;
    });
    const zodRes = measure(n, () => {
      const z = c.zod();
      const out = core.toJSONSchema(core.strictify(z as never, p.d), p.d);
      releaseZodIds();
      return out;
    });
    rows.push(`| ${c.id} | ${p.id} | ${aRes.ms} | ${aRes.keptMB} | ${real ? real.ms : '—'} | ${real ? real.keptMB : '—'} | ${zodRes.ms} | ${zodRes.keptMB} |`);
    process.stderr.write(`${rows[rows.length - 1]}\n`);
  }
}
console.log(rows.join('\n'));
