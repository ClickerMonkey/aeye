/**
 * `npm run bench`: time `@aeye/schema` against today's zod path on the corpus
 * (see cases.ts). Prints markdown tables (median and p95 per operation) and
 * writes bench/.results/timings.json.
 *
 *   npm run bench                 # everything
 *   npm run bench -- --quick      # shorter sampling
 *   npm run bench -- --only=query # case ids containing "query"
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import Handlebars from 'handlebars';
import { Bench } from 'tinybench';
import { schemaHelpers } from '../src/index';
import { aRequest, asTool, CASES, core, PROFILES, releaseZodIds, REQUESTS, zodRequest, type Case } from './cases';
import { agreed, verdicts, wiresFor, zodMessage } from './equivalence';

const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const ONLY = args.find((x) => x.startsWith('--only='))?.slice(7);
/** Child mode: one case (or `requests`), rows as JSON to a file. Each case runs in its own process: the zod path keeps memory between calls. */
const CHILD = args.find((x) => x.startsWith('--child='))?.slice(8);
const OUT = args.find((x) => x.startsWith('--out='))?.slice(6);
const TIME = QUICK ? 60 : 250;

export interface Stat { readonly median: number; readonly p95: number; readonly n: number }
const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

async function sample(fn: () => unknown, prepare: (() => void) | undefined, budget: number, k: number): Promise<Stat> {
  const b = new Bench({ time: budget, warmupTime: Math.min(50, budget / 4), iterations: 5 });
  b.add('x', fn, prepare ? { beforeEach: prepare } : {});
  await b.warmup();
  await b.run();
  const s = [...b.tasks[0]!.result!.samples].map((x) => x / k).sort((x, y) => x - y);
  return { median: quantile(s, 0.5), p95: quantile(s, 0.95), n: s.length };
}

/** Below this an iteration is batched (timer resolution and call overhead would dominate). */
const BATCH_MS = 0.05;

/**
 * Median and p95 (ms) of one operation on its own input (`input` runs untimed before each
 * call: decoding is in place). Fast operations are timed in batches of k calls, per call.
 */
async function time<T = void>(run: (x: T) => unknown, input?: () => T, budget = TIME): Promise<Stat> {
  let x: T;
  // A slow call (the zod path's Anthropic render of query takes seconds and keeps ~250 MB each time): 3 timed calls.
  const t0 = performance.now();
  run(input ? input() : (undefined as T));
  const first = performance.now() - t0;
  if (first > 50) {
    const s: number[] = [];
    for (let i = 0; i < 3; i++) { const v = input ? input() : (undefined as T); const t = performance.now(); run(v); s.push(performance.now() - t); }
    s.sort((p, q) => p - q);
    return { median: s[1]!, p95: s[2]!, n: 3 };
  }
  const one = await sample(() => run(x), () => { x = input ? input() : (undefined as T); }, Math.min(budget, 40), 1);
  if (one.median >= BATCH_MS) return sample(() => run(x), () => { x = input ? input() : (undefined as T); }, budget, 1);
  const k = Math.min(1000, Math.ceil(BATCH_MS / Math.max(one.median, 1e-5)) * 4);
  let xs: T[] = [];
  return sample(() => { for (let i = 0; i < k; i++) run(xs[i]!); }, () => { xs = Array.from({ length: k }, () => (input ? input() : (undefined as T))); }, budget, k);
}

export interface Row { group: string; caseId: string; label: string; profile: string; op: string; a?: Stat; zod?: Stat; note?: string; message?: { a: number; zod: number | string } }
const rows: Row[] = [];
const log = (r: Row) => {
  rows.push(r);
  const f = (s?: Stat) => (s ? `${fmt(s.median)} (p95 ${fmt(s.p95)})` : 'n/a');
  process.stderr.write(`${r.caseId} ${r.profile} ${r.op}: a ${f(r.a)} | zod ${f(r.zod)}${r.note ? ` — ${r.note}` : ''}\n`);
};
export const fmt = (ms: number) => (ms >= 100 ? `${ms.toFixed(0)} ms` : ms >= 1 ? `${ms.toFixed(1)} ms` : ms >= 0.01 ? `${(ms * 1000).toFixed(0)} µs` : `${(ms * 1000).toFixed(1)} µs`);

const clone = <T>(v: T): T => structuredClone(v);
type ZodLike = { safeParse(v: unknown): { success: boolean; error?: { message: string } } };

