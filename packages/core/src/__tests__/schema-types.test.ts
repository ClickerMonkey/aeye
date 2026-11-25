/**
 * Type-level proofs for Tool / Prompt on `a` schemas: the call and output
 * types come from the schema in every form (static, dynamic bundle bound
 * from ctx, from (ctx, input), a codec, the zod bridge), and a schema whose
 * dynamic step needs more than the component's ctx is a compile error.
 * Checked by `tsc` (node_modules/.tc/core-tests.json); at runtime the file
 * only constructs the components.
 */
import { expectTypeOf } from 'expect-type';
import { z } from 'zod';
import { a } from '@aeye/schema';
import { Prompt } from '../prompt';
import { Tool } from '../tool';
import type { Context } from '../types';

type Ctx = { tenant: string; categories: string[] };

const Static = a.object({ name: a.string(), tags: a.record(a.number()), note: a.string().optional() });
const Dynamic = a
  .declare<{ Category: string }>()
  .dynamic((ctx: Context<Ctx, {}>) => ({ Category: a.enum(ctx.categories) }), { key: (ctx) => ctx.tenant })
  .result(a.object({ category: a.ref('Category'), score: a.number() }));
const ByInput = a
  .define({ Base: a.object({ id: a.string() }) })
  .dynamic((_ctx: Context<{}, {}>, input: { extra: boolean }) => ({ Extra: input.extra ? a.object({ x: a.number() }) : a.object({ y: a.string() }) }))
  .result(a.object({ base: a.ref('Base'), extra: a.ref('Extra') }));
const Codec = a.codec(a.object({ csv: a.string() }), { decode: (w) => w.csv.split(','), encode: (v: string[]) => ({ csv: v.join(',') }) });

const staticTool = new Tool({
  name: 'static',
  description: 's',
  schema: Static,
  call: (input) => {
    expectTypeOf(input).toEqualTypeOf<{ name: string; tags: Record<string, number>; note?: string }>();
    return input.name;
  },
});

const dynamicTool = new Tool({
  name: 'dynamic',
  description: 'd',
  schema: Dynamic,
  call: (input, _refs, ctx: Context<Ctx, {}>) => {
    expectTypeOf(input).toEqualTypeOf<{ category: string; score: number }>();
    return `${ctx.tenant}:${input.category}`;
  },
});

const codecTool = new Tool({
  name: 'codec',
  description: 'c',
  schema: Codec,
  call: (input) => {
    expectTypeOf(input).toEqualTypeOf<string[]>();
    return input.length;
  },
});

// TODO(step 2): the bridge — zod infers too.
const zodTool = new Tool({
  name: 'zod',
  description: 'z',
  schema: z.object({ id: z.number() }),
  call: (input) => {
    expectTypeOf(input).toEqualTypeOf<{ id: number }>();
    return input.id;
  },
});

const staticPrompt = new Prompt({ name: 'p', description: 'p', content: 'x', schema: Static });
const inputPrompt = new Prompt({ name: 'p2', description: 'p', content: 'x', schema: ByInput, input: (input: { extra: boolean } | undefined) => ({ e: input?.extra }) });
type ByInputOut = a.infer<typeof ByInput>;
expectTypeOf<ByInputOut['base']>().toEqualTypeOf<{ id: string }>();
const textPrompt = new Prompt({ name: 'p3', description: 'p', content: 'x', schema: a.string().min(5) });

// Never called: the types are what's checked.
const typesOnly = () => {
  expectTypeOf(staticPrompt.get('result')).resolves.toEqualTypeOf<{ name: string; tags: Record<string, number>; note?: string } | undefined>();
  expectTypeOf(textPrompt.get('result')).resolves.toEqualTypeOf<string | undefined>();
  expectTypeOf(inputPrompt.get('result', { extra: true })).resolves.toEqualTypeOf<ByInputOut | undefined>();
};
void typesOnly;

new Tool({
  name: 'bad',
  description: 'b',
  // @ts-expect-error — Dynamic's step needs `categories` from ctx, which this tool's ctx lacks.
  schema: Dynamic,
  call: (_input, _refs, _ctx: Context<{ other: true }, {}>) => '',
});

new Tool({
  name: 'refs',
  description: 'r',
  // @ts-expect-error — a schema with a free ref isn't bindable.
  schema: a.object({ x: a.ref('Nope') }),
  call: () => '',
});

describe('schema types', () => {
  it('constructs every form', () => {
    expect([staticTool, dynamicTool, codecTool, zodTool].map(t => t.name)).toEqual(['static', 'dynamic', 'codec', 'zod']);
  });
});
