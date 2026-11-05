# Schema dialects per provider (research, 2026-11-04)

Purpose: tell the library which JSON Schema keywords and limits each provider family accepts for
(a) strict tool calling, (b) non-strict tools, (c) structured output, so the emitted schema doesn't get an HTTP 400.

Every source below was read on **2026-11-04**. "Not documented" means the official page doesn't mention it. Treat these as UNKNOWN and keep the conservative choice.

Sources (short keys used in the tables):

| Key | URL |
|---|---|
| OAI-SO | https://developers.openai.com/api/docs/guides/structured-outputs |
| OAI-FC | https://developers.openai.com/api/docs/guides/function-calling |
| ANT-SO | https://platform.claude.com/docs/en/build-with-claude/structured-outputs |
| GEM-SO | https://aistudio.google.com/docs/structured-output (ai.google.dev now 301-redirects here) |
| GEM-FC | https://aistudio.google.com/docs/function-calling |
| GEM-REF | https://aistudio.google.com/api-reference/caching (Schema / FunctionDeclaration reference) |
| GEM-BLOG | https://blog.google/technology/developers/gemini-api-structured-outputs/ (2025-11-05) |
| GEM-OAI | https://aistudio.google.com/docs/openai |
| VTX | https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/control-generated-output |
| XAI-SO | https://docs.x.ai/docs/guides/structured-outputs |
| OR-SO | https://openrouter.ai/docs/guides/features/structured-outputs |
| OR-TC | https://openrouter.ai/docs/guides/features/tool-calling |
| OR-PARAM | https://openrouter.ai/docs/api/reference/parameters |
| OR-ROUTE | https://openrouter.ai/docs/guides/routing/provider-selection |
| DS-JSON | https://api-docs.deepseek.com/guides/json_mode |
| DS-TOOL | https://api-docs.deepseek.com/guides/tool_calls |
| QWEN | https://www.alibabacloud.com/help/en/model-studio/qwen-structured-output |
| MIS-API | https://docs.mistral.ai/api/endpoint/chat |
| MIS-SO | https://docs.mistral.ai/capabilities/structured-output/custom_structured_output/ |
| GROQ | https://console.groq.com/docs/structured-outputs |
| CBR | https://inference-docs.cerebras.ai/capabilities/structured-outputs |
| TOG | https://docs.together.ai/docs/json-mode |
| FW | https://docs.fireworks.ai/structured-responses/structured-response-formatting |
| DI | https://docs.deepinfra.com/chat/structured-outputs |
| KIMI | https://platform.kimi.ai/docs/guide/use-json-mode-feature-of-kimi-api (platform.moonshot.ai redirects here) |
| ZAI | https://docs.z.ai/guides/capabilities/struct-output |

---

## 1. OpenAI (Structured Outputs + strict function calling)

Model support: `json_schema` works on gpt-4o-2024-08-06, gpt-4o-mini and later. gpt-4-turbo and older models get `json_object` only [OAI-SO]. The guides list no keyword differences between reasoning models (o-series, gpt-5.x) and gpt-4.1/4o. The only model-specific schema rule is for **fine-tuned models**, which reject `minLength, maxLength, pattern, format, minimum, maximum, multipleOf, patternProperties, minItems, maxItems` [OAI-SO].

| Keyword / rule | Status | Src |
|---|---|---|
| root | must be `type: object`, not `anyOf` | OAI-SO |
| `additionalProperties` | must be `false` on every object | OAI-SO, OAI-FC |
| `required` | every property must be listed. Make a field optional with a `["T","null"]` type array or a union with null | OAI-SO, OAI-FC |
| `anyOf` | yes, but not at the root, and each branch must be valid under the subset | OAI-SO |
| `allOf`, `not`, `if/then/else`, `dependentRequired`, `dependentSchemas` | **unsupported** | OAI-SO |
| `oneOf` | not documented (not listed as supported or unsupported). Treat as unsupported | OAI-SO |
| `$defs` + `$ref` | yes | OAI-SO |
| root `$ref: "#"` recursion | yes (documented example) | OAI-SO |
| recursion via `$defs` | yes | OAI-SO |
| `const` | yes (counted in the 120k character budget) | OAI-SO |
| `enum` | yes | OAI-SO |
| string `pattern` | yes | OAI-SO |
| string `format` | `date-time, time, date, duration, email, hostname, ipv4, ipv6, uuid` | OAI-SO |
| `minLength`/`maxLength` | not in the base list. The doc names them only as **unsupported for fine-tuned models**, which implies base models accept them | OAI-SO |
| `minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf` | yes | OAI-SO |
| `minItems`/`maxItems` | yes | OAI-SO |
| `patternProperties` | the doc names it only as unsupported for fine-tuned models | OAI-SO |
| key order | output follows schema key order | OAI-SO |

