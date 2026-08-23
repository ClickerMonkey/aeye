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
| `allowRootRef` / `allowDefsRef` | Whether `$ref: '#'` / `$ref: '#/$defs/X'` are permitted. Under `allowDefsRef: false` the emitter never produces a `$defs` section at all: a shared node is **inlined** at each use site, and a non-root cycle takes the bounded placeholder (`supportsRecursion` alone does not license a `$ref` the descriptor cannot spell). |
| `anyEncoding` | How `z.any()` / `z.unknown()` is emitted — see below. |
| `supportedStringFormats` | `'all'` or a `Set<string>` whitelist. |
| `supportsRecursion` | Whether `$ref` self-reference works. |
| `maxStrictTools` / `maxStrictOptionalParams` / `maxStrictUnionTypes` | Per-request slot budgets (`undefined` = no documented limit). |
| `schemaSizeLimits` | Per-SCHEMA size ceilings — properties, nesting, total string characters, enum values (`undefined` = no documented limit) — see below. |
| `maxEnumValues` | Opt-in ceiling on how many values ONE emitted `enum` may carry (`undefined` = no cap). `GOOGLE_STRICT`/`GOOGLE_NON_STRICT` declare 40, a MEASURED response to a real provider rejection; every other built-in declares none — see below. |

### `schemaSizeLimits` — how BIG one strict schema may be

