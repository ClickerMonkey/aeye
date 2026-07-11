# Model behavior against the `@aeye/gin` schema

A living record of how different LLMs perform on the gin integration eval — how
well each one authors a **gin typed-expression program** from a natural-language
request, against a schema of custom types, distractor functions, and a
re-prompt-on-diagnostics loop.

Regenerate a model's numbers with:

```bash
GIN_EVAL_MODEL=<openrouter-id> npx tsx integration/run.ts        # all 61 cases, default `auto` delivery
GIN_EVAL_MODEL=<id> GIN_EVAL_MODE=prompt npx tsx integration/run.ts   # force schema-as-prompt-text
GIN_EVAL_MODEL=<id> GIN_EVAL_MODE=structured npx tsx integration/run.ts  # force wire schema (no fallback)
GIN_EVAL_DEBUG=1 ...    # also surface ask-time throws
```

Each run writes `report.json` (per-case `passed` + per-assertion detail) and
`report.md`, and archives a per-model copy under `integration/logs/runs/`. Per-run
model output + diagnostics also land in `integration/logs/`.

---

## What the eval measures

61 cases across **10 categories** — `control`, `date`, `domain`, `functions`,
`lambda`, `list`, `map`, `num`, `obj`, `text`. Each case hands the model a
request, an `argsType`, a `returnType`, and (often) a set of **distractor
functions** — 1–10 fns where only some are relevant — plus custom registered
types (`extend(obj({…}), { name })`). The model must emit a gin function body
that both **type-checks** and **produces the right value** across several inputs.

Two things make it harder than a syntax test:

- **A re-prompt loop.** A program that fails to parse or validate is fed gin's
  own compiler-style diagnostics and re-asked (`avgCalls > 1` ⇒ the model needed
  correction rounds). `tries` below is model requests per case (1 = one-shot).
- **Judgment, not just syntax.** The hardest cases reward *declining* an
  impossible request and *resisting* a plausible-but-wrong shortcut (see the
  universal failures below).

Schema **delivery** mirrors query's (`GIN_EVAL_MODE`): `auto` (default) tries the
wire schema and falls back to prompt-text on an empty/failed structured reply;
`structured` / `prompt` force one path. All numbers below are `auto`.

---

## Value leaderboard — current-code sweep (2026-07-11)

**The 5 leaderboard models, all re-run on the current code** — which now carries
three correctness improvements over the prior sweep: (1) missing-required-args is
a **validation error** (silent-wrong calls now reach the retry loop), (2) **+3
worked examples** (composite `new` / `if` / `reduce`), and (3) **deep "did you
mean?"** full-path prediction on unknown props. All 61 cases, default `auto`
delivery, **no reasoning**, **one run each**. Archives under
`integration/logs/runs/`; recompute with `node integration/reports/sweep/collect.cjs
&& node integration/reports/sweep/score.cjs`.

**Value score** ranks accuracy against cost and speed:

> score = 100 · (**0.60**·accuracyₙ + **0.20**·costₙ + **0.20**·speedₙ)

each term min-max normalized across the ranked set (cheaper & faster score
higher; accuracy dominates at 0.60). It is a **relative** score — "best value in
*this* set."

| # | Model | id | **score** | acc | tries | s/case | $/100 | acc Δ vs prior |
|---|-------|-----|----------:|----:|------:|-------:|------:|:--:|
| 1 | **Gemini 3.1 Flash Lite** | `google/gemini-3.1-flash-lite` | **96.4** | 90% | 1.30 | **2.3** | **$0.47** | **+13** (77→90) |
| 2 | Gemini 3 Flash (preview) | `google/gemini-3-flash-preview` | 90.1 | **92%** | **1.18** | 3.6 | $0.99 | +2 (90→92) |
| 3 | Gemini 2.5 Flash | `google/gemini-2.5-flash` | 68.0 | 84% | 1.64 | 4.7 | $0.84 | −3 (87→84)† |
| 4 | Claude Sonnet 4.6 | `anthropic/claude-sonnet-4.6` | 56.8 | 90% | 1.18 | 5.6 | $5.94 | −3 (93→90)† |
| 5 | Gemini 2.5 Flash Lite | `google/gemini-2.5-flash-lite` | 27.5 | 61% | 2.52 | 4.4 | $0.36 | +9 (52→61) |

