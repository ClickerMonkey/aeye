/**
 * CORPUS: the harness's fn schemas (E:\GitHub\harness, read-only), ported to `a`.
 *
 * Sources:
 * - core/src/primitives.ts (QualifiedName, SystemName, InstanceName, LocalName, Audience);
 * - core/src/model-names.ts (a fn's model name, `FN_NAME_PATTERN`, the two-way translation `modelFnNames`);
 * - core/src/people-only.ts + sdk/src/zod-gin.ts `toolArgsOf` (people-only fields, `forModels`, union
 *   flattening, `{input}` wrapping), sdk/src/gin.ts (`g.fnName()`, `g.record`), core/src/gin-record.ts;
 * - core/src/context-graph.ts + core/src/inject.ts (the memory fns' args: `inject` people-only, `clear` narrower);
 * - sdk/src/zod-gin.test.ts (its `Shape`, `Either`, `Body` fixtures);
 * - core/src/mcp-servers.ts + core/src/remote-auth.ts (the build-9 instance configs zod-gin.test.ts reads);
 * - hub/src/catalog/catalog.ts:252 `signature()` + hub/src/catalog/fixtures.ts (shop/orders);
 * - hub/src/models/structured.ts + its four callers (the hub's own structured answers).
 *
 * How the harness's model names map to `a`: a fn-name field (`g.fnName()`, zod's `FnNameValue`) is ONE named type
 * `FnName`, a codec supplied per prompt by the dynamic step from the prompt's `ModelFnNames` (static mode spells some
 * fns as its tools: `find`, `load`…). The code holds the qualified name (`fs/read`); the model reads and writes the
 * model name (`fs__read`). Every bundle that has a fn-name field declares `FnName` and binds it from the names.
 *
 * zod features with no `a` counterpart (recorded as gaps in harness-fns.test.ts):
 * - `z.templateLiteral` (QualifiedName `${string}/${string}`, ResourceUri): ported as an identity codec over a
 *   patterned string, cast to the template type;
 * - `.default(x)`: ported as `.optional()` (zod's output has the default filled in, so the field is required there);
 * - `.omit` / `.partial` / `.pick` / `.keyof` on objects: shapes rebuilt by hand;
 * - `.transform` without an inverse (zod-gin.test.ts `when`): no faithful port.
 */
import { createHash } from 'node:crypto';
import { expectTypeOf } from 'expect-type';
import { a, fromGin, ginNamedTypes, type AnySchema, type Bound, type GinRegistryLike, type GinTypeDef } from '../../index';

// ============================================================================
// Primitives (core/src/primitives.ts)
// ============================================================================

/** primitives.ts:183 */
export const SYSTEM_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
/** primitives.ts:189 `z.templateLiteral([z.string().regex(SYSTEM_NAME_PATTERN), '/', z.string().min(1)])`. */
export type QualifiedName = `${string}/${string}`;
// GAP (template literal): no `a.templateLiteral`; an identity codec over the pattern gives the exact code type.
export const QualifiedName = a.codec(a.string().pattern('^[a-z][a-z0-9-]*/.+$'), {
  decode: (wire) => wire as QualifiedName,
  encode: (name: QualifiedName) => name,
});
expectTypeOf<a.infer<typeof QualifiedName>>().toEqualTypeOf<QualifiedName>();

/** primitives.ts:267 `z.string().regex(SYSTEM_NAME_PATTERN).brand<'InstanceName'>()`. */
export const InstanceName = a.string().pattern(SYSTEM_NAME_PATTERN).brand<'InstanceName'>();
export type InstanceName = a.infer<typeof InstanceName>;
expectTypeOf<InstanceName>().toMatchTypeOf<string>();
expectTypeOf<string>().not.toMatchTypeOf<InstanceName>();

/** primitives.ts:97 */
export const LocalName = a.string().pattern(/^[A-Za-z_][A-Za-z0-9_.-]*$/);
/** primitives.ts:214 */
export const Audience = a.enum(['user', 'llm', 'both', 'none']);

