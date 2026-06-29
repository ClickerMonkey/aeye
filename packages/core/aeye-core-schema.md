# @aeye/core — Schema & strict mode

`src/schema.ts` converts Zod schemas to provider-correct JSON Schema. Each LLM provider implements strict structured output / strict tool args with its *own* JSON-Schema dialect; a `FormatDescriptor` captures one dialect, so a single Zod schema can target all of them. Most apps never call these directly — `@aeye/ai` selects and applies a descriptor per request — but provider authors and advanced users do.

## The `strict` policy (tri-state)

`Tool.strict` and `Prompt.strict` (and `ToolDefinition.strict` / `ResponseFormat.strict`) are `boolean | number`:

| Value | Meaning |
|------|---------|
| `true` | **Require** strict. `@aeye/ai` filters model selection to strict-capable models; fails if none qualify. |
| `false` | **Force** lenient. Standard JSON Schema, no `strict: true` on the wire. |
| `number > 0` (default `1`) | **Prefer** strict, accept fallback. Higher number = higher priority when more strict items are requested than the model's per-request budget allows. |
| omitted | Treated as `1`. |

Default `1` keeps things working against unannotated models. Use `true` only when strict is non-negotiable.

## `FormatDescriptor`

A descriptor (see `src/schema.ts` line ~26 for the fully documented interface) describes how to emit JSON Schema for one dialect. Key fields:

| Field | Controls |
|------|----------|
| `id` | Unique id; pinned onto `request.responseFormat.descriptor` / `ToolDefinition.descriptor` so the validator can re-resolve it. |
| `family` | `'openai' \| 'anthropic' \| 'google' \| (string & {})`. |
| `objectAllFieldsRequired` | Whether every property must appear in `required[]`. |
| `objectClosedByDefault` | Whether objects emit `additionalProperties: false`. |
| `recordEncoding` | `'array-of-pairs'` vs `'open-record'`. |
| `tupleEncoding` | `'object-numeric-keys'` vs `'prefix-items'` vs `'items-union'`. |
| `optionalAsNullable` | Emit optionals as `T \| null` (OpenAI strict) vs drop from `required[]`. |
| `allowAllOf` / `allowAnyOf` / `allowOneOf` | Combinator support. |
| `supportedStringFormats` | `'all'` or a `Set<string>` whitelist. |
| `supportsRecursion` | Whether `$ref` self-reference works. |
| `maxStrictTools` / `maxStrictOptionalParams` / `maxStrictUnionTypes` | Per-request slot budgets (`undefined` = no documented limit). |

## Built-in descriptors

Seven ship frozen and pre-registered:

| Export | Family / Strict | Notes |
|------|------|-------|
| `OPENAI_STRICT` | openai / strict | records→array-of-pairs, tuples→numeric-key objects, `optional → T \| null`, closed objects, restricted format whitelist. |
| `ANTHROPIC_STRICT` | anthropic / strict | closed objects, no recursion, no length/range constraints; budgets 20 tools / 24 optional params / 16 unions. |
| `GOOGLE_STRICT` | google / strict | `prefixItems`, `$ref: '#'` recursion, `propertyOrdering`, restricted format whitelist. |
| `LENIENT` | lenient / non-strict | No rewrites; everything passes through. Default for unannotated models. |
| `OPENAI_NON_STRICT`, `ANTHROPIC_NON_STRICT`, `GOOGLE_NON_STRICT` | family / non-strict | Aliased to `LENIENT` but tagged with the family for diagnostics. |

## Functions

```typescript
toJSONSchema(schema: z.ZodType,
  options: ToJSONSchemaOptions | boolean | FormatDescriptor): JSONSchema
strictify<S extends z.ZodType>(schema: S, descriptor?: FormatDescriptor): S   // default OPENAI_STRICT
analyzeSchema(schema): SchemaFeatures
registerDescriptor(descriptor: FormatDescriptor): void
getDescriptor(family: DescriptorFamily, strict: boolean): FormatDescriptor
getDescriptorById(id: string | undefined): FormatDescriptor
hasDescriptorFamily(family: string | undefined): boolean
resolveDescriptor(options: ToJSONSchemaOptions | boolean | FormatDescriptor): FormatDescriptor
strictestOf(a, b): FormatDescriptor
strictPriority(requested: boolean | number | undefined): number
```

- `toJSONSchema` accepts a descriptor, a `ToJSONSchemaOptions` object, or a boolean (back-compat: `true` ⇒ `OPENAI_STRICT`, `false` ⇒ `LENIENT`).
- `strictify` rewrites a Zod schema in place per the descriptor (results cached in a WeakMap; same OOM-safe pattern as `analyzeSchema`).
- `analyzeSchema` returns `SchemaFeatures`: `{ hasRecursion, optionalParameterCount, unionTypeCount, recordCount, tupleCount }` — cached per schema.

```typescript
import { OPENAI_STRICT, ANTHROPIC_STRICT, getDescriptor, toJSONSchema } from '@aeye/core';

const schema = z.object({
  name: z.string(),
  tags: z.record(z.string(), z.string()),
});

toJSONSchema(schema, OPENAI_STRICT);                 // tags → array of {key, value}
toJSONSchema(schema, ANTHROPIC_STRICT);              // tags → array of {key, value}
toJSONSchema(schema, getDescriptor('google', true)); // tags → standard additionalProperties
toJSONSchema(schema, true);                          // === OPENAI_STRICT
toJSONSchema(schema, false);                         // === LENIENT
```

## `SchemaBudget`

`new SchemaBudget(descriptor)` allocates strict "slots" across a single request when a descriptor has per-request limits (e.g. Anthropic). Providers call:

```typescript
budget.allocateTool(schema, requested): FormatDescriptor   // returns strict or LENIENT, decrements
budget.allocateOutput(schema, requested): FormatDescriptor // output schema; consumes param/union budget, not a tool slot
```

It returns `LENIENT` when `requested === false`, when the schema uses an unrepresentable feature, or when a positive-number request can't fit the remaining budget (priority order; `true` always wins subject to feasibility).

## Registering a custom descriptor

```typescript
import { registerDescriptor, type FormatDescriptor, OPENAI_STRICT } from '@aeye/core';

const MY_PROVIDER_STRICT: FormatDescriptor = {
  ...OPENAI_STRICT,                 // start from a known-good baseline
  id: 'my-provider-strict',
  family: 'openai',
  recordEncoding: 'open-record',    // override only the deltas
  tupleEncoding: 'prefix-items',
  supportsRecursion: true,
};

registerDescriptor(MY_PROVIDER_STRICT);
```

Once registered, `toJSONSchema(schema, MY_PROVIDER_STRICT)` / `strictify(...)` work, and the Prompt/Tool validation roundtrip resolves `'my-provider-strict'` by id from the request.

## Gotchas

- `ToolDefinition.parameters` and `ResponseFormat.type` stay **raw Zod**. The matching `strictify` is applied *lazily* by the provider once it knows the model's descriptor, then pinned via `descriptor` id so the validator (`Tool.parse` / Prompt output validation) matches the exact wire shape the model saw.
- Strict dialects drop features they can't represent (Anthropic: no recursion, no numeric ranges). If a feature matters, check `analyzeSchema` against the descriptor or force `strict: false`.
- The `JSONSchema` / `JSONSchemaType` / `ToJSONSchemaOptions` / `DescriptorFamily` types are exported for tooling.
