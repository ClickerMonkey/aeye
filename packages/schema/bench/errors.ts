/**
 * Errors for the model (pass 4): for every made-invalid answer of the bench
 * corpus (cases.ts), the message the model gets back at each detail level
 * (size, time of reject + message) next to the zod path's message size.
 *
 *   npm run bench:errors                     # table (markdown) on stdout
 *   npm run bench:errors -- --show           # also print each message
 *   npm run bench:errors -- --only=gin       # case ids containing "gin"
 *   npm run bench:errors -- --no-zod         # skip the zod side (slow on query)
 */
import { Bench } from 'tinybench';
import { asTool, CASES, PROFILES, core } from './cases';
import { wiresFor } from './equivalence';
import type { ErrorDetail } from '../src/index';

const args = process.argv.slice(2);
const SHOW = args.includes('--show');
const NO_ZOD = args.includes('--no-zod');
const ONLY = args.find((x) => x.startsWith('--only='))?.slice(7);
const PROFILE = args.find((x) => x.startsWith('--profile='))?.slice(10);
const LEVELS: readonly ErrorDetail[] = ['summary', 'list', 'markers', 'full'];
const clone = <T>(v: T): T => structuredClone(v);
const fmt = (ms: number) => (ms >= 100 ? `${ms.toFixed(0)} ms` : ms >= 1 ? `${ms.toFixed(1)} ms` : `${(ms * 1000).toFixed(0)} µs`);

/** Median ms of `run` on a fresh copy each time (decoding is in place). */
async function time(run: (x: unknown) => unknown, input: () => unknown): Promise<number> {
  let x: unknown;
  const b = new Bench({ time: 150, warmupTime: 30, iterations: 5 });
  b.add('x', () => run(x), { beforeEach: () => { x = input(); } });
  await b.warmup();
  await b.run();
  const s = [...b.tasks[0]!.result!.samples].sort((p, q) => p - q);
  return s[Math.floor(s.length / 2)]!;
}

const rows: string[] = [];
rows.push('| case | profile | answer | summary | list | markers | full (default) | reject + full message | reject + list message | zod message |');
rows.push('|---|---|---|---|---|---|---|---|---|---|');
for (const c of CASES) {
  if (ONLY && !c.id.includes(ONLY)) continue;
  const zs = NO_ZOD ? undefined : c.zod();
  for (const p of PROFILES) {
    if (PROFILE && p.id !== PROFILE) continue;
    const r = c.aBound(false).render(asTool(p.a));
    const strict = zs ? (core.strictify(zs as never, p.d) as unknown as { safeParse(v: unknown): { success: boolean; error?: { message: string } } }) : undefined;
    for (const w of wiresFor(c, p)) {
      if (w.valid) continue;
      const sizes: number[] = [];
      for (const level of LEVELS) {
        const res = r.parse(clone(w.aWire), { errorFormat: level });
        if (res.ok) throw new Error(`${c.id} ${p.id} ${w.answer.name}: the invalid answer decoded`);
        sizes.push(res.message.length);
        if (SHOW) process.stdout.write(`\n=== ${c.id} · ${p.id} · ${w.answer.name} · ${level} (${res.message.length} chars)\n${res.message}\n`);
      }
      const full = await time((x) => { const res = r.parse(x); return res.ok ? res.value : res.message; }, () => clone(w.aWire));
      const list = await time((x) => { const res = r.parse(x, { errorFormat: 'list' }); return res.ok ? res.value : res.message; }, () => clone(w.aWire));
      let zod: string = '—';
      if (strict) {
        try {
          const zr = strict.safeParse(clone(w.zWire));
          zod = zr.success ? '(accepted)' : String(zr.error!.message.length);
        } catch (e) {
          zod = `threw: ${(e as Error).message}`;
        }
      }
      const row = `| ${c.id} | ${p.id} | ${w.answer.name} | ${sizes.join(' | ')} | ${fmt(full)} | ${fmt(list)} | ${zod} |`;
      rows.push(row);
      process.stderr.write(`${row}\n`);
    }
  }
}
console.log(`\n${rows.join('\n')}`);