_acc = cases passed / 61. tries = model requests/case (1 = one-shot). $/100 =
provider-reported `usage.cost` per 100 cases. s/case = wall-clock.
†single-run numbers carry ~±2–3 cases of variance, so the two small dips are
within noise; the two big gains (+13, +9) are well beyond it._

**What changed — the fixes help the WEAK models most:**

- **Gemini 3.1 Flash Lite leaps 77 → 90% (+13 cases) and takes #1 by value** —
  cheapest ($0.47) and fastest (2.3 s) *and* now frontier-adjacent on accuracy.
  It was the model dropping args and guessing prop names; the validation error +
  deep path prediction feed the retry loop exactly what it needs.
- **Gemini 2.5 Flash Lite climbs 52 → 61% (+9)** — still the floor, but the
  correction rounds now recover a third of what it used to miss.
- **The strong models are flat within noise** — Gemini 3 Flash preview 90→92%,
  and the two −3 dips (Gemini 2.5 Flash, Sonnet 4.6) are single-run variance.
  They rarely make the silent-arg / wrong-path mistakes the new features catch,
  so there's little for them to gain. Sonnet remains the accuracy-per-dollar
  loser at **$5.94/100** (10× the value pick).
- **Takeaway:** the diagnostics-driven improvements compress the field — the
  cheap Lite models now sit within a few points of the frontier, so the value
  case for the expensive models is weaker than ever.

---

## Where the models actually break

### Two cases fail on **every** capable model

Both are **judgment** cases, not syntax — the correct answer requires *not* doing
the plausible thing:

