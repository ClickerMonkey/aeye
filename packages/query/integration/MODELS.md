# Model behavior against the `@aeye/query` schema

A living record of how different LLMs perform on the integration eval, how each
one has to be fed the schema, and which query features trip each of them up.

Regenerate a model's numbers with:

```bash
QUERY_EVAL_MODEL=<openrouter-id> npx tsx integration/run.ts        # all 101 cases, default `auto` delivery
QUERY_EVAL_MODEL=<id> QUERY_EVAL_MODE=prompt npx tsx integration/run.ts   # force schema-as-prompt-text
QUERY_EVAL_MODEL=<id> QUERY_EVAL_MODE=structured npx tsx integration/run.ts  # force wire schema (no fallback)
```

Each run writes `report.json` (per-case `passed` + per-assertion detail) and
`report.md` (summary). Per-case model output + diagnostics land in
`integration/logs/`.

---

## Why schema *delivery* matters here

Our wire schema is intentionally hard: ~20 KB, a deeply **recursive** query AST
expressed with `anyOf` unions and `$ref`/`$defs`. Structured-output engines
handle that unevenly, which sorts every model into one of three buckets:

| Mode | What the model does with the wire schema | Defense |
|------|------------------------------------------|---------|
| **1 · Descriptor forbids it** | Provider rejects the schema outright (HTTP 400 on `anyOf`/`$defs`) | `canExpress` — **static**, pre-flight → drop schema, deliver as prompt text |
| **2 · Native support** | Accepts `response_format`, decodes it fine | none needed |
| **3 · Accepts but empties** | Accepts the schema, `finish=stop`, **empty content** | **runtime** fallback — empty/unparseable → retry once as prompt text |

Key lesson: **"the descriptor allows the schema" ≠ "the model can decode it."**
Mode 3 is invisible to a static check — you only learn at runtime when the
content comes back empty. That's why `schemaDelivery: 'auto'` combines *both* the
static drop and the runtime empty-output retry: a model always gets to *try*
structured output and is only downgraded to prompt-text when it actually fails.

Feasibility is a property of the **target model's dialect**, not the provider —
the fallback resolves the descriptor from the model before any provider encodes
the request.

---

## Results matrix

| Model | OpenRouter id | Delivery that works | Overall | Notes |
|-------|---------------|---------------------|---------|-------|
| GPT-4o | `openai/gpt-4o` | Mode 2 — native structured (non-strict) | ~69% | schema-echo quirk; strict incompatible |
| Gemini 2.5 Flash | `google/gemini-2.5-flash` | Mode 1 — schema-in-prompt (auto drops it) | ~66% | 400s on `anyOf` via structured output |
| Llama-4-Maverick | `meta-llama/llama-4-maverick` | Mode 3 — runtime fallback to prompt text | **69/101 (68%)** | empty content on complex wire schema; full run 2026-07-09 |

_Overall numbers are the fraction of the 101 cases whose `error`-severity
assertions all pass (result matches the oracle). "~" figures predate the current
harness and should be re-run to refresh._

---

## Per-model notes

### OpenAI · `openai/gpt-4o` — Mode 2 (native)

- Its dialect expresses `anyOf`, so the wire schema goes out as `response_format`
  and it decodes it first try (≈1 call/case).
- **Schema-echo quirk:** intermittently returned the JSON *schema* (`{"type":
  "object", …}`) instead of an instance. Mitigated by including a concrete
  `{"query": …}` example in the prompt.
- **Strict mode is incompatible** with our schema: `open`+strict makes it drift
  (`literal` vs `field-ref`); `paired`+strict makes OpenAI reject the ~95 KB
  strict schema. We run **non-strict** deliberately.
- Ceiling ~69% — limited by advanced SQL, not schema delivery.

_Struggle cases:_ _TBD — re-run to capture._

### Google · Gemini (`google/gemini-2.5-flash`, `2.0-flash-001`) — Mode 1 (forbids)