async function benchCase(c: Case, ok: Set<string>) {
  // Build: the schema (static: a new schema; dynamic: a bind with a new catalog / registry) — cold; and the warm path.
  const aCold = c.dynamic ? () => c.aBound(true) : c.aBuild!;
  log({ group: 'build', caseId: c.id, label: c.label, profile: '-', op: c.dynamic ? 'bind, new key' : 'build', a: await time(aCold), zod: await time(() => c.zod()) });
  if (c.dynamic) log({ group: 'build', caseId: c.id, label: c.label, profile: '-', op: 'bind, cached', a: await time(() => c.aBound(false)), note: 'zod: built per call' });

  for (const p of PROFILES) {
    releaseZodIds();
    const ap = asTool(p.a);
    // Render, first: build + render on a new schema / bind. Cached: the same schema again.
    log({
      group: 'render', caseId: c.id, label: c.label, profile: p.id, op: 'build + first render',
      a: await time(() => c.aBound(true).render(ap).jsonSchema),
      zod: await time(() => { const z = c.zod(); return core.toJSONSchema(core.strictify(z as never, p.d), p.d); }),
    });
    const bound = c.aBound(false);
    const zs = c.zod();
    const r = bound.render(ap);
    r.jsonSchema;
    log({
      group: 'render', caseId: c.id, label: c.label, profile: p.id, op: 'render again',
      a: await time(() => bound.render(ap).jsonSchema),
      zod: await time(() => core.toJSONSchema(core.strictify(zs as never, p.d), p.d)),
      note: 'zod: strictify cached, toJSONSchema per request (openai.ts)',
    });
    const strict = core.strictify(zs as never, p.d) as unknown as ZodLike;

    // Decode: each agreed (case, profile, answer, verdict) pair; a decodes in place, so each iteration gets a fresh copy (untimed).
    for (const w of wiresFor(c, p)) {
      const key = `${c.id}|${p.id}|${w.answer.name}|${w.valid}`;
      const comparable = ok.has(key);
      const aT = await time((aw: unknown) => { const res = r.parse(aw); return res.ok ? res.value : res.message; }, () => clone(w.aWire), w.answer.big ? TIME * 2 : TIME);
      const zT = comparable
        ? await time((zw: unknown) => { const res = strict.safeParse(zw); return res.success ? res : zodMessage(res.error!); }, () => clone(w.zWire), w.answer.big ? TIME * 2 : TIME)
        : undefined;
      // The message the model gets back (pass 4's baseline): its size on each side.
      let message: Row['message'];
      if (!w.valid) {
        const ar = r.parse(clone(w.aWire));
        let zl: number | string = '—';
        if (comparable) { const zr = strict.safeParse(clone(w.zWire)); try { zl = zr.error!.message.length; } catch (e) { zl = `threw: ${(e as Error).message}`; } }
        message = { a: ar.ok ? 0 : ar.message.length, zod: zl };
      }
      log({
        group: 'decode', caseId: c.id, label: c.label, profile: p.id, op: `${w.valid ? 'decode' : 'reject + message'}: ${w.answer.name}`,
        a: aT, ...(zT ? { zod: zT } : {}), ...(message ? { message } : {}), ...(comparable ? {} : { note: 'zod path sends a different wire shape here (cycle breaker); not comparable' }),
      });
    }

    // Encode: the code value in the wire shape. Today's path writes the code value with JSON.stringify.
    for (const ans of c.answers) {
      const code = ans.code();
      log({
        group: 'encode', caseId: c.id, label: c.label, profile: p.id, op: `encodeText: ${ans.name}`,
        a: await time(() => r.encodeText(code as never)), zod: await time(() => JSON.stringify(ans.zodCode ? ans.zodCode(code) : code)),
        note: 'zod: JSON.stringify of the code value (no wire encoder)',
      });
    }
  }
  // Handlebars helper (one profile: OpenAI strict).
  const r = c.aBound(false).render(asTool(PROFILES[0]!.a));
  const code = c.answers[0]!.code();
  const tplA = Handlebars.compile('Example call: {{encode value}}');
  const tplZ = Handlebars.compile('Example call: {{{json value}}}');
  const helpersA = schemaHelpers(r);
  const helpersZ = { json: (v: unknown) => JSON.stringify(v) };
  log({
    group: 'encode', caseId: c.id, label: c.label, profile: PROFILES[0]!.id, op: `handlebars: ${c.answers[0]!.name}`,
    a: await time(() => tplA({ value: code }, { helpers: helpersA as never })), zod: await time(() => tplZ({ value: code }, { helpers: helpersZ })),
  });
}