/** resources.ts:8 `z.templateLiteral([z.string().regex(/^[a-z][a-z0-9+.-]*$/), '://', z.string()])`. */
export type ResourceUri = `${string}://${string}`;
export const ResourceUri = a.codec(a.string().pattern('^[a-z][a-z0-9+.-]*://.*$'), {
  decode: (wire) => wire as ResourceUri,
  encode: (uri: ResourceUri) => uri,
});
/** resources.ts:12 */
export const SectionKey = a.string().min(1).brand<'SectionKey'>();
export type SectionKey = a.infer<typeof SectionKey>;

// ============================================================================
// A fn's model name (core/src/model-names.ts)
// ============================================================================

/** model-names.ts:20,22,24 */
export const MODEL_FN_NAME_MAX = 64;
const MODEL_FN_NAME_CUT = 54;
const MODEL_FN_NAME_HASH = 8;
/** model-names.ts:31,33 */
const FN_PART = '[A-Za-z0-9](?:[A-Za-z0-9-]|_(?![_.]|$))*';
export const FN_LOCAL_NAME_PATTERN = new RegExp(`^${FN_PART}(?:\\.${FN_PART})*$`);
/** model-names.ts:270 — what marks a gin text as a fn's name (`g.fnName()`). */
export const FN_NAME_PATTERN = '^[a-z]\\S*$';
/** model-names.ts:272 — what a fn-name field tells the model (hub modes.ts:77 `withFnNameDocs` adds it). */
export const FN_NAME_DESCRIPTION = 'A fn\'s name, as your tools spell it.';

const splitName = (fn: QualifiedName): { system: string; local: string } => {
  const at = fn.indexOf('/');
  return { system: fn.slice(0, at), local: fn.slice(at + 1) };
};
/** model-names.ts:55 */
const fullModelName = (fn: QualifiedName): string => {
  const { system, local } = splitName(fn);
  return `${system}__${local.replaceAll('.', '__')}`;
};
const isQualified = (name: string): name is QualifiedName => /^[a-z][a-z0-9-]*\/.+$/.test(name);