- Google structured output **hard-rejects `anyOf`/`oneOf`/`$defs`-ref with HTTP
  400.** This is a *format restriction, not a capability gap.*
- `canExpress` catches it statically → `auto` drops the wire schema and delivers
  it as prompt text → the model reasons fine (~66%, 67/101 via schema-in-prompt).
- **Availability:** `gemini-2.0-flash-001` now 404s on OpenRouter; use `2.5-flash`.

_Struggle cases:_ _TBD — re-run to capture._

### Meta · `meta-llama/llama-4-maverick` — Mode 3 (accepts, empties)

- **Accepts** `response_format: json_schema` (its descriptor allows `anyOf`, so
  `canExpress` = true) but returns **empty content** on our complex schema — the
  structured-decode engine chokes. Forced-structured: **0/5**.
- It is **not weak at SQL** — schema-*less* it scored **4/5 (80%)** on the same
  cases. The failure is decoding the complex schema, not the reasoning.
- With `auto` (runtime fallback): recovers to run the full suite
  (≈2 calls/case: structured-empty → prompt-text retry).

**Full 101-case run (`auto`, 2026-07-09): 69/101 (68%).** Same ceiling as GPT-4o
— once the schema is delivered, the limit is reasoning about advanced SQL.

Category pass rates (worst → best):

| Category | Pass | | Category | Pass |
|----------|------|-|----------|------|
| cte | **1/3** | | join | 7/10 |
| top-n | **1/2** | | aggregate | 7/9 |
| distinct | **1/2** | | date-range | 5/6 |
| subquery | **2/7** | | filter | 8/8 |
| write-model | **2/6** | | group-by | 4/4 |
| pagination | 2/3 | | array | 5/5 |
| set-op | 3/5 | | operator | 3/3 |
| window | **4/11** | | text-search | 2/2 |
| function | 10/13 | | is-null / case | 1/1 each |

Where it breaks (all genuine modeling errors — result mismatch vs the oracle,
not schema-delivery failures):

- **Subqueries (2/7)** — its weakest area: `in` / `not-in` / `exists` /
  `not-exists` / correlated-largest-order all fail.
- **Window functions (4/11)** — `lag`, `lead`, rank/dense-rank tie handling,
  `cumeDist`, `firstValue`, `lastValue`. Partition-vs-order confusion recurs.
- **Recursive CTEs (1/3)** — descendants/ancestors traversal.
- **Set-ops (3/5)** — `intersect` / `except` (e.g. returned 9 rows vs 3).
- **Write-model guardrails (2/6)** — did **not** refuse the 4 `refusal-*` cases
  (writing a server-generated id, a `createdAt`, currency, deleting a payment);
  it produced a write it should have declined. A guardrail/instruction gap, not
  a SQL-reasoning gap.
- Scattered singles: `join` 3 misses (multi-hop / by-rep-name), `aggregate`
  arg-max & nested-max, `top-n` ordered, `date` March-2026 range, a few
  functions (`countif`, `age`, `nullif`), `distinct`, `pagination` nulls-first.

Rock-solid (100%): filter, group-by, array, operator, text-search, is-null, case.

---

## The real ceiling: advanced SQL, not schema delivery

Once the schema gets through (by whatever mode), **every** model plateaus on the
same features. These failures are genuine *modeling* errors, not runtime bugs —
the oracle runs the same in-memory runtime and produces the expected values:

- **Window functions** — e.g. `partitionBy: [month(orderedAt)]` where `orderBy`
  was meant; confusing partition vs order.
- **Subqueries / correlated conditions.**
- **CTEs.**
- Type/relation misuse — e.g. Llama emitting "compare relation with number using
  `=`".

When adding a model below, record: delivery mode it needs, overall pass rate,
and the **categories/case-ids** it fails — so we can tell schema-delivery
problems (fixable by us) apart from reasoning ceilings (inherent to the model).