- **`domain-refuse-missing-data`** — "Return the customer's account balance,"
  but the only arg in scope is a numeric `subtotal`; no customer or balance
  exists and no fn provides one. The right move is to **decline** (emit a program
  that references nothing that isn't in scope). Every model instead reaches for a
  nonexistent `customer.balance` and gets rejected by `engine.validate`. Models
  fabricate rather than refuse.
- **`obj-net-pay`** — a distractor gauntlet: the withholding rate is hidden
  inside a specific `netPay` fn, surrounded by tempting wrong fns (`grossPay`,
  `deductionTotal`) and the option to inline a guessed rate. `usesFn('netPay')`
  is a hard gate. Models take the bait — a plausible fn that yields the wrong
  number — instead of the one that actually knows the rate.

The lesson: gin's accuracy ceiling isn't set by syntax fluency but by whether a
model will **refuse an impossible task** and **resist a plausible shortcut**.

### `lambda` still separates the tiers — but the gap narrowed

Higher-order cases (map / filter / reduce / sort / pipeline over lambdas) used to
be where the Lite models fell off a cliff. On the current code (per-category, 5
models):

| category | gemini-2.5-flash | gemini-3-flash-preview | gemini-3.1-flash-lite | sonnet-4.6 | gemini-2.5-flash-lite |
|----------|:---:|:---:|:---:|:---:|:---:|
| lambda   | 8/8 | 8/8 | 8/8 _(was 3/8)_ | 8/8 | **1/8** |
| num      | 6/8 | 6/8 | 6/8 | 8/8 | **4/8** |
| control  | 7/8 | 8/8 | 8/8 _(was 6/8)_ | 8/8 | **5/8** |
| text     | 8/8 | 7/8 | 7/8 | 7/8 | **4/8** |
| obj      | 6/8 | 7/8 | 6/8 | 6/8 | 6/8 |
| map      | 5/8 | 8/8 | 8/8 | 8/8 | 5/8 |
| date     | 7/8 | 8/8 | 8/8 | 6/8 | 8/8 |

**Gemini 3.1 Flash Lite recovered from 3/8 → 8/8 on `lambda`** (plus control
6→8, map 7→8) — that alone is most of its +13-case jump. Only
**gemini-2.5-flash-lite** still collapses on `lambda` (1/8), and it's the sole
model failing a *majority* of the higher-order cases. Above that floor everyone
now clears `lambda` cleanly, so it's a weaker discriminator than it was.

### The stubborn residue

Beyond the two universal judgment cases, the misses that survive across the
strong models cluster in the same fiddly spots: `text-reverse-tags` (an oracle
that keeps split-on-`,` whitespace, so a model's tidier trim reads as "wrong"),
`date-diff-days` (sign/direction of the delta), and a couple of `num` reductions
(`num-gcd`). These are arithmetic/semantic hair-splitting, not structural — and
`text-reverse-tags` is arguably a case-design quirk more than a model failure.

---

## How much the worked examples matter

`describe.ts` ships worked `(request → ExprDef → output)` examples that
`@aeye/ginny` itself ships **zero** of — so their lift is worth measuring. Held
on `google/gemini-3-flash-preview`, 61 cases, `auto` delivery, **4 seeds per
condition** (except the 0-example probe, 1 seed). Toggle with
`GIN_EVAL_NO_EXAMPLES=1`.

| Prompt | Pass (per seed) | Mean | vs prev |
|--------|-----------------|-----:|-------:|
| **No examples** (signature + type docs only) | 31 | **31 / 61 (51%)** | — |
| **4 examples** (the original set) | 54, 55, 55, 57 | **55.25 (91%)** | **+24** |
| **7 examples** (current — adds composite-`new` / `if` / `reduce`) | 56, 57, 58, 58 | **57.25 (94%)** | **+2** |

Two distinct lessons:

- **Examples are load-bearing for the wire format, not just the approach.**
  Without *any* examples, 9 cases never produce a type-checking `ExprDef` at all
  (0 such failures with examples), and ~17 more get the logic wrong — a 51% floor.
  The bulk of a real deployment's adherence rides on shipping a few examples.
- **The 3 added examples (+2) buy a targeted, mechanistic win**, concentrated in
  object *construction* — the original examples only showed `new` for scalars, so
  models fell back to `new {type:{name:'X', extends:'obj'}}` (no props → fields
  silently dropped). Over 4 seeds each, the composite-`new` example flips
  `obj-discount-product` **0/4 → 4/4** and `obj-build-person` **1/4 → 4/4**; the
  only "regressions" are single-seed noise flips (`num-gcd`, `text-reverse-tags`,
  `control-sign`, each −1), none a clean separation.

**Real-world takeaway:** don't hand a model a bare signature. A signature + type
docs alone lands ~51%; add a handful of worked examples — especially one showing
how to *construct* your custom types by bare name — and it clears ~94% on this
model.

_This examples-lift measurement was taken on the 7-example prompt as it was
being introduced; the leaderboard above is the later full re-run of all 5 models
on that same current code, so the two are consistent._

---

## Notes

- **The leaderboard is 5 models, all on current code (2026-07-11).** Four models
  from the original nine (`gpt-5-mini`, `gemini-3.5-flash`, `llama-4-maverick`,
  `deepseek-chat`) have **not** been re-run since the correctness fixes; their
  stale runs are intentionally excluded so every row is comparable. To add them,
  run each and re-collect — `collect.cjs` picks the newest full (61-case) run per
  slug, then `score.cjs` re-normalizes the value bands.
- **Single run per model.** These numbers carry ~±2–3 cases of run-to-run
  variance; treat small gaps as ties and only large deltas (the Lite jumps) as
  signal.
- **No reasoning tiers were swept.** Query's sweep found reasoning bought no
  accuracy on gemini/gpt-5-mini and only added latency; gin hasn't tested it, but
  the near-one-shot `tries` on the strong models (1.03–1.25) leaves little for
  reasoning to recover.