/** model-names.ts:61 `modelFnName`: `/` and `.` as `__`; past 64, cut to 54 + `_x` + 8 hex of the name's sha-256. */
export function modelFnName(fn: QualifiedName): string {
  const full = fullModelName(fn);
  const name = full.length <= MODEL_FN_NAME_MAX
    ? full
    : `${full.slice(0, MODEL_FN_NAME_CUT).replace(/_+$/, '')}_x${createHash('sha256').update(fn).digest('hex').slice(0, MODEL_FN_NAME_HASH)}`;
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** model-names.ts:75 */
const looksCut = (name: string): boolean => name.length === MODEL_FN_NAME_MAX && /_x[0-9a-f]{8}$/.test(name);

/** model-names.ts:89 `fnOfModelNameByRule`: the first `__` ends the system, each later `__` is a `.`. */
export function fnOfModelNameByRule(name: string): QualifiedName | undefined {
  if (looksCut(name)) return undefined;
  const at = name.indexOf('__');
  if (at <= 0) return undefined;
  const system = name.slice(0, at);
  const local = name.slice(at + 2).split('__').join('.');
  if (!SYSTEM_NAME_PATTERN.test(system) || !FN_LOCAL_NAME_PATTERN.test(local)) return undefined;
  const fn = `${system}/${local}` as const;
  return fullModelName(fn).length <= MODEL_FN_NAME_MAX && fullModelName(fn) === name ? fn : undefined;
}

/** model-names.ts:322 — the hub fns static mode's tools stand for. */
export type StaticToolFns = Readonly<Record<string, { readonly fn: QualifiedName; readonly also?: readonly QualifiedName[] }>>;

/**
 * model-names.ts:333 `ModelFnNames`, the part a schema needs: one prompt's names, both ways. `learn` (asking the
 * registry about cut names) is the caller's, before decoding; `version` keys the bound schema per prompt.
 */
export interface ModelFnNamesLike {
  readonly version: number;
  /** The name the model calls this fn by here: its model name, or in static mode the tool that does its job. */
  name(fn: QualifiedName): string;
  /** The fn a name from the model means (a model name, a static tool's name, or, tolerated, a qualified name). */
  fn(name: string): QualifiedName | undefined;
}

/** model-names.ts:413 `modelFnNames`, without a registry (`RULE_ONLY_NAMES`): static tools, names given out, the rule. */
export function modelFnNames(mode: { type: 'tools' } | { type: 'static'; tools: StaticToolFns }, version = 1): ModelFnNamesLike {
  const standIn = new Map<string, string>();
  const toolFn = new Map<string, QualifiedName>();
  if (mode.type === 'static') {
    for (const [tool, { fn, also }] of Object.entries(mode.tools)) {
      toolFn.set(tool, fn);
      standIn.set(fn, tool);
      for (const other of also ?? []) if (!standIn.has(other)) standIn.set(other, tool);
    }
  }
  const byModel = new Map<string, QualifiedName>();
  return {
    version,
    name: (fn) => {
      const stood = standIn.get(fn);
      if (stood !== undefined) return stood;
      const model = modelFnName(fn);
      if (!byModel.has(model)) byModel.set(model, fn);
      return model;
    },
    fn: (given) => toolFn.get(given) ?? byModel.get(given) ?? (isQualified(given) ? given : fnOfModelNameByRule(given)),
  };
}

/**
 * sdk/src/gin.ts:43 `g.fnName()` = `text({ pattern: FN_NAME_PATTERN })`, read back at the boundary (model-names.ts
 * `read`/`value`), described by hub modes.ts:77 `withFnNameDocs`. In `a`: a codec, the model's spelling on the wire.
 */
export function fnNameOf(names: ModelFnNamesLike) {
  return a.codec(a.string().pattern(FN_NAME_PATTERN).describe(FN_NAME_DESCRIPTION), {
    decode: (wire: string): QualifiedName | Error => names.fn(wire) ?? new Error(`${wire} names no fn: write a fn's name as your tools spell it.`),
    encode: (fn: QualifiedName): string => names.name(fn),
  });
}

/** The chain start every fn-name-carrying bundle shares: `FnName` is supplied per prompt. */
export const withFnNames = <D extends Record<string, AnySchema>>(defs: D) =>
  a.define(defs).declare<{ FnName: QualifiedName }>();
const fnNameStep = (names: ModelFnNamesLike) => ({ FnName: fnNameOf(names) });
const byPrompt = { key: (names: ModelFnNamesLike) => names };

// ============================================================================
// People-only fields and narrower model forms (core/src/context-graph.ts, inject.ts, people-only.ts)
// ============================================================================

/** inject.ts:18 */
export const AGENT_TARGET_PATTERN = /^(?:\*|[a-z*][a-z0-9*-]*\/[A-Za-z0-9_*][A-Za-z0-9_.*-]*)$/;
/** inject.ts:19 `z.string().regex(…, msg).refine((t) => !t.includes('**'), 'write one *')`. */
export const AgentTargetDecl = a.string().pattern(AGENT_TARGET_PATTERN).refine((target) => !target.includes('**'), 'write one *');

/** inject.ts:76 */
export const InjectDecl = a.object({
  into: a.array(AgentTargetDecl).min(1).describe('The agents it goes into: exact agent names or patterns (`AgentTargetDecl`). At least one.'),
  order: a.int().min(0).max(1000).default(100).describe('Lower comes first. Default 100; the hub\'s own items are 10 to 30.'),
  requires: a.array(QualifiedName).default([]).describe('Fns its text names without bringing them.'),
  mode: a.enum(['tools', 'static']).optional().describe('Only in this chat mode; absent, in both.'),
  replaces: a.array(QualifiedName).optional().describe('Context items it takes the place of.'),
});

/** context-graph.ts:90 `LinkTarget`: the `fn` option's name is a fn-name field. */
export const LinkTarget = a.discriminatedUnion('kind', [
  a.object({ kind: a.literal('context'), name: QualifiedName }),
  a.object({ kind: a.literal('fn'), name: a.ref('FnName') }),
  a.object({ kind: a.literal('type'), name: QualifiedName }),
  a.object({ kind: a.literal('resource'), uri: ResourceUri, section: SectionKey.optional() }),
]);

/** context-graph.ts:148 `ContextOptions`: `inject` is people-only (people-only.ts `peopleOnly`). */
export const contextOptionsShape = {
  weight: a.number().min(0).max(2).optional().describe('How much it counts when scored (0 leaves it out; 1 when absent).'),
  summary: a.string().optional().describe('A short form shown at `signature` detail.'),
  tags: a.array(a.string().min(1)).optional(),
  fns: a.array(a.ref('FnName')).optional().describe('Tied fns: offered whenever this item is loaded.'),
  suggestFns: a.array(a.ref('FnName')).optional().describe('Fns suggested alongside it.'),
  inject: InjectDecl.optional().forPeople().describe('Put it in these agents\' system prompts.'),
  command: a.string().pattern(/^[a-z][a-z0-9-]*$/).optional().describe('A `/command` name that loads it.'),
  visible: Audience.optional().describe('Who sees it listed, and who it is suggested to.'),
  suggest: Audience.optional(),
  parent: QualifiedName.optional().describe('Its parent in a hierarchy.'),
} as const;

/** `ContextOptions.keyof()` (GAP: no `.keyof`). */
export const CONTEXT_OPTION_KEYS = ['weight', 'summary', 'tags', 'fns', 'suggestFns', 'inject', 'command', 'visible', 'suggest', 'parent'] as const;
/** context-graph.ts:184 `ModelClearable`: every option but the people-only ones. */
export const MODEL_CLEARABLE = ['weight', 'summary', 'tags', 'fns', 'suggestFns', 'command', 'visible', 'suggest', 'parent'] as const;

/** context-graph.ts:175 `RememberArgs`. */
const rememberShape = {
  text: a.string().min(1),
  title: a.string().optional().describe('A short title; the name\'s slug comes from it (or the first words).'),
  scope: a.enum(['session', 'user', 'everyone']).default('session'),
  about: a.array(a.ref('LinkTarget')).optional(),
  ...contextOptionsShape,
} as const;
export const RememberArgs = withFnNames({ LinkTarget })
  .dynamic(fnNameStep, byPrompt)
  .result(a.object(rememberShape));

/**
 * context-graph.ts:187 `UpdateMemoryArgs = RememberArgs.omit({ scope }).partial().extend({ name, clear })` (GAP: no
 * `.omit`/`.partial`, rebuilt by hand). `clear`'s model form (`forModels`) leaves out the people-only option.
 */
export const UpdateMemoryArgs = withFnNames({ LinkTarget })
  .dynamic(fnNameStep, byPrompt)
  .result(a.object({
    text: a.string().min(1).optional(),
    title: rememberShape.title,
    about: rememberShape.about,
    ...contextOptionsShape,
    name: QualifiedName,
    clear: a.array(a.enum(CONTEXT_OPTION_KEYS)).optional()
      .forModels(a.array(a.enum(MODEL_CLEARABLE)).optional())
      .describe('Options to remove; an option left out of the edit stays as it was.'),
  }));

/** The real code types (zod `z.infer`, with the GAP-default fields optional as ported). */
export type LinkTargetT =
  | { kind: 'context'; name: QualifiedName }
  | { kind: 'fn'; name: QualifiedName }
  | { kind: 'type'; name: QualifiedName }
  | { kind: 'resource'; uri: ResourceUri; section?: SectionKey };
export interface InjectDeclT {
  into: string[];
  order: number;
  requires: QualifiedName[];
  mode?: 'tools' | 'static';
  replaces?: QualifiedName[];
}
type Aud = 'user' | 'llm' | 'both' | 'none';
export interface ContextOptionsT {
  weight?: number;
  summary?: string;
  tags?: string[];
  fns?: QualifiedName[];
  suggestFns?: QualifiedName[];
  inject?: InjectDeclT;
  command?: string;
  visible?: Aud;
  suggest?: Aud;
  parent?: QualifiedName;
}
export type RememberArgsT = { text: string; title?: string; scope: 'session' | 'user' | 'everyone'; about?: LinkTargetT[] } & ContextOptionsT;
export type UpdateMemoryArgsT = { text?: string; title?: string; about?: LinkTargetT[]; name: QualifiedName; clear?: (typeof CONTEXT_OPTION_KEYS)[number][] } & ContextOptionsT;

expectTypeOf<a.infer<typeof InjectDecl>>().toEqualTypeOf<InjectDeclT>();
expectTypeOf<a.infer<typeof RememberArgs>>().toEqualTypeOf<{
  text: string; title?: string; scope: 'session' | 'user' | 'everyone'; about?: LinkTargetT[];
  weight?: number; summary?: string; tags?: string[]; fns?: QualifiedName[]; suggestFns?: QualifiedName[]; inject?: InjectDeclT;
  command?: string; visible?: Aud; suggest?: Aud; parent?: QualifiedName;
}>();
expectTypeOf<a.infer<typeof UpdateMemoryArgs>>().toEqualTypeOf<{
  name: QualifiedName; text?: string; title?: string; about?: LinkTargetT[];
  weight?: number; summary?: string; tags?: string[]; fns?: QualifiedName[]; suggestFns?: QualifiedName[]; inject?: InjectDeclT;
  command?: string; visible?: Aud; suggest?: Aud; parent?: QualifiedName; clear?: (typeof CONTEXT_OPTION_KEYS)[number][];
}>();
// `.default(x)`: optional on the wire, required in the code type (zod's output).
expectTypeOf<a.infer<typeof InjectDecl>['order']>().toEqualTypeOf<number>();
// The ctx the dynamic step needs is one prompt's names.
expectTypeOf(UpdateMemoryArgs.bind).parameters.toEqualTypeOf<[names: ModelFnNamesLike]>();

// ============================================================================
// sdk/src/zod-gin.test.ts fixtures: what `ginOf` / `toolArgsOf` read off zod schemas
// ============================================================================

/** zod-gin.test.ts:10 `Shape`. */
export const Shape = a.object({
  name: a.string().min(1).max(40).describe('What it is called.'),
  email: a.string().format('email'),
  count: a.int().min(0),
  ratio: a.number().max(1),
  on: a.boolean().optional(),
  mode: a.enum(['fast', 'slow']).default('fast'),
  one: a.literal('only'),
  tags: a.array(a.string()),
  scope: a.discriminatedUnion('scope', [a.object({ scope: a.literal('hub') }), a.object({ scope: a.literal('user'), user: a.string() })]),
  extra: a.record(a.number()),
  note: a.string().nullable(),
  data: a.json(),
  // GAP (transform): `z.string().transform((text) => text.length)` has no inverse to encode with; the input side only.
  when: a.string(),
});
expectTypeOf<a.infer<typeof Shape>>().toEqualTypeOf<{
  name: string; email: string; count: number; ratio: number; on?: boolean; mode: 'fast' | 'slow'; one: 'only'; tags: string[];
  scope: { scope: 'hub' } | { scope: 'user'; user: string }; extra: Record<string, number>; note: string | null;
  data: import('../../index').JsonValue; when: string;
}>();

/** zod-gin.test.ts:49 `Either`: a union of objects at a tool's root (`toolArgsOf` flattens it). */
export const Either = a.discriminatedUnion('kind', [
  a.object({ kind: a.literal('a'), a: a.string() }),
  a.object({ kind: a.literal('b'), b: a.number(), note: a.string().optional() }),
]);
expectTypeOf<a.infer<typeof Either>>().toEqualTypeOf<{ kind: 'a'; a: string } | { kind: 'b'; b: number; note?: string }>();
/** zod-gin.ts:126 `FlatArgs`: what `toolArgsOf` gives a model for `Either` (every member's fields, each optional). */
export const EitherFlat = a.object({ kind: a.enum(['a', 'b']).optional(), a: a.string().optional(), b: a.number().optional(), note: a.string().optional() });

/** zod-gin.test.ts:69 `Body` = `{ text }.extend(Options.shape)`, `secret` people-only. */
export const Body = a.object({ text: a.string(), note: a.string().optional(), secret: a.string().optional().forPeople() });
expectTypeOf<a.infer<typeof Body>>().toEqualTypeOf<{ text: string; note?: string; secret?: string }>();
/** zod-gin.test.ts:97 `forModels(z.enum(['a','b']), z.enum(['a']))`. */
export const Pick = a.object({ pick: a.enum(['a', 'b']).forModels(a.enum(['a'])) });

/** zod-gin.test.ts:117 records over open keys: gin `record<list<num>>`. */
export const RecordOfLists = a.record(a.array(a.number()));
/** zod-gin.test.ts:104 `z.partialRecord(Metric, Weight)`: an object of optional fields, one per key. */
export const Weight = a.object({ weight: a.number().min(0), k: a.number().min(0).optional() }).describe('A part of the score.');
export const Weights = a.record(a.enum(['embedding', 'words']), Weight);
expectTypeOf<a.infer<typeof Weights>>().toEqualTypeOf<{ embedding?: { weight: number; k?: number }; words?: { weight: number; k?: number } }>();

// ============================================================================
// The build-9 instance configs (core/src/mcp-servers.ts:29-68, remote-auth.ts:27-60): a person's admin form
// ============================================================================

const RemoteAuthPer = a.enum(['shared', 'person']);
const HeaderName = a.string().pattern(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/);
/** remote-auth.ts:60 */
export const RemoteAuth = a.discriminatedUnion('kind', [
  a.object({ kind: a.literal('none') }),
  a.object({ kind: a.literal('bearer'), per: RemoteAuthPer, token: a.string().min(1).optional() }),
  a.object({ kind: a.literal('headers'), per: RemoteAuthPer, names: a.array(HeaderName).min(1), values: a.record(a.string()).optional() }),
  a.object({ kind: a.literal('oauth'), per: RemoteAuthPer, scopes: a.array(a.string().min(1)).optional(), clientId: a.string().min(1).optional(), clientSecret: a.string().min(1).optional() }),
]);
/** mcp-servers.ts:29 */
export const McpTransport = a.discriminatedUnion('type', [
  a.object({
    type: a.literal('stdio'),
    command: a.string().min(1),
    args: a.array(a.string()).default([]),
    env: a.record(a.string()).optional().describe('Environment values by name (config secrets).'),
    cwd: a.string().min(1).optional(),
  }),
  a.object({ type: a.literal('http'), url: a.string().format('uri') }),
  a.object({ type: a.literal('sse'), url: a.string().format('uri') }),
]);
/** mcp-servers.ts:51 */
export const McpServerConfig = a.object({
  label: a.string().min(1),
  description: a.string().optional(),
  transport: McpTransport,
  auth: RemoteAuth.default({ kind: 'none' }),
  trusted: a.boolean().default(false),
  approval: a.enum(['always', 'writes', 'never']).default('writes'),
  prompts: a.boolean().default(true),
  resources: a.boolean().default(true),
  maxTools: a.int().min(1).max(1000).default(200),
  timeout: a.int().min(1000).default(120_000),
});
expectTypeOf<a.infer<typeof McpServerConfig>['transport']>().toEqualTypeOf<
  | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string>; cwd?: string }
  | { type: 'http'; url: string }
  | { type: 'sse'; url: string }