Separate from the per-request slot budgets above: every bound here is a **sum over ONE schema** (one tool's `parameters`, or one structured-output schema), so no other item in the request can change the verdict. `SchemaBudget` therefore treats an over-size schema as a feasibility failure rather than a budget one — that single item degrades to the family's non-strict descriptor **even when it asked for `strict: true`**, and the rest of the request is untouched.

```typescript
interface SchemaSizeLimits {
  maxObjectProperties: number;      // summed over every nesting level
  maxNestingDepth: number;          // levels of nested containers below the root
  maxTotalStringChars: number;      // property names + enum values + const values
  maxTotalEnumValues: number;       // summed across every enum property
  largeEnumValueCount: number;      // the single-enum value count above which…
  maxLargeEnumStringChars: number;  // …that one enum's string values are also bounded
}
```

**`OPENAI_STRICT` is the only built-in that declares them**, because Structured Outputs is the only one of the three dialects that documents them. Verified against developers.openai.com "Supported schemas" on 2026-08-23: *"A schema may have up to 5000 object properties total, with up to 10 levels of nesting"*, *"total string length of all property names, definition names, enum values, and const values cannot exceed 120,000 characters"*, *"A schema may have up to 1000 enum values across all enum properties"*, and *"For a single enum property with string values, the total string length of all enum values cannot exceed 15,000 characters when there are more than 250 enum values"*. Every one of those was raised in July 2025 (100→5000 properties, 15,000→120,000 characters, 500→1000 enum values, 7,500→15,000 for the >250-value enum); the pre-raise numbers are still widely quoted secondhand.

Scope is Structured Outputs — a tool carrying `strict: true`, or a `json_schema` response format. Non-strict function calling is best-effort with no compiled decoder, which is exactly why degrading the offending item is a complete answer rather than a partial one.

`checkSchemaSizeLimits(schema, descriptor)` is the public form and returns one line per bound broken (empty = it fits, or the dialect publishes none) — the answer to "why did my tool silently stop being strict?".

The measurement is taken from the **Zod** schema rather than from the emitted JSON, so where an encoding is descriptor-dependent it counts the widest one (a record as its `{key, value}` pair form, a tuple as its numeric-key form). Over-counting costs strictness on a schema that would have fitted; under-counting costs an HTTP 400, so the rounding goes up. `$defs` entry names are not counted: they are generated at emit time, few, and short against a 120,000-character budget.

### `maxEnumValues` — an opt-in dialect ceiling that WIDENS, and why only Google sets one

Some providers may reject a schema whose `enum` is simply too long. That is **not** one of the per-request budgets above: those are strict-mode allowances the `SchemaBudget` spends across a whole request, degrading an item that no longer fits to the family's non-strict descriptor, whereas this one would fire whatever the strictness, so it is enforced structurally at the point an `enum` is emitted.

Over the cap the emitter **widens** — it does not truncate. It drops the `enum` keyword, emits the node's plain scalar `type`, and puts **every** value into the `description`:

```jsonc
// z.enum([...20 values]) under a descriptor with maxEnumValues: 8
{ "type": "string", "description": "One of these 20 values: name_0, name_1, …, name_19" }
```

Truncating would make the values past the cap **unreachable** — the wire schema would constrain them away, so a caller whose 96 values are all legitimately selectable would lose 56 of them. Widening removes only the cardinality the dialect cannot compile, and the model keeps complete information. If the source schema carries its own `.describe()`, the value list is appended to it rather than replacing it.

The trade is enforcement: a widened node no longer rejects a value structurally, so whatever validates the model's output afterwards must. `Tool.parse` does — it runs against the ORIGINAL zod schema, whose `enum` is untouched — so a hallucinated member comes back as a normal, re-promptable validation error.

**`GOOGLE_STRICT`/`GOOGLE_NON_STRICT` declare `maxEnumValues: 40`. Every other built-in declares no cap.** The field exists because a large `enum` was believed to make Gemini answer `400 INVALID_ARGUMENT`. An initial round of measurement against `google/gemini-3-flash-preview` through OpenRouter (2026-08-23) looked like it disproved that: single-parameter enums at 50/64/72/80/96/128/256/512/1024/**2048** SYNTHETIC values (`name_0`, `name_1`, …) all returned HTTP 200, as did an eleven-tool roster modelled on a real kind-authoring agent with a 96-value enum on one tool.

**That conclusion was wrong, because none of it used the CONTENT of a real session.** A third round replayed the exact wire bytes of an actual product request — `fn_load`'s `names` array, enum-constrained to a real session's 98 known component/fn names (`default_renderer`, `QueryWidget`, `ConfirmPrompt`, `list_widget_types`, …) — and it 400'd, reproducibly, twice, byte-for-byte identical to what was actually sent. Bisecting that real value list: 90 values passes, 93 fails. Bisecting what differs from the earlier synthetic probes: 98 SHORT synthetic values (284 total characters) pass; 206 short values matching the real list's total character count (714 characters) also pass; only the real, longer, identifier-shaped values fail, and only past ~92 of them. So the limit tracks neither raw member count nor total character/byte budget — most likely actual tokenized grammar-state count, which short repetitive synthetic strings compress far below what real identifier text does at the same count or character budget. This is why the first two rounds' synthetic and lightly-realistic probes never tripped it.

The widen-to-string fallback this field triggers was verified against the exact failing real schema: dropping `enum` and putting the same 98 values into the `description` of a plain string field returned HTTP 200 with the expected tool call — confirming the fallback mechanism actually fixes the failure it exists for, not just a synthetic stand-in.

`40` is not a measured edge — it is a conservative floor with roughly 2x margin under the real one (90 passes / 93 fails) measured on this one real value set. Given the failure tracks content, not just count, a different session's actual name list could plausibly fail at a different count; 40 was also the cap the product that surfaced this ran under in production for months, which is corroborating evidence it holds in practice, not just in this one measurement.

The reliability comparison from the earlier rounds still stands and is why a cap is preferable to leaving every enum uncapped "to be safe" at a much lower number: `enum` vs plain-string-with-full-list, 10 trials each over confusable near-duplicate names at 96 and 512 values, scored 10/10 on-target with zero off-list answers for BOTH encodings. So there is no reliability cost to raising this cap later if a higher safe value is measured — only downside risk to leaving it too high.

One trap for whoever measures this next: with `max_tokens` at 64, a forced-tool probe can come back `finish_reason: "length"` with no tool call and empty content, which reads exactly like a grammar that produced nothing. It usually is not — this model spends reasoning tokens first. Give a forced-tool probe room before calling an empty completion a failure.

So: **set this only where a provider is MEASURED to reject a large enum using the SESSION'S OWN real content, not synthetic stand-ins, and set it conservatively below the measured edge until more value sets are tested.** An `enum` that fits is the more correct encoding, because it is the one the model cannot answer outside of.

### `anyEncoding` — and what each mode requires

An open "any JSON value" slot has no single portable spelling, so each dialect picks one. **Each mode needs keywords the same descriptor has to allow**, and `checkDescriptorConsistency` enforces that pairing:

| Mode | Shape | Requires |
|------|------|------|
| `'recursive-strict'` | `$defs/Any` with array-of-pairs records (OpenAI strict has no open objects) | `allowAnyOf`, `allowDefsRef`, `supportsRecursion` |
| `'recursive-open'` | `$defs/Any` with `additionalProperties: <self>` | `allowAnyOf`, `allowDefsRef`, `supportsRecursion` |
| `'flat'` | inline non-recursive `anyOf` over every JSON type | `allowAnyOf` |
| `'unconstrained'` | the empty schema `{}` (plus any `description`) | nothing |

`'unconstrained'` is the only mode available to a dialect that forbids combinators **and** named `$defs` (Google). Per JSON Schema a schema with no assertion keywords validates every instance, which is exactly what "any value" means — so it is lossless as a constraint, and the source schema's `description` still rides along as the human/model-facing signal.

## Built-in descriptors

Seven ship frozen and pre-registered:

| Export | Family / Strict | Notes |
|------|------|-------|
| `OPENAI_STRICT` | openai / strict | records→array-of-pairs, tuples→numeric-key objects, `optional → T \| null`, closed objects, restricted format whitelist. |
| `ANTHROPIC_STRICT` | anthropic / strict | closed objects, no recursion, no length/range constraints; budgets 20 tools / 24 optional params / 16 unions. |
| `GOOGLE_STRICT` | google / strict | `prefixItems`, `$ref: '#'` recursion, `propertyOrdering`, restricted format whitelist, `z.any()` → `unconstrained` (Gemini forbids `anyOf` and named `$defs`). |
| `LENIENT` | lenient / non-strict | No rewrites; everything passes through. Default for unannotated models. |
| `OPENAI_NON_STRICT`, `ANTHROPIC_NON_STRICT` | family / non-strict | Aliased to `LENIENT` but tagged with the family for diagnostics. |
| `GOOGLE_NON_STRICT` | google / non-strict | `LENIENT` **except** `anyEncoding: 'unconstrained'`. Gemini compiles a decoding grammar whenever a tool call is forced, and rejects a self-referencing `$defs/Any` when it does — which has nothing to do with a per-tool strict flag (Google's function-calling API has none), so the encoding belongs to the dialect. |

## Functions

```typescript
toJSONSchema(schema: z.ZodType,
  options: ToJSONSchemaOptions | boolean | FormatDescriptor): JSONSchema
strictify<S extends z.ZodType>(schema: S, descriptor?: FormatDescriptor): S   // default OPENAI_STRICT
analyzeSchema(schema): SchemaFeatures
registerDescriptor(descriptor: FormatDescriptor): void
checkDescriptorConsistency(descriptor: FormatDescriptor): string[]   // [] when consistent
getDescriptor(family: DescriptorFamily, strict: boolean): FormatDescriptor
getDescriptorById(id: string | undefined): FormatDescriptor
hasDescriptorFamily(family: string | undefined): boolean
resolveDescriptor(options: ToJSONSchemaOptions | boolean | FormatDescriptor): FormatDescriptor
strictestOf(a, b): FormatDescriptor
strictPriority(requested: boolean | number | undefined): number
```

- `toJSONSchema` accepts a descriptor, a `ToJSONSchemaOptions` object, or a boolean (back-compat: `true` ⇒ `OPENAI_STRICT`, `false` ⇒ `LENIENT`).
- `strictify` rewrites a Zod schema in place per the descriptor (results cached in a WeakMap; same OOM-safe pattern as `analyzeSchema`).
- `analyzeSchema` returns `SchemaFeatures`: `{ hasRecursion, optionalParameterCount, unionTypeCount, recordCount, tupleCount, enums, objectPropertyCount, maxNestingDepth, stringSizeChars }` — cached per schema. The last four feed `schemaSizeLimits`; `enums` keeps a per-enum `{valueCount, stringValueChars}` breakdown because the large-enum character rule is conditional on that SAME enum's value count, which a pair of totals cannot answer.
- `checkSchemaSizeLimits(schema, descriptor)` reports the per-schema size bounds a schema breaks (see `schemaSizeLimits`).
- `checkDescriptorConsistency` reports settings that ask the emitter for a keyword the same descriptor forbids (`anyEncoding` vs `allowAnyOf` / `allowDefsRef` / `supportsRecursion`), or a limit that would quietly stop governing anything: a `maxEnumValues` below 1 or non-integer (which widens every enum the dialect emits), a non-positive `schemaSizeLimits` bound (which degrades every schema), a `largeEnumValueCount` at or above `maxTotalEnumValues` (unreachable rule), or size limits on a non-strict descriptor (the API applies none). `registerDescriptor` runs it and `console.warn`s each problem, because otherwise the first report of a contradiction is a provider HTTP 400.

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
budget.allocateTool(schema, requested): FormatDescriptor   // returns strict or the family's non-strict, decrements
budget.allocateOutput(schema, requested): FormatDescriptor // output schema; consumes param/union budget, not a tool slot
```

It falls back when `requested === false`, when the schema uses an unrepresentable feature, when the schema exceeds the dialect's `schemaSizeLimits`, or when a positive-number request can't fit the remaining budget (priority order; `true` always wins subject to *budget*, never subject to feasibility or size).

**The fallback is the descriptor's own family, non-strict — never the family-blind `LENIENT`.** A dialect rule can outlive strict mode: `GOOGLE_NON_STRICT` exists for exactly one such rule, the `unconstrained` encoding of `z.any()`, because Gemini compiles a decoding grammar whenever a tool call is forced and no per-tool `strict` flag is involved. Degrading to `LENIENT` put the self-referencing `$defs/Any` that encoding was created to avoid straight back on the Google wire — and did so for *every* schema that degrades, which under `GOOGLE_STRICT` (`allowAnyOf: false`) is every recursive gin/query program schema there is. For the other families the change is behaviour-neutral by construction: `OPENAI_NON_STRICT` / `ANTHROPIC_NON_STRICT` are `LENIENT` with a family tag, and a family that registers no non-strict variant resolves to `LENIENT`. Only the `descriptor` id pinned on the tool differs, and it round-trips through `getDescriptorById`.

"Unrepresentable" here means a **combinator the descriptor forbids** (`z.union` → `anyOf`, `z.intersection` → `allOf`), because nothing rewrites those away — a schema carrying one under `GOOGLE_STRICT` is a provider HTTP 400. **Recursion is not unrepresentable**: the emitter replaces any back-edge the descriptor cannot spell with a bounded placeholder, so a recursive schema stays strict (looser at the back-edge, never rejected). That is the difference between this check and `canExpress`, which additionally treats a widened back-edge as a reason to fall back — the right answer for a structured *output* (it can be delivered as prompt text instead) and the wrong one for a *tool* (it cannot).

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
