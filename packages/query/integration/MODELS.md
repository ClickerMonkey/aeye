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

## Current value leaderboard — full sweep (2026-07-11)

**The authoritative current numbers.** All 101 cases, default `auto` delivery,
**no reasoning**, on the current schema — post `relation-path` removal, post
insert/update redesign (keyed-object `rows` / `set`, `WriteValueDef`), with the
enum `reject` tool gated behind a real `*-readonly` policy error. Every run is
archived under `integration/reports/sweep/`. This **supersedes** both the
schema-delivery matrix and the named-join table below (kept for history).

**Value score** ranks accuracy against cost and speed:

> score = 100 · (**0.60**·accuracyₙ + **0.20**·costₙ + **0.20**·speedₙ)

each term min-max normalized across the ranked set (cheaper & faster score
higher; accuracy dominates at 0.60). It is a **relative** score — "best value in
this set," not an absolute rating. Recompute with `node
integration/reports/sweep/score.cjs`.

| # | Model | id | **score** | acc | tries | s/case | $/100 |
|---|-------|-----|----------:|----:|------:|-------:|------:|
| 1 | **Gemini 3 Flash (preview)** | `google/gemini-3-flash-preview` | **97.3** | **92%** | 1.41 | 3.4 | $1.17 |
| 2 | GPT-5 mini | `openai/gpt-5-mini` | 86.4 | 90% | 2.16 | 12.5 | **$0.45** |
| 3 | Gemini 3.5 Flash | `google/gemini-3.5-flash` | 84.2 | 87% | 1.36 | 2.8 | $3.51 |
| 4 | Gemini 2.5 Flash | `google/gemini-2.5-flash` | 80.6 | 83% | 2.44 | 4.0 | $1.02 |
| 5 | Claude Sonnet 4.6 | `anthropic/claude-sonnet-4.6` | 76.7 | 91% | 1.38 | 5.7 | $9.66 |
| 6 | Gemini 3.1 Flash Lite | `google/gemini-3.1-flash-lite` | 74.4 | 78% | 1.40 | 2.1 | $0.51 |
| 7 | Claude Sonnet 4 | `anthropic/claude-sonnet-4` | 73.9 | 91% | 1.50 | 6.6 | $10.69 |
| 8 | Llama-4-Maverick | `meta-llama/llama-4-maverick` | 46.9 | 74% | 3.17 | 22.0 | $1.05 |
| 9 | Gemini 2.5 Flash Lite | `google/gemini-2.5-flash-lite` | 37.3 | 59%† | 3.22 | 4.9 | $0.44 |
| 10 | DeepSeek V3 | `deepseek/deepseek-chat` | 30.7 | 65% | 1.56 | 22.8 | $0.57 |

_avg tries = model requests/case (1 = one-shot). $/100 = provider-reported
`usage.cost` per 100 cases (no local math). s/case = wall-clock.
†Flash-Lite's 59% is a low-variance draw — see the note below._

**What the score exposes:**

- **Gemini 3 Flash preview is the outright champion (97.3)** — top accuracy (92%)
  *and* cheap ($1.17) *and* fast (3.4 s), near one-shot (1.41 tries). Nothing
  else is close on value.
- **Both Anthropic frontier models are accuracy-competitive *value-losers*.**
  Sonnet 4.6 (91%) and Sonnet 4 (91%) tie for 2nd on raw accuracy but rank **5th
  and 7th** — their **~$10/100** cost (8–9× the champion, for *lower* accuracy)
  tanks the value. This is exactly why they're dropped from the default sweep.
- **GPT-5 mini (2nd) is the budget pick** — 90% at the cheapest price ($0.45),
  held back only by latency (12.5 s) and its Mode-4 retries (2.16/case: it 400s on
  the structured schema and recovers via prompt-text fallback, cheap at mini
  pricing).
- **Gemini 3.5 Flash is a value trap** — ranks 3rd on the formula (fast) but is
  **$3.51/100 for 87%**: 3× the champion's price for *lower* accuracy. Almost
  certainly hidden reasoning tokens; prefer `3-flash-preview`.
- **Bottom tier** (llama-maverick, deepseek) is killed by ~22 s latency; flash-lite
  by its 59% draw.

**Qwen 2.5 72B — unrankable outlier.** `qwen/qwen-2.5-72b-instruct` is excluded
from the value ranking on three counts: (1) **10/101 (10%) in this `auto` sweep** —
but that's mostly **Mode-3 delivery flakiness** on the complex schema, consistent
with its historical 6/101 auto; its *real* ability is ~51% in `prompt` mode.
(2) **Pathologically slow** — 135 s/case average, 10–17 min on the recursive-CTE
cases (up to 996 s). (3) **OOM-crashes the harness** at the default Node heap (needs
`NODE_OPTIONS=--max-old-space-size=4096`). Its extreme latency would also distort
the min-max speed normalization for every real contender, so it's reported
separately, not ranked. If you need a Qwen data point, run it in
`QUERY_EVAL_MODE=prompt`.

**Flash-Lite's 59% is variance, not a regression.** Full `gemini-2.5-flash-lite`
runs on the same code swing **59 / 75 / 81%**. Diffing the 59% run against an 81%
run: the 31 flipped pass→fail cases are dominated by *trivial* ones falling into
**retry spirals** (`filter-products-over-500` 1→6 calls, `join-orders-by-rep-name`
1→12, `fn-window-rownumber` 1→11), 9 cases flip the *other* way, and only 2 of 31
were write-model. The model didn't lose capability — retries=5 amplifies each
first-try stumble into a full spiral, so a weak model's pass rate is noise-bounded
(~72% ±12). The insert/update + reject changes are clean.

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

> **⚠ HISTORICAL — two eras stale.** This matrix is the schema-delivery era
> (pre-2026-07-10), measured against a schema that still had a `relation-path`
> expr. That construct was removed (next section, +~15 pts) and the write model
> was later redesigned. **For current numbers see [Current value leaderboard]
> (#current-value-leaderboard--full-sweep-2026-07-11) at the top.** Everything
> below is kept for history.

---

## Named-join refactor (2026-07-10) — +14–15 across frontier models

The matrix above measured a schema with a `relation-path` expr — an
implicit-join *value* construct with no raw-SQL analog. Models (trained on flat
SQL) consistently mis-referenced a relation as a scalar field-ref in
correlations (`salesOrder.customer = customer.id`), which **validated silently
and returned 0/all rows** — so they failed the entire subquery + set-op cluster.

Three changes fixed it: (1) replace `relation-path` with **explicit named joins**
(`joins:[{on:{kind:'relation',source,field,as}}]`, then a plain `{source,field}`
ref); (2) **validate subquery bodies** so a relation-vs-scalar correlation is a
re-promptable `ref.relation` error (the model then self-corrects to the join
form); (3) ship **correlated-join + recursive-CTE examples**. Relation-vs-relation
comparisons (`post.creator = comment.creator`) stay legal and compare by FK key.

| Model | before | after | Δ | avg attempts* |
|-------|--------|-------|---|---------------|
| Claude Sonnet 4.6 (`anthropic/claude-sonnet-4.6`) | 73/101 (72%) | **92/101 (91%)** | **+19** | **1.20** |
| Claude Sonnet 4 (`anthropic/claude-sonnet-4`) | 76/101 (75%) | **90/101 (89%)** | **+14** | **1.19** |
| Gemini 3 Flash preview (`google/gemini-3-flash-preview`) | 75/101 (74%) | **90/101 (89%)** | **+15** | 1.26 |
| GPT-5.1 (`openai/gpt-5.1`) | 70/101 (69%) | **76/101 (75%)** | **+6** | 2.25 |
| DeepSeek V3 (`deepseek/deepseek-chat`) | 51/101 (50%) | **53/101 (52%)** | +2 | 1.95 |

_*avg model requests per case (1 = one-shot; >1 = re-prompts / delivery-fallback
retries) — a COST signal now tracked in `report.json` (`avgCalls`,
`avgCallsPassed`, per-case `calls`) and the console/`report.md`. Higher pass rate
bought with more attempts is not strictly better: Sonnet 4/4.6 win at ~1.2
(near one-shot); GPT-5.1's 75% costs 2.25 — its Mode-4 fallback re-issues every
case as prompt-text._

**The lift scales with model strength.** The frontier models (Sonnet 4/4.6,
Gemini 3-flash) jump +14–19 to 89–91% — they leverage the explicit joins, the
re-prompt-on-error, and the examples. GPT-5.1 gains +6 (subquery/set-op up, but
`function`/`date-range` regressed). DeepSeek is ~flat and NOISY: big gains on the
hard cluster (subquery 1/7→5/7, set-op 1/5→3/5) offset by regressions on
*simpler* categories (operator, distinct, case, array) — the added verbosity of
explicit joins is a wash for a weaker model. Sonnet 4.6 is now the top model.

Category lift (frontier models, consistent):

| Category | before → after |
|----------|----------------|
| **subquery** | 2/7 → **7/7** |
| **set-op** | 3/5 → **5/5** |
| **aggregate** | 6–7/9 → **9/9** |
| group-by | 2–3/4 → **4/4** |
| window | 7/11 → 8–9/11 |
| cte | 1/3 → 2/3 (descendants recovered by the recursive example) |

The remaining tail is shared across models: the 4 write-model **refusal
guardrails** (models won't decline a protected write), hard **window** cases
(rank-ties, first/lastValue), the composite-FK join, and a recursive-CTE
ancestors off-by-one.

---

## Reasoning (extended thinking) — a noisy, expensive lever

`QUERY_EVAL_REASONING=low|medium|high` sets the prompt's `config.reason.effort`
(OpenRouter maps it per family; reasoning tokens/cost flow through `usage.cost`).
Gemini 2.5 Flash Lite, full 101, `high` vs baseline:

| | pass | tries | $ / 101 | latency |
|---|---|---|---|---|
| baseline | 76/101 (75%) | 1.69 | $0.35 | ~instant |
| reasoning=high | 82/101 (81%) | 2.10 | $0.58 | **21.7 s/case** |

**+6 net but noisy** — 15 cases newly pass (correlated-max, argmax, nested-max,
cumeDist, lastValue), 9 regress (in-customers, set-except, rank-ties, arrays) —
at **1.7× cost** and **~22 s/case**. It does NOT close the gap to the frontier:
Sonnet 4/4.6 and Gemini 3-flash hit **89–91% WITHOUT reasoning at ~1.2 tries**
and far lower latency. Verdict: reasoning-on-a-cheap-model is poor ROI vs just
using a frontier model — high variance, big latency/cost tax, sub-frontier
ceiling.

## Fast / cheap tier — price vs performance (post-refactor, 2026-07-10)

> Current pass/cost numbers live in the [value leaderboard](#current-value-leaderboard--full-sweep-2026-07-11)
> above. This section is the **cost-structure deep-dive** + the retained **Haiku
> 4.5** data point (Haiku was dropped from the sweep as poor value). Table numbers
> are an earlier cheap-tier batch; treat the leaderboard as authoritative.

The eval tracks four axes per run, all in `report.json` (and the console /
`report.md` summary): **pass rate**, **avg attempts/case** (`avgCalls` +
`avgCallsPassed` — model requests, 1 = one-shot), **$ cost** (`totalCostUsd` /
`avgCostUsd`, from the provider-reported `usage.cost` — no local math), and
**latency** (`avgDurationMs` — wall-clock per case). Per-case `calls`, `tokensIn`,
`tokensOut`, `costUsd`, and `durationMs` are in `report.json.cases`. Full
101-case runs on the cheap tier:

| Model | id | pass | avg tries | $ / 101 | list $/M (in·out) |
|-------|-----|------|-----------|---------|-------------------|
| **GPT-5 mini** | `openai/gpt-5-mini` | **93/101 (92%)** | 2.09 | **$0.43** | 0.25 · 2 |
| Claude Haiku 4.5 | `anthropic/claude-haiku-4.5` | 84/101 (83%) | 1.42 | $3.42 | 1 · 5 |
| Gemini 3.1 Flash Lite | `google/gemini-3.1-flash-lite` | 82/101 (81%) | 1.28 | $0.51 | 0.25 · 1.5 |
| Gemini 2.5 Flash Lite | `google/gemini-2.5-flash-lite` | 76/101 (75%) | 1.69 | $0.35 | 0.10 · 0.40 |

- **GPT-5 mini is the value leader** — 92% (ties the frontier Sonnet 4.6) for
  **$0.43/101**. It pays 2.09 attempts/case: like GPT-5.1 it 400s on the
  structured schema and recovers via the Mode-4 prompt-text fallback (every case
  = 2 requests), but the retries are cheap at mini pricing.
- **Claude Haiku 4.5 is poor value** — 83% but **$3.42** (8× GPT-5 mini for LESS
  accuracy). It's priced mid-tier ($1/$5 per M), not flash-cheap; the ~20 KB
  input (schema + all examples) × its price dominates.
- **Gemini Flash-Lite tier is the cheapest** ($0.35–0.51) at 75–81%; `3.1` beats
  `2.5` — a generational lift at the bottom of the price curve.
- Cost is **input-dominated** (~20 K tokens/case: the schema + every example,
  since the eval renders all examples). Trimming examples would cut cost but the
  full set is what drove the accuracy lift — a knob to tune per deployment.

---

## The real ceiling: advanced SQL, not schema delivery

Once the schema is delivered (by whatever mode) and after the named-join refactor,
the **frontier reaches 91–92%** — the old "everyone plateaus in the low-70s" wall
was mostly the `relation-path`/subquery-delivery problem, now fixed. What's left
is a genuine *modeling*-difficulty tail (not runtime bugs — the oracle runs the
same in-memory runtime and produces the expected values). Remaining worst
categories, by cross-model miss rate on the fresh sweep:

| Category | Miss rate (10 models) | Why models miss |
|----------|----------------------|-----------------|
| **cte** (recursive) | **43%** | recursive self-reference: the recursive member must query the CTE by name; models emit a non-recursive single hop |
| **distinct** | **40%** | the aggregate `distinct: true` flag — omitted → row count instead of distinct count |
| **window** | **38%** | rank tie-and-gap vs rowNumber; firstValue/lastValue **frames**; cumeDist/ntile/nthValue |
| **write-model refusal** | **35%** | was a guardrail gap; **fixed** to 6/6 (Gemini) via the keyed-object insert/update schema + the enum `reject` tool gated behind a real `*-readonly` policy error — `insert-id` is the last sticky one |
| **function** | 22% | relation-hop functions (`age`) and exact unit/type semantics |
| **join** | 18% | composite-FK relations (join on two key columns, not one) |
| **subquery / aggregate** | ~17% | arg-max (return the owning row, not the max); most subqueries now pass ≤1 model |

Rock-solid across models (≤8% miss): filter, operator, array, text-search,
is-null, case, group-by, set-op, top-n, and most date-range.

### Hardest cases — cross-model failure matrix (2026-07-11 sweep)

The **10 ranked models** (excludes qwen at 10%), each case scored by **how many of
the 10 failed it** (`error`-severity oracle mismatch). Regenerate with `node
integration/reports/sweep/failmatrix.cjs`. Distribution: **1** case fails 10/10,
1 fails 9/10, 2 fail 8/10, then a long tail — **29 of 101 pass on all 10**, and
only 13 cases fail on ≥4 models. The hard core:

| fails | Case | Category | Root cause (why models miss) |
|------:|------|----------|------------------------------|
| **10/10** | `win-rank-month-ties` | window | **rank tie-and-gap arithmetic.** Models *do* pick `rank` (structural assert passes) but order by the raw timestamp, so every row is distinct → `rank` degenerates to `rowNumber` (1,2,3,4) and misses the gap the `dateTrunc('month')` ordering designs in (…3,3,**5**). The diffs are literally the missing gap ("expected 5, got 4"). |
| **9/10** | `cte-recursive-ancestors-rgb-laptops` | cte | **recursive self-reference.** The recursive member must join `category→parent` and filter `category.id IN (SELECT pid FROM ancestors)` — referencing the CTE from inside its own body. Models emit a single non-recursive join (direct parent only) or bungle the working-table correlation. |
| **8/10** | `join-return-matching-invoice` | join | **composite-FK relation.** `salesReturn.invoice` joins on **both** `sales_order_id` AND `customer_id`. Models hand-roll a single-column join (keeping refunded orders that should drop) instead of using the named `invoice` relation that carries both keys. |
| **8/10** | `refusal-insert-product-id` | write-model | **strongest write refusal.** Models overwhelmingly *want* to insert the server-generated `id` rather than decline; the `reject` affordance helps elsewhere but this is the stickiest guardrail. |
| **7/10** | `fn-age-payment-lag` | function | **`age()` across a relation hop.** Needs `age(payment.paidAt, invoice.issuedAt) > 10` (whole-day span). Models substitute a subtraction / `dateDiff` with the wrong unit or type, or miss the payment→invoice hop. |
| **6/10** | `op-distinct-products-ordered` | distinct | **`COUNT(DISTINCT …)` flag.** Needs the aggregate's `distinct: true`; models emit plain `count` and inflate 12 → the 48-line row count. |
| **5/10 ×8** | `agg-argmax-*`, `agg-nested-max-*`, `page-nulls-first-shippedat`, `win-lead`, `win-cumedist`, `win-firstvalue`, `win-lastvalue` | aggregate / window / pagination | arg-max (return the row *owning* the max, not the max); NULLS-FIRST ordering; window **frame** semantics (lastValue/firstValue need an explicit frame or they return the current row); cumeDist/lead defaults. |

**Category failure density** (total model-fails ÷ cases, across the 10):

| Category | miss rate | read |
|----------|-----------|------|
| **cte (recursive)** | **43%** | 13 fails / 3 cases — highest per-case; recursive self-reference is the single hardest construct |
| **window** | **38%** | 42 fails / 11 cases — the biggest *volume* of failure: ties, frames, cumeDist/ntile/nthValue |
| **write-model** | **35%** | 21 fails / 6 cases — refusal guardrails (much improved, but `insert-id` remains sticky) |
| **distinct** | **40%** | 8 / 2 — the `distinct` aggregate flag |
| function 22% · join 18% · subquery 17% · aggregate 16% | — | tail: relation-hop functions, composite-FK joins, arg-max |
| filter · set-op · group-by · array · operator · text-search | ≤8% | rock-solid |

**What changed vs the old (pre-refactor) matrix — the good news.** The old section
had **all four subqueries and both set-ops failing universally (8/8)**. After the
named-join refactor + subquery-body validation, that entire cluster collapsed:
subquery is now **17% miss** (most cases fail ≤1 model) and set-op **8%**. The
hard core is no longer "whole construct families fail together" — it's now a
handful of genuinely-advanced *semantics* cases (rank ties, recursive traversal,
composite-FK, window frames, arg-max) that even hand-written SQL gets wrong.

**Why these specifically.** The common thread across the survivors is **a
computation the model can *name* but not get *exactly right*** — it picks `rank`,
`age`, `count`, `firstValue` correctly (structural asserts pass) but the *result*
is wrong because a subtlety is dropped: the window's `orderBy` key (month-trunc,
not raw date), the aggregate's `distinct` flag, the composite join key, the window
frame, or the recursive correlation. These are **not** schema-naming failures
(unlike the old subquery cluster, which the refactor fixed) — they're the
irreducible-difficulty tail. The next lever, if pursued, is worked examples for
each (a `rank`-with-ties example, a composite-FK-join example, a window-frame
example), the same tactic that lifted subquery/set-op/cte-descendants.

---

## Per-model notes

### Google Gemini — `3-flash-preview` **92%** · `3.5-flash` 87% · `2.5-flash` 83% · `3.1-flash-lite` 78% · `2.5-flash-lite` 59–81% — Mode 1

- Google structured output **hard-rejects `anyOf`/`oneOf`/`$defs`-ref (HTTP
  400)** — a *format restriction, not a capability gap*. `canExpress` catches it
  statically → `auto` drops the wire schema and delivers it as prompt text.
- The **strongest family** on this eval — **`3-flash-preview` is the overall value
  champion** (92%, $1.17/100, 3.4 s). `3.5-flash` scores well (87%) but at **$3.51**
  it's a value trap (probably hidden reasoning tokens) — prefer `3-flash-preview`.
- **`2.5-flash-lite` is high-variance** — full runs swing 59/75/81%; a weak model
  where retries=5 amplifies each first-try stumble into a spiral. Don't read a
  single low draw as a regression (see the leaderboard note).
- Weakest at recursive cte and the window tie/frame cases, like everyone.
- **Availability:** slugs churn upstream — sanity-check any Gemini id with
  `--limit 1` before a full run.

### Anthropic Claude Sonnet — `sonnet-4` 91% · `sonnet-4.6` 91% — Mode 2

- Native structured output (~1.4 calls/case); the `anthropic` dialect expresses
  our schema, no fallback needed. Both hit **91%** — accuracy-competitive with the
  Gemini frontier.
- **But both are value-losers: ~$10/100** (sonnet-4 $10.69, sonnet-4.6 $9.66) — 8–9×
  the `gemini-3-flash-preview` champion for *lower* accuracy. Dropped from the
  default sweep for that reason. Use only if an Anthropic-native data point is
  needed.
- **Older Claude is unreachable:** the entire Claude 3.x sonnet line
  (`claude-3.5-sonnet`, `claude-3.7-sonnet`) now **404s on OpenRouter** and is
  absent from the scrape — can't be evaluated here without an Anthropic-direct
  key. Currently reachable sonnets: 4, 4.5, 4.6, 5 (+ the `~…-latest` alias).

### OpenAI GPT-5 mini — `openai/gpt-5-mini` — 90%, Mode 4 → **budget pick**

- **90% for $0.45/100 — the cheapest strong model** and #2 on the value board.
  Like GPT-5.1 it **400s on the structured schema** and recovers via the Mode-4
  prompt-text fallback (2.16 calls/case), but the retries are cheap at mini
  pricing. The one drawback is **latency** (12.5 s/case) from the double request.

### Meta Llama-4-Maverick — `meta-llama/llama-4-maverick` — 74%, Mode 3

- **Accepts** `response_format` but returns **empty content** on the complex
  schema → `auto` runtime-fallback retries as prompt text (3.17 calls/case).
- Not weak at SQL per se; the failure is decoding the wire schema, plus **22 s/case**
  latency (the retries) that tanks its value score.

### DeepSeek V3 — `deepseek/deepseek-chat` — 65%, Mode 2

- Delivers fine (LENIENT dialect → structured output accepted, ~1.6 calls). Its
  low score is **genuinely weaker SQL**: valid queries that run but return the
  wrong rows. Also **22.8 s/case** — the joint-slowest. (Up from the pre-refactor
  50%, but still bottom-tier value.)

### OpenAI GPT-5.1 — `openai/gpt-5.1` — 75% (refactor-era `auto`); Mode 4

- **`400 Provider returned error`** on our full schema (a *simple* `json_schema`
  returns HTTP 200). Before the Mode-4 fallback, every case failed in <1s with
  1 call (the 4/101 "passes" were write-model *refusal* cases that trivially pass
  when the model produces nothing).
- **In `prompt` mode: 67/101 (66%)** — fully competitive with the Gemini/Claude
  tier. The `auto` failure was *entirely* delivery; the model is strong.
- **Recovers in `auto`** via the runtime request-error fallback: the structured
  `400` is caught and retried as prompt text (≈2.25 calls/case) — no manual
  `QUERY_EVAL_MODE=prompt` needed. Post-refactor it reaches **76/101 (75%)**, but
  at **2.25 calls/case** (every case is a double request) it's an expensive
  Mode-4 tax; **not re-run in the fresh sweep** (dropped alongside the pricey
  tier). `gpt-5-mini` is the cheaper way to get the same Mode-4 recovery.
- Notably a *newer* OpenAI model is **more** restrictive on structured output
  than gpt-4o. Weakest: cte, window, subquery.

### Qwen 2.5 72B — `qwen/qwen-2.5-72b-instruct` — 10% (fresh `auto`) / 51% (prompt); Mode 3 (flaky)

- `response_format` works on a simple schema; on the complex one it's flaky —
  sometimes empties (→ runtime fallback → valid-but-wrong query), sometimes yields
  nothing. The fresh `auto` sweep scored **10/101 (10%)** — mostly delivery
  flakiness, consistent with its historical 6/101 auto.
- **In `prompt` mode: 52/101 (51%)** — this is its *real* ability, genuinely
  mid-tier: it collapses on group-by, subquery, cte, and join.
- **Operationally painful:** 135 s/case average (up to 996 s on recursive CTE) and
  **OOM-crashes** the harness at the default Node heap (needs
  `NODE_OPTIONS=--max-old-space-size=4096`). Excluded from the value ranking.

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
