/**
 * `npm run bench:memory`: retained heap and per-call garbage, `@aeye/schema`
 * vs the zod path. Each measurement runs in its own child process (a fresh
 * heap), started with --expose-gc and a 256 MB semi-space so a measured loop
 * of allocations is not interrupted by a scavenge (checked: a loop that saw a
 * GC is retried with fewer calls).
 *
 *   retained   N binds/builds rendered on all 4 profiles, kept alive: heap per item
 *   released   the same, then every reference dropped: heap the caches still hold
 *   churn      200 binds in a row (new catalog each), nothing kept: heap the caches hold
 *   garbage    bytes allocated per call (decode, render again, encode)
 *   snapshot   heap snapshot after `retained` for the biggest object kinds
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';
import { fileURLToPath } from 'node:url';
import { aRequest, asTool, CASES, core, PROFILES, QueryTool, REQUESTS, zodRequest } from './cases';

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with node --expose-gc');
const fullGc = () => { for (let i = 0; i < 4; i++) gc(); };
const heap = () => { fullGc(); return process.memoryUsage().heapUsed; };
const MB = (b: number) => b / 2 ** 20;

let gcs = 0;
new PerformanceObserver((l) => { gcs += l.getEntries().length; }).observe({ entryTypes: ['gc'] });

/** Bytes allocated per call of `fn` (no GC during the loop; fewer calls if one happened). */
function garbage(fn: () => unknown, prep: () => unknown[] = () => [], k0 = 200): number {
  for (let k = k0; k >= 1; k = Math.floor(k / 2)) {
    const inputs = Array.from({ length: k }, () => prep());
    fullGc();
    const before = process.memoryUsage().heapUsed;
    const g = gcs;
    for (let i = 0; i < k; i++) (fn as (...a: unknown[]) => unknown)(...inputs[i]!);
    const after = process.memoryUsage().heapUsed;
    if (gcs === g) return (after - before) / k;
  }
  return NaN;
}

/** Instance counts and self sizes per constructor in a heap snapshot (top n by size). */
function snapshotTop(n = 12): { name: string; count: number; mb: number }[] {
  const chunks: string[] = [];
  const s = v8.getHeapSnapshot();
  let buf;
  while ((buf = s.read()) !== null) chunks.push(buf.toString());
  const snap = JSON.parse(chunks.join(''));
  const f = snap.snapshot.meta.node_fields as string[];
  const types = snap.snapshot.meta.node_types[0] as string[];
  const [iType, iName, iSize] = [f.indexOf('type'), f.indexOf('name'), f.indexOf('self_size')];
  const by = new Map<string, { count: number; size: number }>();
  const nodes = snap.nodes as number[];
  for (let i = 0; i < nodes.length; i += f.length) {
    const type = types[nodes[i + iType]!]!;
    const name = type === 'object' || type === 'closure' ? `${type === 'closure' ? 'closure ' : ''}${snap.strings[nodes[i + iName]!]}` : `(${type})`;
    const e = by.get(name) ?? { count: 0, size: 0 };
    e.count++; e.size += nodes[i + iSize]!;
    by.set(name, e);
  }
  return [...by].sort((x, y) => y[1].size - x[1].size).slice(0, n).map(([name, e]) => ({ name, count: e.count, mb: +MB(e.size).toFixed(2) }));
}

/** Live instances of our classes (by snapshot constructor name). */
function liveCounts(names: readonly string[]): Record<string, number> {
  const top = snapshotTop(100000);
  return Object.fromEntries(names.map((n) => [n, top.find((t) => t.name === n)?.count ?? 0]));
}

// ============================================================================
// Child-process scenarios
// ============================================================================

type Result = Record<string, unknown>;