Limits [OAI-SO]: 5,000 object properties in total; 10 levels of nesting; 120,000 characters total across property names, definition names, enum values and const values; 1,000 enum values in total; a single string enum with more than 250 values is capped at 15,000 characters.

Tools [OAI-FC]:
- **Responses API**: "Responses requests will attempt to normalize your schema into strict mode when possible". So function tools are strict **by default** unless you send `strict: false`.
- **Chat Completions**: "remain non-strict by default".
- If `strict: true` and the schema is invalid, the request "will be rejected with details about the missing constraints".
- The guide doesn't exclude gpt-5.x from `strict` tools. Strict works with parallel calls ("beginning with GPT-5, functions can be called in parallel"). For fine-tuned models, strict is disabled when the model calls several functions in one turn. For `gpt-4.1-nano-2025-04-14`, the guide recommends disabling parallel calls.
- GPT-6 Astra / GPT-6.1 Sol need the Responses API for tool calling. `tool_search` / deferred loading needs gpt-5.4 or later.
- Custom tools take a CFG: `lark` or `regex` syntax. Lark lookarounds, lazy modifiers and non-`%import common` imports aren't supported. A regex must fit on one line. A grammar that's too complex returns an error.
- Non-strict tools: any JSON Schema is accepted, with no constrained decoding. The guide gives no keyword list. Its soft guidance is to keep fewer than 20 functions available.
- JSON mode (`json_object`): the word "JSON" must appear in the context, or the API errors [OAI-SO].

## 2. Anthropic (structured outputs `output_config.format` + `strict: true` tools)

Models (page metadata) [ANT-SO]: claude-fable-5-1, claude-mythos-5-1, claude-fable-5, claude-mythos-5, claude-mythos-preview, claude-opus-5-5, claude-opus-5, claude-sonnet-5-5, claude-sonnet-5, claude-haiku-5-5, claude-haiku-4-5-20251001, claude-opus-4-8/4-7/4-6, claude-sonnet-4-6, claude-opus-4-5-20251101, claude-sonnet-4-5-20250929. The old `output_format` parameter is deprecated: it needs beta header `structured-outputs-2025-11-13`, or the API returns 400.

| Keyword / rule | Status | Src |
|---|---|---|
| types | object, array, string, integer, number, boolean, null | ANT-SO |
| `enum` | primitives only (string/number/bool/null), no complex types | ANT-SO |
| `const` | yes | ANT-SO |
| `anyOf` | yes | ANT-SO |
| `allOf` | yes, **but not `allOf` combined with `$ref`** | ANT-SO |
| `oneOf` | not documented. Treat as unsupported | ANT-SO |
| `$ref` / `$defs` / `definitions` | yes. External `$ref` isn't supported | ANT-SO |
| recursion | **not supported** | ANT-SO |
| root `$ref` | not documented. Keep "no" | ANT-SO |
| `default` | yes | ANT-SO |
| `required` | yes. Optional fields are allowed but count toward the limit below | ANT-SO |
| `additionalProperties` | must be `false` (any other value returns 400) | ANT-SO |
| `format` | `date-time, time, date, duration, email, hostname, uri, ipv4, ipv6, uuid` | ANT-SO |
| `pattern` | yes. Supported: anchors, `* + ?`, simple `{n,m}`, `[] . \d \w \s`, groups. **No** backreferences, lookaround, `\b \B`, or large `{n,m}` ranges. Complex patterns may return 400 | ANT-SO |
| `minLength`/`maxLength` | **unsupported** | ANT-SO |
| `minimum/maximum/multipleOf` | **unsupported** | ANT-SO |
| `minItems` | only 0 or 1. All other array constraints are unsupported | ANT-SO |
| `prefixItems` | not documented. Keep "no" | ANT-SO |

