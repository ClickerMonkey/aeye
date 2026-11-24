/**
 * CORPUS: the harness's authoring agents' drafts and tools (sdk/src/authoring.ts `authoringAgent` / `authoringTool`,
 * `schema: ZodType | (session) => ZodType`, rebuilt each round), ported to `a`. A function-form schema is a chain whose
 * dynamic step reads the session; the draft tool's args are `{ draft: <schema> }` (sdk authoring.ts:404).
 *
 * Sources:
 * - systems/code/server/authoring.ts:174 `draftSchema` + `CODE_EXAMPLES` (:69);
 * - systems/api/server/authoring.ts:285 `draftSchema` + `API_EXAMPLES` (:88);
 * - sdk/src/program/tools.ts: `search` (:108), `load` (:133), `signature` (:199) tools;
 * - systems/input/server/authoring.ts:157-187 `FieldTypeDraft`, `FieldType` (a hand-written recursive TypeDef subset,
 *   `z.lazy` + an explicit `z.ZodType<FieldTypeDraft>` annotation, "rather than taken from gin's buildSchemas, whose
 *   lazy schemas are rebuilt on every visit"), `FormDraftSchema`; input/shared/index.ts:19 `InputFormSchema`;
 * - sdk/src/widget-schema.ts:189 `widgetProposalSchema` (the strict per-call schema: enums of the ranked visuals, their
 *   styles and bindable columns, typed arg plans, presets, actions, drill) and sdk/src/widget-check.ts `checkWidget`
 *   (its arg, style and binding rules, as the schema's refinement), with sdk/src/widgets.test.ts:195's fixtures.
 */
import { expectTypeOf } from 'expect-type';
import { a, fromGin, LENIENT as LENIENT_PROFILE, type AnySchema, type SchemaOf, type GinTypeDef, type JsonValue } from '../../index';
import { Grammar, type ExprT, type ObjTypeDefT, type ProgramSessionLike, type TypeDefT } from './harness-grammar';
import { LocalName, type QualifiedName } from './harness-fns';

// ============================================================================
// code / api drafts (over the session's program grammar)
// ============================================================================

const snake = a.string().pattern(/^[a-z][a-z0-9_]*$/).describe('snake_case, after what it does.');

/** code authoring.ts:174 */
const codeDraft = a.object({
  name: snake,
  description: a.string().min(1).describe('One sentence: what it gives and what its args are for.'),
  program: a.ref('Expr').describe('The program: one gin expression whose value is the result.'),
  sample: a.record(a.json()).describe('Sample args to check it with: a value for every required arg.'),
});
export const CodeDraft = Grammar.result(codeDraft);
/** The `set` tool (code's draft tool, `toolNames: { draft: 'set' }`): `{ draft }`. */
export const CodeSetTool = Grammar.result(a.object({ draft: codeDraft }));

/** api authoring.ts:285 */
export const ApiDraft = Grammar.result(a.object({
  name: snake,
  description: a.string().min(1).describe('One sentence: what it gives and what its args are for.'),
  request: a.ref('Expr').describe('The program giving the api/HttpRequest.'),
  responseType: a.ref('TypeDef').optional().describe('The type of response.body, when output reads it.'),
  output: a.ref('Expr').optional().describe('The program mapping `response` to the result.'),
  sample: a.record(a.json()).describe('Sample args: a value for every required arg.'),
}));

/** code authoring.ts:22 `CodeDraft`, api authoring.ts:28 `ApiDraft` (ExprDef / TypeDef as the grammar types them). */
type Expr = a.infer<typeof import('./harness-grammar').Program>;
type TypeDef = a.infer<typeof import('./harness-grammar').TypeDefSchema>;
expectTypeOf<a.infer<typeof CodeDraft>>().toEqualTypeOf<{ name: string; description: string; program: Expr; sample: Record<string, JsonValue> }>();
expectTypeOf<a.infer<typeof ApiDraft>>().toEqualTypeOf<{ name: string; description: string; request: Expr; responseType?: TypeDef; output?: Expr; sample: Record<string, JsonValue> }>();
expectTypeOf<Expr>().toMatchTypeOf<ExprT>();
expectTypeOf(CodeDraft.bind).parameters.toEqualTypeOf<[session: ProgramSessionLike]>();

