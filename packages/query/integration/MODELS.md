# Model behavior against the `@aeye/query` schema

A living record of how different LLMs perform on the integration eval, how each
one has to be fed the schema, and which query features trip each of them up.

Regenerate a model's numbers with:

```bash
QUERY_EVAL_MODEL=<openrouter-id> npx tsx integration/run.ts        # all 101 cases, default `auto` delivery
QUERY_EVAL_MODEL=<id> QUERY_EVAL_MODE=prompt npx tsx integration/run.ts   # force schema-as-prompt-text
QUERY_EVAL_MODEL=<id> QUERY_EVAL_MODE=structured npx tsx integration/run.ts  # force wire schema (no fallback)
QUERY_EVAL_DEBUG=1 ...    # also print the swallowed request/parse error ([ASKERR])
```

Each run writes `report.json` (per-case `passed` + per-assertion detail) and
`report.md`; per-model reports from batch runs are kept in
`integration/reports/`. Per-case model output + diagnostics land in
`integration/logs/`.

> **Model ids come from the `@aeye/models` package** (`src/models/openrouter.ts`
> registry + `src/strict-support.ts` dialect table), but registry membership is
> **not required to run** — `resolveStrictFormat` falls back to the id prefix, so
> `anthropic/…`, `google/…`, `openai/…` get the right descriptor from the slug
> alone. Slugs can also be retired upstream (OpenRouter 404) even while still in
> the scraped registry — always sanity-check a new id with `--limit 1` first.

---

## Why schema *delivery* matters here

Our wire schema is intentionally hard: ~20 KB, a deeply **recursive** query AST
expressed with `anyOf` unions and `$ref`/`$defs`. Structured-output engines
handle that unevenly, which sorts every model into one of **four** buckets:

| Mode | What the model does with the wire schema | Defense |
|------|------------------------------------------|---------|
| **1 · Descriptor forbids it** | Provider rejects `anyOf`/`$defs` up front (HTTP 400) — a *known dialect limit* | `canExpress` — **static**, pre-flight → drop schema, deliver as prompt text |
| **2 · Native support** | Accepts `response_format`, decodes it fine | none needed |
| **3 · Accepts but empties** | Accepts the schema, `finish=stop`, **empty content** | **runtime** fallback — empty/unparseable → retry once as prompt text |
| **4 · Errors on the *complex* schema** | Accepts *simple* schemas, but **HTTP 400s on our big recursive one** at request time | **runtime** fallback — request throws → retry once as prompt text |

Two lessons the eval taught us:

- **"The descriptor allows the schema" ≠ "the model can decode it."** Modes 3 and
  4 are invisible to a static check — you only learn at runtime, either when the
  content comes back empty (3) or when the request itself fails (4). So
  `schemaDelivery: 'auto'` combines the static drop *and* a **runtime** fallback
  that fires on both: empty/unparseable content **or** a request-time error →
  promote to prompt-text and retry once. GPT-5.1 (which `400`s on our schema but
  scores 66% in prompt mode) now recovers automatically in `auto` (≈2 calls/case:
  structured `400` → prompt-text retry), exactly the way Llama does for empties.
- **The runtime fallback is opt-out.** It's on by default under `'auto'`; set
  `runtimeSchemaFallback: false` on the prompt to disable *both* runtime recoveries
  (an empty reply then becomes an ordinary parse-retry and a request error
  propagates). The static drop for dialects that can't express the schema (Mode 1)
  is unaffected.

Feasibility is a property of the **target model's dialect**, not the provider —
the fallback resolves the descriptor from the model before any provider encodes
the request.

---

## Results matrix (default `auto` delivery unless noted)