Limits [ANT-SO]. All of these count across every strict schema in the request:
- 20 strict tools per request (non-strict tools don't count).
- 24 optional parameters in total.
- 16 parameters with union types (`anyOf` or type arrays) in total.
- An internal grammar size limit returns 400 "Schema is too complex for compilation".
- Compilation times out after 180 seconds.

Unsupported features return 400 with details. Non-strict tools: any JSON Schema, not grammar-enforced.

## 3. Google Gemini

API surface note: the Gemini docs moved from ai.google.dev to aistudio.google.com (301). The structured-output guide now shows the **Interactions API** (`POST /v1beta/interactions`, `response_format: {type:"text", mime_type:"application/json", schema:{...}}`, header `Api-Revision: 2026-05-20`) [GEM-SO]. On `generateContent`, `responseJsonSchema` (JSON Schema) and `parametersJsonSchema` are "mutually exclusive" with `responseSchema` / `parameters` (the OpenAPI subset) [GEM-REF, GEM-BLOG].

| Keyword | responseJsonSchema / parametersJsonSchema | responseSchema (OpenAPI subset) | Src |
|---|---|---|---|
| types | string, number, integer, boolean, object, array, null (via type array) | type + `nullable` | GEM-SO, GEM-REF |
| `title`, `description` | yes | yes | GEM-SO, GEM-REF |
| `properties`, `required` | yes | yes | GEM-SO, GEM-REF |
| `additionalProperties` | yes | not in field list | GEM-SO, GEM-BLOG |
| `enum` | yes. No count limit documented, but "Trim large enum lists" | strings only (Vertex) | GEM-SO, VTX |
| `format` | `date-time, date, time` (AI Studio examples). Vertex also lists `duration` | same | GEM-SO, VTX |
| `minimum`/`maximum` | yes | yes | GEM-SO, GEM-REF |
| `items`, `prefixItems` | yes | `items` only | GEM-SO, GEM-BLOG |
| `minItems`/`maxItems` | yes, **enforced** (and each counted position duplicates the item schema in the grammar) | yes | GEM-SO, GEM-FC |
| `anyOf` | yes | yes | GEM-SO, GEM-REF |
| `oneOf`, `allOf` | not documented | not listed | GEM-SO |
| `$ref`/`$defs` | yes | not listed | GEM-SO, GEM-BLOG |
| recursion | yes, but the recursive reference must be optional or nullable. "Avoid recursing through required properties or arrays with minItems greater than zero" | n/a | GEM-SO, GEM-FC |
| `pattern` | not documented | in Schema field list | GEM-REF |
| `minLength, maxLength, minProperties, maxProperties, uniqueItems, contains, minContains, maxContains` | **silently stripped, not rejected** | `minLength/maxLength/minProperties/maxProperties` listed | GEM-SO, GEM-REF |
| `propertyOrdering` | not needed: key order is preserved on Gemini 2.5 and later, and on the OpenAI-compat API | supported. Without it, Vertex orders keys alphabetically with required keys first | GEM-BLOG, VTX |

Limits: no numbers are published. The schema compiles to a state machine with limits on total states, branching and nesting depth; going over returns `400 INVALID_ARGUMENT` [GEM-SO, GEM-FC]. Optional properties, enum values and `anyOf` branches multiply the branching, and long property keys cost states [GEM-FC]. The docs advise keeping 10-20 active tools [GEM-FC]. Vertex: unsupported fields are ignored; the schema counts toward input tokens [VTX].

Gemini 2.5 vs 3: the docs show no keyword differences. Gemini 3 adds structured output combined with function calling (preview) [GEM-SO, GEM-FC]. Tool strictness comes from `function_calling_config` mode `VALIDATED` ("Model ensures function schema adherence") [GEM-FC]. There is no per-tool `strict` flag.

OpenAI-compatible endpoint: `beta.chat.completions.parse` with a Pydantic `response_format` works, and tools work. The page documents no schema rules or `strict` semantics [GEM-OAI]. Assume the same subset as `responseJsonSchema`.

## 4. xAI Grok

Models: Grok 4 family (examples use grok-4.7). Structured outputs combined with tools are "only available for supported Grok 4 family models" [XAI-SO].

| Keyword | Status | Src |
|---|---|---|
| types | string, number, integer, boolean, null, enum, const, array, object | XAI-SO |
| `anyOf` | yes | XAI-SO |
| `oneOf` | **yes** | XAI-SO |
| `allOf` | yes with a **single** subschema. Multiple subschemas are best-effort | XAI-SO |
| `$ref`/`$defs` | non-circular only (no recursion) | XAI-SO |
| `format` enforced | `date, time, date-time, email, uuid, ipv4, ipv6, uri`. Other formats are accepted but not enforced | XAI-SO |
| `pattern` | ECMA-262 subset with implicit `^...$`, and `.` matches newlines. No backrefs, `\p{..}`, `\b`, lookaround, inline modifiers, or conditionals | XAI-SO |
| `minLength`/`maxLength` | guaranteed up to 2,048 | XAI-SO |
| `minItems`/`maxItems` | guaranteed up to 256 | XAI-SO |
| `minProperties`/`maxProperties` | guaranteed up to 64 | XAI-SO |
| `minimum/maximum/exclusive*` | no limit | XAI-SO |
| `prefixItems` | yes ("use prefixItems for tuple validation"). **Array-form `items` returns 400** | XAI-SO |
| `additionalProperties` | **defaults to false**; must set `true` explicitly | XAI-SO |
| `required` | fields not listed are optional | XAI-SO |
| best-effort only | `not`, `if/then/else`, multi-subschema `allOf`, unknown formats, bounds over the limits above | XAI-SO |
| **400** | empty `enum`/`anyOf`, boolean (`true`/`false`) property schemas, `minContains`/`maxContains`, array-form `items` | XAI-SO |

Tools: "the `strict` flag is implicitly always `true`", so tool args always conform. There are no separate non-strict tools [XAI-SO]. `json_object` is accepted.

## 5. OpenRouter

- Shape: Chat `response_format: {type:"json_schema", json_schema:{name, strict, schema}}`; Responses `text.format: {type:"json_schema", name, strict, schema}` [OR-SO].
- OpenRouter documents no schema transformation or keyword restrictions; it defers to each upstream provider. Strict enforcement "varies"; some providers approximate [OR-SO].
- Support is **per endpoint**. Look for `structured_outputs` in the model's `supported_parameters` ("If the model can return structured outputs using response_format json_schema") [OR-SO, OR-PARAM].
- `require_parameters` (default `false`) routes only to providers that support every parameter. When it's false, a provider "will ignore unknown parameters". However, `tools`, response format and `verbosity` act as soft preferences: if only some providers support one, the request goes only to those; if **none** do, "the parameter is ignored" (silently) [OR-ROUTE].
- Unsupported provider (when required): "The request will fail with an error indicating lack of support" [OR-SO].
- Tools follow the OpenAI shape; "For non-OpenAI providers, it will be transformed accordingly" [OR-PARAM]. The tool-calling guide doesn't mention `strict` [OR-TC].
- **Anthropic upstream**: for json_schema response formats, OpenRouter adds the `structured-outputs-2025-11-13` header automatically. For `strict: true` on tools you must pass that header yourself. "Without this header, OpenRouter will strip the `strict` field and route normally" [OR-ROUTE].
- `json_object` = JSON mode [OR-PARAM]. Response healing is available for non-streaming `json_schema` requests [OR-SO].
- Implication: through OpenRouter, emit the dialect of the **upstream** family (openai/*, anthropic/*, google/*, x-ai/*). For open-weight models, which provider serves the request varies, so use the most conservative dialect, or pin a provider.

## 6. Open-weight families and hosts

| Family / host | json_schema? | strict? | Keyword notes | Src |
|---|---|---|---|---|
| **DeepSeek official** | **no** (only `json_object` is documented; prompt must contain "json"; output can come back as blank content) | strict **tools** in beta, at `base_url=https://api.deepseek.com/beta`; every tool must be `strict:true` | types object/string/number/integer/boolean/array/enum/anyOf. All props required, `additionalProperties:false`. String: `pattern`, `format` ∈ {email, hostname, ipv4, ipv6, uuid}; **no minLength/maxLength**. Number: const, default, min/max, exclusive*, multipleOf. Array: **no minItems/maxItems**. `$def`/`$ref` (doc writes `#/$def/...`), recursion allowed | DS-JSON, DS-TOOL |
| **Qwen (Alibaba Model Studio)** | yes, `strict:true` (Qwen3.7 Plus/Flash/Max, Qwen3.8 Max/Flash) | strict on tools: not documented | Very broad: `$defs/$ref`, `anyOf/oneOf/allOf/not`, `if/then/else`, min/maxLength, pattern, format, min/max/exclusive*, items/prefixItems/min/maxItems/unevaluatedItems, min/maxProperties, dependent*, unevaluatedProperties. **400** on `uniqueItems, contains, min/maxContains, additionalItems, patternProperties, propertyNames, multipleOf`. Thinking mode: no structured output. Multimodal input falls back to json_object. json_object needs "JSON" in the prompt | QWEN |
| **Mistral La Plateforme** | yes (`json_schema` "guarantees ... JSON"); recommended over JSON mode | `strict` field and tool strict not described in the official reference | no keyword list published | MIS-API, MIS-SO |
| **Groq** | yes | strict (constrained) only on `openai/gpt-oss-20b`, `gpt-oss-120b`, `qwen/qwen3.8-27b`, `meta-models/muse-spark-open`; best-effort (default) also on gpt-oss-safeguard-20b | strict: all required, `additionalProperties:false`; documented: anyOf, `$ref`/`$defs`, root `#` recursion, `$defs` recursion; formats/pattern/minLength/minItems/oneOf/allOf undocumented. Best-effort mismatch can return **400** "Generated JSON does not match". **No streaming or tool use** combined with SO. json_object on all models | GROQ |
| **Cerebras** | yes | strict on response_format and on `tools[].function.strict` (qwen-3.8-27b, kimi-k2.7-code, gpt-oss-120b, gemma-4-31b) | yes: types incl. null, enum/const (primitive), non-root anyOf, local non-recursive `$ref/$defs`, `prefixItems` + `items:false`, min/max/exclusive*/multipleOf. **No**: recursion, oneOf, allOf, not, `nullable`, if/then/else, dependent*, patternProperties, unevaluatedProperties, **pattern, format, minItems, maxItems**; min/maxLength not on qwen-3.8-27b strict tools. Root must be an object, not a union; `additionalProperties:false`; every array needs `items`. Limits: 5,000 chars, depth 10, **500 props**, **500 enum values**, 7,500 chars for an enum over 250 values | CBR |
| **Together** | yes (`json_schema`, plus `regex`) | no `strict` documented | no restrictions stated | TOG |
| **Fireworks** | yes (`json_object`, `json_schema`, BNF grammar) | no `strict` documented | broad: anyOf/oneOf/allOf, in-doc `$ref` incl. self/mutual recursion; `pattern` is best-effort (lookaround dropped); external `$ref` unsupported | FW |
| **DeepInfra** | yes (`json_schema` with `strict:true`) | — | no keyword list | DI |
| **Moonshot Kimi (official)** | **no** (only `json_object` documented; object roots only) | — | — | KIMI |
| **Zhipu GLM (Z.ai)** | **no** (only `json_object`, glm-5/4.7/4.6) | — | client-side validation | ZAI |
| **gpt-oss** | host-dependent: strict on Groq and Cerebras | | use the host's dialect | GROQ, CBR |
| **Meta Llama** | host-dependent: Together/Fireworks/DeepInfra json_schema (not strict-guaranteed); not on Groq's strict list | | | TOG, FW, DI, GROQ |

---

## Deltas vs current descriptors

**OPENAI_STRICT**
- All fields required: CONFIRMED [OAI-SO]
- additionalProperties false: CONFIRMED [OAI-SO]
- records as array of pairs / tuples as numeric-key objects: CONFIRMED (no `patternProperties`/open records under strict; `prefixItems` isn't in the supported list) [OAI-SO]
- no allOf: CONFIRMED [OAI-SO]
- no oneOf: UNKNOWN (not documented either way; keep "no")
- anyOf yes (not at root): CONFIRMED [OAI-SO]
- root $ref '#', $defs, recursion: CONFIRMED [OAI-SO]
- formats {date-time,time,date,duration,email,hostname,ipv4,ipv6,uuid}: CONFIRMED [OAI-SO]
- pattern, min/max (+exclusive*, multipleOf), minItems/maxItems: CONFIRMED [OAI-SO]
- minLength/maxLength: UNKNOWN (not listed for base models; named only as unsupported for fine-tuned models). New: **fine-tuned models need a stripped dialect** (no pattern/format/min/max/multipleOf/minItems/maxItems/minLength/maxLength/patternProperties)
- limits 5000 props / 10 depth / 120000 chars / 1000 enum / >250-value enum ≤15000 chars: CONFIRMED [OAI-SO]
- New: Responses API treats tools as strict by default (send `strict:false` to opt out); Chat Completions is non-strict by default [OAI-FC]

**ANTHROPIC_STRICT**
- additionalProperties only false: CONFIRMED [ANT-SO]
- no prefixItems: UNKNOWN (not documented; keep "no")
- allOf yes: CHANGED (qualified): allOf is supported, **but not allOf combined with `$ref`** [ANT-SO]
- anyOf yes: CONFIRMED
- oneOf no: UNKNOWN (not documented; keep "no")
- no root $ref: UNKNOWN (not documented; keep)
- $defs yes, no recursion: CONFIRMED (also accepts `definitions`; no external `$ref`)
- "all formats pass": CHANGED: the docs list exactly `date-time, time, date, duration, email, hostname, uri, ipv4, ipv6, uuid`. Emit only these
- pattern yes: CONFIRMED, with a restricted regex subset (no backrefs, lookaround, `\b`, or large `{n,m}`)
- no minLength/maxLength, no min/max: CONFIRMED (multipleOf also unsupported)
- minItems only 0 or 1: CONFIRMED
- 20 strict tools / 24 optional params / 16 union params: CONFIRMED. Union count includes type arrays like `["string","null"]`. New: grammar-size 400 and 180 s compile timeout

**GOOGLE_STRICT**
- anyOf yes, $defs/$ref yes: CONFIRMED [GEM-SO, GEM-BLOG]
- allOf no / oneOf no: UNKNOWN (not documented; keep "no")
- root ref yes: UNKNOWN (not documented)
- recursion only through optional/nullable (and not through minItems>0 arrays): CONFIRMED [GEM-SO, GEM-FC]
- formats {date-time,date,time}: CONFIRMED (Vertex also lists `duration`)
- pattern no: UNKNOWN (not documented for JSON Schema; the OpenAPI Schema object lists `pattern`)
- minLength/maxLength no: CHANGED (qualified): they are **silently stripped, not rejected**, so emitting them is harmless but unenforced
- minItems/maxItems, min/max, prefixItems, additionalProperties/open records: CONFIRMED [GEM-SO, GEM-BLOG]
- propertyOrdering emitted: CHANGED: key order is preserved natively on 2.5+ and on the OpenAI-compat API. propertyOrdering is only needed for `responseSchema` (OpenAPI), though still harmless there
- enum cap ~40: UNKNOWN (no number published; only "may be rejected" if the state machine is too large)
- New: docs now lead with the Interactions API (`response_format.schema`). Tool strictness is `VALIDATED` mode, not a per-tool `strict` flag

**XAI_STRICT**
- anyOf yes: CONFIRMED
- allOf no: CHANGED: single-subschema allOf is enforced; multiple subschemas are best-effort (no 400)
- oneOf no: CHANGED: **oneOf is supported**
- $defs non-circular yes, no recursion: CONFIRMED
- prefixItems yes: CONFIRMED (array-form `items` returns 400)
- formats {date,time,date-time,email,uuid,ipv4,ipv6,uri}: CONFIRMED
- pattern yes: CONFIRMED (implicit full-match anchors; no `\b`, `\p{}`, lookaround, backrefs)
- length/item/numeric bounds yes: CONFIRMED, with guarantees up to minLength/maxLength 2048, min/maxItems 256, min/maxProperties 64
- additionalProperties defaults false: CONFIRMED
- schema-valued records: CONFIRMED (additionalProperties may be `true` or a schema). Avoid `true`/`false` as a *property* schema (400)
- New: tool `strict` is always implicitly true; empty enum/anyOf returns 400

## Recommended new descriptor families

1. **OPENAI_FINETUNED_STRICT**: OpenAI strict minus every string/number/array constraint and format.
2. **JSON_OBJECT_ONLY** (DeepSeek official response_format, Kimi official, Zhipu GLM): no server-side schema. Put the schema in the prompt, include the word "JSON", and validate on the client. Kimi needs an object root.
3. **DEEPSEEK_STRICT_TOOLS** (beta endpoint only): OpenAI-strict-like; pattern + formats {email,hostname,ipv4,ipv6,uuid}; **no** minLength/maxLength/minItems/maxItems; recursion allowed.
4. **CEREBRAS_STRICT**: OpenAI-strict shape, but **no pattern/format/minItems/maxItems/oneOf/allOf/recursion**, prefixItems allowed, half the OpenAI limits (500 props, 500 enum values, 5,000 chars).
5. **GROQ_STRICT**: OpenAI-strict shape on gpt-oss/qwen3.8/muse only; can't be combined with tools or streaming.
6. **QWEN_JSON_SCHEMA**: permissive (oneOf/allOf/not/if/then/else ok), but must strip `multipleOf, uniqueItems, contains, min/maxContains, additionalItems, patternProperties, propertyNames` (they return 400).
7. **BEST_EFFORT_JSON_SCHEMA** (Together, Fireworks, DeepInfra, Mistral, OpenRouter open-weight models): send a plain, conservative schema (no strict-only requirements) and always validate on the client.