>();

// ============================================================================
// The hub's fn signatures: gin decls → `a` (hub/src/catalog/catalog.ts:252 `signature()`)
// ============================================================================

/**
 * catalog/fixtures.ts:14 `shop`: the named type `shop/Product` (`g.obj({ sku: g.text(), price: g.num({ min: 0 }) })`)
 * and fns whose args are gin decls, as a manifest carries them.
 */
export const ProductDef = { name: 'obj', props: { sku: { type: { name: 'text' } }, price: { type: { name: 'num', options: { min: 0 } } } } } as const;
/** fixtures.ts:23 `shop/get` args. */
export const ShopGetArgsDef = { name: 'obj', props: { sku: { type: { name: 'text' } } } } as const;
/** fixtures.ts:38 `orders/place` args: a named type by name. */
export const OrdersPlaceArgsDef = { name: 'obj', props: { product: { type: { name: 'shop/Product' } }, count: { type: { name: 'num' } } } } as const;

/** The hub's stored types, as the catalog's scope resolves them (`#scopes.parse(…, #storedLookup)`). */
export interface StoredTypes extends GinRegistryLike {}

/**
 * catalog.ts:252 `signature(name)`: the fn's args parsed in the scope of the stored named types, as a value schema
 * with every doc and `unknownKeys: 'refuse'`. In `a`: the args converted once per fn version, the named types the
 * dynamic step (cached by the stored types' version). Built per fn at run time (cached like `#signatures`).
 */