| Model | OpenRouter id | Mode | Overall | One-line |
|-------|---------------|------|---------|----------|
| Claude Sonnet 4 | `anthropic/claude-sonnet-4` | 2 | **76/101 (75%)** | native; top of the pack (within noise) |
| Gemini 3 Flash (preview) | `google/gemini-3-flash-preview` | 1 | **75/101 (74%)** | |
| Gemini 2.5 Flash | `google/gemini-2.5-flash` | 1 | **74/101 (73%)** | |
| Gemini 3.5 Flash | `google/gemini-3.5-flash` | 1 | **74/101 (73%)** | |
| Claude Sonnet 4.6 | `anthropic/claude-sonnet-4.6` | 2 | **73/101 (72%)** | native; best at windows (10/11) |
| Llama-4-Maverick | `meta-llama/llama-4-maverick` | 3 | **69/101 (68%)** | empties on wire schema → runtime fallback |
| GPT-4o | `openai/gpt-4o` | 2 | ~69% | native (non-strict); older run |
| GPT-5.1 | `openai/gpt-5.1` | **4** | **70/101 (69%)** in `auto` (was 4/101); 67/101 (66%) in `prompt` | 400s on the complex schema → runtime fallback |
| Qwen 2.5 72B (prompt mode) | `qwen/qwen-2.5-72b-instruct` | 3 (flaky) | **52/101 (51%)** in `prompt`; **6/101** flaky in `auto` | genuinely mid-tier SQL |
| DeepSeek V3 | `deepseek/deepseek-chat` | 2 | **51/101 (50%)** | delivers fine, genuinely weaker SQL |
| Claude Sonnet 3.5 / 3.7 | `anthropic/claude-3.{5,7}-sonnet` | — | **N/A** | HTTP 404 — whole Claude 3.x sonnet line retired on OpenRouter |

_All full runs 2026-07-09. Overall = fraction of the 101 cases whose
`error`-severity assertions all pass (result matches the oracle). GPT-4o "~69%"
predates the current harness. **GPT-5.1's and Qwen's low `auto` scores were
delivery failures, not SQL ability** — their prompt-mode numbers are the real
measure._

---

## The real ceiling: advanced SQL, not schema delivery

Once the schema is delivered (by whatever mode), **every capable model plateaus
in the low-70s** and fails on the *same* features. These are genuine *modeling*
errors, not runtime bugs — the oracle runs the same in-memory runtime and
produces the expected values. Worst categories, essentially universal:

| Category | Typical pass | Why models miss |
|----------|-------------|-----------------|
| **subquery** | 1–3 / 7 | `in`/`not-in`/`exists`/`not-exists`/correlated — the single hardest area |
| **cte** (recursive) | 1 / 3 | recursive descendants/ancestors traversal |
| **window** | 4–10 / 11 | partition-vs-order confusion; tie handling; lag/lead/cumeDist |
| **set-op** | 1–3 / 5 | `intersect`/`except` row semantics |
| **aggregate** | 5–6 / 9 | arg-max / nested-max |
| **write-model refusal** | 2–4 / 6 | **guardrail gap** — models *don't refuse* writing server-generated ids / `createdAt` / currency; they emit the write they should decline |
| top-n, distinct | ~1 / 2 | ordered top-N, distinct-on |

Rock-solid across models: filter, operator, array, text-search, is-null, case,
and (for the stronger models) group-by, date-range, most functions.

---

## Per-model notes

### Google Gemini — `3-flash-preview` 74% · `2.5-flash` 73% · `3.5-flash` 73% — Mode 1

- Google structured output **hard-rejects `anyOf`/`oneOf`/`$defs`-ref (HTTP
  400)** — a *format restriction, not a capability gap*. `canExpress` catches it
  statically → `auto` drops the wire schema and delivers it as prompt text.
- The **strongest family** on this eval; the three variants are within 1 case of
  each other — the schema-in-prompt path is stable across Gemini generations.
- Weakest at subquery (1–2/7) and recursive cte (1/3), like everyone.
- **Availability:** `gemini-2.0-flash-001` and `gemini-3.5-flash` may be absent
  from the scraped registry / retired; `2.5-flash` and `3-flash-preview` current.

### Anthropic Claude Sonnet — `sonnet-4` 75% · `sonnet-4.6` 72% — Mode 2

- Native structured output (1 call/case); the `anthropic` dialect expresses our
  schema, no fallback needed.
