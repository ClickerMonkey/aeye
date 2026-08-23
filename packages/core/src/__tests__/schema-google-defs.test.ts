/**
 * `GOOGLE_STRICT` declares `allowDefsRef: false` — Gemini's structured-output
 * dialect has no `$defs` and no named `$ref`. The emitter used to consult only
 * `supportsRecursion` when deciding how to spell a re-encountered schema, so it
 * shipped `$defs`/`$ref` under that descriptor anyway, by two routes:
 *
 *  1. a NON-ROOT cycle — `supportsRecursion: true` skipped the bounded
 *     cycle-breaker, and `allowRootRef` only covers the root, so the back-edge
 *     fell through to `$ref: '#/$defs/X'`;
 *  2. any node carrying an `aid`/`id`, or any node simply reused twice — those
 *     were promoted to a `$defs` entry regardless of the descriptor. A plain
 *     `z.string()` shared between two properties was enough.
 *
 * Both produce a schema the descriptor says it cannot send. These tests pin the
 * output as `$defs`-free; the sizes in the assertions are recorded because the
 * fix trades `$defs` reuse for inlining, and on a sendable schema that trade is
 * cheap (a named leaf inlines SMALLER than it refs).
 */

import { z } from 'zod';
import { GOOGLE_STRICT, LENIENT, OPENAI_STRICT, strictify, toJSONSchema } from '../index';

function render(schema: z.ZodType, descriptor = GOOGLE_STRICT): string {
  return JSON.stringify(toJSONSchema(strictify(schema, descriptor), descriptor));
}

type NodeShape = { name: string; children: NodeShape[] };
const RecursiveNode: z.ZodType<NodeShape> = z.object({
  name: z.string(),
  children: z.array(z.lazy(() => RecursiveNode)),
});

describe('GOOGLE_STRICT emits no $defs and no named $ref', () => {
  it('a root cycle', () => {
    const json = render(RecursiveNode);
    expect(json).not.toContain('"$defs"');
    expect(json).not.toContain('"$ref"');
  });

  it('a NON-ROOT cycle — the back-edge takes the bounded placeholder', () => {
    const json = render(z.object({ label: z.string(), tree: RecursiveNode }));
    expect(json).not.toContain('"$defs"');
    expect(json).not.toContain('"$ref"');
    // The placeholder still NAMES what it stands in for, so the model is told
    // the shape recurses rather than being handed a bare open object — and it
    // does so WITHOUT pointing at a `$defs` section this dialect never emits.
    expect(json).toContain('Recursive reference to');
    expect(json).not.toContain('#/$defs/');
  });

  it('a NAMED sub-schema used twice — inlined at both sites', () => {
    // `aid`, not `id`: `id` goes in zod's GLOBAL registry, so a second schema
    // declaring it (or `strictify` re-stamping metadata onto its clone) throws
    // "ID already exists". `aid` is the codegen-facing name the converter reads
    // first, and it is what a generated schema actually carries.
    const Named = z.object({ a: z.string() }).meta({ aid: 'GoogleNamed' });
    const json = render(z.object({ one: Named, two: Named }));
    expect(json).not.toContain('"$defs"');
    expect(json).not.toContain('"$ref"');
    // Both use sites carry the real shape, not a dangling reference.
    expect(json.match(/"properties":\{"a":\{"type":"string"\}\}/g)).toHaveLength(2);
  });

  it('an UNNAMED leaf shared between two properties — no accidental promotion', () => {
    // The subtle one: `z.string()` bound once and used twice is the SAME object,
    // so the converter's identity cache hit and promoted a bare string to
    // `$defs/__schema1`. Nothing about that node asked to be named.
    const shared = z.string();
    const json = render(z.object({ one: shared, two: shared }));
    expect(json).not.toContain('"$defs"');
    expect(json).not.toContain('"$ref"');
  });
});

describe('descriptors that DO allow $defs are unchanged', () => {
  it('OPENAI_STRICT and LENIENT still share a named sub-schema through $defs', () => {
    const Named = z.object({ a: z.string() }).meta({ aid: 'RefNamed' });
    const schema = z.object({ one: Named, two: Named });
    for (const descriptor of [OPENAI_STRICT, LENIENT]) {
      const json = render(schema, descriptor);
      expect(json).toContain('"$defs"');
      expect(json).toContain('#/$defs/RefNamed');
    }
  });
});
