# Provider Refresh 2026: OpenAI and OpenRouter

Status: **implemented** on branch `provider-refresh-2026` (2026-10-30), except the deferred items
below. The rest of this document is the original plan; this section records what landed and where
it departed from the plan.

### Outcome

| Phase | Result |
|---|---|
| 0 Bug fixes | Done: B1–B12. Live testing found more: core `toFile` dropped every data URL's payload; transcription lost text/srt/vtt (bare-string) results; OpenRouter now rejects `reasoning.effort` and `max_tokens` together (both were sent); BYOK requests cost $0; internal `@aeye/core` ranges (`^0.3.9` vs workspace 0.5.4) made packages run against stale nested copies. |
| 1 Core types | Done, additive. Request: seed, verbosity, serviceTier, metadata, modalities and audio output, hostedTools, moderate. Response/Chunk: citations, images, audio, moderation, serviceTier. Usage: cacheWrite, per-tool calls, image output tokens. ModelInfo: reasoningEfforts, retiresAt (retired models are never selected). |
| 2 OpenAI Responses | Done. `api: 'auto' \| 'chat' \| 'responses'`; auto uses Responses for Responses-only models, hosted tools, and reasoning summary/mode/context. Encrypted reasoning round-trips statelessly (verified live). |
| 3 Hosted tools | Done for web_search, web_fetch, file_search, code_interpreter, image_generation, and mcp (OpenAI Responses tools; OpenRouter `openrouter:*` server tools). Custom grammar tools, `allowed_tools`, tool search/defer, and async tools are deferred. |
| 4 OpenAI media | Done. GPT Image only (DALL·E retired), transcription diarization with known speakers, any speech voice. |
| 5 OpenRouter | Done except rerank and video (deferred). Images go through chat with the image modality rather than `/images`, whose shape is not OpenAI-compatible. Embeddings, speech, and transcription use the OpenAI-compatible endpoints. |
| 6 Registry | OpenAI scraper rewritten against the docs' Markdown pages (no puppeteer); OpenRouter metrics from the endpoints API. OpenAI (136 models) and OpenRouter (677) registries regenerated. Replicate and AWS not rescraped. |
| 7 Deferred | Unchanged, plus rerank, video generation, custom/async tools, and tool search. |
| 8 Docs | Provider docs, READMEs, and guides updated. |

### Decisions as taken

- **D1** openai v7, Node ≥ 22: done.
- **D2** `fetch` over `@openrouter/sdk`: done; OpenRouter's media endpoints mostly need no new client at all.
- **D3** Instead of splitting `audio`, a separate `audioOutput` capability marks chat models that
  produce audio; `audio` keeps meaning text-to-speech, so no deprecation was needed.
- **D4** `gpt-realtime-2.1-mini` returns 404 on `/v1/audio/speech`, so the TTS default stays
  `gpt-4o-mini-tts` until it retires (2027-01-06).
- **D5** `auto` stays Chat Completions by default.
- **D6** Video generation deferred with rerank: each needs a new AI-layer API.

### Schema dialects (`core/src/schema.ts`)