/** program/tools.ts:199 `signature`: the new fn's args (an obj type) and result type. */
export const SignatureArgs = Grammar.result(a.object({
  args: a.ref('TypeDef').describe('An obj type: {"name":"obj","props":{"amount":{"type":{"name":"num"}}}}.'),
  returns: a.ref('TypeDef').describe('The result type.'),
}));
/** program/tools.ts:133 `load`, :108 `search`. */
export const LoadToolArgs = a.object({
  fns: a.array(a.string().min(1)).optional().describe('Fns as search listed them (`system/name`).'),
  types: a.array(a.string().min(1)).optional().describe('Named types as a load or search listed them.'),
});
export const SearchToolArgs = a.object({ text: a.string().min(1).describe('What the fn should do, in plain words.') });

// code authoring.ts:60-100 `CODE_EXAMPLES`, verbatim (its helpers inlined).
const num = { name: 'num' } as const;
const text = { name: 'text' } as const;
const arg = (name: string) => ({ kind: 'get' as const, path: [{ prop: 'args' }, { prop: name }] });
const literal = (value: number) => ({ kind: 'new' as const, type: num, value });
const method = (left: { path: readonly ({ prop: string } | { args: Record<string, ExprT> })[] }, name: string, other: ExprT) =>
  ({ kind: 'get' as const, path: [...left.path, { prop: name }, { args: { other } }] });
const RESULT = { name: 'obj', props: { total: { type: num }, note: { type: text } } } as const;
export const CODE_EXAMPLES = {
  priceWithTax: {
    signature: { args: { name: 'obj', props: { amount: { type: num }, rate: { type: num } } }, returns: RESULT },
    program: {
      kind: 'new', type: RESULT,
      value: {
        total: method(arg('amount'), 'mul', method(method(arg('rate'), 'div', literal(100)), 'add', literal(1))),
        note: { kind: 'template', template: '{amount} at {rate}%', params: { kind: 'get', path: [{ prop: 'args' }] } },
      },
    },
  },
  withLocal: {
    signature: { args: { name: 'obj', props: { amount: { type: num }, rate: { type: num } } }, returns: RESULT },
    program: {
      kind: 'define',
      vars: [{ name: 'total', value: method(arg('amount'), 'mul', method(method(arg('rate'), 'div', literal(100)), 'add', literal(1))) }],
      body: { kind: 'new', type: RESULT, value: { total: { kind: 'get', path: [{ prop: 'total' }] }, note: { kind: 'get', path: [{ prop: 'total' }, { prop: 'toText' }, { args: {} }] } } },
    },
  },
  callsFn: {
    signature: { args: { name: 'obj', props: { ticket: { type: text } } }, returns: text },
    program: {
      kind: 'template', template: '{ticket}: {summary}',
      params: {
        kind: 'new', type: { name: 'obj', props: { ticket: { type: text }, summary: { type: text } } },
        value: { ticket: arg('ticket'), summary: { kind: 'get', path: [{ prop: 'fns' }, { prop: 'tickets' }, { prop: 'status' }, { args: { ticket: arg('ticket') } }, { prop: 'summary' }] } },
      },
    },
  },
} as const satisfies Record<string, { signature: { args: TypeDefT; returns: TypeDefT }; program: ExprT }>;

