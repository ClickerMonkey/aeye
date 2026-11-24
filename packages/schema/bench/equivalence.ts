/**
 * Like with like: for every case × profile × answer, both sides must give the
 * same verdict on the same wire value (valid and made-invalid). A pair that
 * disagrees is reported and left out of the decode timings.
 */
import { asTool, CASES, PROFILES, REQUESTS, type Answer, type Case, type ProfilePair, core } from './cases';

export interface Wire {
  readonly answer: Answer;
  readonly aWire: unknown;
  readonly zWire: unknown;
  readonly valid: boolean;
}

const clone = <T>(v: T): T => structuredClone(v);

/**
 * Set `path` of a wire value to `value`, going through what a profile wrapped:
 * JSON text (a string, or `{json: "…"}`), `{input}` roots and tuples-as-objects are left to the
 * caller's paths; JSON text is parsed, changed and written back.
 */
export function setAt(root: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const go = (v: any, i: number): any => {
    if (i === path.length) return value;
    if (typeof v === 'string') {
      try { return JSON.stringify(go(JSON.parse(v), i)); } catch { return v; }
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.json === 'string' && path[i] !== 'json') {
      return { json: go(v.json, i) };
    }
    const k = path[i]!;
    if (v === null || typeof v !== 'object') return v;
    v[k] = go(v[k], i + 1);
    return v;
  };
  return go(root, 0);
}

/** The wire values one case sends on one profile: each answer valid and invalid. */
export function wiresFor(c: Case, p: ProfilePair): Wire[] {
  const r = c.aBound(false).render(asTool(p.a));
  const out: Wire[] = [];
  for (const ans of c.answers) {
    const code = ans.code();
    const aWire = r.encode(clone(code) as never);
    // gin's own code shape writes maps as pairs; on a pairs profile the `a` wire already is that.
    const zWire = ans.zodCode && p.a.records !== 'pairs' ? ans.zodCode(clone(aWire)) : clone(aWire);
    out.push({ answer: ans, aWire, zWire, valid: true });
    if (ans.invalid) {
      const ab = setAt(clone(aWire), ans.invalid[0], ans.invalid[1]);
      const zb = setAt(clone(zWire), ans.invalid[0], ans.invalid[1]);
      out.push({ answer: ans, aWire: ab, zWire: zb, valid: false });
    }
  }
  return out;
}

/** zod builds its message on first read; for a deep union failure it can pass V8's string limit. */
export function zodMessage(e: { message: string }): string {
  try { return e.message.slice(0, 400); } catch (x) { return `(reading the message threw: ${(x as Error).message})`; }
}

export interface Verdict { readonly caseId: string; readonly profile: string; readonly answer: string; readonly valid: boolean; readonly a: boolean; readonly zod: boolean; readonly zodError?: string; readonly aError?: string }

export function verdicts(): Verdict[] {
  const out: Verdict[] = [];
  for (const c of CASES) {
    const zs = c.zod();
    for (const p of PROFILES) {
      const r = c.aBound(false).render(asTool(p.a));
      const strict = core.strictify(zs as never, p.d) as unknown as { safeParse(v: unknown): { success: boolean; error?: { message: string } } };
      for (const w of wiresFor(c, p)) {
        const t0 = performance.now();
        const ar = r.parse(clone(w.aWire));
        const t1 = performance.now();
        let zr: { success: boolean; error?: { message: string } };
        try { zr = strict.safeParse(clone(w.zWire)); } catch (e) { zr = { success: false, error: { message: `threw: ${(e as Error).message}` } }; }
        if (process.env.BENCH_TRACE) process.stderr.write(`${c.id} ${p.id} ${w.answer.name} ${w.valid} a=${(t1 - t0).toFixed(1)}ms zod=${(performance.now() - t1).toFixed(1)}ms
`);
        out.push({
          caseId: c.id, profile: p.id, answer: w.answer.name, valid: w.valid, a: ar.ok, zod: zr.success,
          ...(zr.success ? {} : { zodError: zodMessage(zr.error!) }),
          ...(ar.ok ? {} : { aError: ar.message.slice(0, 400) }),
        });
      }
    }
  }
  return out;
}

/** Keys `case|profile|answer|valid` both sides agree on (and agree with the expectation). */
export function agreed(vs: readonly Verdict[]): Set<string> {
  return new Set(vs.filter((v) => v.a === v.valid && v.zod === v.valid).map((v) => `${v.caseId}|${v.profile}|${v.answer}|${v.valid}`));
}

export { REQUESTS };

if (process.argv[1]?.endsWith('equivalence.ts')) {
  const vs = verdicts();
  const bad = vs.filter((v) => v.a !== v.valid || v.zod !== v.valid);
  console.log(`${vs.length - bad.length}/${vs.length} verdict pairs agree with each other and the expectation.`);
  for (const v of bad) console.log(`${v.caseId} ${v.profile} ${v.answer} ${v.valid ? 'valid' : 'invalid'}: a ${v.a}, zod ${v.zod}${v.zodError ? ` (zod: ${v.zodError.replace(/s+/g, ' ').slice(0, 160)})` : ''}${v.aError ? ` (a: ${v.aError.slice(0, 160)})` : ''}`);
  if (bad.some((v) => v.a !== v.valid)) process.exitCode = 1;
}