function retained(caseId: string, side: 'a' | 'zod', n: number, withSnapshot: boolean): Result {
  const c = CASES.find((x) => x.id === caseId)!;
  const base = heap();
  let kept: unknown[] = [];
  for (let i = 0; i < n; i++) {
    if (side === 'a') {
      const b = c.aBound(true);
      kept.push(b, PROFILES.map((p) => b.render(asTool(p.a)).jsonSchema));
    } else {
      const z = c.zod();
      kept.push(z, PROFILES.map((p) => core.toJSONSchema(core.strictify(z as never, p.d), p.d)));
    }
  }
  const held = heap() - base;
  const snap = withSnapshot ? snapshotTop() : undefined;
  kept = [];
  const released = heap() - base;
  return { perItemMB: +MB(held / n).toFixed(3), heldMB: +MB(held).toFixed(1), releasedMB: +MB(released).toFixed(2), ...(snap ? { snapshot: snap } : {}) };
}

/** Without Anthropic: the zod path keeps ~250 MB per Anthropic render of query (measured separately, `anthropicRender`). */
const CHURN_PROFILES = PROFILES.filter((p) => p.id !== 'anthropic-strict');
function churn(side: 'a' | 'zod', n: number): Result {
  const c = CASES.find((x) => x.id === 'query-paired')!;
  const base = heap();
  const at: number[] = [];
  for (let i = 1; i <= n; i++) {
    if (side === 'a') { const b = c.aBound(true); for (const p of CHURN_PROFILES) b.render(asTool(p.a)).jsonSchema; }
    else { const z = c.zod(); for (const p of CHURN_PROFILES) core.toJSONSchema(core.strictify(z as never, p.d), p.d); }
    if (i === 16 || i === n / 2 || i === n) at.push(+MB(heap() - base).toFixed(2));
  }
  const out: Result = { after16MB: at[0], afterHalfMB: at[1], afterAllMB: at[2] };
  if (side === 'a') {
    out.live = liveCounts(['Compiler', 'Bound', 'Rendered', 'Node']);
    // Empty the bundle's bind LRU: what is left is held by the module-level caches.
    (QueryTool as unknown as { cache: Map<unknown, unknown> }).cache.clear();
    out.afterLruClearedMB = +MB(heap() - base).toFixed(2);
    out.liveAfterLruCleared = liveCounts(['Compiler', 'Bound', 'Rendered', 'Node']);
  }
  return out;
}

function requests(id: string, side: 'a' | 'zod', n: number): Result {
  const q = REQUESTS.find((x) => x.id === id)!;
  const p = PROFILES[0]!;
  const base = heap();
  let kept: unknown[] = [];
  for (let i = 0; i < n; i++) kept.push(side === 'a' ? aRequest(q.aItems(), p.a) : zodRequest(q.zTools(), p.d));
  const held = heap() - base;
  kept = [];
  return { perRequestMB: +MB(held / n).toFixed(2), releasedMB: +MB(heap() - base).toFixed(2) };
}

/** Heap kept per "render again" (the same schema, rendered for the next request): the zod path recomputes toJSONSchema. */
function renderAgain(): Result {
  const out: Result = {};
  for (const c of CASES) for (const p of PROFILES) {
    const z = c.zod();
    core.toJSONSchema(core.strictify(z as never, p.d), p.d);
    const r = c.aBound(false).render(asTool(p.a));
    r.jsonSchema;
    const slow = c.id.startsWith('query') || c.id.startsWith('product');
    const n = slow && p.id === 'anthropic-strict' ? 2 : 5;
    let b = heap();
    for (let i = 0; i < n; i++) core.toJSONSchema(core.strictify(z as never, p.d), p.d);
    const zKept = (heap() - b) / n;
    b = heap();
    for (let i = 0; i < n; i++) c.aBound(false).render(asTool(p.a)).jsonSchema;
    const aKept = (heap() - b) / n;
    out[`${c.id} ${p.id}`] = { zodMB: +MB(zKept).toFixed(2), aMB: +MB(aKept).toFixed(3) };
  }
  return out;
}