export function signatureOf<const T extends GinTypeDef>(args: T) {
  return a
    .module()
    .dynamic((types: StoredTypes) => ginNamedTypes(types), { key: (types) => types.version })
    .result(fromGin(args) as AnySchema);
}
/** A fn whose args name no stored type: a static signature with its exact code type. */
export const ShopGetArgs = fromGin(ShopGetArgsDef).strict();
expectTypeOf<a.infer<typeof ShopGetArgs>>().toEqualTypeOf<{ sku: string }>();
/** `orders/place`: the named type is a ref, its schema the stored type's. */
export const OrdersPlaceArgs = a
  .declare<{ 'shop/Product': { sku: string; price: number } }>()
  .dynamic((types: StoredTypes) => ginNamedTypes<{ 'shop/Product': { sku: string; price: number } }>(types), { key: (types) => types.version })
  .result(fromGin(OrdersPlaceArgsDef).strict());
expectTypeOf<a.infer<typeof OrdersPlaceArgs>>().toEqualTypeOf<{ product: { sku: string; price: number }; count: number }>();
expectTypeOf(OrdersPlaceArgs.bind).parameters.toEqualTypeOf<[types: StoredTypes]>();

// ============================================================================
// The hub's structured answers (hub/src/models/structured.ts `structuredAnswer`)
// ============================================================================