- **Sonnet 4 (`anthropic/claude-sonnet-4`): 76/101 (75%)** — top of the pack,
  though within run-to-run noise of the Gemini tier. **Sonnet 4.6
  (`claude-sonnet-4.6`): 73/101 (72%)**, with the **best window-function score
  (10/11)** of any model. Both weak in the usual places: subquery 2/7, cte 1/3,
  write-model 2/6, set-op 3/5.
- **Older Claude is unreachable:** the entire Claude 3.x sonnet line
  (`claude-3.5-sonnet`, `claude-3.7-sonnet`) now **404s on OpenRouter** and is
  absent from the scrape — can't be evaluated here without an Anthropic-direct
  key. Currently reachable sonnets: 4, 4.5, 4.6, 5 (+ the `~…-latest` alias).

### Meta Llama-4-Maverick — `meta-llama/llama-4-maverick` — 68%, Mode 3

- **Accepts** `response_format` but returns **empty content** on the complex
  schema → `auto` runtime-fallback retries as prompt text (≈2 calls/case).
- Not weak at SQL (schema-*less* ≈80% on sampled filters); the failure is
  decoding the wire schema. Weakest at subquery (2/7), window (4/11), cte (1/3),
  set-op (3/5); write-model refusal 2/6.

### DeepSeek V3 — `deepseek/deepseek-chat` — 50%, Mode 2

- Delivers fine (LENIENT dialect → structured output accepted, mostly 1 call).
  Its low score is **genuinely weaker SQL**: valid queries that run but return
  the wrong rows (e.g. `row count 4 vs 8`, `count 6 vs 24`). Misses leak into
  otherwise-easy categories (filter 6/8, operator 2/3, array 3/5) — the only
  tested model that stumbles below the "advanced SQL" line.

### OpenAI GPT-5.1 — `openai/gpt-5.1` — 66% (prompt); Mode 4 (now auto-recovered)

- **`400 Provider returned error`** on our full schema (a *simple* `json_schema`
  returns HTTP 200). Before the Mode-4 fallback, every case failed in <1s with
  1 call (the 4/101 "passes" were write-model *refusal* cases that trivially pass
  when the model produces nothing).
- **In `prompt` mode: 67/101 (66%)** — fully competitive with the Gemini/Claude
  tier. The `auto` failure was *entirely* delivery; the model is strong.
- **Now recovers in `auto`** via the runtime request-error fallback: the
  structured `400` is caught and retried as prompt text (≈2 calls/case) →
  **70/101 (69%)** at full scale, matching (here, edging) its prompt-mode 66%.
  No manual `QUERY_EVAL_MODE=prompt` needed.
- Notably a *newer* OpenAI model is **more** restrictive on structured output
  than gpt-4o (which handled the same schema at ~69%). Weakest: cte 0/3,
  window 4/11, subquery 3/7.

### Qwen 2.5 72B — `qwen/qwen-2.5-72b-instruct` — 51% (prompt); Mode 3 (flaky)

- `response_format` works on a simple schema; on the complex one it's flaky —
  sometimes empties (→ runtime fallback → valid-but-wrong query, 2 calls),
  sometimes yields nothing (1 call). The `auto` score (6/101) is mostly delivery
  flakiness.
- **In `prompt` mode: 52/101 (51%)** — this is its *real* ability, and it's
  genuinely mid-tier: unlike the top models it collapses on **group-by (0/4)**,
  subquery (0/7), cte (0/3), and join (2/10). Comparable to DeepSeek's tier.

### Claude Sonnet 3.7 — `anthropic/claude-3.7-sonnet` — unavailable

- **HTTP 404 "No endpoints found"** on OpenRouter — the slug is retired (still in
  the scraped registry). Not tested. `claude-3.5-sonnet` is available as a
  substitute if an older-Claude data point is wanted.

---

When adding a model: record the **delivery mode** it needs, the overall pass
rate, and the **categories/case-ids** it fails — so we can tell schema-delivery
problems (fixable by us) apart from reasoning ceilings (inherent to the model).
Always confirm a low score is *reasoning* and not a swallowed 400/404
(`QUERY_EVAL_DEBUG=1`).