function perCall(): Result {
  const out: Result = {};
  const clone = <T>(v: T): T => structuredClone(v);
  for (const id of ['tool-small', 'harness-fn', 'chart-1k', 'gin-grammar', 'query-paired', 'product-query-set']) {
    const c = CASES.find((x) => x.id === id)!;
    for (const p of [PROFILES[0]!, PROFILES[3]!]) {
      const r = c.aBound(false).render(asTool(p.a));
      r.jsonSchema;
      const zs = c.zod();
      const strict = core.strictify(zs as never, p.d) as unknown as { safeParse(v: unknown): unknown };
      core.toJSONSchema(strict as never, p.d);
      const ans = c.answers[c.answers.length > 1 ? 1 : 0]!;
      const code = ans.code();
      const wire = r.encode(clone(code) as never);
      const zwire = ans.zodCode && p.a.records !== 'pairs' ? ans.zodCode(clone(wire)) : wire;
      const k = ans.big ? 10 : 200;
      const st = r.parse(clone(wire)).stats;
      out[`${id} ${p.id}`] = {
        answer: ans.name,
        wireKB: +(JSON.stringify(wire).length / 1024).toFixed(1),
        aDecodeKB: +(garbage((w) => r.parse(w), () => [clone(wire)], k) / 1024).toFixed(2),
        aCopies: st,
        zodDecodeKB: +(garbage((w) => strict.safeParse(w), () => [clone(zwire)], k) / 1024).toFixed(2),
        aRenderAgainKB: +(garbage(() => r.jsonSchema) / 1024).toFixed(3),
        zodRenderAgainKB: +(garbage(() => core.toJSONSchema(core.strictify(zs as never, p.d), p.d), () => [], 50) / 1024).toFixed(1),
        aEncodeKB: +(garbage(() => r.encode(code as never), () => [], k) / 1024).toFixed(2),
        jsonStringifyKB: +(garbage(() => JSON.stringify(code), () => [], k) / 1024).toFixed(2),
      };
    }
  }
  return out;
}

// ============================================================================
// Driver
// ============================================================================

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'child') {
  const [what, x, y, z] = rest;
  let r: Result;
  if (what === 'retained') r = retained(x!, y as 'a' | 'zod', Number(z), x === 'query-paired' && y === 'a');
  else if (what === 'churn') r = churn(x as 'a' | 'zod', Number(y));
  else if (what === 'requests') r = requests(x!, y as 'a' | 'zod', Number(z));
  else if (what === 'renderAgain') r = renderAgain();
  else r = perCall();
  process.stdout.write(JSON.stringify(r));
} else {
  const self = fileURLToPath(import.meta.url);
  const run = (...a: string[]): Result => {
    const outp = execFileSync(process.execPath, ['--expose-gc', '--max-semi-space-size=256', '--max-old-space-size=12288', '--import', 'tsx', self, 'child', ...a], { encoding: 'utf8', maxBuffer: 64 * 2 ** 20 });
    return JSON.parse(outp.slice(outp.indexOf('{')));
  };
  const results: Result = { node: process.version };
  const ret: Result = {};
  for (const [id, n] of [['tool-small', 1000], ['harness-fn', 500], ['gin-value', 500], ['gin-grammar', 20], ['query-open', 10], ['query-paired', 10], ['product-query-set', 10]] as const) {
    for (const side of ['a', 'zod'] as const) {
      process.stderr.write(`retained ${id} ${side}\n`);
      ret[`${id} ${side}`] = run('retained', id, side, String(n));
    }
  }
  results.retained = ret;
  results.churn = { a: run('churn', 'a', '100'), zod: run('churn', 'zod', '100') };
  results.renderAgainRetained = run('renderAgain');
  process.stderr.write('requests\n');
  results.requests = Object.fromEntries(REQUESTS.flatMap((q) => (['a', 'zod'] as const).map((s) => [`${q.id} ${s}`, run('requests', q.id, s, q.id === 'request-129' ? '10' : '30')])));
  process.stderr.write('per call\n');
  results.perCall = run('perCall');
  mkdirSync(new URL('./.results/', import.meta.url), { recursive: true });
  writeFileSync(new URL('./.results/memory.json', import.meta.url), JSON.stringify(results, null, 1));
  console.log(JSON.stringify(results, null, 1));
}