// api authoring.ts:76-110 `API_EXAMPLES` (repo, openIssues), verbatim.
const lit = (type: TypeDefT, value: unknown) => ({ kind: 'new' as const, type, value });
const field = (from: string, name: string) => ({ kind: 'get' as const, path: [{ prop: from }, { prop: 'body' }, { prop: name }] });
const ISSUE = { name: 'obj', props: { number: { type: num }, title: { type: text } } } as const;
export const API_EXAMPLES = {
  repo: {
    signature: { args: { name: 'obj', props: { owner: { type: text }, repo: { type: text } } }, returns: { name: 'obj', props: { name: { type: text }, stars: { type: num } } } },
    request: { kind: 'new', type: { name: 'api/HttpRequest' }, value: { method: 'GET', url: { kind: 'template', template: '/repos/{owner}/{repo}', params: { kind: 'get', path: [{ prop: 'args' }] } } } },
    responseType: { name: 'obj', props: { name: { type: text }, stargazers_count: { type: num } } },
    output: { kind: 'new', type: { name: 'obj', props: { name: { type: text }, stars: { type: num } } }, value: { name: field('response', 'name'), stars: field('response', 'stargazers_count') } },
  },
  openIssues: {
    signature: { args: { name: 'obj', props: { owner: { type: text }, repo: { type: text } } }, returns: { name: 'list', generic: { V: ISSUE } } },
    request: {
      kind: 'new', type: { name: 'api/HttpRequest' },
      value: {
        method: 'GET',
        url: { kind: 'template', template: '/repos/{owner}/{repo}/issues', params: { kind: 'get', path: [{ prop: 'args' }] } },
        params: lit({ name: 'list', generic: { V: { name: 'api/HttpParam' } } }, [lit({ name: 'api/HttpParam' }, { key: 'state', value: lit(text, 'open') })]),
      },
    },
  },
} as const;

// ============================================================================
// input forms (systems/input/server/authoring.ts:157)
// ============================================================================

/** authoring.ts:157 `FieldTypeDraft`, verbatim (`| undefined` dropped: optional keys are absent after decoding). */
export type FieldTypeDraft =
  | { name: 'text'; options?: { minLength?: number; maxLength?: number } }
  | { name: 'num'; options?: { min?: number; max?: number; whole?: boolean } }
  | { name: 'bool' | 'date' | 'timestamp' | 'duration' }
  | { name: 'enum'; generic: { V: { name: 'text' } }; options: { values: Record<string, string> } }
  | { name: 'list'; generic: { V: FieldTypeDraft }; options?: { minLength?: number; maxLength?: number } }
  | { name: 'optional'; generic: { T: FieldTypeDraft } }
  | { name: 'obj'; props: Record<string, { docs?: string; type: FieldTypeDraft }> };

const lengths = a.object({ minLength: a.int().min(0).optional(), maxLength: a.int().min(1).optional() }).optional();

/**
 * authoring.ts:172 `FieldType` — in zod a `z.lazy` union with a hand-written type annotation; in `a` a named type that
 * refers to itself, its type inferred (no annotation, no workaround).
 */
const fieldTypes = {
    FieldType: a.union([
      a.object({ name: a.literal('text'), options: lengths }),
      a.object({ name: a.literal('num'), options: a.object({ min: a.number().optional(), max: a.number().optional(), whole: a.boolean().optional() }).optional() }),
      a.object({ name: a.enum(['bool', 'date', 'timestamp', 'duration']) }),
      a.object({ name: a.literal('enum'), generic: a.object({ V: a.object({ name: a.literal('text') }) }), options: a.object({ values: a.record(a.string()).describe('Each choice: its key and the words the person reads.') }) }),
      a.object({ name: a.literal('list'), generic: a.object({ V: a.ref('FieldType') }), options: lengths }),
      a.object({ name: a.literal('optional'), generic: a.object({ T: a.ref('FieldType') }) }),
      a.object({ name: a.literal('obj'), props: a.record(a.object({ docs: a.string().optional().describe('The question the person reads.'), type: a.ref('FieldType') })) }),
    ]),
} as const;
// authoring.ts:183 `FormDraftSchema = InputFormSchema.omit({ type }).extend({ type })` (input shared/index.ts:19)
const formDraft = a.object({
    title: a.string().min(1),
    description: a.string(),
    submit: a.string().min(1).optional().describe('The submit button\'s words ("Send" when absent).'),
    type: a.object({ name: a.literal('obj'), props: a.record(a.object({ docs: a.string().min(1).describe('The question the person reads.'), type: a.ref('FieldType') })) })
      .describe('The gin type of the answers: an obj whose props are the questions.'),
});
export const FormDraft = a.define(fieldTypes).result(formDraft);
type FormDraft = a.infer<typeof FormDraft>;
type FieldType = FormDraft['type']['props'][string]['type'];
expectTypeOf<FormDraft>().toEqualTypeOf<{
  title: string; description: string; submit?: string;
  type: { name: 'obj'; props: Record<string, { docs: string; type: FieldType }> };
}>();
// the inferred recursive type is the hand-written one, both ways
expectTypeOf<FieldType>().toMatchTypeOf<FieldTypeDraft>();
expectTypeOf<FieldTypeDraft>().toMatchTypeOf<FieldType>();
/** sdk authoring.ts:404 the draft tool `{ draft }`. */
export const FormDraftTool = a.define(fieldTypes).result(a.object({ draft: formDraft }).describe('Write (or rewrite) the whole draft.'));

