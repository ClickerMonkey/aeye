# @aeye/schema: performance and memory, compared with the zod path

Phil: "I want notes on performance and memory usage etc. ideally comparing zod."

This compares `@aeye/schema` with what the monorepo does today, on the corpus's real schemas.

## How it was measured

**Machine.** Intel i7-9700 (8 threads, 3.0 GHz), 48 GB, Windows 11 (10.0.26300), Node v22.20.0. Numbers are from one full run of `npm run bench` and `npm run bench:memory` (2026-11-24, on this pass's final code).

**The two sides.**
- **@aeye/schema:** the corpus ports (`src/__tests__/corpus/`), bound and rendered with `asTool(profile)` as `planRequest` renders tools. Decoding uses `rendered.parse(wire)` (in place).
- **The zod path, as each package uses it today:**
  - render: `toJSONSchema(strictify(schema, d), d)`, as openai.ts's `convertTools` does for every request;
  - decode: `strictify(schema, d).safeParse(wire)`, as tool.ts and prompt.ts do;
  - errors: the `ZodError.message`, which is what a thrown parse error carries;
  - a request: `SchemaBudget` and per-tool allocation in priority order (ai's `allocateToolDescriptors`), then strictify and toJSONSchema per tool;
  - encode: `JSON.stringify` of the code value. The zod path has no wire encoder, so this is not the same output on strict profiles. It is only a floor.
  - Core's schema module comes from source (`packages/core/src/schema`). Core's dist predates the current strictify.

**The schemas** (`bench/cases.ts`):

| case | `a` side | zod side |
|---|---|---|
| `tool-small` | cletus `type_import` | hand-written zod twin |
| `tool-defaults` | cletus `image_find` (`.default`) | twin |
| `gin-value` | `fromGin(TaskDef)` | gin `registry.parse(TaskDef).toValueSchema()` |
| `harness-fn` | harness MCP server config (discriminated unions, records, defaults) | twin (URLs as a pattern: core's converter has no `ZodURL`) |
| `chart-1k` | cletus chart group | twin |
| `gin-grammar` | `WriteArgs` (`{program: Expr}`, the full TypeDef + Expr grammar) | `z.object({ program: buildSchemas(registry).Expr })` |
| `query-open` / `-names` / `-typed` / `-paired` | `{query: Query}` at `{}`, `functions: names`, `functions: typed`, `strict: true` | `@aeye/query` `buildSchemas(registry, same options).Query` |
| `product-query-set` | product's `query_set` (`strict: true`, `maxEnumSize: 100`, prefed catalog) | `buildSchemas(engine, { strict: true, maxEnumSize: 100 })`, built per call as product does |
| `request-8`, `request-129` | 8 / 129 tools cycling 5 corpus schemas, each with its own description | the same with the zod twins |
| `request-query-agent` | `query_set` + 4 small tools | the same |

**Profiles:** OpenAI strict, Anthropic strict, Gemini (`GOOGLE_STRICT`), lenient. Each is paired with core's descriptor of the same name.

**Like with like** (`bench/equivalence.ts`, `npm run bench:equivalence`):
- Every answer is encoded into each profile's wire shape by `a`. It is fed to both sides as is (valid), and with one field made wrong at a code path (invalid). Both sides must give the expected verdict.
- 163 of 184 pairs agree. The other 21 are the recursive grammars (gin, query) on Anthropic and Gemini, where `a` writes recursion as JSON text and core's cycle breaker expects a different shape.
- Those decodes are timed on the `a` side only (marked "—").
- The run stops if `a` ever disagrees with the expectation.

**Timing** uses tinybench 2.9:
- 250 ms of samples per operation after warm-up.
- Operations under 50 µs are timed in batches of k calls, and the result is per call.
- Calls over 50 ms (the zod path's Anthropic renders of query) are timed 3 times: the median is the middle one and the "p95" is the slowest.
- Decoding is in place, so each call gets a fresh `structuredClone` of the wire, made outside the timing.
- Each case runs in its own process, because the zod path keeps memory between calls (below).
- **Read the p95s as noise.** They are wide on this desktop machine; the medians are steady to about ±20% between runs, except the zod side of query.

**Memory** uses `node --expose-gc`, with full GCs before each reading:
- **Retained:** `process.memoryUsage().heapUsed` after building and rendering N schemas or binds on all 4 profiles and keeping them.
- **Released:** the same after dropping them.
- **Churn:** 100 query binds in a row with nothing kept.
- **Per-call garbage:** heap growth over k calls, with a 256 MB semi-space so no scavenge runs. Each loop is warmed up first and retried with fewer calls if a GC happened anyway.
- **Snapshot:** a heap snapshot (`v8.getHeapSnapshot`), grouped by constructor.

## Headline

| | @aeye/schema | zod path |
|---|---|---|
| render a schema again for the next request | memoized: ~0 µs, 0 bytes | recomputed every request: 10 µs (small tool) · 0.7 ms (gin) · 100–160 ms (query paired/typed, OpenAI) · **1.9–3.2 s (query on Anthropic)** |
| first render, small tool / harness fn | 45 µs / 290 µs | 92 µs / 674 µs |
| first render, query paired (OpenAI / Anthropic) | 22 ms / 34 ms | 171 ms / **3.1 s** |
| decode, small tool | 0.4–0.8 µs | 0.2–0.3 µs |
| decode, 1k chart rows | ~200 µs | ~75 µs |
| decode, gin 200-program block (OpenAI) | 5.6 ms | 33 ms |
| decode, query insert 1k rows (paired, OpenAI) | 3.4 ms | 0.7 s |
| reject + error message, small tool | 0.6–1.0 µs, 41 chars | 5.6–6.3 µs, 164 chars |
| reject + error message, query paired rich select | 50 µs, **54 chars** | 0.27 s, **39 MB** |
| reject, query paired insert 1k rows | 5 ms, 61 chars | 5 s, then reading the message **throws** (`RangeError: Invalid string length`) |
| 129-tool request (OpenAI): new tools / next turn | 21 ms / 0.66 ms | 111 ms / 9.5 ms (and sends all 129: over OpenAI's 128) |
| query agent request (query_set + 4), next turn | 29 µs | 85 ms |
| memory per query bind, 4 profiles, kept | 8.8 MB | 275 MB (most of it the Anthropic render's growth, below) |
| heap left after 100 query binds (3 profiles), nothing kept | 108 MB, flat after 16 (the bind LRU); 9.7 MB once the LRU is emptied | 234 MB, growing ~2 MB per bind, never freed |

## Conclusions

**Where `a` is faster, and why:**
- **Every request after the first.**
  - A `Bound` memoizes its rendering per profile, so a repeated request costs a map lookup.
  - The zod path runs strictify (cached) and then `toJSONSchema` (not cached) for every tool on every request.
  - For a query-sized schema that is 0.1–0.2 s per turn on OpenAI or Gemini, and 2–3 s on Anthropic.
- **Building and binding.**
  - Constructing an `a` schema is 20–50× cheaper than constructing the zod one: a few objects against zod's checks and wrappers.
  - A query bind with a new catalog costs 1–1.2 ms against `buildSchemas`' 2–15 ms. A cached bind costs under 1 µs.
- **First render of large or recursive grammars.** 4–20× faster than the zod path on OpenAI, Gemini and lenient, and 100–270× on Anthropic. The zod converter re-walks recursive lazies and builds its cycle-breaker placeholders by calling the lazy getters again.
- **Decoding big recursive answers.** 6–15× faster for gin programs. For query's paired grammar, 200–500×: the zod side tries every union option at every level and builds the nested failure for each.
- **Errors.** Rejecting a wrong answer costs `a` the same as accepting a right one, and the message is one line per problem at the path the model wrote (41–185 characters here). zod's message for a union-heavy schema is the whole tree of failed options:
  - 80 KB–10 MB for gin;
  - 1–180 MB for query;
  - for a 1k-row query insert, larger than V8's maximum string length, so reading `error.message` throws.

  Pass 4 (errors for the model) starts from this baseline.

**Where `a` is slower, and why:**
- **Small flat decodes.**
  - A 3-field tool answer decodes in ~0.5 µs against zod's ~0.25 µs. 1k flat chart rows take ~200 µs against ~75 µs.
  - zod 4 compiles a specialised parser per object shape. `a` walks closures through a generic `Node.run`, and keeps both a wire path and a code path for error reporting.
  - This is far below anything a model call costs (1k rows: 0.2 ms), but it is the one place zod wins on speed.
- **Encoding into the wire shape.** 2–10× `JSON.stringify` of the code value on strict profiles:
  - nulls for absent fields, pairs for records, the option of each untagged union found by checking the value;
  - on lenient, where the shapes match, it is the same as `JSON.stringify`;
  - the zod path has no encoder at all, so its prompts and examples write the code shape even where the model is asked for the wire shape.
- **Memory per small schema rendered on 4 profiles.**
  - `a` takes 50 KB / 383 KB / 179 KB (small tool / harness fn / gin value) against zod's 37 / 281 / 81 KB. The memoized JSON and the compiled nodes are kept, so the next request is free.
  - A 129-tool request kept alive takes 1.9 MB against 1.2 MB.

**What to watch:**
- **Per-bind memory of big grammars.**
  - A query bind rendered on 4 profiles keeps 8.8 MB. The heap snapshot shows ~4k nodes per bind, with ~19k closures and ~30k internal arrays.
  - The query port's bind LRU (`cacheSize: 16`) can therefore hold ~140 MB at its fullest.
  - When query is integrated, pick its default `cacheSize` with this in mind (4 holds ~35 MB), or render fewer profiles per bind.
  - The closure-per-node design is the cost. A leaner node representation would cut it.
- **Allocations per decoded value.**
  - After this pass, ~250 bytes of short-lived garbage per 1k-row chart row on the hot path (zod ~130).
  - A 1k-row query insert: 5 MB, against zod's 88 MB.
- **The invalid-answer path through untagged unions** (product `insert` with a bad enum value: 0.35 ms against 7 µs for the valid one). It tries each option to find the closest. That is fine at this size; pass 4 should keep it bounded when it adds "did you mean".

## Problems found and fixed in `packages/schema`

Each has a test in `src/__tests__/perf.test.ts`, and each fails without its fix.

1. **Encoding slowed down without bound, and leaked.**
   - `Rendered.nodeFor(s)` compiled the subschema again on every call.
   - Every encode through an untagged union asks for the options' lenient nodes, as does every union check (`matches`). So each value encoded added that option's whole subtree to the lenient compiler, and `finish()` re-walked all of it.
   - Before the fix:
     - 5 encodes of a 1k-row query insert added 5,000 nodes each time;
     - 40 rows took 1.5 s, 1k rows never finished;
     - a 200-program gin block took 240 ms.
   - Now `nodeFor` is memoized per subschema instance. 1k rows encode in 3 ms, and the gin block in 5–10 ms.
2. **Caches pinned stale binds.**
   - A ref-free node is cached per (schema, profile) in a `WeakMap`. But the node kept the compiler of the bind that first compiled it: that bind's env, nodes, lenient rendering and every profile it rendered.
   - For a static subtree (most of a grammar), that was one stale bind per profile for the life of the process.
   - Before the fix: 22 MB and 2 `Bound`s left after 200 query binds and an emptied LRU.
   - Now ref-free nodes compile in a per-profile shared compiler (`sharedCompiler(profile)`). It has no env and forgets its node list after the `needs` fixpoint, so it holds only the profile.
   - After the fix: 9.7 MB, the shared nodes of the static grammar, and no stale bind. The one `Bound` still alive is the loop's last.
3. **Decoding allocated per value.**
   - `Cx`'s path stacks used `push`/`pop`, which let V8 shrink and regrow the backing store at every level.
   - Open objects built an `Object.keys` list they never needed.
   - The field loops were `for…of`.
   - Now the stacks are arrays indexed by depth, the key list is only built when unknown keys matter, and the loops are indexed.
   - Garbage per 1k-row chart decode went from 817 KB to 260 KB, and per gin 200-program decode from 2.1 MB to 1.1 MB.

The global node cache stays a `WeakMap` keyed by schema instance. With fix 2 it retains nothing but the nodes of live schemas, so no LRU or tunable is needed. The bind caches were already bounded per bundle (`DynamicOptions.cacheSize`, default 4).

## Worrying, outside `packages/schema` (the zod path today)

These are measured here, not fixed here.

- **@aeye/query leaks every `buildSchemas` call.**
  - Its process-local `sharedIdRegistry` (a zod registry, aids.ts) keeps every generation's shared fragments in its id map forever, and the ids are salted per generation so they never repeat.
  - That is ~2 MB per call (62 MB freed by emptying the map after 30 calls).
  - product builds `query_set`'s schema per turn, so a long-lived product process grows without bound.
  - The bench empties that map between measurements (`bench/zod-registries.ts`) so the timing runs can finish.
- **Core's `toJSONSchema` grows the heap on every call for query schemas.**
  - About 2 MB per call on OpenAI and Gemini, and **~250 MB per call on Anthropic**, which also takes 2–3 s.
  - This is the "render again" path openai.ts takes on every request.
  - The likely cause is the cycle breaker: `genericize` calls `z.lazy`'s `def.getter()`, and query's lazies build fresh schemas.
  - The full bench needed per-case processes and a 12 GB heap to survive it. Before that it ran out of memory at 4 GB, then at 8 GB.
- **zod error messages for union-heavy schemas are unusable as model feedback**: megabytes, or a `RangeError` when read (above).
- **The zod path sends 129 tools** where OpenAI takes 128. `a` puts the overflow behind the dispatcher tool.

## Running it

- `npm run bench` runs everything (about 25 min). `-- --quick` samples less; `-- --only=query` runs the cases whose id contains "query".
- It prints the tables and writes `bench/.results/timings.json` and `rows-<case>.json`. `--only` re-runs merge with the earlier rows.
- `npm run bench:memory` writes `bench/.results/memory.json` (about 15 min). `-- --part=perCall` re-runs only the allocation counts.
- `npm run bench:equivalence` checks that the two sides give the same verdicts.

## All memory numbers

Generated by `npm run bench:memory`.

### Retained: N schemas / binds rendered on all 4 profiles and kept

| case | N | @aeye/schema per item | zod path per item | @aeye/schema left after release | zod path left after release |
|---|---|---|---|---|---|
| tool-small | 1000 | 0.05 MB | 0.037 MB | 1.12 MB | 1.18 MB |
| harness-fn | 500 | 0.383 MB | 0.281 MB | 3.55 MB | 1.73 MB |
| gin-value | 500 | 0.179 MB | 0.081 MB | 1.98 MB | 1.09 MB |
| gin-grammar | 20 | 1.927 MB | 2.461 MB | 3.21 MB | 5.96 MB |
| query-open | 10 | 2.254 MB | 14.666 MB | 22.54 MB | 31.68 MB |
| query-paired | 10 | 8.841 MB | 275.491 MB | 89.21 MB | 593.89 MB |
| product-query-set | 10 | 9.381 MB | 260.018 MB | 93.8 MB | 564.16 MB |

"Left after release" for the `a` query cases is the bind LRU (`cacheSize: 16` in the query port), which still holds the 10 binds; for zod it is the leaks described above.

### Heap snapshot after 10 query-paired binds (4 profiles each), biggest kinds

| kind | count | MB |
|---|---|---|
| (array) | 303311 | 59.22 |
| (string) | 55809 | 10.68 |
| closure | 194874 | 10.42 |
| Object | 148474 | 7.8 |
| (code) | 66819 | 6.83 |
| system / Context | 43269 | 3.38 |
| Node | 40113 | 3.37 |
| Array | 93078 | 2.84 |
| (hidden) | 42565 | 1.65 |
| (object shape) | 15761 | 1.47 |
| (native) | 1728 | 0.99 |
| Set | 29352 | 0.9 |

### Churn: 100 query-paired binds in a row (new catalog each, 3 profiles, nothing kept)

| | after 16 | after 50 | after 100 | after emptying the bind LRU |
|---|---|---|---|---|
| @aeye/schema | 106.95 MB | 108.25 MB | 108.37 MB | 9.68 MB (live: {Compiler:6,Bound:1,Rendered:3,Node:3124}) |
| zod path | 51.96 MB | 125.91 MB | 233.93 MB | — |

Before fix 2 the `a` row ended at 22.3 MB with 2 live `Bound`s and 8 compilers.

### Heap kept per "render again" (same schema, next request) — zod path

| case | profile | zod path MB per call | @aeye/schema |
|---|---|---|---|
| query-open | openai-strict | 0.52 | 0 |
| query-open | anthropic-strict | 11.41 | 0 |
| query-open | gemini | 0.48 | 0 |
| query-names | openai-strict | 0.86 | 0 |
| query-names | anthropic-strict | 19.22 | 0 |
| query-names | gemini | 0.82 | 0 |
| query-typed | openai-strict | 2.37 | 0 |
| query-typed | anthropic-strict | 244.15 | 0 |
| query-typed | gemini | 2.17 | 0 |
| query-paired | openai-strict | 2.5 | 0 |
| query-paired | anthropic-strict | 257.17 | 0 |
| query-paired | gemini | 2.38 | 0 |
| product-query-set | openai-strict | 2.45 | 0 |
| product-query-set | anthropic-strict | 240.97 | 0 |
| product-query-set | gemini | 2.33 | 0 |

Every other case keeps < 0.1 MB per call on both sides.

### Requests kept alive (OpenAI strict)

| request | @aeye/schema per request | zod path per request |
|---|---|---|
| request-8 | 0.14 MB | 0.06 MB |
| request-129 | 1.91 MB | 1.17 MB |
| request-query-agent | 0.18 MB | 1.27 MB |

### Garbage per call (KB allocated, short-lived)

| case | profile | answer | wire KB | a decode | a copies (objects/arrays/edits/JSON parsed) | zod decode | a render again | zod render again | a encode | JSON.stringify |
|---|---|---|---|---|---|---|---|---|---|---|
| tool-small | openai-strict | args | 0.1 | 1.47 | 0/0/1/0 | 1.69 | 0.019 | 9.7 | 0.63 | 0.09 |
| tool-small | lenient | args | 0 | 1.2 | 0/0/0/0 | 0.7 | 0.001 | 6.8 | 0.08 | 0.07 |
| harness-fn | openai-strict | config | 0.4 | 6.2 | 2/0/4/0 | 13.04 | 0.001 | 67.3 | 1.43 | 0.33 |
| harness-fn | lenient | config | 0.3 | 4.67 | 0/0/0/0 | 5.1 | 0.001 | 52.5 | 0.56 | 0.33 |
| chart-1k | openai-strict | 1k rows | 34.4 | 260.55 | 0/0/1/0 | 134.61 | 0.001 | 23 | 0.26 | 35.5 |
| chart-1k | lenient | 1k rows | 34.4 | 260.13 | 0/0/0/0 | 133.74 | 0.001 | 16.6 | 0.09 | 35.5 |
| gin-grammar | openai-strict | block of 200 programs | 145.8 | 1102.03 | 200/0/3401/1000 | 21389.97 | 0.001 | 524.1 | 3462.57 | 122.56 |
| gin-grammar | lenient | block of 200 programs | 109.4 | 5849.93 | 0/0/0/0 | 14390.92 | 0 | 433.4 | 0.06 | 122.56 |
| query-paired | openai-strict | insert 1k rows | 64.6 | 5113.51 | 0/0/3/0 | 87667.16 | 0 | 3761.6 | 3027.46 | 81.96 |
| query-paired | lenient | insert 1k rows | 64.5 | 5104.69 | 0/0/0/0 | 75497.52 | 0 | 4360.1 | 2904.57 | 81.96 |
| product-query-set | openai-strict | insert | 0.2 | 12.66 | 0/0/6/0 | 19.36 | 0 | 3701.9 | 4.71 | 0.18 |
| product-query-set | lenient | insert | 0.2 | 12.01 | 0/0/0/0 | 14.67 | 0 | 4380.6 | 4.6 | 0.18 |

## All timings

Generated by `npm run bench` (median, with p95 in parentheses; "zod ÷ a" > 1 means `a` is faster).

Node v22.20.0, Intel(R) Core(TM) i7-9700 CPU @ 3.00GHz (8 threads), 48 GB, Windows_NT 10.0.26300.

### build

| case | profile | operation | @aeye/schema median (p95) | zod path median (p95) | zod ÷ a |
|---|---|---|---|---|---|
| tool-small | - | build | 0.8 µs (0.9 µs) | 19 µs (22 µs) | 24× |
| tool-defaults | - | build | 1.1 µs (1.8 µs) | 27 µs (46 µs) | 26× |
| gin-value | - | build | 22 µs (462 µs) | 252 µs (8.9 ms) | 12× |
| harness-fn | - | build | 5.9 µs (6.4 µs) | 224 µs (328 µs) | 38× |
| chart-1k | - | build | 1.8 µs (2.1 µs) | 47 µs (56 µs) | 26× |
| gin-grammar | - | bind, new key | 40 µs (330 µs) | 16 µs (21 µs) | 0.4× |
| gin-grammar | - | bind, cached | 0.2 µs (0.2 µs) | — | — |
| query-open | - | bind, new key | 97 µs (121 µs) | 634 µs (5.6 ms) | 6.5× |
| query-open | - | bind, cached | 0.2 µs (0.3 µs) | — | — |
| query-names | - | bind, new key | 109 µs (138 µs) | 677 µs (1.1 ms) | 6.2× |
| query-names | - | bind, cached | 0.6 µs (0.7 µs) | — | — |
| query-typed | - | bind, new key | 338 µs (480 µs) | 660 µs (4.3 ms) | 2.0× |
| query-typed | - | bind, cached | 0.6 µs (0.6 µs) | — | — |
| query-paired | - | bind, new key | 975 µs (34.0 ms) | 2.3 ms (93.6 ms) | 2.3× |
| query-paired | - | bind, cached | 0.5 µs (2.0 µs) | — | — |
| product-query-set | - | bind, new key | 1.2 ms (43.7 ms) | 15.1 ms (173 ms) | 12× |
| product-query-set | - | bind, cached | 0.6 µs (2.5 µs) | — | — |

### render

| case | profile | operation | @aeye/schema median (p95) | zod path median (p95) | zod ÷ a |
|---|---|---|---|---|---|
| tool-small | openai-strict | build + first render | 45 µs (75 µs) | 92 µs (175 µs) | 2.0× |
| tool-small | openai-strict | render again | 0.0 µs (0.0 µs) | 10 µs (11 µs) | memoized |
| tool-small | anthropic-strict | build + first render | 30 µs (44 µs) | 69 µs (81 µs) | 2.3× |
| tool-small | anthropic-strict | render again | 0.0 µs (0.0 µs) | 8.1 µs (9.3 µs) | memoized |
| tool-small | gemini | build + first render | 30 µs (41 µs) | 68 µs (78 µs) | 2.3× |
| tool-small | gemini | render again | 0.0 µs (0.0 µs) | 9.0 µs (15 µs) | memoized |
| tool-small | lenient | build + first render | 31 µs (52 µs) | 41 µs (55 µs) | 1.3× |
| tool-small | lenient | render again | 0.0 µs (0.0 µs) | 7.4 µs (12 µs) | memoized |
| tool-defaults | openai-strict | build + first render | 36 µs (88 µs) | 113 µs (185 µs) | 3.2× |
| tool-defaults | openai-strict | render again | 0.0 µs (0.0 µs) | 16 µs (17 µs) | memoized |
| tool-defaults | anthropic-strict | build + first render | 28 µs (35 µs) | 99 µs (115 µs) | 3.5× |
| tool-defaults | anthropic-strict | render again | 0.0 µs (0.0 µs) | 15 µs (16 µs) | memoized |
| tool-defaults | gemini | build + first render | 29 µs (34 µs) | 99 µs (111 µs) | 3.4× |
| tool-defaults | gemini | render again | 0.0 µs (0.0 µs) | 15 µs (16 µs) | memoized |
| tool-defaults | lenient | build + first render | 29 µs (34 µs) | 46 µs (53 µs) | 1.6× |
| tool-defaults | lenient | render again | 0.0 µs (0.0 µs) | 12 µs (15 µs) | memoized |
| gin-value | openai-strict | build + first render | 215 µs (2.9 ms) | 490 µs (8.9 ms) | 2.3× |
| gin-value | openai-strict | render again | 0.0 µs (0.0 µs) | 46 µs (88 µs) | memoized |
| gin-value | anthropic-strict | build + first render | 172 µs (1.5 ms) | 435 µs (5.9 ms) | 2.5× |
| gin-value | anthropic-strict | render again | 0.0 µs (0.0 µs) | 46 µs (583 µs) | memoized |
| gin-value | gemini | build + first render | 173 µs (1.2 ms) | 586 µs (5.8 ms) | 3.4× |
| gin-value | gemini | render again | 0.0 µs (0.0 µs) | 42 µs (174 µs) | memoized |
| gin-value | lenient | build + first render | 160 µs (2.7 ms) | 317 µs (1.5 ms) | 2.0× |
| gin-value | lenient | render again | 0.0 µs (0.0 µs) | 40 µs (366 µs) | memoized |
| harness-fn | openai-strict | build + first render | 290 µs (385 µs) | 674 µs (1.0 ms) | 2.3× |
| harness-fn | openai-strict | render again | 0.0 µs (0.0 µs) | 116 µs (156 µs) | memoized |
| harness-fn | anthropic-strict | build + first render | 233 µs (324 µs) | 730 µs (1.1 ms) | 3.1× |
| harness-fn | anthropic-strict | render again | 0.0 µs (0.0 µs) | 112 µs (125 µs) | memoized |
| harness-fn | gemini | build + first render | 225 µs (288 µs) | 656 µs (950 µs) | 2.9× |
| harness-fn | gemini | render again | 0.0 µs (0.0 µs) | 111 µs (125 µs) | memoized |
| harness-fn | lenient | build + first render | 223 µs (273 µs) | 404 µs (513 µs) | 1.8× |
| harness-fn | lenient | render again | 0.0 µs (0.0 µs) | 92 µs (105 µs) | memoized |
| chart-1k | openai-strict | build + first render | 80 µs (107 µs) | 182 µs (230 µs) | 2.3× |
| chart-1k | openai-strict | render again | 0.0 µs (0.0 µs) | 27 µs (32 µs) | memoized |
| chart-1k | anthropic-strict | build + first render | 69 µs (108 µs) | 177 µs (275 µs) | 2.6× |
| chart-1k | anthropic-strict | render again | 0.0 µs (0.0 µs) | 26 µs (31 µs) | memoized |
| chart-1k | gemini | build + first render | 64 µs (81 µs) | 182 µs (646 µs) | 2.9× |
| chart-1k | gemini | render again | 0.0 µs (0.0 µs) | 23 µs (33 µs) | memoized |
| chart-1k | lenient | build + first render | 62 µs (72 µs) | 91 µs (102 µs) | 1.5× |
| chart-1k | lenient | render again | 0.0 µs (0.0 µs) | 20 µs (22 µs) | memoized |
| gin-grammar | openai-strict | build + first render | 910 µs (4.4 ms) | 5.1 ms (9.0 ms) | 5.6× |
| gin-grammar | openai-strict | render again | 0.0 µs (0.0 µs) | 730 µs (1.2 ms) | memoized |
| gin-grammar | anthropic-strict | build + first render | 1.5 ms (6.7 ms) | 25.0 ms (37.9 ms) | 16× |
| gin-grammar | anthropic-strict | render again | 0.0 µs (0.0 µs) | 3.0 ms (4.1 ms) | memoized |
| gin-grammar | gemini | build + first render | 1.1 ms (4.5 ms) | 6.2 ms (13.3 ms) | 5.6× |
| gin-grammar | gemini | render again | 0.0 µs (0.0 µs) | 669 µs (1.2 ms) | memoized |
| gin-grammar | lenient | build + first render | 1.0 ms (5.9 ms) | 3.6 ms (8.5 ms) | 3.6× |
| gin-grammar | lenient | render again | 0.0 µs (0.0 µs) | 776 µs (1.6 ms) | memoized |
| query-open | openai-strict | build + first render | 1.4 ms (7.0 ms) | 4.7 ms (10.3 ms) | 3.3× |
| query-open | openai-strict | render again | 0.0 µs (0.0 µs) | 2.8 ms (7.8 ms) | memoized |
| query-open | anthropic-strict | build + first render | 1.5 ms (5.8 ms) | 66.6 ms (71.1 ms) | 45× |
| query-open | anthropic-strict | render again | 0.0 µs (0.0 µs) | 60.7 ms (70.5 ms) | memoized |
| query-open | gemini | build + first render | 1.5 ms (5.8 ms) | 7.8 ms (15.0 ms) | 5.1× |
| query-open | gemini | render again | 0.0 µs (0.1 µs) | 7.4 ms (37.4 ms) | memoized |
| query-open | lenient | build + first render | 1.2 ms (5.5 ms) | 4.1 ms (9.5 ms) | 3.3× |
| query-open | lenient | render again | 0.0 µs (0.0 µs) | 2.0 ms (5.4 ms) | memoized |
| query-names | openai-strict | build + first render | 1.4 ms (6.9 ms) | 6.8 ms (13.0 ms) | 5.1× |
| query-names | openai-strict | render again | 0.0 µs (0.0 µs) | 4.8 ms (11.5 ms) | memoized |
| query-names | anthropic-strict | build + first render | 1.4 ms (5.0 ms) | 88.2 ms (91.1 ms) | 64× |
| query-names | anthropic-strict | render again | 0.0 µs (0.0 µs) | 82.5 ms (93.8 ms) | memoized |
| query-names | gemini | build + first render | 1.3 ms (4.8 ms) | 8.7 ms (12.6 ms) | 6.5× |
| query-names | gemini | render again | 0.0 µs (0.0 µs) | 4.3 ms (8.4 ms) | memoized |
| query-names | lenient | build + first render | 1.2 ms (5.4 ms) | 6.2 ms (10.6 ms) | 5.0× |
| query-names | lenient | render again | 0.0 µs (0.0 µs) | 2.8 ms (5.8 ms) | memoized |
| query-typed | openai-strict | build + first render | 4.4 ms (8.9 ms) | 17.4 ms (20.0 ms) | 3.9× |
| query-typed | openai-strict | render again | 0.0 µs (0.0 µs) | 13.3 ms (39.0 ms) | memoized |
| query-typed | anthropic-strict | build + first render | 6.3 ms (22.6 ms) | 1141 ms (1512 ms) | 180× |
| query-typed | anthropic-strict | render again | 0.0 µs (0.0 µs) | 1109 ms (1167 ms) | memoized |
| query-typed | gemini | build + first render | 5.1 ms (15.2 ms) | 29.4 ms (35.6 ms) | 5.8× |
| query-typed | gemini | render again | 0.0 µs (0.0 µs) | 16.0 ms (18.2 ms) | memoized |
| query-typed | lenient | build + first render | 11.5 ms (73.8 ms) | 22.9 ms (31.1 ms) | 2.0× |
| query-typed | lenient | render again | 0.0 µs (0.0 µs) | 17.4 ms (60.5 ms) | memoized |
| query-paired | openai-strict | build + first render | 21.8 ms (67.4 ms) | 171 ms (247 ms) | 7.9× |
| query-paired | openai-strict | render again | 0.0 µs (0.0 µs) | 157 ms (176 ms) | memoized |
| query-paired | anthropic-strict | build + first render | 34.0 ms (61.3 ms) | 3149 ms (3804 ms) | 93× |
| query-paired | anthropic-strict | render again | 0.0 µs (0.0 µs) | 3232 ms (3527 ms) | memoized |
| query-paired | gemini | build + first render | 10.0 ms (31.7 ms) | 191 ms (342 ms) | 19× |
| query-paired | gemini | render again | 0.0 µs (0.1 µs) | 134 ms (286 ms) | memoized |
| query-paired | lenient | build + first render | 29.1 ms (140 ms) | 294 ms (454 ms) | 10× |
| query-paired | lenient | render again | 0.0 µs (0.0 µs) | 97.6 ms (103 ms) | memoized |
| product-query-set | openai-strict | build + first render | 49.3 ms (84.5 ms) | 183 ms (198 ms) | 3.7× |
| product-query-set | openai-strict | render again | 0.0 µs (0.0 µs) | 105 ms (137 ms) | memoized |
| product-query-set | anthropic-strict | build + first render | 16.6 ms (64.4 ms) | 4520 ms (7168 ms) | 272× |
| product-query-set | anthropic-strict | render again | 0.0 µs (0.0 µs) | 1933 ms (2392 ms) | memoized |
| product-query-set | gemini | build + first render | 8.0 ms (16.0 ms) | 35.8 ms (42.5 ms) | 4.5× |
| product-query-set | gemini | render again | 0.0 µs (0.0 µs) | 20.5 ms (25.6 ms) | memoized |
| product-query-set | lenient | build + first render | 7.7 ms (16.4 ms) | 21.6 ms (23.9 ms) | 2.8× |
| product-query-set | lenient | render again | 0.0 µs (0.0 µs) | 7.8 ms (13.1 ms) | memoized |

### decode

| case | profile | operation | @aeye/schema median (p95) | zod path median (p95) | zod ÷ a |
|---|---|---|---|---|---|
| tool-small | openai-strict | decode: args | 0.8 µs (0.9 µs) | 0.3 µs (0.7 µs) | 0.4× |
| tool-small | openai-strict | reject + message: args | 1.0 µs (1.2 µs) | 6.3 µs (6.9 µs) | 6.4× |
| tool-small | anthropic-strict | decode: args | 0.5 µs (0.7 µs) | 0.2 µs (0.5 µs) | 0.5× |
| tool-small | anthropic-strict | reject + message: args | 0.6 µs (0.9 µs) | 5.8 µs (6.5 µs) | 9.1× |
| tool-small | gemini | decode: args | 0.4 µs (0.7 µs) | 0.2 µs (0.4 µs) | 0.5× |
| tool-small | gemini | reject + message: args | 0.6 µs (0.8 µs) | 5.7 µs (6.4 µs) | 9.3× |
| tool-small | lenient | decode: args | 0.4 µs (0.6 µs) | 0.2 µs (0.4 µs) | 0.5× |
| tool-small | lenient | reject + message: args | 0.6 µs (0.7 µs) | 5.6 µs (6.1 µs) | 9.5× |
| tool-defaults | openai-strict | decode: args | 0.4 µs (0.7 µs) | 0.4 µs (0.6 µs) | 0.9× |
| tool-defaults | openai-strict | reject + message: args | 0.6 µs (0.8 µs) | 6.2 µs (9.7 µs) | 10× |
| tool-defaults | anthropic-strict | decode: args | 0.5 µs (0.6 µs) | 0.4 µs (0.4 µs) | 0.8× |
| tool-defaults | anthropic-strict | reject + message: args | 0.6 µs (0.7 µs) | 5.9 µs (6.6 µs) | 10.0× |
| tool-defaults | gemini | decode: args | 0.4 µs (0.5 µs) | 0.4 µs (0.5 µs) | 0.9× |
| tool-defaults | gemini | reject + message: args | 0.6 µs (0.8 µs) | 5.9 µs (6.4 µs) | 10.0× |
| tool-defaults | lenient | decode: args | 0.4 µs (0.7 µs) | 0.2 µs (0.3 µs) | 0.5× |
| tool-defaults | lenient | reject + message: args | 0.6 µs (1.0 µs) | 6.1 µs (11 µs) | 9.7× |
| gin-value | openai-strict | decode: task | 3.5 µs (42 µs) | 1.7 µs (10 µs) | 0.5× |
| gin-value | openai-strict | reject + message: task | 4.0 µs (20 µs) | 11 µs (61 µs) | 2.6× |
| gin-value | anthropic-strict | decode: task | 3.6 µs (23 µs) | 1.9 µs (18 µs) | 0.5× |
| gin-value | anthropic-strict | reject + message: task | 4.1 µs (32 µs) | 9.8 µs (66 µs) | 2.4× |
| gin-value | gemini | decode: task | 2.3 µs (20 µs) | 1.8 µs (7.8 µs) | 0.8× |
| gin-value | gemini | reject + message: task | 2.7 µs (18 µs) | 10 µs (75 µs) | 3.7× |
| gin-value | lenient | decode: task | 2.5 µs (11 µs) | 1.7 µs (10 µs) | 0.7× |
| gin-value | lenient | reject + message: task | 2.7 µs (15 µs) | 10 µs (44 µs) | 3.8× |
| harness-fn | openai-strict | decode: config | 5.0 µs (6.7 µs) | 6.3 µs (7.3 µs) | 1.3× |
| harness-fn | openai-strict | reject + message: config | 5.4 µs (6.1 µs) | 17 µs (19 µs) | 3.2× |
| harness-fn | anthropic-strict | decode: config | 3.5 µs (4.6 µs) | 6.3 µs (7.2 µs) | 1.8× |
| harness-fn | anthropic-strict | reject + message: config | 3.9 µs (4.7 µs) | 17 µs (21 µs) | 4.4× |
| harness-fn | gemini | decode: config | 2.8 µs (3.6 µs) | 5.5 µs (6.7 µs) | 2.0× |
| harness-fn | gemini | reject + message: config | 3.2 µs (4.4 µs) | 16 µs (24 µs) | 5.0× |
| harness-fn | lenient | decode: config | 2.9 µs (4.1 µs) | 3.5 µs (4.8 µs) | 1.2× |
| harness-fn | lenient | reject + message: config | 3.2 µs (3.9 µs) | 12 µs (14 µs) | 3.9× |
| chart-1k | openai-strict | decode: 10 rows | 2.9 µs (3.6 µs) | 1.1 µs (1.5 µs) | 0.4× |
| chart-1k | openai-strict | reject + message: 10 rows | 3.5 µs (4.6 µs) | 9.3 µs (15 µs) | 2.6× |
| chart-1k | openai-strict | decode: 1k rows | 198 µs (232 µs) | 72 µs (103 µs) | 0.4× |
| chart-1k | openai-strict | reject + message: 1k rows | 196 µs (269 µs) | 88 µs (165 µs) | 0.4× |
| chart-1k | anthropic-strict | decode: 10 rows | 2.6 µs (3.2 µs) | 1.0 µs (1.5 µs) | 0.4× |
| chart-1k | anthropic-strict | reject + message: 10 rows | 2.8 µs (3.6 µs) | 7.5 µs (8.6 µs) | 2.7× |
| chart-1k | anthropic-strict | decode: 1k rows | 202 µs (315 µs) | 84 µs (139 µs) | 0.4× |
| chart-1k | anthropic-strict | reject + message: 1k rows | 215 µs (287 µs) | 92 µs (178 µs) | 0.4× |
| chart-1k | gemini | decode: 10 rows | 2.6 µs (3.0 µs) | 1.3 µs (2.1 µs) | 0.5× |
| chart-1k | gemini | reject + message: 10 rows | 2.9 µs (3.5 µs) | 8.3 µs (11 µs) | 2.9× |
| chart-1k | gemini | decode: 1k rows | 194 µs (236 µs) | 85 µs (110 µs) | 0.4× |
| chart-1k | gemini | reject + message: 1k rows | 205 µs (260 µs) | 95 µs (159 µs) | 0.5× |
| chart-1k | lenient | decode: 10 rows | 2.5 µs (3.3 µs) | 1.1 µs (2.2 µs) | 0.4× |
| chart-1k | lenient | reject + message: 10 rows | 2.9 µs (3.9 µs) | 7.6 µs (9.3 µs) | 2.6× |
| chart-1k | lenient | decode: 1k rows | 211 µs (271 µs) | 66 µs (86 µs) | 0.3× |
| chart-1k | lenient | reject + message: 1k rows | 191 µs (241 µs) | 100 µs (186 µs) | 0.5× |
| gin-grammar | openai-strict | decode: everything program | 126 µs (213 µs) | 1.3 ms (2.2 ms) | 11× |
| gin-grammar | openai-strict | reject + message: everything program | 70 µs (120 µs) | 1.8 ms (3.1 ms) | 26× |
| gin-grammar | openai-strict | decode: block of 200 programs | 5.6 ms (6.3 ms) | 32.5 ms (45.5 ms) | 5.8× |
| gin-grammar | openai-strict | reject + message: block of 200 programs | 5.6 ms (6.3 ms) | 36.6 ms (50.4 ms) | 6.6× |
| gin-grammar | openai-strict | decode: if 60 deep | 860 µs (1.4 ms) | 3.1 ms (4.2 ms) | 3.6× |
| gin-grammar | openai-strict | reject + message: if 60 deep | 33 µs (48 µs) | 5.7 ms (13.3 ms) | 171× |
| gin-grammar | anthropic-strict | decode: everything program | 126 µs (148 µs) | — | — |
| gin-grammar | anthropic-strict | reject + message: everything program | 93 µs (124 µs) | 531 µs (3.3 ms) | 5.7× |
| gin-grammar | anthropic-strict | decode: block of 200 programs | 10.1 ms (23.1 ms) | — | — |
| gin-grammar | anthropic-strict | reject + message: block of 200 programs | 8.8 ms (22.4 ms) | 7.5 ms (16.2 ms) | 0.9× |
| gin-grammar | anthropic-strict | decode: if 60 deep | 1.6 ms (12.5 ms) | — | — |
| gin-grammar | anthropic-strict | reject + message: if 60 deep | 228 µs (3.2 ms) | 553 µs (9.8 ms) | 2.4× |
| gin-grammar | gemini | decode: everything program | 92 µs (159 µs) | — | — |
| gin-grammar | gemini | reject + message: everything program | 46 µs (108 µs) | 1.7 ms (3.1 ms) | 37× |
| gin-grammar | gemini | decode: block of 200 programs | 5.9 ms (8.1 ms) | — | — |
| gin-grammar | gemini | reject + message: block of 200 programs | 5.4 ms (7.1 ms) | 85.4 ms (156 ms) | 16× |
| gin-grammar | gemini | decode: if 60 deep | 632 µs (1.3 ms) | 3.0 ms (4.0 ms) | 4.7× |
| gin-grammar | gemini | reject + message: if 60 deep | 21 µs (38 µs) | 4.4 ms (6.7 ms) | 204× |
| gin-grammar | lenient | decode: everything program | 95 µs (267 µs) | 1.8 ms (8.2 ms) | 19× |
| gin-grammar | lenient | reject + message: everything program | 64 µs (434 µs) | 3.8 ms (8.5 ms) | 60× |
| gin-grammar | lenient | decode: block of 200 programs | 7.9 ms (71.4 ms) | 96.7 ms (173 ms) | 12× |
| gin-grammar | lenient | reject + message: block of 200 programs | 7.8 ms (54.3 ms) | 106 ms (110 ms) | 14× |
| gin-grammar | lenient | decode: if 60 deep | 814 µs (2.6 ms) | 4.1 ms (7.2 ms) | 5.0× |
| gin-grammar | lenient | reject + message: if 60 deep | 33 µs (88 µs) | 4.9 ms (7.5 ms) | 146× |
| query-open | openai-strict | decode: rich select | 30 µs (50 µs) | 956 µs (3.7 ms) | 32× |
| query-open | openai-strict | reject + message: rich select | 30 µs (35 µs) | 13.2 ms (17.5 ms) | 443× |
| query-open | openai-strict | decode: insert 1k rows | 4.3 ms (6.8 ms) | 18.6 ms (23.0 ms) | 4.4× |
| query-open | openai-strict | reject + message: insert 1k rows | 4.7 ms (7.9 ms) | 16.5 ms (23.5 ms) | 3.5× |
| query-open | openai-strict | decode: expr 100 deep | 136 µs (182 µs) | 1.1 ms (3.9 ms) | 8.4× |
| query-open | openai-strict | reject + message: expr 100 deep | 140 µs (194 µs) | 40.6 ms (47.2 ms) | 289× |
| query-open | anthropic-strict | decode: rich select | 35 µs (45 µs) | — | — |
| query-open | anthropic-strict | reject + message: rich select | 36 µs (53 µs) | 22.0 ms (45.4 ms) | 605× |
| query-open | anthropic-strict | decode: insert 1k rows | 4.2 ms (5.1 ms) | 17.4 ms (20.4 ms) | 4.2× |
| query-open | anthropic-strict | reject + message: insert 1k rows | 4.6 ms (5.9 ms) | 15.8 ms (22.3 ms) | 3.4× |
| query-open | anthropic-strict | decode: expr 100 deep | 189 µs (215 µs) | — | — |
| query-open | anthropic-strict | reject + message: expr 100 deep | 196 µs (309 µs) | 4.5 ms (7.3 ms) | 23× |
| query-open | gemini | decode: rich select | 34 µs (124 µs) | — | — |
| query-open | gemini | reject + message: rich select | 35 µs (118 µs) | 77.4 ms (121 ms) | 2208× |
| query-open | gemini | decode: insert 1k rows | 3.0 ms (7.4 ms) | 21.1 ms (101 ms) | 7.0× |
| query-open | gemini | reject + message: insert 1k rows | 3.9 ms (29.3 ms) | 45.4 ms (46.6 ms) | 12× |
| query-open | gemini | decode: expr 100 deep | 214 µs (873 µs) | — | — |
| query-open | gemini | reject + message: expr 100 deep | 216 µs (990 µs) | 4.9 ms (11.2 ms) | 23× |
| query-open | lenient | decode: rich select | 23 µs (63 µs) | 1.2 ms (2.7 ms) | 50× |
| query-open | lenient | reject + message: rich select | 25 µs (79 µs) | 22.3 ms (71.4 ms) | 889× |
| query-open | lenient | decode: insert 1k rows | 2.5 ms (5.7 ms) | 21.8 ms (25.3 ms) | 8.7× |
| query-open | lenient | reject + message: insert 1k rows | 3.4 ms (22.1 ms) | 20.0 ms (33.4 ms) | 6.0× |
| query-open | lenient | decode: expr 100 deep | 114 µs (180 µs) | 1.1 ms (1.8 ms) | 9.7× |
| query-open | lenient | reject + message: expr 100 deep | 113 µs (169 µs) | 40.5 ms (63.1 ms) | 359× |
| query-names | openai-strict | decode: rich select | 32 µs (54 µs) | 996 µs (2.1 ms) | 31× |
| query-names | openai-strict | reject + message: rich select | 31 µs (46 µs) | 26.0 ms (28.5 ms) | 826× |
| query-names | openai-strict | decode: insert 1k rows | 4.5 ms (5.7 ms) | 15.6 ms (17.9 ms) | 3.5× |
| query-names | openai-strict | reject + message: insert 1k rows | 4.3 ms (5.3 ms) | 15.5 ms (21.8 ms) | 3.7× |
| query-names | openai-strict | decode: expr 100 deep | 138 µs (162 µs) | 1.2 ms (2.1 ms) | 8.9× |
| query-names | openai-strict | reject + message: expr 100 deep | 137 µs (162 µs) | 52.1 ms (53.1 ms) | 380× |
| query-names | anthropic-strict | decode: rich select | 34 µs (55 µs) | — | — |
| query-names | anthropic-strict | reject + message: rich select | 34 µs (42 µs) | 26.0 ms (32.6 ms) | 763× |
| query-names | anthropic-strict | decode: insert 1k rows | 4.0 ms (5.0 ms) | 15.5 ms (19.0 ms) | 3.8× |
| query-names | anthropic-strict | reject + message: insert 1k rows | 5.9 ms (14.7 ms) | 20.6 ms (35.7 ms) | 3.5× |
| query-names | anthropic-strict | decode: expr 100 deep | 225 µs (888 µs) | — | — |
| query-names | anthropic-strict | reject + message: expr 100 deep | 193 µs (269 µs) | 7.1 ms (11.7 ms) | 37× |
| query-names | gemini | decode: rich select | 30 µs (37 µs) | — | — |
| query-names | gemini | reject + message: rich select | 31 µs (45 µs) | 95.2 ms (102 ms) | 3024× |
| query-names | gemini | decode: insert 1k rows | 2.2 ms (2.8 ms) | 12.2 ms (13.6 ms) | 5.4× |
| query-names | gemini | reject + message: insert 1k rows | 2.2 ms (3.0 ms) | 13.1 ms (17.9 ms) | 5.8× |
| query-names | gemini | decode: expr 100 deep | 179 µs (193 µs) | — | — |
| query-names | gemini | reject + message: expr 100 deep | 181 µs (198 µs) | 6.7 ms (10.0 ms) | 37× |
| query-names | lenient | decode: rich select | 21 µs (27 µs) | 984 µs (1.9 ms) | 47× |
| query-names | lenient | reject + message: rich select | 21 µs (34 µs) | 21.0 ms (37.6 ms) | 989× |
| query-names | lenient | decode: insert 1k rows | 2.2 ms (2.9 ms) | 11.9 ms (14.3 ms) | 5.4× |
| query-names | lenient | reject + message: insert 1k rows | 2.2 ms (3.1 ms) | 12.9 ms (18.4 ms) | 5.7× |
| query-names | lenient | decode: expr 100 deep | 110 µs (131 µs) | 1.0 ms (1.6 ms) | 9.3× |
| query-names | lenient | reject + message: expr 100 deep | 111 µs (133 µs) | 52.9 ms (52.9 ms) | 475× |
| query-typed | openai-strict | decode: rich select | 29 µs (35 µs) | 7.4 ms (8.9 ms) | 256× |
| query-typed | openai-strict | reject + message: rich select | 30 µs (44 µs) | 110 ms (339 ms) | 3693× |
| query-typed | openai-strict | decode: insert 1k rows | 4.2 ms (5.8 ms) | 13.2 ms (15.6 ms) | 3.2× |
| query-typed | openai-strict | reject + message: insert 1k rows | 4.0 ms (5.2 ms) | 17.2 ms (19.2 ms) | 4.3× |
| query-typed | openai-strict | decode: expr 100 deep | 134 µs (158 µs) | 1.1 ms (3.0 ms) | 7.9× |
| query-typed | openai-strict | reject + message: expr 100 deep | 136 µs (170 µs) | 416 ms (704 ms) | 3056× |
| query-typed | anthropic-strict | decode: rich select | 35 µs (47 µs) | — | — |
| query-typed | anthropic-strict | reject + message: rich select | 36 µs (54 µs) | 192 ms (197 ms) | 5350× |
| query-typed | anthropic-strict | decode: insert 1k rows | 4.4 ms (8.0 ms) | 18.7 ms (25.3 ms) | 4.3× |
| query-typed | anthropic-strict | reject + message: insert 1k rows | 4.3 ms (8.0 ms) | 23.1 ms (25.8 ms) | 5.4× |
| query-typed | anthropic-strict | decode: expr 100 deep | 191 µs (220 µs) | — | — |
| query-typed | anthropic-strict | reject + message: expr 100 deep | 196 µs (264 µs) | 49.7 ms (53.7 ms) | 253× |
| query-typed | gemini | decode: rich select | 34 µs (54 µs) | — | — |
| query-typed | gemini | reject + message: rich select | 37 µs (71 µs) | 622 ms (641 ms) | 16878× |
| query-typed | gemini | decode: insert 1k rows | 2.3 ms (4.3 ms) | 15.2 ms (19.6 ms) | 6.6× |
| query-typed | gemini | reject + message: insert 1k rows | 2.7 ms (11.4 ms) | 27.0 ms (69.4 ms) | 9.9× |
| query-typed | gemini | decode: expr 100 deep | 193 µs (245 µs) | — | — |
| query-typed | gemini | reject + message: expr 100 deep | 202 µs (293 µs) | 62.0 ms (75.9 ms) | 306× |
| query-typed | lenient | decode: rich select | 27 µs (275 µs) | 9.3 ms (15.4 ms) | 347× |
| query-typed | lenient | reject + message: rich select | 23 µs (47 µs) | 126 ms (129 ms) | 5482× |
| query-typed | lenient | decode: insert 1k rows | 2.5 ms (6.1 ms) | 17.0 ms (24.6 ms) | 6.8× |
| query-typed | lenient | reject + message: insert 1k rows | 2.6 ms (6.0 ms) | 19.5 ms (25.4 ms) | 7.4× |
| query-typed | lenient | decode: expr 100 deep | 119 µs (401 µs) | 1.4 ms (6.8 ms) | 12× |
| query-typed | lenient | reject + message: expr 100 deep | 125 µs (280 µs) | 302 ms (323 ms) | 2419× |
| query-paired | openai-strict | decode: rich select | 39 µs (109 µs) | 11.5 ms (12.9 ms) | 297× |
| query-paired | openai-strict | reject + message: rich select | 50 µs (382 µs) | 269 ms (343 ms) | 5372× |
| query-paired | openai-strict | decode: insert 1k rows | 3.4 ms (17.9 ms) | 692 ms (832 ms) | 201× |
| query-paired | openai-strict | reject + message: insert 1k rows | 5.0 ms (26.9 ms) | 5148 ms (5250 ms) | 1024× |
| query-paired | openai-strict | decode: expr 100 deep | 160 µs (342 µs) | 3.4 ms (54.0 ms) | 21× |
| query-paired | openai-strict | reject + message: expr 100 deep | 167 µs (491 µs) | 425 ms (765 ms) | 2550× |
| query-paired | anthropic-strict | decode: rich select | 5.1 ms (35.3 ms) | — | — |
| query-paired | anthropic-strict | reject + message: rich select | 55 µs (5.2 ms) | 423 ms (447 ms) | 7649× |
| query-paired | anthropic-strict | decode: insert 1k rows | 3.1 ms (34.3 ms) | 1598 ms (1628 ms) | 510× |
| query-paired | anthropic-strict | reject + message: insert 1k rows | 4.9 ms (38.3 ms) | 4749 ms (4962 ms) | 961× |
| query-paired | anthropic-strict | decode: expr 100 deep | 217 µs (1.3 ms) | — | — |
| query-paired | anthropic-strict | reject + message: expr 100 deep | 218 µs (986 µs) | 76.7 ms (113 ms) | 352× |
| query-paired | gemini | decode: rich select | 42 µs (292 µs) | — | — |
| query-paired | gemini | reject + message: rich select | 42 µs (234 µs) | 2128 ms (2700 ms) | 50399× |
| query-paired | gemini | decode: insert 1k rows | 8.0 ms (434 ms) | 2319 ms (2539 ms) | 291× |
| query-paired | gemini | reject + message: insert 1k rows | 27.5 ms (203 ms) | 6123 ms (8606 ms) | 223× |
| query-paired | gemini | decode: expr 100 deep | 220 µs (4.2 ms) | — | — |
| query-paired | gemini | reject + message: expr 100 deep | 223 µs (2.5 ms) | 66.8 ms (70.5 ms) | 300× |
| query-paired | lenient | decode: rich select | 29 µs (224 µs) | 35.7 ms (87.1 ms) | 1230× |
| query-paired | lenient | reject + message: rich select | 29 µs (244 µs) | 429 ms (1607 ms) | 14865× |
| query-paired | lenient | decode: insert 1k rows | 6.9 ms (125 ms) | 2198 ms (3069 ms) | 321× |
| query-paired | lenient | reject + message: insert 1k rows | 4.6 ms (59.2 ms) | 7370 ms (8375 ms) | 1586× |
| query-paired | lenient | decode: expr 100 deep | 140 µs (631 µs) | 4.5 ms (156 ms) | 32× |
| query-paired | lenient | reject + message: expr 100 deep | 144 µs (671 µs) | 538 ms (656 ms) | 3746× |
| product-query-set | openai-strict | decode: groupCount | 23 µs (213 µs) | 35.8 ms (94.7 ms) | 1550× |
| product-query-set | openai-strict | reject + message: groupCount | 19 µs (84 µs) | 48.5 ms (98.4 ms) | 2581× |
| product-query-set | openai-strict | decode: insert | 7.4 µs (135 µs) | 19 µs (571 µs) | 2.5× |
| product-query-set | openai-strict | reject + message: insert | 350 µs (23.4 ms) | 90.7 ms (143 ms) | 259× |
| product-query-set | anthropic-strict | decode: groupCount | 12 µs (21 µs) | 3.0 ms (6.3 ms) | 260× |
| product-query-set | anthropic-strict | reject + message: groupCount | 13 µs (24 µs) | 5.4 ms (15.1 ms) | 429× |
| product-query-set | anthropic-strict | decode: insert | 5.5 µs (10.0 µs) | 8.5 µs (13 µs) | 1.6× |
| product-query-set | anthropic-strict | reject + message: insert | 375 µs (708 µs) | 18.8 ms (37.8 ms) | 50× |
| product-query-set | gemini | decode: groupCount | 11 µs (15 µs) | 3.1 ms (7.1 ms) | 288× |
| product-query-set | gemini | reject + message: groupCount | 12 µs (16 µs) | 6.0 ms (10.6 ms) | 508× |
| product-query-set | gemini | decode: insert | 5.0 µs (7.8 µs) | 8.2 µs (12 µs) | 1.6× |
| product-query-set | gemini | reject + message: insert | 332 µs (625 µs) | 17.5 ms (24.1 ms) | 53× |
| product-query-set | lenient | decode: groupCount | 8.9 µs (11 µs) | 2.5 ms (6.4 ms) | 285× |
| product-query-set | lenient | reject + message: groupCount | 10 µs (14 µs) | 6.6 ms (11.6 ms) | 635× |
| product-query-set | lenient | decode: insert | 4.5 µs (7.5 µs) | 7.5 µs (8.6 µs) | 1.7× |
| product-query-set | lenient | reject + message: insert | 287 µs (384 µs) | 21.0 ms (27.8 ms) | 73× |

### encode

| case | profile | operation | @aeye/schema median (p95) | zod path median (p95) | zod ÷ a |
|---|---|---|---|---|---|
| tool-small | openai-strict | encodeText: args | 0.5 µs (0.5 µs) | 0.3 µs (0.3 µs) | 0.6× |
| tool-small | anthropic-strict | encodeText: args | 0.3 µs (0.3 µs) | 0.3 µs (0.3 µs) | 1.0× |
| tool-small | gemini | encodeText: args | 0.3 µs (0.3 µs) | 0.3 µs (0.4 µs) | 1.0× |
| tool-small | lenient | encodeText: args | 0.3 µs (0.3 µs) | 0.3 µs (0.3 µs) | 1.0× |
| tool-small | openai-strict | handlebars: args | 4.0 µs (4.4 µs) | 3.6 µs (3.9 µs) | 0.9× |
| tool-defaults | openai-strict | encodeText: args | 0.5 µs (0.5 µs) | 0.3 µs (0.3 µs) | 0.6× |
| tool-defaults | anthropic-strict | encodeText: args | 0.5 µs (0.6 µs) | 0.3 µs (0.4 µs) | 0.6× |
| tool-defaults | gemini | encodeText: args | 0.5 µs (0.5 µs) | 0.3 µs (0.3 µs) | 0.6× |
| tool-defaults | lenient | encodeText: args | 0.5 µs (0.8 µs) | 0.3 µs (0.3 µs) | 0.6× |
| tool-defaults | openai-strict | handlebars: args | 4.0 µs (4.3 µs) | 3.7 µs (4.2 µs) | 0.9× |
| gin-value | openai-strict | encodeText: task | 2.5 µs (35 µs) | 1.6 µs (9.2 µs) | 0.6× |
| gin-value | anthropic-strict | encodeText: task | 2.5 µs (14 µs) | 1.6 µs (6.7 µs) | 0.7× |
| gin-value | gemini | encodeText: task | 1.5 µs (5.9 µs) | 1.6 µs (8.0 µs) | 1.1× |
| gin-value | lenient | encodeText: task | 1.5 µs (1.9 µs) | 1.6 µs (1.9 µs) | 1.1× |
| gin-value | openai-strict | handlebars: task | 6.9 µs (9.4 µs) | 5.5 µs (7.7 µs) | 0.8× |
| harness-fn | openai-strict | encodeText: config | 3.1 µs (3.5 µs) | 1.5 µs (1.7 µs) | 0.5× |
| harness-fn | anthropic-strict | encodeText: config | 3.0 µs (4.0 µs) | 1.5 µs (1.7 µs) | 0.5× |
| harness-fn | gemini | encodeText: config | 2.3 µs (2.4 µs) | 1.5 µs (1.6 µs) | 0.7× |
| harness-fn | lenient | encodeText: config | 2.4 µs (2.5 µs) | 1.6 µs (1.9 µs) | 0.7× |
| harness-fn | openai-strict | handlebars: config | 7.8 µs (8.9 µs) | 5.9 µs (8.3 µs) | 0.8× |
| chart-1k | openai-strict | encodeText: 10 rows | 2.6 µs (3.5 µs) | 2.2 µs (2.6 µs) | 0.8× |
| chart-1k | openai-strict | encodeText: 1k rows | 169 µs (186 µs) | 166 µs (192 µs) | 1.0× |
| chart-1k | anthropic-strict | encodeText: 10 rows | 2.2 µs (2.3 µs) | 1.9 µs (2.3 µs) | 0.9× |
| chart-1k | anthropic-strict | encodeText: 1k rows | 161 µs (192 µs) | 159 µs (189 µs) | 1.0× |
| chart-1k | gemini | encodeText: 10 rows | 1.9 µs (2.0 µs) | 1.9 µs (2.0 µs) | 1.0× |
| chart-1k | gemini | encodeText: 1k rows | 154 µs (166 µs) | 155 µs (165 µs) | 1.0× |
| chart-1k | lenient | encodeText: 10 rows | 2.0 µs (2.1 µs) | 2.0 µs (2.3 µs) | 1.0× |
| chart-1k | lenient | encodeText: 1k rows | 166 µs (214 µs) | 170 µs (209 µs) | 1.0× |
| chart-1k | openai-strict | handlebars: 10 rows | 6.6 µs (7.3 µs) | 5.8 µs (6.5 µs) | 0.9× |
| gin-grammar | openai-strict | encodeText: everything program | 105 µs (593 µs) | 21 µs (63 µs) | 0.2× |
| gin-grammar | openai-strict | encodeText: block of 200 programs | 5.1 ms (18.3 ms) | 696 µs (4.5 ms) | 0.1× |
| gin-grammar | openai-strict | encodeText: if 60 deep | 516 µs (1.0 ms) | 121 µs (389 µs) | 0.2× |
| gin-grammar | anthropic-strict | encodeText: everything program | 35 µs (782 µs) | 23 µs (68 µs) | 0.7× |
| gin-grammar | anthropic-strict | encodeText: block of 200 programs | 982 µs (4.3 ms) | 717 µs (3.1 ms) | 0.7× |
| gin-grammar | anthropic-strict | encodeText: if 60 deep | 149 µs (312 µs) | 117 µs (147 µs) | 0.8× |
| gin-grammar | gemini | encodeText: everything program | 64 µs (106 µs) | 22 µs (27 µs) | 0.3× |
| gin-grammar | gemini | encodeText: block of 200 programs | 1.3 ms (6.0 ms) | 903 µs (3.5 ms) | 0.7× |
| gin-grammar | gemini | encodeText: if 60 deep | 688 µs (2.5 ms) | 126 µs (524 µs) | 0.2× |
| gin-grammar | lenient | encodeText: everything program | 20 µs (23 µs) | 21 µs (32 µs) | 1.1× |
| gin-grammar | lenient | encodeText: block of 200 programs | 607 µs (867 µs) | 625 µs (784 µs) | 1.0× |
| gin-grammar | lenient | encodeText: if 60 deep | 119 µs (153 µs) | 118 µs (144 µs) | 1.0× |
| gin-grammar | openai-strict | handlebars: everything program | 106 µs (124 µs) | 25 µs (32 µs) | 0.2× |
| query-open | openai-strict | encodeText: rich select | 23 µs (28 µs) | 5.0 µs (5.4 µs) | 0.2× |
| query-open | openai-strict | encodeText: insert 1k rows | 3.1 ms (231 ms) | 816 µs (1.0 ms) | 0.3× |
| query-open | openai-strict | encodeText: expr 100 deep | 116 µs (127 µs) | 43 µs (47 µs) | 0.4× |
| query-open | anthropic-strict | encodeText: rich select | 14 µs (15 µs) | 4.8 µs (5.2 µs) | 0.4× |
| query-open | anthropic-strict | encodeText: insert 1k rows | 3.0 ms (7.4 ms) | 825 µs (986 µs) | 0.3× |
| query-open | anthropic-strict | encodeText: expr 100 deep | 61 µs (77 µs) | 47 µs (93 µs) | 0.8× |
| query-open | gemini | encodeText: rich select | 20 µs (35 µs) | 4.9 µs (6.5 µs) | 0.2× |
| query-open | gemini | encodeText: insert 1k rows | 1.5 ms (2.3 ms) | 814 µs (1.1 ms) | 0.5× |
| query-open | gemini | encodeText: expr 100 deep | 60 µs (72 µs) | 43 µs (58 µs) | 0.7× |
| query-open | lenient | encodeText: rich select | 4.7 µs (5.5 µs) | 4.8 µs (6.3 µs) | 1.0× |
| query-open | lenient | encodeText: insert 1k rows | 773 µs (874 µs) | 767 µs (832 µs) | 1.0× |
| query-open | lenient | encodeText: expr 100 deep | 42 µs (43 µs) | 42 µs (47 µs) | 1.0× |
| query-open | openai-strict | handlebars: rich select | 28 µs (40 µs) | 8.6 µs (9.7 µs) | 0.3× |
| query-names | openai-strict | encodeText: rich select | 21 µs (23 µs) | 4.7 µs (5.0 µs) | 0.2× |
| query-names | openai-strict | encodeText: insert 1k rows | 3.2 ms (7.3 ms) | 836 µs (969 µs) | 0.3× |
| query-names | openai-strict | encodeText: expr 100 deep | 116 µs (124 µs) | 41 µs (45 µs) | 0.4× |
| query-names | anthropic-strict | encodeText: rich select | 13 µs (16 µs) | 5.1 µs (8.5 µs) | 0.4× |
| query-names | anthropic-strict | encodeText: insert 1k rows | 3.4 ms (8.0 ms) | 867 µs (1.3 ms) | 0.3× |
| query-names | anthropic-strict | encodeText: expr 100 deep | 59 µs (64 µs) | 41 µs (44 µs) | 0.7× |
| query-names | gemini | encodeText: rich select | 19 µs (21 µs) | 4.8 µs (7.2 µs) | 0.3× |
| query-names | gemini | encodeText: insert 1k rows | 1.4 ms (1.6 ms) | 831 µs (1.1 ms) | 0.6× |
| query-names | gemini | encodeText: expr 100 deep | 60 µs (65 µs) | 42 µs (53 µs) | 0.7× |
| query-names | lenient | encodeText: rich select | 4.6 µs (4.9 µs) | 4.7 µs (4.9 µs) | 1.0× |
| query-names | lenient | encodeText: insert 1k rows | 764 µs (865 µs) | 777 µs (947 µs) | 1.0× |
| query-names | lenient | encodeText: expr 100 deep | 43 µs (49 µs) | 45 µs (61 µs) | 1.1× |
| query-names | openai-strict | handlebars: rich select | 28 µs (49 µs) | 8.9 µs (12 µs) | 0.3× |
| query-typed | openai-strict | encodeText: rich select | 23 µs (50 µs) | 5.0 µs (9.3 µs) | 0.2× |
| query-typed | openai-strict | encodeText: insert 1k rows | 3.1 ms (5.0 ms) | 833 µs (1.1 ms) | 0.3× |
| query-typed | openai-strict | encodeText: expr 100 deep | 116 µs (126 µs) | 47 µs (215 µs) | 0.4× |
| query-typed | anthropic-strict | encodeText: rich select | 653 µs (816 µs) | 5.4 µs (8.1 µs) | 0.0× |
| query-typed | anthropic-strict | encodeText: insert 1k rows | 3.3 ms (5.8 ms) | 935 µs (1.3 ms) | 0.3× |
| query-typed | anthropic-strict | encodeText: expr 100 deep | 65 µs (79 µs) | 46 µs (59 µs) | 0.7× |
| query-typed | gemini | encodeText: rich select | 24 µs (81 µs) | 5.5 µs (12 µs) | 0.2× |
| query-typed | gemini | encodeText: insert 1k rows | 1.9 ms (5.3 ms) | 1.1 ms (2.5 ms) | 0.6× |
| query-typed | gemini | encodeText: expr 100 deep | 70 µs (707 µs) | 54 µs (228 µs) | 0.8× |
| query-typed | lenient | encodeText: rich select | 21 µs (43 µs) | 5.1 µs (7.3 µs) | 0.2× |
| query-typed | lenient | encodeText: insert 1k rows | 1.7 ms (2.7 ms) | 868 µs (1.3 ms) | 0.5× |
| query-typed | lenient | encodeText: expr 100 deep | 90 µs (117 µs) | 48 µs (79 µs) | 0.5× |
| query-typed | openai-strict | handlebars: rich select | 32 µs (72 µs) | 9.6 µs (18 µs) | 0.3× |
| query-paired | openai-strict | encodeText: rich select | 27 µs (113 µs) | 5.4 µs (7.2 µs) | 0.2× |
| query-paired | openai-strict | encodeText: insert 1k rows | 2.9 ms (23.8 ms) | 336 µs (808 µs) | 0.1× |
| query-paired | openai-strict | encodeText: expr 100 deep | 138 µs (214 µs) | 53 µs (73 µs) | 0.4× |
| query-paired | anthropic-strict | encodeText: rich select | 16 µs (136 µs) | 5.4 µs (19 µs) | 0.3× |
| query-paired | anthropic-strict | encodeText: insert 1k rows | 2.5 ms (9.3 ms) | 343 µs (2.3 ms) | 0.1× |
| query-paired | anthropic-strict | encodeText: expr 100 deep | 73 µs (149 µs) | 52 µs (88 µs) | 0.7× |
| query-paired | gemini | encodeText: rich select | 23 µs (63 µs) | 5.4 µs (37 µs) | 0.2× |
| query-paired | gemini | encodeText: insert 1k rows | 3.8 ms (31.4 ms) | 388 µs (4.7 ms) | 0.1× |
| query-paired | gemini | encodeText: expr 100 deep | 73 µs (282 µs) | 54 µs (92 µs) | 0.7× |
| query-paired | lenient | encodeText: rich select | 24 µs (128 µs) | 5.4 µs (106 µs) | 0.2× |
| query-paired | lenient | encodeText: insert 1k rows | 3.4 ms (14.1 ms) | 347 µs (2.1 ms) | 0.1× |
| query-paired | lenient | encodeText: expr 100 deep | 107 µs (566 µs) | 53 µs (211 µs) | 0.5× |
| query-paired | openai-strict | handlebars: rich select | 43 µs (342 µs) | 10 µs (67 µs) | 0.2× |
| product-query-set | openai-strict | encodeText: groupCount | 9.7 µs (38 µs) | 2.0 µs (21 µs) | 0.2× |
| product-query-set | openai-strict | encodeText: insert | 4.9 µs (46 µs) | 0.8 µs (4.5 µs) | 0.2× |
| product-query-set | anthropic-strict | encodeText: groupCount | 9.6 µs (12 µs) | 2.2 µs (2.4 µs) | 0.2× |
| product-query-set | anthropic-strict | encodeText: insert | 5.0 µs (5.9 µs) | 0.9 µs (1.0 µs) | 0.2× |
| product-query-set | gemini | encodeText: groupCount | 8.7 µs (12 µs) | 2.0 µs (2.2 µs) | 0.2× |
| product-query-set | gemini | encodeText: insert | 4.6 µs (6.1 µs) | 0.8 µs (0.9 µs) | 0.2× |
| product-query-set | lenient | encodeText: groupCount | 7.8 µs (13 µs) | 1.8 µs (2.0 µs) | 0.2× |
| product-query-set | lenient | encodeText: insert | 3.8 µs (4.4 µs) | 0.7 µs (0.8 µs) | 0.2× |
| product-query-set | openai-strict | handlebars: groupCount | 15 µs (17 µs) | 5.8 µs (7.4 µs) | 0.4× |

### request

| case | profile | operation | @aeye/schema median (p95) | zod path median (p95) | zod ÷ a |
|---|---|---|---|---|---|
| request-8 | openai-strict | new tools + plan | 720 µs (1.7 ms) | 3.7 ms (10.3 ms) | 5.2× |
| request-8 | openai-strict | same tools, next turn | 21 µs (39 µs) | 457 µs (964 µs) | 22× |
| request-8 | anthropic-strict | new tools + plan | 1.8 ms (7.7 ms) | 3.7 ms (11.1 ms) | 2.1× |
| request-8 | anthropic-strict | same tools, next turn | 47 µs (89 µs) | 463 µs (1.8 ms) | 9.8× |
| request-8 | gemini | new tools + plan | 517 µs (1.5 ms) | 3.7 ms (9.7 ms) | 7.2× |
| request-8 | gemini | same tools, next turn | 18 µs (29 µs) | 479 µs (1.3 ms) | 27× |
| request-8 | lenient | new tools + plan | 270 µs (891 µs) | 2.3 ms (14.3 ms) | 8.5× |
| request-8 | lenient | same tools, next turn | 15 µs (48 µs) | 399 µs (3.0 ms) | 26× |
| request-129 | openai-strict | new tools + plan | 21.0 ms (35.6 ms) | 111 ms (177 ms) | 5.3× |
| request-129 | openai-strict | same tools, next turn | 663 µs (6.4 ms) | 9.5 ms (9.6 ms) | 14× |
| request-129 | anthropic-strict | new tools + plan | 99.9 ms (133 ms) | 112 ms (129 ms) | 1.1× |
| request-129 | anthropic-strict | same tools, next turn | 2.0 ms (3.2 ms) | 22.3 ms (61.7 ms) | 11× |
| request-129 | gemini | new tools + plan | 18.9 ms (34.3 ms) | 107 ms (163 ms) | 5.7× |
| request-129 | gemini | same tools, next turn | 494 µs (4.1 ms) | 11.8 ms (18.0 ms) | 24× |
| request-129 | lenient | new tools + plan | 6.7 ms (32.7 ms) | 92.8 ms (213 ms) | 14× |
| request-129 | lenient | same tools, next turn | 236 µs (2.0 ms) | 12.5 ms (41.5 ms) | 53× |
| request-query-agent | openai-strict | new tools + plan | 485 µs (551 µs) | 1725 ms (1821 ms) | 3559× |
| request-query-agent | openai-strict | same tools, next turn | 29 µs (516 µs) | 85.0 ms (208 ms) | 2893× |
| request-query-agent | anthropic-strict | new tools + plan | 475 µs (13.5 ms) | 115 ms (117 ms) | 243× |
| request-query-agent | anthropic-strict | same tools, next turn | 43 µs (81 µs) | 43.6 ms (65.8 ms) | 1026× |
| request-query-agent | gemini | new tools + plan | 294 µs (380 µs) | 1504 ms (1827 ms) | 5110× |
| request-query-agent | gemini | same tools, next turn | 20 µs (151 µs) | 41.0 ms (87.1 ms) | 2026× |
| request-query-agent | lenient | new tools + plan | 151 µs (475 µs) | 51.6 ms (82.3 ms) | 341× |
| request-query-agent | lenient | same tools, next turn | 10.0 µs (46 µs) | 14.0 ms (59.4 ms) | 1409× |

### errors (size of the message the model gets back, characters)

| case | profile | answer | @aeye/schema | zod path |
|---|---|---|---|---|
| tool-small | openai-strict | args | 41 | 164 |
| tool-small | anthropic-strict | args | 41 | 164 |
| tool-small | gemini | args | 41 | 164 |
| tool-small | lenient | args | 41 | 164 |
| tool-defaults | openai-strict | args | 38 | 161 |
| tool-defaults | anthropic-strict | args | 38 | 161 |
| tool-defaults | gemini | args | 38 | 161 |
| tool-defaults | lenient | args | 38 | 161 |
| gin-value | openai-strict | task | 32 | 191 |
| gin-value | anthropic-strict | task | 32 | 191 |
| gin-value | gemini | task | 32 | 191 |
| gin-value | lenient | task | 32 | 191 |
| harness-fn | openai-strict | config | 54 | 224 |
| harness-fn | anthropic-strict | config | 54 | 224 |
| harness-fn | gemini | config | 54 | 224 |
| harness-fn | lenient | config | 54 | 224 |
| chart-1k | openai-strict | 10 rows | 50 | 188 |
| chart-1k | openai-strict | 1k rows | 52 | 190 |
| chart-1k | anthropic-strict | 10 rows | 50 | 188 |
| chart-1k | anthropic-strict | 1k rows | 52 | 190 |
| chart-1k | gemini | 10 rows | 50 | 188 |
| chart-1k | gemini | 1k rows | 52 | 190 |
| chart-1k | lenient | 10 rows | 50 | 188 |
| chart-1k | lenient | 1k rows | 52 | 190 |
| gin-grammar | openai-strict | everything program | 159 | 80709 |
| gin-grammar | openai-strict | block of 200 programs | 175 | 458285 |
| gin-grammar | openai-strict | if 60 deep | 174 | 150839 |
| gin-grammar | anthropic-strict | everything program | 169 | 75953 |
| gin-grammar | anthropic-strict | block of 200 programs | 185 | 666489 |
| gin-grammar | anthropic-strict | if 60 deep | 184 | 54108 |
| gin-grammar | gemini | everything program | 159 | 125232 |
| gin-grammar | gemini | block of 200 programs | 185 | 10049689 |
| gin-grammar | gemini | if 60 deep | 174 | 150839 |
| gin-grammar | lenient | everything program | 159 | 80709 |
| gin-grammar | lenient | block of 200 programs | 175 | 458285 |
| gin-grammar | lenient | if 60 deep | 174 | 150839 |
| query-open | openai-strict | rich select | 54 | 2899972 |
| query-open | openai-strict | insert 1k rows | 74 | 59775 |
| query-open | openai-strict | expr 100 deep | 71 | 8625689 |
| query-open | anthropic-strict | rich select | 54 | 4523457 |
| query-open | anthropic-strict | insert 1k rows | 74 | 59775 |
| query-open | anthropic-strict | expr 100 deep | 81 | 1031515 |
| query-open | gemini | rich select | 54 | 15650235 |
| query-open | gemini | insert 1k rows | 53 | 59775 |
| query-open | gemini | expr 100 deep | 81 | 1031515 |
| query-open | lenient | rich select | 54 | 2884055 |
| query-open | lenient | insert 1k rows | 53 | 59054 |
| query-open | lenient | expr 100 deep | 71 | 8602054 |
| query-names | openai-strict | rich select | 54 | 4557400 |
| query-names | openai-strict | insert 1k rows | 74 | 59775 |
| query-names | openai-strict | expr 100 deep | 71 | 14655115 |
| query-names | anthropic-strict | rich select | 54 | 6744923 |
| query-names | anthropic-strict | insert 1k rows | 74 | 59775 |
| query-names | anthropic-strict | expr 100 deep | 81 | 1595553 |
| query-names | gemini | rich select | 54 | 23655825 |
| query-names | gemini | insert 1k rows | 53 | 59775 |
| query-names | gemini | expr 100 deep | 81 | 1595553 |
| query-names | lenient | rich select | 54 | 4541681 |
| query-names | lenient | insert 1k rows | 53 | 59054 |
| query-names | lenient | expr 100 deep | 71 | 14631942 |
| query-typed | openai-strict | rich select | 54 | 28386885 |
| query-typed | openai-strict | insert 1k rows | 74 | 514133 |
| query-typed | openai-strict | expr 100 deep | 71 | 66218450 |
| query-typed | anthropic-strict | rich select | 54 | 44277260 |
| query-typed | anthropic-strict | insert 1k rows | 74 | 514133 |
| query-typed | anthropic-strict | expr 100 deep | 81 | 9965226 |
| query-typed | gemini | rich select | 54 | 137889163 |
| query-typed | gemini | insert 1k rows | 53 | 514133 |
| query-typed | gemini | expr 100 deep | 81 | 9965226 |
| query-typed | lenient | rich select | 54 | 28303756 |
| query-typed | lenient | insert 1k rows | 53 | 511438 |
| query-typed | lenient | expr 100 deep | 71 | 66095891 |
| query-paired | openai-strict | rich select | 54 | 39057959 |
| query-paired | openai-strict | insert 1k rows | 61 | threw: Invalid string length |
| query-paired | openai-strict | expr 100 deep | 71 | 68870787 |
| query-paired | anthropic-strict | rich select | 54 | 56900977 |
| query-paired | anthropic-strict | insert 1k rows | 61 | threw: Invalid string length |
| query-paired | anthropic-strict | expr 100 deep | 81 | 10244259 |
| query-paired | gemini | rich select | 54 | 179299544 |
| query-paired | gemini | insert 1k rows | 61 | threw: Invalid string length |
| query-paired | gemini | expr 100 deep | 81 | 10244259 |
| query-paired | lenient | rich select | 54 | 38946631 |
| query-paired | lenient | insert 1k rows | 61 | threw: Invalid string length |
| query-paired | lenient | expr 100 deep | 71 | 68747046 |
| product-query-set | openai-strict | groupCount | 82 | 541847 |
| product-query-set | openai-strict | insert | 72 | 4942413 |
| product-query-set | anthropic-strict | groupCount | 82 | 541847 |
| product-query-set | anthropic-strict | insert | 72 | 4941753 |
| product-query-set | gemini | groupCount | 82 | 541847 |
| product-query-set | gemini | insert | 72 | 4941753 |
| product-query-set | lenient | groupCount | 82 | 539248 |
| product-query-set | lenient | insert | 72 | 4921711 |