/** chat/suggestions.ts:46 */
const DecisionItem = a.object({
  name: a.string().describe('The candidate\'s key (kind:name), exactly as given.'),
  reason: a.string().optional().describe('Why, in under 12 words.'),
});
/** chat/suggestions.ts:53 */
export const DecisionAnswer = a.object({
  picks: a.array(DecisionItem).describe('The candidates that clearly help with the latest message.'),
  declined: a.array(DecisionItem).optional().describe('Candidates left out, when there is a reason worth keeping.'),
});
/** chat/suggestions.ts:350 */
export const SystemDecisionAnswer = a.object({
  picked: a.array(a.object({
    id: a.string().describe('The candidate\'s id, exactly as given.'),
    why: a.string().optional().describe('Why it answers what is wanted, in under 15 words.'),
  })).describe('The candidates that fully answer what is wanted, best first; none when none does.'),
  note: a.string().optional().describe('When none is picked, why.'),
});
/** fns/auto.ts:24 */
export const Verdict = a.object({
  allow: a.boolean().describe('Whether it may go ahead without asking.'),
  reason: a.string().describe('One short sentence the person will read.'),
});
/** fns/decided.ts:72,78 */
const JudgedItem = a.object({
  name: a.string().describe('The hit\'s name, exactly as given.'),
  reason: a.string().optional().describe('Why, in under 12 words.'),
});
export const FilterAnswer = a.object({
  keep: a.array(JudgedItem).describe('The hits that fit what the search is for.'),
  dropped: a.array(JudgedItem).optional().describe('Hits left out, when there is a reason worth keeping.'),
});
expectTypeOf<a.infer<typeof DecisionAnswer>>().toEqualTypeOf<{ picks: { name: string; reason?: string }[]; declined?: { name: string; reason?: string }[] }>();
expectTypeOf<a.infer<typeof SystemDecisionAnswer>>().toEqualTypeOf<{ picked: { id: string; why?: string }[]; note?: string }>();
expectTypeOf<a.infer<typeof Verdict>>().toEqualTypeOf<{ allow: boolean; reason: string }>();
expectTypeOf<a.infer<typeof FilterAnswer>>().toEqualTypeOf<{ keep: { name: string; reason?: string }[]; dropped?: { name: string; reason?: string }[] }>();

/** A gin type of `g.record` (core/src/gin-record.ts:40 `RecordType`, `{ name: 'record', generic: { V } }`). */
export const RecordGinDef = { name: 'record', generic: { V: { name: 'list', generic: { V: { name: 'num' } } } } } as const;
/** A `g.fnName()` field, as its gin decl travels (`{ name: 'text', options: { pattern: FN_NAME_PATTERN } }`). */
export const InspectArgsDef = {
  name: 'obj',
  props: { name: { type: { name: 'text', options: { pattern: FN_NAME_PATTERN } } }, detail: { type: { name: 'optional', generic: { T: { name: 'enum', options: { values: { listed: 'listed', signature: 'signature', full: 'full' } } } } } } },
} as const;

/** Bound helpers for tests. */
export type AnyBound = Bound<unknown>;