/** input/server/authoring.test.ts:19 `PROJECT`. */
export const PROJECT: FormDraft = {
  title: 'Project details',
  description: 'What the project is and how long it takes.',
  type: { name: 'obj', props: { project: { docs: 'Which project?', type: { name: 'text' } }, hours: { docs: 'How many hours?', type: { name: 'optional', generic: { T: { name: 'num', options: { whole: true } } } } } } },
};

// ============================================================================
// widgets: the strict per-call proposal schema (sdk/src/widget-schema.ts)
// ============================================================================

/** core/src/widgets.ts:41-65 `RELATIVE_DATES` (expr → what it yields). */
export const RELATIVE_DATES = {
  'today': 'day', 'today-1d': 'day', 'today+1d': 'day', 'today-7d': 'day', 'today-30d': 'day', 'today+7d': 'day',
  'startOf(week)': 'day', 'endOf(week)': 'day', 'startOf(month)': 'day', 'endOf(month)': 'day', 'startOf(month,today-1mo)': 'day',
  'startOf(quarter)': 'day', 'startOf(year)': 'day', 'now': 'instant', 'now-1h': 'instant', 'now-24h': 'instant',
} as const;
export type RelativeDate = keyof typeof RELATIVE_DATES;
/** sdk relative-dates.ts:189 */
export function relativeDatesFor(typeName: string): RelativeDate[] {
  const yields = typeName === 'date' ? 'day' : typeName === 'timestamp' ? 'instant' : undefined;
  return (Object.keys(RELATIVE_DATES) as RelativeDate[]).filter((expr) => RELATIVE_DATES[expr] === yields);
}

/** core widgets.ts:69 `ArgValue`, :73 `ChoiceOption`, :81 `ArgPlan` — the code side of a plan. */
export type ArgValue = { literal: JsonValue } | { relative: RelativeDate };
export type ArgPlan =
  | { show: 'control'; label?: string; choices?: { label: string; value?: ArgValue }[]; custom?: boolean; default?: ArgValue }
  | { show: 'pinned'; value: ArgValue }
  | { show: 'hidden' };
/** widget-schema.ts:56 `WidgetDraftInput` (what every call's schema pipes into). */
export interface WidgetDraftInputT {
  name: string;
  description: string;
  title: string;
  choice: { visual: string; style: string; label?: string; bind?: Record<string, string[]> };
  more: string[];
  args: Record<string, ArgPlan>;
  presets: { label: string; sets: Record<string, ArgValue> }[];
  actions?: { fn: QualifiedName; label?: string; confirm?: true; bind: Record<string, string>; then?: 'open' | 'refresh' | 'status' }[];
  drill?: { fn: QualifiedName; label: string; bind: Record<string, string> };
  live?: boolean;
}