Re-read and live-probed 2026-10-30: OpenAI strict now emits numeric, item, and length bounds;
Google strict takes `anyOf` and `$defs` (Google's November 2025 JSON Schema expansion) but not
`allOf` or `pattern`, and `any` stays the empty schema because Gemini rejects ref loops through
required values; a new `xai` family covers Grok. Without a full `ModelInfo`, providers now use the
model family's non-strict dialect instead of LENIENT. The curated strict-support table matches
current model ids (and no longer matches Claude 4/4.1, which have no strict mode).

aeye was built in October 2025 against the OpenAI Chat Completions API and OpenRouter's
OpenAI-compatible endpoint. Both platforms have moved a long way in the year since. This
document does three things:

1. Catalogues what `@aeye/*` supports **today** (§1).
2. Catalogues what OpenAI (§2) and OpenRouter (§3) have **added, changed or retired** since roughly
   September 2025.
3. Lays out a phased plan to close the gaps (§5), with the gap matrix (§4) and the open decisions (§6)
   that need an owner's call before work starts.

Sources:
- **OpenAI:** the changelog, deprecations, models and pricing pages. The docs moved to
  `developers.openai.com/api/docs/...`, and the old `platform.openai.com/docs/changelog` now redirects
  there. Also the `openai-node` `CHANGELOG.md`.
- **OpenRouter:** `openrouter.ai/docs/changelog`, which only goes back to 2026-07-03. Also
  `openrouter.ai/blog/announcements`, including the monthly release spotlights, and the OpenAPI spec
  history in `OpenRouterTeam/typescript-sdk`.

The research was done through summarising fetches. **Spot-check exact slugs, prices and dates against
the live docs before you implement against them.** Items marked *(unverified)* had no primary source.

---

## 1. What aeye supports today

### 1.1 Provider surface (`packages/ai/src/types.ts`)

`Provider` implements:
- `listModels`, `checkHealth`
- `createExecutor`/`createStreamer` (chat)
- `generateImage(Stream)`, `editImage(Stream)`
- `transcribe(Stream)`, `speech` (no streaming variant)
- `embed`
- `analyzeImage(Stream)`

There is no moderation, files, batch, video, realtime, rerank, or OpenAI Responses support anywhere.

### 1.2 Taxonomy

- **`ModelCapability`:** `chat, tools, vision, json, structured, streaming, reasoning, image, audio,
  hearing, embedding, zdr, toolsStrict`.
  - Missing: video in or out, moderation, rerank, file/PDF input, web search, hosted tools, realtime.
- **`ModelInfo`:** has no explicit input/output modality fields and no deprecation or expiry date.
- **`ModelPricing`:** covers text in/out/cached, audio, image, reasoning, embeddings and per-request.
  - Missing: cache-write price, web-search or tool-call price, per-second video, long-context tiers,
    service-tier multipliers.
- **`Usage`:** has no cache-write tokens, server or hosted tool usage, or service tier.

### 1.3 Core request and response (`packages/core/src/types.ts`)

**`Request` fields:**
- Sampling: temperature, topP, maxTokens, frequencyPenalty and presencePenalty, stop, logitBias,
  logProbabilities.
- Tools: tools (function tools only), toolChoice, toolsOneAtATime.
- Output and reasoning: responseFormat (text, json, or a Zod schema with a strict-descriptor system),
  `reason{effort: low|medium|high, maxTokens}`.
- Caching and identity: cacheKey (`prompt_cache_key`), userKey (`safety_identifier`).
- `extra` passthrough.
- Missing: seed, n, verbosity, service tier, metadata, output modalities, prediction, and any built-in
  tools.

**Content parts:** `text | image | file | audio`.
- There is no video part, no image `detail`, no filename, no file id, and no `cache_control` or
  cache breakpoint.

**`Response`:**
- `content` (string), toolCalls, finishReason, refusal, `reasoning{content, details[]}` (shaped on
  OpenRouter `reasoning_details`), usage (with `cost` when the provider reports it).
- Missing: annotations or citations, generated images or audio in chat, logprobs, moderation results,
  and the served service tier.

### 1.4 `@aeye/openai` (`packages/openai/src/openai.ts`, openai SDK `^6.6.0`, locked at 6.9.1)

Endpoints it uses:
- `chat.completions` (non-streaming and streaming)
- `images.generate` and `images.edit`, with `partial_images` streaming
- `audio.transcriptions`, with delta, segment and done streaming
- `audio.speech`
- `embeddings`
- `models.list`

Chat mapping:
- `developer` role for all system messages.
- Function tools with strict-schema budgeting.
- `json_object`, or `json_schema` with strict.
- `reasoning_effort`.
- Content parts: `input_audio` (wav/mp3) and inline base64 `file`.
- Usage splits cached, reasoning and audio tokens.

### 1.5 `@aeye/openrouter` (`packages/openrouter/src/openrouter.ts`)

- Extends the OpenAI provider.
- **Config-level defaults only:** `provider` routing (order, only, ignore, allowFallbacks,
  requireParameters, dataCollection, zdr, quantizations, sort string, maxPrice) and `transforms`.
- **Per-request:** reasoning `{enabled, effort, max_tokens}`, and `reasoning`/`reasoning_details`
  round-trip.
- **Strict handling:** auto `require_parameters` for strict schemas.
- **Cost:** reads `usage.cost`.
- **Disabled:** image, speech, transcription and embedding methods are overridden to `undefined`.
- **Model data:** the model list comes from `/models` plus `/endpoints/zdr`. Latency and throughput
  are scraped with puppeteer.

### 1.6 `@aeye/models`

Generated registries:

| Registry | Last refresh | Notes |
|---|---|---|
| `openai.ts` | **2025-11-17** | Newest entries are gpt-5-pro, gpt-audio-mini and sora-2. No gpt-5.1 or later. |
| `openrouter.ts` | 2026-07-11 | 346 models, including gpt-5.6, claude-opus-4.8 and gemini-3.5. |
| `replicate.ts` | 2025-11 | |
| `aws.ts` | 2025-11 | |

The OpenAI scraper drives puppeteer against the old `platform.openai.com/docs/models/{slug}` URLs.

### 1.7 Known bugs found during this survey (verified in code)

| # | Location | Bug |
|---|---|---|
| B1 | `openai.ts:1281-1302` | Streaming chat never sends `reasoning_effort`; only the non-streaming path does (:1177). |
| B2 | `openai.ts:1911` | `editImage` calls `augmentImageGenerateRequest` instead of `augmentImageEditRequest`. |
| B3 | `openrouter.ts:367-374`, `:392-399` | Overwrites `usage.text.input/output` with raw `prompt_tokens`/`completion_tokens` after the base class split out cached and reasoning tokens, so token stats double-count. |
| B4 | `models/src/models/openai.ts` + `ai.ts:692-704` | No `pricing.reasoning` on any OpenAI model, and reasoning tokens are subtracted from `text.output`, so **direct-OpenAI reasoning tokens cost $0**. OpenAI bills them as output tokens. |
| B5 | `openai.ts:1701`, `:1941` | gpt-image usage (`input_tokens`/`output_tokens`) goes through the chat usage converter and is lost. `ai/src/apis/image.ts:87` defaults quality to `'standard'`, which does not match gpt-image pricing tiers. |
| B6 | `openai.ts:1234` | Non-streaming refusal is read from `content` on `content_filter`; `message.refusal` is ignored. |
| B7 | `openai.ts:725` | Operator precedence in audio format detection (`a \|\| b && c ? 'wav' : 'mp3'`). |
| B8 | `openai.ts:2379`, `:2454` | The default vision model is `gpt-4-vision-preview`, which is long gone. The defaults `tts-1` and `whisper-1` are being retired (§2.4). |
| B9 | `openrouter/src/openrouter.ts:103-155` | `file` input modality is mapped to the `vision` capability. |
| B10 | `models/src/models/openai.ts` | Misclassifications: sora-2 is tagged chat/vision/audio, omni-moderation is tagged chat/vision, gpt-image-1 is tagged chat, and gpt-5 lists image params. |
| B11 | `ai/src/types.ts:844` | `streem` typo in `ModelHandler.imageAnalyze`. |
| B12 | `openai.ts` (`message.annotations`) | `logprobs` are requested but never surfaced, and `message.annotations` (url citations) is dropped. |

---

## 2. OpenAI: what changed (Sep 2025 → Oct 2026)

### 2.1 Headlines

- **Chat Completions is still supported and not deprecated.** Even `gpt-6-astra` lists it.
- **New capability ships Responses-first, or Responses-only.** Examples: hosted tools, compaction,
  skills, programmatic and async tool calls, `prompt_cache_options`, WebSocket mode, `phase`, and the
  `*-codex` and `*-pro` models.
- **The Assistants API shut down on 2026-08-26.**
- **The Videos/Sora API was deprecated on 2026-03-24 and shut down on 2026-09-24.**
- **Many models aeye defaults to or lists are retired, or retire within months** (§2.4).
- **openai-node v7.0.0 (2026-07-27) requires Node 22.** v6 → v7 had no other listed break.
  - v6.0.0 (2025-09-30) turned tool-call output into `string | content[]`.
  - Some v7 minors broke types, in the Decisions/Live areas only.

### 2.2 New models

**Text and reasoning**

| Date | Models | Notes |
|---|---|---|
| 2025-11-13 | `gpt-5.1`, `gpt-5.1-chat-latest`, `gpt-5.1-codex(-mini)` | New effort `none` (the default on 5.1), `apply_patch` and `shell` tools, 24h cache retention. |
| 2025-12-04 | `gpt-5.1-codex-max` | |
| 2025-12-11 | `gpt-5.2`, `gpt-5.2-chat-latest` | Effort `xhigh`; concise reasoning summaries; `/responses/compact`. |
| 2026-01-14 | `gpt-5.2-codex` | |
| 2026-02-24 | `gpt-5.3-codex` | |
| 2026-03-03 | `gpt-5.3-chat-latest` | |
| 2026-03-05 | `gpt-5.4`, `gpt-5.4-pro` | 1.05M context, 128K output; tool search; GA `computer` tool. |
| 2026-03-17 | `gpt-5.4-mini`, `gpt-5.4-nano` | |
| 2026-04-24 | `gpt-5.5`, `gpt-5.5-pro` | |
| 2026-05 → 2026-10 | `chat-latest` | Rolling snapshot. |
| 2026-07-09 | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` (`gpt-5.6` = sol) | Effort `max`; **Pro became `reasoning.mode: "pro"`** on the same slug; `reasoning.context`; `prompt_cache_options`. |
| 2026-08-07 | `gpt-5.6-cyber` and Daybreak tiers | Gated access. |
| 2026-09-03 | **`gpt-6-astra`** | Flagship. Efforts low…max, no `none`. |
| 2026-09-22 | `gpt-6-sol`, `gpt-6-luna` | |
| 2026-09-29 | `gpt-6.1-sol` | |
| 2026-10-26 | `gpt-6.1-terra` | |

Also:
- Open-weight `gpt-oss-safeguard-120b/20b` (2025-10-29).
- GPT-Rosalind for life sciences (trusted access only).

**Image**

| Date | Model | Notes |
|---|---|---|
| 2025-10-06 | `gpt-image-1-mini` | |
| 2025-12-16 | `gpt-image-1.5`, `chatgpt-image-latest` | |
| 2026-04-21 | `gpt-image-2` | Transparent background preview from 2026-08-20. |
| 2026-09-08 | `gpt-image-2.5-sunburst` (quality), `gpt-image-2.5-flare` (fast) | Quality levels `low, medium, high, xhigh, max, auto`. |

Endpoint changes:
- `/images/edits` accepts JSON bodies (2026-02).
- Batch supports image models.

**Audio**

| Date | Model | Notes |
|---|---|---|
| ~2025-10-16 | `gpt-4o-transcribe-diarize` | `response_format: diarized_json`, known-speaker reference clips. |
| 2025-12-15 | Mini audio snapshots | Custom voices (SDK support 2026-03). |
| 2026-02-23 | `gpt-realtime-1.5`, `gpt-audio-1.5` | `gpt-audio-1.5` is on Chat Completions. |
| 2026-05-07 | `gpt-realtime-2`, `gpt-realtime-translate`, `gpt-realtime-whisper` | |
| 2026-07-06 | `gpt-realtime-2.1(-mini)` | |
| 2026-07-28 | `gpt-transcribe` (files and realtime), `gpt-live-transcribe` | |
| 2026-09-10 | `gpt-live-1` | On the new **Live API**, `v1/live/sessions`. |
| 2026-10-16 | Prompt-to-voice | Create a voice from a text description; 9 new voices. |

**Video:** `sora-2` and `sora-2-pro` (2025-10-06), then character references, 20s, 1080p and
`/videos/edits` (2026-03-12). **All deprecated on 2026-03-24 and shut down on 2026-09-24.**

**Embeddings and moderation:** nothing new. `text-embedding-3-small/large` and
`omni-moderation-latest` are still current.

### 2.3 New API features

**Reasoning**
- Effort is now `none | minimal | low | medium | high | xhigh | max`, and support varies by model.
- `reasoning.mode: "pro"` and `reasoning.context` (`auto | all_turns | current_turn`) on GPT-5.6+.
- Reasoning summaries, with a concise option.
- Encrypted reasoning items for stateless round-trips.
- `reasoning_text` stream events.
- Effort can change mid-conversation on GPT-6.

**Responses API** (most of the new surface)
- **Conversations** (`/v1/conversations`).
- **Compaction:** client-side `/responses/compact`, and server-side `context_management`.
- `/responses/input_tokens` token counting.
- **Hosted tools:** web search (image results; `return_token_budget`), file search (`in`/`nin`
  filters), code interpreter/containers, the GA `computer` tool, `image_generation`, remote MCP and
  connectors, hosted and local `shell`, `apply_patch`, **tool search** (`defer_loading`), **Skills**,
  `programmatic_tool_calling`.
- **Tool flavours:**
  - `custom` freeform tools with optional grammar (Lark or regex).
  - `allowed_tools` tool_choice.
  - Tool outputs can be images or files.
  - **Async tool calls** (`async: true`, GPT-6+).
  - Mid-turn steering.
- `phase` on output messages (intermediate vs final).
- WebSocket mode.
- Background mode.
- Error diagnostics and model notices.

**Chat Completions and Responses**
- `verbosity`.
- `prompt_cache_retention: "24h"` (2025-11). Superseded on GPT-5.6+ by
  `prompt_cache_options{mode: implicit|explicit, ttl: 30m|12h}`, with explicit
  `prompt_cache_breakpoint` content markers (up to 4) and a **cache-write charge**: 1.25× input for 30m,
  2.5× for 12h.
- `usage.*.cache_write_tokens`.
- **Inline moderation:** `moderation: {model}` returns input and output moderation results
  (2026-06-04).
- `input_file` accepts many more document types and gets `detail`.
- Image `detail: "original"`.
- New 429 `slow_down` and 503 `server_is_overloaded` error codes.

**Service tiers**
- `default`.
- `flex` (~50%).
- `fast`, renamed from `priority`, which is still accepted (2×).
- `scale`.
- `ultrafast` (~6×, GPT-6 Astra and 6.1 Sol).
- Long-context surcharge: over 272K input tokens costs 2× input and 1.5× output for the whole request
  (GPT-5.4+).

**Other surfaces**
- Realtime GA (2025-08-28; WebRTC, SIP, image input, MCP). The beta shape is gone.
- Live API.
- Agents API (beta).
- Decisions API (`/v1/decisions`, GA 2026-10-22).
- Admin, spend-limit and Usage/Costs APIs.
- Webhooks management.
- Batch for images.
- Per-request regional processing.
- Bedrock and Vertex endpoints.

### 2.4 Deprecations that touch aeye

| Shut down (done) | Retiring |
|---|---|
| dall-e-2, dall-e-3 (2026-05-12) | `gpt-image-1-mini`, `gpt-image-1.5`, `chatgpt-image-latest` → 2026-12-01 |
| `gpt-image-1`, `o1`, `o1-pro`, `o3-mini`, `o4-mini`, `gpt-4`, `gpt-4-turbo`, `gpt-3.5-turbo`, `gpt-4.1-nano` (2026-10-23) | `gpt-5`, `-mini`, `-nano`, `-pro`, `o3`, `o3-pro` → 2026-12-11 |
| gpt-4o audio/realtime previews, `chatgpt-4o-latest`, `codex-mini-latest` | **`tts-1`, `tts-1-hd`, `gpt-4o-mini-tts` → 2027-01-06** |
| `gpt-5-chat-latest`, `gpt-5(.1)-codex*`, `gpt-5.1-chat-latest`, deep-research models, `computer-use-preview`, search previews (2026-07-23) | **`gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini` → 2027-01-14** |
| Assistants API (2026-08-26); Videos API and Sora (2026-09-24) | `gpt-realtime`, `gpt-audio` and their minis → 2027-01-20 |
| | **`whisper-1`, `gpt-4o(-mini)-transcribe(-diarize)`, `/audio/translations` → 2027-02-26** |
| | `gpt-5.1`, `gpt-5.3-codex`, `gpt-5.4-nano` → 2027-04-01 |
| | Reusable prompts, Evals and Agent Builder → 2026-11-30; self-serve fine-tuning → 2027-01-06 |

---

## 3. OpenRouter: what changed (Sep 2025 → Oct 2026)

### 3.1 New endpoints

All are under `https://openrouter.ai/api/v1` unless noted.

| When | Endpoint |
|---|---|
| 2025-10 beta, **GA 2026-07-25** | `POST /responses`. Stateless; OpenAI Responses shape. |
| ≤2025-09 | `POST /embeddings`, `GET /embeddings/models`. Multimodal on some models. |
| ≤2026-01 | **`POST /messages`**, Anthropic Messages compatible. Since 2026-10-21 the stream has no trailing `[DONE]`. |
| 2026-04 | `POST /rerank` (Cohere, Fireworks) |
| 2026-04-15 | **Video generation** (async): `POST /videos`, `GET /videos/{id}`, `GET /videos/{id}/content`, `GET /videos/models`. Models: Seedance, Veo 3.1, Wan, Sora 2 Pro, Grok Imagine. |
| 2026-05-01 | **`POST /audio/speech`** (voices from `supported_voices`; cloning; multi-speaker) and **`POST /audio/transcriptions`** (multipart, `response_format`, timestamps, `diarize`, `keyterms`). ElevenLabs was added 2026-10-07. |
| 2026-06-12 | Files API (`/files`) |
| 2026-06-23 | **Unified Image API**: `POST /images` (streams), `GET /images/models`, `GET /images/models/{slug}/endpoints` |
| 2026-09-22 | **Batch API** (`/batches`; 50% price; `:batch` variant; `callback_url`) |
| 2026-09-29 | `GET /tools`, the server-tool catalogue |
| misc | `/generation/content`, `/generation/feedback`, `GET /model/{author}/{slug}`, presets API (`/presets/{slug}/chat/completions` and others), guardrails, workspaces, BYOK, observability destinations, analytics, external users (renamed from end users 2026-10-21), OAuth `/auth/keys/code`, workload identity `/oauth/token` |

The legacy `/completions` route was dropped from the OpenAPI spec in early 2026 *(live status
unverified)*.

### 3.2 Model and endpoint metadata

**`/models`**
- New fields: `expiration_date`, `knowledge_cutoff`, `supported_voices`, `benchmarks`, `links`,
  `alias_target`, `default_parameters`.
- New **`reasoning` object**: `supported_efforts`, `default_effort`, `default_enabled`,
  `supports_max_tokens`, `mandatory`.
- `architecture.output_modalities` now includes image, audio, video, embeddings and rerank.
- Query filters: `output_modalities`, `region`, price and age filters, and indexes, with `sort`
  (2026-07).

**Pricing fields**
- Already present before Sep 2025, but **ignored by aeye**: `input_cache_read`, `input_cache_write`,
  `web_search`, `audio`, `image_output`, `input_audio_cache`, `discount`.
- New: `image_token`, `audio_output`, `input_cache_write_1h`, and `overrides` (time-of-day pricing).

**`/models/{id}/endpoints` (per provider)**
- Fields: `quantization`, `max_prompt_tokens`/`max_completion_tokens`, `supported_parameters`,
  `uptime_*`, `latency_last_30m`, `throughput_last_30m`, `perf_last_30m_by_workload`,
  `supports_implicit_caching`, `supports_tool_choice`, `native_tools`, `service_tier`, and
  audio/voice flags.
- This could **replace the puppeteer metrics scrape**.

### 3.3 Request features

**Provider routing (`provider`)**
- Everything aeye has, plus:
  - `enforce_distillable_text`
  - `max_price.request` and `max_price.audio`
  - `sort` as an object `{by, partition}`, with the new `exacto` value
  - `preferred_min_throughput` and `preferred_max_latency` (a number or p50–p99 object)
  - `provider.options`, a per-provider passthrough
- `route` is deprecated.
- **The default routing changed on 2026-10-28** from cheapest-first to quality-weighted. Sorting or
  ordering, `:nitro`/`:floor`, or BYOK bypasses it.
- **Auto Exacto** (2026-03-12) reorders providers for tool-calling requests by default.

**Variants**

| Variant | Status |
|---|---|
| `:free`, `:batch` (new) | catalog variants |
| `:nitro`, `:floor`, `:exacto` | routing variants |
| `:online`, `:thinking`, `:extended` | **deprecated** |

**Routers**
- `openrouter/auto`, via the `auto-router` plugin: `allowed_models` wildcards, `excluded_models`,
  `pin_model`, `cost_quality_tradeoff` 0–10.
- `openrouter/free`.
- `openrouter/pareto-code`.
- `openrouter/fusion`.
- `~vendor/model-latest` aliases.

**Presets:** `@preset/slug`, now versioned, with an API.

**Plugins**
- `web` (deprecated in favour of the server tool), `web-fetch`, `file-parser` (`pdf.engine`).
- **`response-healing`** (2025-12, JSON repair, non-streaming).
- **`context-compression`** (`middle-out`), which replaces `transforms`.
- `moderation`, `alignment`, `armor`, and the router plugins.

**Server tools (beta)**
- Specified as `tools: [{type: "openrouter:<name>"}]`, run by OpenRouter in an agent loop.
- Names: web_search, web_fetch, datetime, image_generation, advisor, subagent, tool search; shell,
  bash and apply_patch on Responses/Messages only.
- Controls: `stop_server_tools_when`, `deferred_tools`, async tools.
- Usage reports `server_tool_use_details` and `cost_details.server_tool_cost`.

**Reasoning**
- `reasoning{effort: none|minimal|low|medium|high|xhigh|max, max_tokens, exclude, enabled, summary,
  mode, context}`, plus a top-level `reasoning_effort` shorthand.
- `reasoning_details` must round-trip **unmodified and in order**. Detail types now include
  `reasoning.server_tool_call` and the `google-gemini-v1` format.

**Caching**
- Top-level `cache_control` gives automatic breakpoints for Anthropic, Bedrock, Vertex and Azure.
- Block-level `cache_control` takes TTL `5m` or `1h`.
- `prompt_cache_options` and `prompt_cache_breakpoint` for GPT-5.6+.
- `session_id` / `x-session-id` keeps sticky routing for cache hits.
- Usage includes `cache_write_tokens` and `cache_discount`.
- Response caching makes identical requests free.

**Usage and cost**
- **Always returned now.** `usage: {include: true}` is a deprecated no-op.
- `cost_details` (upstream costs, server tool cost), `is_byok`, `openrouter_metadata`.

**Other request fields:** `service_tier` (auto, default, fast/priority, flex, scale, ultrafast),
`trace` (Broadcast observability), `metadata`, `prediction`, `seed`, `debug.echo_upstream_body`,
`user`.

**Multimodal via chat**
- **Image output:** `modalities: ["text","image"]` plus `image_config` (`aspect_ratio`, `image_size`);
  images come back in `message.images`.
- **Audio output:** `modalities: ["text","audio"]` plus `audio{voice, format}`, streaming only.
- `input_audio`, `video_url` (with `processing`) and `file` parts; PDFs via file-parser.

**In-region routing:** `eu.openrouter.ai` and `us.openrouter.ai` (Business/Enterprise).

### 3.4 SDKs

| Package | Status |
|---|---|
| `@openrouter/sdk` | 1.0 on 2026-07-20, now 1.5.x. ESM, Speakeasy-generated, zod-based. Covers every namespace above. |
| `@openrouter/agent` | `callModel` agent loop, 2026-04. |
| `@openrouter/ai-sdk-provider` | 3.x, for the Vercel AI SDK v7. |

---

## 4. Gap matrix

Effort: S = under a day, M = a few days, L = a week or more.

| Area | OpenAI has | OpenRouter has | aeye today | Gap | Effort |
|---|---|---|---|---|---|
| Reasoning effort values | none … max | none … max | low/med/high | widen the type; per-model support | S |
| Reasoning mode/context/summary | pro mode, context, summaries | same passthrough | — | new `reason` fields | S |
| OpenAI reasoning round-trip | encrypted items (Responses) | `reasoning_details` | OR only | needs the Responses executor | M |
| Verbosity, seed, service tier, metadata | ✓ | ✓ | — | `Request` fields; serve tier into `Response` | S |
| Responses API | primary API; some models Responses-only | GA | — | new OpenAI executor path | L |
| Hosted/server tools | web/file search, code, computer, MCP, shell, patch, tool search, image gen | `openrouter:*` server tools | — | `BuiltinTool` abstraction | L |
| Custom/freeform tools, `allowed_tools`, async tools | ✓ | partial | — | ToolDefinition variants | M |
| Citations/annotations | `url_citation` | same | dropped | `Response.annotations` | S |
| Images in chat output | via Responses tool | `modalities` + `message.images` | — | `Response.images` / content parts | M |
| Audio in chat output | gpt-audio(-1.5) | `modalities` + `audio` | — | `Response.audio` | M |
| Video input part | — | `video_url` | — | `MessageContentType 'video'` | S |
| File id/filename/detail | ✓ | ✓ | inline base64, fixed name | extend `MessageContent` | S |
| Prompt caching | retention → `prompt_cache_options`, breakpoints, write cost | `cache_control`, `session_id` | `cacheKey` only | cache options + breakpoint marker; cache-write usage and pricing | M |
| Inline moderation | `moderation` param | moderation plugin | — | request flag + `Response.moderation` | S |
| Moderation API | omni-moderation | — | — | optional `moderate()` op | S |
| Image models | gpt-image-2 / 2.5, quality xhigh/max/auto, multi-image edit, output_format/compression | `/images` + chat modalities | gpt-image-1 sizes hard-coded | new family; params; OR image support | M |
| Transcription | gpt-transcribe, diarized_json | `/audio/transcriptions` | whisper/4o-transcribe | diarize, new defaults, OR STT | M |
| Speech | new voices, custom/prompt voices, stream_format | `/audio/speech` | 10-voice whitelist | open voice set; OR TTS | S–M |
| Embeddings | unchanged | `/embeddings` | OpenAI only | enable on OR | S |
| Rerank | — | `/rerank` | — | new op (`rerank`) | M |
| Video generation | shut down | `/videos` (async) | — | new async op, OR only | L |
| OR routing per request | — | rich `provider`, variants, presets, routers | config defaults only | typed per-request routing | M |
| OR plugins | — | web-fetch, file-parser, response-healing, context-compression | `transforms` | typed plugins; migrate transforms | S–M |
| OR pricing fields | — | cache read/write, web_search, audio, image_output | text/image/reasoning only | map; extend `ModelPricing` | S |
| OR model metadata | — | reasoning object, expiration, endpoints perf | modalities + params; scraped metrics | use API; drop puppeteer | M |
| Model registry (OpenAI) | gpt-5.1 … gpt-6.1, images, audio | — | frozen 2025-11-17 | rescrape from developers.openai.com; deprecation dates | M |
| Batch | images + chat | `/batches` | — | out of scope (§5, Phase 7) | — |
| Realtime / Live / Agents / Decisions | ✓ | Decisions alpha | — | out of scope (§5, Phase 7) | — |
| openai SDK | v7 (Node 22) | — | ^6.6 | upgrade (decision D1) | S |

---

## 5. Plan

Phases are ordered so that each one ships on its own. Each phase ends with typecheck, unit tests,
and the relevant `test-integration` cases against live keys.

### Phase 0: Bug fixes (no API changes)

1. B1: send `reasoning_effort` on streaming chat.
2. B2: `editImage` calls `augmentImageEditRequest`.
3. B3: drop the OpenRouter usage overwrite. Let the base `convertOpenAIUsage` split the usage, and only
   add OpenRouter-specific fields (`cost`, `cost_details`).
4. B4: when `pricing.reasoning` is missing, cost reasoning tokens at `pricing.text.output`, and add a
   test.
5. B5: map gpt-image usage (`input_tokens`, `output_tokens`, `input_tokens_details`) into
   `Usage.text`/`Usage.image`, and stop defaulting image quality to `'standard'`.
6. B6, B7 and B11: small correctness fixes.
7. B8: new defaults.
   - Vision → `gpt-5.4-mini` or the current cheap chat model.
   - TTS → `gpt-realtime-2.1-mini`, or keep `gpt-4o-mini-tts` until 2027-01; see decision D4.
   - STT → `gpt-transcribe`.
   - Embeddings → unchanged.
8. B9: map `file` input to a new `files` capability (Phase 1) instead of `vision`.

### Phase 1: Core type extensions (`@aeye/core`, `@aeye/ai`)

These are additive, so the change is non-breaking for callers.

**`ReasoningEffort`**
- Becomes `'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'`.
- `reason` gains `mode?: 'pro'`, `context?: 'auto'|'all_turns'|'current_turn'`,
  `summary?: 'auto'|'concise'|'detailed'` and `exclude?: boolean`.
- Providers clamp an unsupported effort to the nearest supported value. OpenRouter now publishes
  `reasoning.supported_efforts`, so store it in `ModelInfo.reasoning`.

**`Request` fields**
- `seed`, `verbosity: 'low'|'medium'|'high'`, `serviceTier`, `metadata`,
  `outputModalities: ('text'|'image'|'audio')[]`, `audio?: {voice, format}`, `imageOutput?:
  {aspectRatio, size, quality}`.
- `moderation?: boolean | {model}`.
- `cache?: {retention?: '30m'|'1h'|'12h'|'24h', mode?: 'implicit'|'explicit'}`.

**`MessageContent`**
- Add a `'video'` type.
- Add `filename`, `fileId`, `detail: 'low'|'high'|'auto'|'original'`, and a `cacheBreakpoint?: boolean |
  {ttl}` marker. That marker maps to OpenAI `prompt_cache_breakpoint` and to OpenRouter/Anthropic
  `cache_control`.

**`Response` and `Chunk`**
- `annotations` (url citations: title, url, start/end index).
- `images` (b64/url, mime).
- `audio` (data, transcript, format).
- `logprobs`.
- `moderation` results.
- `serviceTier`, `phase`.

**`Usage`**
- `text.cacheWrite`.
- `tools: Record<string, {calls, cost?}>` for web search and server tools.
- `costDetails`.

**`ModelPricing`**
- `text.cacheWrite` (plus TTL variants).
- `tools` (per-call prices such as web search).
- `video` (per second).
- `longContext` (threshold and multipliers).
- `tierMultipliers`.

**`ModelInfo`**
- `inputModalities`, `outputModalities`.
- `reasoning: {efforts, defaultEffort, mandatory, supportsMaxTokens}`.
- `deprecatedAt`, `retiresAt`.
- `knowledgeCutoff`.

**`ModelCapability` additions**
- `files` (document input)
- `videoIn`, `video` (generation)
- `audioOut` (split from `audio` if decision D3 approves)
- `moderation`, `rerank`
- `webSearch`, `hostedTools`
- `responses` (model is Responses-only)

**Selection**
- Exclude models past `retiresAt` by default.
- Add a `includeDeprecated` metadata flag.

### Phase 2: OpenAI Responses executor (`@aeye/openai`)

Responses becomes a second chat transport in the same provider.

1. Add `OpenAIConfig.api: 'chat' | 'responses' | 'auto'`, defaulting to `'auto'`. `'auto'` uses Chat
   Completions unless the model needs Responses or the request uses a Responses-only feature:
   - The model's registry entry has the `responses` capability, as `*-codex` and `*-pro` do.
   - The request uses hosted tools, compaction, custom tools or async tools.
2. Request mapping:
   - messages → `input` items, with system → `instructions`.
   - Tools, `tool_choice` (including `allowed_tools`), `text.format` for structured output,
     `text.verbosity`, `reasoning{effort, summary, mode, context}`.
   - `store: false` with `include: ['reasoning.encrypted_content']` by default (stateless).
   - `prompt_cache_options`, `service_tier`, `moderation`.
3. Response mapping:
   - output items → content, toolCalls, reasoning (summary + encrypted item in `reasoning.details`
     with `format: 'openai-responses-v1'`).
   - annotations, `phase`, image generation results, and usage, including `cache_write_tokens` and
     `compute_units`.
4. **Reasoning round-trip:** send stored encrypted reasoning items back on the next turn. The core
   `Prompt` loop already keeps `reasoning.details` on assistant messages, so only the OpenAI conversion
   needs work.
5. Streaming: map the Responses event stream (`response.output_text.delta`, `.reasoning_summary_text.delta`,
   `.function_call_arguments.delta`, `.output_item.done`, `.completed`, error events) onto the existing
   `Chunk` events.
6. Optional stateful mode: `previousResponseId` / `conversation` passthrough when `store: true`.
7. Integration tests: one per model family (gpt-5.6-luna, gpt-6-luna, one codex model), each covering
   tools, strict schema, reasoning round-trip and streaming.

### Phase 3: Built-in and hosted tools (core + OpenAI + OpenRouter)

1. Add a `BuiltinTool` union alongside `ToolDefinition` in core:
   - `{type: 'web_search', options}`, `{type: 'web_fetch'}`, `{type: 'file_search', vectorStoreIds}`
   - `{type: 'code_interpreter'}`, `{type: 'image_generation', options}`
   - `{type: 'mcp', server}`, `{type: 'computer', ...}`, `{type: 'shell'}`, `{type: 'apply_patch'}`
   - `{type: 'tool_search'}`
   - `{type: 'provider', name, config}` as the escape hatch
2. Mapping:
   - OpenAI → Responses hosted tools.
   - OpenRouter → `openrouter:web_search`, `openrouter:web_fetch`, `openrouter:image_generation`,
     `openrouter:datetime` and similar, plus `stop_server_tools_when`.
   - A provider that lacks a tool makes model selection skip it (`webSearch` / `hostedTools`
     capabilities).
3. `custom` freeform tools: `ToolDefinition` gets `format?: {type: 'text'} | {type: 'grammar', syntax:
   'lark'|'regex', definition}`. Also `defer?: boolean` for tool search / `defer_loading`, and
   `async?: boolean`.
4. Local tools that the model *drives*, such as `shell` and `apply_patch` when they run on the
   client, surface as ordinary tool calls handled by the `Prompt` loop.
5. Tool results may return image and file parts. openai-node v6 allows this, and the
   placeholder-text downgrade in `convertContentText` should go away for the Responses path.

### Phase 4: OpenAI media refresh

1. **Images:**
   - Add the `gpt-image-2` and `gpt-image-2.5-*` families.
   - Quality `low|medium|high|xhigh|max|auto`.
   - `size: 'auto'` plus the per-model size list, taken from the registry instead of hard-coded.
   - `outputFormat` (png/jpeg/webp), `outputCompression`, `moderation`, `inputFidelity`.
   - **Multi-image edits** (`image: Resource[]`); JSON-body edits.
   - Drop the DALL·E code paths (shut down), or keep them behind the `dall-e-` prefix only.
2. **Transcription:**
   - `gpt-transcribe` as the default.
   - `responseFormat: 'diarized_json'` with speaker segments (`TranscriptionResponse.segments[]` with
     `speaker`).
   - `knownSpeakers` reference clips, `chunkingStrategy`, `include: ['logprobs']`.
3. **Speech:**
   - Remove the hard voice whitelist. Validate against the registry voice list, and allow custom voice
     ids.
   - `streamFormat: 'sse'` → `speechStream`.
   - Note that the replacement for `tts-1` and `gpt-4o-mini-tts` is a realtime model (decision D4).
4. **Moderation:** an optional `ai.moderate(input)` op (`omni-moderation-latest`), plus the inline
   `moderation` flag from Phase 1.
5. **Video:** none. Sora is shut down on OpenAI, and video generation goes through OpenRouter
   (Phase 5).

### Phase 5: OpenRouter refresh (`@aeye/openrouter`)

**1. Per-request routing.** Add a typed `request.openrouter?: { ... }`, merged over the config
defaults. Fields:
- `provider`: full current schema, including the `sort` object/partition, `preferred_*` and
  `provider.options`.
- `models` fallback array.
- `variant: 'nitro'|'floor'|'exacto'|'free'`, appended to the slug.
- `preset`.
- `plugins`.
- `sessionId`.
- `trace`.

Also wire up the currently unused `models` and `user` fields.

**2. Plugins**
- Typed `fileParser{pdfEngine}`, `responseHealing`, `contextCompression`, `webFetch`.
- Translate the config `transforms: ['middle-out']` to the `context-compression` plugin, and
  deprecate `transforms`.

**3. Deprecated features.** Stop sending `usage: {include}`. Never generate `:online`, `:thinking`
or `:extended` slugs; use web search through the Phase 3 tool instead.

**4. Reasoning**
- Send `reasoning{effort, max_tokens, exclude, summary, mode, context}` only, and drop the duplicate
  `reasoning_effort` from the base class.
- Clamp to `supported_efforts`.
- Keep `reasoning_details` order intact; it already round-trips.

**5. Response extras**
- Annotations.
- `message.images` (image output via chat).
- `delta.audio` (audio output).
- `cost_details`, `server_tool_use_details`, cache write tokens, `service_tier`.

**6. Re-enable operations** that are now native OpenRouter endpoints:

| Operation | Endpoint | Notes |
|---|---|---|
| `embed` | `/embeddings` | |
| `generateImage(Stream)` | `/images` | Fall back to chat `modalities` for chat-only image models. |
| `editImage` | `/images` with input images, or chat | *(verify the edit shape)* |
| `speech` | `/audio/speech` | |
| `transcribe` | `/audio/transcriptions` | |

**7. New operations** (Phase 1 types):
- `rerank` → `/rerank`.
- `generateVideo` → `/videos`, async: submit, poll, then fetch content. Use the existing resource/
  stream helpers, and a `VideoGenerationRequest` with prompt, duration, resolution, aspect,
  reference images and `previousJobId`.

**8. Model source**
- Map every pricing field (`input_cache_read/write(_1h)`, `web_search`, `audio`, `audio_output`,
  `image_output`, `image_token`, `discount`).
- Map `reasoning`, `expiration_date` → `retiresAt`, `knowledge_cutoff`, and the full modality lists.
- Fetch `/embeddings/models`, `/images/models` and `/videos/models` so non-chat models appear with
  the correct capabilities.
- Optionally fetch `/models/{id}/endpoints` for latency, throughput and uptime, which **replaces the
  puppeteer metrics scrape**.
- Use `supported_parameters` per endpoint to set `toolsStrict` and `structured` more accurately.

**9. Optional `api: 'chat' | 'responses' | 'messages'` transport.** It reuses the Phase 2 Responses
mapper against `/api/v1/responses`. That gives server shell/apply_patch tools and encrypted OpenAI
reasoning through OpenRouter. Low priority: chat completions covers most of it.

### Phase 6: Model registry and scrapers (`@aeye/models`)

1. **OpenAI scraper:**
   - Point it at `developers.openai.com/api/docs/models/{slug}` and the pricing page.
   - Prefer `/v1/models` for the id list.
   - Parse supported endpoints (Chat vs Responses vs Batch), reasoning efforts, modalities, cache-write
     pricing, long-context pricing and deprecation dates (from the deprecations page).
2. Fix the B10 misclassifications:
   - sora → `video`, then drop it as retired.
   - moderation → `moderation`.
   - image models → `image` only.
   - Prune scraper-noise params.
3. Add OpenAI reasoning pricing, which equals output pricing (B4).
4. Refresh `strict-support.ts` to cover `gpt-5.x`, `gpt-6*` and the new OpenRouter families
   (claude-opus-4.8, sonnet-5, gemini-3.5).
5. Rescrape all four registries.
6. Add a CI-able `scrape:check` that fails when an aeye default model id is past `retiresAt`.

### Phase 7: Deferred or out of scope (noted for later)

| Item | Why deferred |
|---|---|
| Realtime GA and the Live API (WebRTC/WebSocket/SIP sessions) | A different programming model. It would be its own package (`@aeye/realtime`) if wanted. |
| Agents API, Decisions API, Skills, Containers, Conversations, Vector stores / file search management | Large stateful surfaces. They can be passed through via `extra` and the Phase 3 `provider` tool escape hatch. |
| Batch API (OpenAI and OpenRouter) | Useful for cost, but needs a job model. Revisit after Phase 5's async video job abstraction exists, since they share polling. |
| Admin, usage, keys, guardrails, workspaces | Not inference. |
| WebSocket mode for Responses | Revisit if agent-loop latency matters. |

### Phase 8: Docs and release

- Update:
  - `packages/docs/providers/{openai,openrouter}.md`
  - the guides (reasoning, image-generation, speech, transcription, structured-output)
  - the package READMEs and `aeye-*.md` summaries
  - the stale "o1/o3-mini" references
- A migration note covering:
  - new defaults
  - deprecated `transforms`
  - the `ReasoningEffort` widening
  - the Node 22 requirement, if D1 lands
- Version bumps per package, then publish. The user publishes to npm.

---

## 6. Open decisions

| # | Decision | Recommendation |
|---|---|---|
| D1 | Upgrade `openai` to v7, which requires Node 22? | **Yes.** v6 lacks GPT-5.6+, `prompt_cache_options` and newer image types. Bump `engines.node` to `>=22` in `@aeye/openai` and `@aeye/openrouter`. |
| D2 | Add `@openrouter/sdk` as a dependency for the new endpoints, or call them with `fetch`? | **`fetch` with hand-written types.** Keeps the dependency tree small. The SDK's generated types change often (several breaking union changes in 2026). |
| D3 | Split capability `audio` into `audioOut`, plus a `speech` op for TTS models, now that chat models output audio? | Yes, keeping `audio` as a deprecated alias for one minor version. |
| D4 | TTS default once `tts-1` and `gpt-4o-mini-tts` retire (2027-01-06)? OpenAI's suggested replacement is a realtime model, which `/audio/speech` may not accept. | Verify whether `gpt-realtime-2.1-mini` works on `/audio/speech`. If not, document the retirement and default OpenAI TTS to whatever `/audio/speech` model survives. |
| D5 | Should `api: 'auto'` default to Responses for *all* OpenAI models? | Not initially. Use Chat Completions unless a model or feature needs Responses. Revisit after Phase 2 has integration coverage. |
| D6 | Video generation in core now (OpenRouter only), or after Batch? | With Phase 5. It is the first async-job op and sets the pattern for Batch. |

## 7. Suggested order and sizing

| Phase | Size | Depends on |
|---|---|---|
| 0 Bug fixes | S | — |
| 1 Core types | M | — |
| 6 Registry refresh | M | 1 |
| 5 OpenRouter refresh (1–5, 8) | M | 1 |
| 2 OpenAI Responses | L | 1 |
| 4 OpenAI media | M | 1, 6 |
| 3 Built-in tools | L | 2 |
| 5 OpenRouter refresh (6, 7, 9) | L | 1, 2 |
| 8 Docs and release | S per phase | each |

Phase 0 can ship immediately as a patch release.
