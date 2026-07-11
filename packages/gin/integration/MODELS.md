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

## Value leaderboard — partial sweep (2026-07-11)

**5 of an intended 9-model set** — the four slower models (`gpt-5-mini`,
`gemini-3.5-flash`, `llama-4-maverick`, `deepseek-chat`) were cut short. All 61
cases, default `auto` delivery, **no reasoning**. Archives under
`integration/logs/runs/`; recompute with `node integration/reports/sweep/collect.cjs
&& node integration/reports/sweep/score.cjs`.

**Value score** ranks accuracy against cost and speed:

> score = 100 · (**0.60**·accuracyₙ + **0.20**·costₙ + **0.20**·speedₙ)

each term min-max normalized across the ranked set (cheaper & faster score
higher; accuracy dominates at 0.60). It is a **relative** score — "best value in
*this* set" — so the small 5-model set makes normalization sensitive; adding the
cut models would move the bands.

| # | Model | id | **score** | acc | tries | s/case | $/100 |
|---|-------|-----|----------:|----:|------:|-------:|------:|
| 1 | **Gemini 2.5 Flash** | `google/gemini-2.5-flash` | **89.1** | 87% | 1.25 | 3.0 | $0.62 |
| 2 | Gemini 3 Flash (preview) | `google/gemini-3-flash-preview` | 81.1 | 90% | 1.15 | 4.3 | $0.92 |
| 3 | Gemini 3.1 Flash Lite | `google/gemini-3.1-flash-lite` | 73.8 | 77% | 1.51 | 3.1 | **$0.56** |
| 4 | Claude Sonnet 4.6 | `anthropic/claude-sonnet-4.6` | 60.0 | **93%** | **1.03** | 5.3 | $4.92 |
| 5 | Gemini 2.5 Flash Lite | `google/gemini-2.5-flash-lite` | 20.6 | 52% | 2.34 | 5.2 | $0.31 |

_acc = cases passed / 61. tries = model requests/case (1 = one-shot). $/100 =
provider-reported `usage.cost` per 100 cases. s/case = wall-clock._

**What the score exposes:**

- **Gemini 2.5 Flash (#1, 89.1) is the value pick** — 87% at $0.62/100 and 3.0
  s/case, near one-shot (1.25 tries). It trails the frontier on raw accuracy by a
  few points but wins decisively on cost×speed.
- **Gemini 3 Flash preview (#2) is the accuracy-per-dollar sweet spot** — the
  best of the cheap models on raw accuracy (90%) and the fewest correction rounds
  of the Gemini line (1.15), for ~1.5× the champion's cost.
- **Claude Sonnet 4.6 (#4) is the accuracy leader that value can't justify
  here** — top accuracy (93%) and the cleanest one-shot rate (1.03 tries), but
  **$4.92/100 is 8× the champion** for +6 pts, so it ranks fourth. Use it when a
  correct first program matters more than price.
- **Gemini 2.5 Flash Lite (#5) is the floor** — 52%, and it needs the most
  correction rounds (2.34 tries). Being the cheapest ($0.31) can't rescue it; it
  fails a *majority* of `lambda` and `num` cases (below). Don't use it for gin.

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

### `lambda` is the capability discriminator

Higher-order cases (map / filter / reduce / sort / pipeline over lambdas) cleanly
separate the tiers — the strong models ace them, the weak ones collapse:

| category | gemini-2.5-flash | gemini-3-flash-preview | gemini-3.1-flash-lite | sonnet-4.6 | gemini-2.5-flash-lite |
|----------|:---:|:---:|:---:|:---:|:---:|
| lambda   | 8/8 | 8/8 | **3/8** | 8/8 | **1/8** |
| num      | 6/8 | 8/8 | 6/8 | 8/8 | **4/8** |
| control  | 6/8 | 8/8 | 6/8 | 8/8 | **4/8** |
| text     | 8/8 | 6/8 | 6/8 | 7/8 | **4/8** |
| obj      | 6/8 | 6/8 | 7/8 | 7/8 | 5/8 |
| map      | 7/8 | 8/8 | 7/8 | 8/8 | 5/8 |
| date     | 8/8 | 7/8 | 8/8 | 7/8 | 6/8 |

`lambda` is where the Lite models fall off a cliff (3/8 and 1/8) while everything
else stays within a case or two of full marks — a good single-signal proxy for
whether a model can handle gin's higher-order surface at all.

### Model-specific trip-ups

- **Gemini 3 Flash preview** loses points on `text` (6/8: `text-slugify`,
  `text-reverse-tags`) and `date-diff-days` — string-munging and date-delta
  arithmetic, not structure.
- **Gemini 2.5 Flash** stumbles on `control-fizzbuzz` / `control-first-index` and
  `num-gcd` / `num-average-list` — multi-branch control flow and numeric
  reductions.
- **Sonnet 4.6**'s only misses beyond the two universal cases are
  `text-reverse-tags` and `date-diff-days` — the same two "everyone finds these
  fiddly" cases the top Gemini hits.

---

## Notes

- **The sweep is partial (5/9).** To complete it, run the four cut models and
  re-collect; the value bands will re-normalize. `collect.cjs` picks the newest
  full (61-case) run per slug, so a fresh run just needs `collect.cjs` +
  `score.cjs`.
- **No reasoning tiers were swept.** Query's sweep found reasoning bought no
  accuracy on gemini/gpt-5-mini and only added latency; gin hasn't tested it, but
  the near-one-shot `tries` on the strong models (1.03–1.25) leaves little for
  reasoning to recover.