/** core registries.ts `VisualChannel`, `VisualShape` (the parts the schema reads). */
export interface VisualChannel { readonly name: string; readonly label: string; readonly accepts: readonly string[]; readonly required: boolean; readonly many: boolean; readonly min?: number; readonly role?: string }
export interface VisualShape { readonly channels: readonly VisualChannel[]; readonly styles: readonly { name: string; whole?: boolean; needs?: readonly string[] }[]; readonly claims?: readonly unknown[] }
export interface VisualContribution { readonly name: string; readonly label: string; readonly shape?: VisualShape }
export interface VisualRank { readonly visual: string; readonly styles: readonly string[]; readonly bind: Readonly<Record<string, string[]>> }
export interface ColumnFacts { readonly name: string; readonly kind: string; readonly role: string; readonly opaque: boolean }
export interface ResultFacts { readonly columns: readonly ColumnFacts[]; readonly whole: boolean }

/** widget-schema.ts:22 `WidgetProposalSchemaInput` (no `table`/`scope`: rules over row values are not ported). */
export interface WidgetProposalInput {
  readonly source: QualifiedName;
  readonly args: ObjTypeDefT;
  readonly facts: ResultFacts;
  readonly ranked: readonly VisualRank[];
  readonly entries: readonly VisualContribution[];
  readonly actions?: readonly QualifiedName[];
  readonly drills?: readonly QualifiedName[];
  readonly live?: boolean;
}

/** sdk widgets.ts:156 `ArgInfo` / :166 `argsOf`. */
interface ArgInfo { readonly name: string; readonly type: GinTypeDef; readonly required: boolean }
export function argsOf(args: ObjTypeDefT): ArgInfo[] {
  return Object.entries(args.props).map(([name, prop]) => {
    const t = prop.type as GinTypeDef;
    const optional = t.name === 'optional';
    return { name, type: optional ? t.generic?.['T'] ?? t : t, required: !optional };
  });
}
/** widgets.ts:179 `pagingOf` */
export function pagingOf(args: ObjTypeDefT): { offset: string; limit: string } | undefined {
  const found = new Map(argsOf(args).map((arg) => [arg.name, arg]));
  const numeric = (name: string) => found.get(name)?.type.name === 'num';
  return numeric('offset') && numeric('limit') ? { offset: 'offset', limit: 'limit' } : undefined;
}
/** widgets.ts:193 `rangeOf` */
export function rangeOf(args: ObjTypeDefT): { from: string; to: string } | undefined {
  const dates = argsOf(args).filter((arg) => arg.type.name === 'date' || arg.type.name === 'timestamp').map((arg) => arg.name);
  const names = new Set(dates);
  for (const [from, to] of [['from', 'to'], ['start', 'end'], ['after', 'before'], ['since', 'until']] as const) {
    for (const name of dates) {
      const prefix = name === from ? '' : name.endsWith(`_${from}`) ? name.slice(0, -from.length) : undefined;
      if (prefix !== undefined && names.has(`${prefix}${to}`)) return { from: name, to: `${prefix}${to}` };
    }
  }
  return undefined;
}

const enumOf = (names: readonly string[]) => {
  const unique = [...new Set(names)];
  return unique.length === 0 ? undefined : a.enum(unique as [string, ...string[]]);
};
const valueSchemas = new Map<string, AnySchema>();
/** gin's value schema of an arg's type (`ginTypeOf(arg.type).toValueSchema({ unknownKeys: 'refuse' })`), cached. */
const typedValue = (type: GinTypeDef): AnySchema => {
  const key = JSON.stringify(type);
  let s = valueSchemas.get(key);
  if (!s) valueSchemas.set(key, (s = fromGin(type)));
  return s;
};