async function benchRequests() {
  for (const q of REQUESTS) {
    if (ONLY && !q.id.includes(ONLY)) continue;
    for (const p of PROFILES) {
      releaseZodIds();
      log({
        group: 'request', caseId: q.id, label: q.label, profile: p.id, op: 'new tools + plan',
        a: await time(() => aRequest(q.aItems(), p.a).entries), zod: await time(() => zodRequest(q.zTools(), p.d)),
      });
      const items = q.aItems();
      const zt = q.zTools();
      log({
        group: 'request', caseId: q.id, label: q.label, profile: p.id, op: 'same tools, next turn',
        a: await time(() => aRequest(items, p.a).entries), zod: await time(() => zodRequest(zt, p.d)),
      });
    }
  }
}

async function child(id: string) {
  const ok = agreed(verdicts());
  if (id === 'requests') await benchRequests();
  else await benchCase(CASES.find((c) => c.id === id)!, ok);
  writeFileSync(OUT!, JSON.stringify(rows));
}

async function main() {
  if (CHILD) return child(CHILD);
  const t0 = performance.now();
  const vs = verdicts();
  const ok = agreed(vs);
  const bad = vs.filter((v) => v.a !== v.valid);
  if (bad.length) {
    console.error('a disagrees with the expected verdict:', bad);
    process.exit(1);
  }
  process.stderr.write(`equivalence: ${ok.size}/${vs.length} verdict pairs comparable (the rest: zod's wire differs)\n`);
  mkdirSync(new URL('./.results/', import.meta.url), { recursive: true });
  const self = fileURLToPath(import.meta.url);
  const ids = [...CASES.map((c) => c.id), 'requests'].filter((id) => !ONLY || id.includes(ONLY));
  for (const id of ids) {
    const out = fileURLToPath(new URL(`./.results/rows-${id}.json`, import.meta.url));
    execFileSync(process.execPath, ['--expose-gc', '--max-old-space-size=12288', '--import', 'tsx', self, `--child=${id}`, `--out=${out}`, ...(QUICK ? ['--quick'] : [])], { stdio: ['ignore', 'ignore', 'inherit'] });
    rows.push(...(JSON.parse(readFileSync(out, 'utf8')) as Row[]));
  }
  const env = { node: process.version, cpu: os.cpus()[0]?.model, cores: os.cpus().length, mem: `${(os.totalmem() / 2 ** 30).toFixed(0)} GB`, os: `${os.type()} ${os.release()}`, quick: QUICK, seconds: Math.round((performance.now() - t0) / 1000) };
  writeFileSync(new URL('./.results/timings.json', import.meta.url), JSON.stringify({ env, verdicts: vs.map(({ zodError, aError, ...v }) => v), rows }, null, 1));
  console.log(markdown(env, rows));
}

/** One table per group: case · profile · op · a · zod · ratio. */
export function markdown(env: Record<string, unknown>, rs: readonly Row[]): string {
  const out = [`Node ${env.node}, ${env.cpu} (${env.cores} threads), ${env.mem}, ${env.os}${env.quick ? ' (quick)' : ''}.`, ''];
  for (const g of ['build', 'render', 'decode', 'encode', 'request']) {
    const gs = rs.filter((r) => r.group === g);
    if (!gs.length) continue;
    out.push(`### ${g}`, '', '| case | profile | operation | @aeye/schema median (p95) | zod path median (p95) | zod ÷ a |', '|---|---|---|---|---|---|');
    for (const r of gs) {
      const cell = (s?: Stat) => (s ? `${fmt(s.median)} (${fmt(s.p95)})` : '—');
      const ratio = r.a && r.zod ? `${(r.zod.median / r.a.median).toFixed(r.zod.median / r.a.median >= 10 ? 0 : 1)}×` : '—';
      out.push(`| ${r.caseId} | ${r.profile} | ${r.op} | ${cell(r.a)} | ${cell(r.zod)} | ${ratio} |`);
    }
    out.push('');
  }
  const errs = rs.filter((r) => r.message);
  if (errs.length) {
    out.push('### errors (size of the message the model gets back, characters)', '', '| case | profile | answer | @aeye/schema | zod path |', '|---|---|---|---|---|');
    for (const r of errs) out.push(`| ${r.caseId} | ${r.profile} | ${r.op.replace('reject + message: ', '')} | ${r.message!.a} | ${r.message!.zod} |`);
    out.push('');
  }
  return out.join('\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