/** widget-schema.ts:95 `argValueSchema` */
function argValueSchema(arg: ArgInfo): AnySchema {
  const literal = a.object({ literal: typedValue(arg.type) }).strict().describe(`A ${arg.type.name} value.`);
  const relative = enumOf(relativeDatesFor(arg.type.name));
  return relative === undefined ? literal : a.union([literal, a.object({ relative }).strict().describe('A relative date, resolved each time the widget runs.')]);
}
/** widget-schema.ts:103 `argPlanSchema` */
function argPlanSchema(arg: ArgInfo): AnySchema {
  const value = argValueSchema(arg);
  const choice = a.object({ label: a.string().min(1), value: arg.required ? value : a.optional(value) }).strict();
  const control = a.object({
    show: a.literal('control'),
    label: a.string().min(1).optional().describe('The chip\'s words, when the arg\'s name doesn\'t say it.'),
    choices: a.array(choice).min(1).optional().describe(arg.required ? 'The only values offered, in order.' : 'The only values offered, in order; a choice without a value clears the arg ("Any").'),
    custom: a.boolean().optional().describe('Whether a value outside the choices may be typed.'),
    default: a.optional(value),
  }).strict();
  const pinned = a.object({ show: a.literal('pinned'), value }).strict().describe('Fixed: no chip, and the widget\'s callers can\'t change it.');
  const hidden = a.object({ show: a.literal('hidden') }).strict().describe('No chip: the arg takes its default.');
  return arg.required ? a.discriminatedUnion('show', [control, pinned]) : a.discriminatedUnion('show', [control, pinned, hidden]);
}
/** widget-schema.ts:118 `bindable` */
const bindable = (channel: VisualChannel, columns: readonly ColumnFacts[]) =>
  columns.filter((c) => !c.opaque && channel.accepts.includes(c.kind) && (channel.role === undefined || channel.role === c.role)).map((c) => c.name);
/** widget-schema.ts:122 `choiceSchema` */
function choiceSchema(input: WidgetProposalInput): AnySchema {
  const shapes = new Map(input.entries.map((entry) => [entry.name, entry]));
  const options = input.ranked.flatMap((rank) => {
    const entry = shapes.get(rank.visual);
    const styles = enumOf(rank.styles);
    if (entry?.shape === undefined || styles === undefined) return [];
    const bind = Object.fromEntries(entry.shape.channels.flatMap((channel) => {
      const columns = enumOf(bindable(channel, input.facts.columns));
      return columns === undefined ? [] : [[channel.name, a.array(columns).min(channel.many ? channel.min ?? 1 : 1).max(channel.many ? input.facts.columns.length : 1).optional().describe(channel.label)]];
    }));
    return [a.object({
      visual: a.literal(rank.visual),
      style: styles,
      label: a.string().min(1).optional(),
      bind: a.object(bind).strict().optional().describe(`Columns per channel, only where the default (${JSON.stringify(rank.bind)}) is wrong.`),
    }).strict().describe(entry.label)];
  });
  const [first, ...rest] = options;
  if (first === undefined) throw new Error(`No visual draws ${input.source}'s result.`);
  return rest.length === 0 ? first : a.discriminatedUnion('visual', [first, ...rest]);
}

/** widget-check.ts:31 `valueProblem` */
function valueProblem(arg: ArgInfo, value: ArgValue): string | undefined {
  if ('relative' in value) return relativeDatesFor(arg.type.name).includes(value.relative) ? undefined : `${value.relative} is not a relative date for a ${arg.type.name} argument.`;
  return a.module().result(typedValue(arg.type)).bind().render(LENIENT_PROFILE).parse(value.literal, { inPlace: false }).ok ? undefined : `${JSON.stringify(value.literal)} is not a valid ${arg.type.name}.`;
}

/** widget-check.ts:47 `argProblems` (the parts a draft can break), verbatim in its rules and words. */
export function argProblems(draft: WidgetDraftInputT, input: WidgetProposalInput, spec: { paging?: { offset: string; limit: string }; range?: { from: string; to: string } }): string[] {
  const problems: string[] = [];
  const args = new Map(argsOf(input.args).map((arg) => [arg.name, arg]));
  const paged = new Set<string>(spec.paging === undefined ? [] : [spec.paging.offset, spec.paging.limit]);
  const ranged = new Set<string>(spec.range === undefined ? [] : [spec.range.from, spec.range.to]);
  const check = (where: string, arg: ArgInfo, value: ArgValue): void => {
    const problem = valueProblem(arg, value);
    if (problem !== undefined) problems.push(`${where}: ${problem}`);
  };
  for (const [name, plan] of Object.entries(draft.args)) {
    const arg = args.get(name);
    if (arg === undefined) { problems.push(`Arg ${name}: ${input.source} has no arg ${name}.`); continue; }
    if (paged.has(name)) problems.push(`Arg ${name} is driven by the widget's pager, so it can't have a plan too.`);
    if (ranged.has(name) && plan.show !== 'control') problems.push(`Arg ${name} is driven by the widget's range, so it can't be ${plan.show}: give it a chip with the range the widget opens on.`);
    if (plan.show === 'hidden' && arg.required) problems.push(`Arg ${name} is hidden, but it has no default: pin a value or show it.`);
    if (plan.show === 'pinned') check(`Arg ${name}`, arg, plan.value);
    if (plan.show !== 'control') continue;
    if (plan.default !== undefined) check(`Arg ${name} default`, arg, plan.default);
    for (const choice of plan.choices ?? []) {
      if (choice.value === undefined) { if (arg.required) problems.push(`Arg ${name}: choice ${choice.label} clears it, but the arg is required.`); continue; }
      check(`Arg ${name} choice ${choice.label}`, arg, choice.value);
    }
  }
  for (const arg of args.values()) {
    if (!arg.required || paged.has(arg.name)) continue;
    const plan = draft.args[arg.name];
    if (plan === undefined || (plan.show === 'control' && plan.default === undefined)) problems.push(`Arg ${arg.name} is required: give its chip a default, or pin a value.`);
  }
  for (const preset of draft.presets) {
    for (const [name, value] of Object.entries(preset.sets)) {
      const arg = args.get(name);
      if (arg === undefined) { problems.push(`Preset ${preset.label}: ${input.source} has no arg ${name}.`); continue; }
      if (draft.args[name]?.show === 'pinned') problems.push(`Preset ${preset.label}: arg ${name} is pinned, so a preset can't set it.`);
      check(`Preset ${preset.label} arg ${name}`, arg, value);
    }
  }
  return problems;
}

/** widget-check.ts:96 `styleProblems` + :132 the action / drill column check (core `bindingProblems` not ported). */
function visualProblems(draft: WidgetDraftInputT, input: WidgetProposalInput): string[] {
  const problems: string[] = [];
  const rank = input.ranked.find((r) => r.visual === draft.choice.visual);
  const shape = input.entries.find((e) => e.name === draft.choice.visual)?.shape;
  if (rank !== undefined && shape !== undefined) {
    const bind = { ...rank.bind, ...draft.choice.bind };
    const style = shape.styles.find((s) => s.name === draft.choice.style);
    if (style?.whole === true && !input.facts.whole) problems.push(`Visual ${draft.choice.visual}: style ${style.name} only draws a whole result.`);
    for (const need of style?.needs ?? []) if (bind[need] === undefined) problems.push(`Visual ${draft.choice.visual}: style ${draft.choice.style} needs ${need} bound.`);
  }
  const columns = new Set(input.facts.columns.map((c) => c.name));
  const binds = [...(draft.actions ?? []).map((x) => ({ what: `Action ${x.fn}`, bind: x.bind })), ...(draft.drill === undefined ? [] : [{ what: `Drill ${draft.drill.fn}`, bind: draft.drill.bind }])];
  for (const { what, bind } of binds) for (const [arg, column] of Object.entries(bind)) if (!columns.has(column)) problems.push(`${what}: arg ${arg} binds column ${column}, which the result lacks.`);
  return problems;
}

/** widget-schema.ts:189 `widgetProposalSchema`'s schema, built from one call's input. */
function proposalSchema(input: WidgetProposalInput): AnySchema {
  const paging = pagingOf(input.args);
  const range = rangeOf(input.args);
  const pagingArgs = new Set(paging === undefined ? [] : [paging.offset, paging.limit]);
  const rangeArgs = new Set(range === undefined ? [] : [range.from, range.to]);
  const open = argsOf(input.args).filter((arg) => !pagingArgs.has(arg.name));
  const plans = a.object(Object.fromEntries(open.map((arg) => {
    const plan = argPlanSchema(arg);
    const about = `${arg.name}: ${arg.type.name}${arg.required ? ', required' : ''}`;
    if (!rangeArgs.has(arg.name)) return [arg.name, plan.describe(about)];
    const ranged = `${about}; a range arg: when a chosen visual draws a range, give it a chip (never pinned or hidden) whose default is where the range opens (a relative date such as startOf(year) and today)${arg.required ? '' : ', or leave it out'}`;
    return [arg.name, (arg.required ? plan : a.optional(plan)).describe(ranged)];
  }))).strict();
  const presetSets = a.object(Object.fromEntries(open.map((arg) => [arg.name, a.optional(argValueSchema(arg))]))).strict();
  const columns = enumOf(input.facts.columns.map((c) => c.name)) ?? a.string();
  const visuals = enumOf(input.ranked.map((r) => r.visual)) ?? a.string();
  const actionFns = enumOf(input.actions ?? []);
  const drillFns = enumOf(input.drills ?? []);
  const shape: Record<string, AnySchema> = {
    name: LocalName.describe('The widget fn\'s name, snake_case ("open_tasks_by_owner").'),
    description: a.string().min(1).describe('One sentence: what the widget shows.'),
    title: a.string().min(1).describe('The widget\'s heading, a few words ("Open tasks by owner").'),
    choice: choiceSchema(input).describe('The visual shown first; the ranked ones only, best first.'),
    more: a.array(visuals).describe('The other visuals the switcher offers (by default every ranked one).'),
    args: plans.describe('A plan for every arg of the source: a chip, pinned or hidden.'),
    presets: a.array(a.object({ label: a.string().min(1), sets: presetSets }).strict()).describe('Named chips that set several args in one tap ("Overdue"); [] for none.'),
    ...(actionFns === undefined ? {} : {
      actions: a.array(a.object({
        fn: actionFns, label: a.string().min(1).optional(), confirm: a.literal(true).optional(), bind: a.record(columns), then: a.enum(['open', 'refresh', 'status']).optional(),
      }).strict()).optional().describe('Leave out to offer every derived action; [] for none.'),
    }),
    ...(drillFns === undefined ? {} : {
      drill: a.object({ fn: drillFns, label: a.string().min(1), bind: a.record(columns) }).strict().optional().describe('What clicking a bar, slice or row opens, its args from the clicked row\'s columns.'),
    }),
    ...(input.live === true ? { live: a.boolean().optional().describe('Re-run on its own while shown.') } : {}),
  };
  // widget-schema.ts:228 `.pipe(WidgetDraftInput).superRefine(checkWidget)` (GAP superRefine: one message for all)
  return a.object(shape).strict().refine((draft) => {
    const d = draft as unknown as WidgetDraftInputT;
    const claims = [d.choice.visual, ...d.more].some((name) => (input.entries.find((e) => e.name === name)?.shape?.claims ?? []).length > 0);
    const problems = [...argProblems(d, input, { ...(paging === undefined ? {} : { paging }), ...(range !== undefined && claims ? { range } : {}) }), ...visualProblems(d, input)];
    return problems.length === 0 || problems.join(' ');
  });
}

/**
 * The strict proposal schema of one `make_widget` call. Its input is runtime (the source's args, a real result's facts,
 * the ranked visuals), so it is the dynamic step, cached per call input. Its output is `WidgetDraftInput`, the type
 * every call's schema shares (widget-schema.ts:56).
 */
export const WidgetProposal = a
  .declare<{ Draft: WidgetDraftInputT }>()
  .dynamic((input: WidgetProposalInput) => ({ Draft: proposalSchema(input) as SchemaOf<WidgetDraftInputT> }), { key: (input) => input })
  .result('Draft');
expectTypeOf<a.infer<typeof WidgetProposal>>().toEqualTypeOf<WidgetDraftInputT>();
expectTypeOf(WidgetProposal.bind).parameters.toEqualTypeOf<[input: WidgetProposalInput]>();
