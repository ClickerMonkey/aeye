# @aeye/docs

LLM-oriented guide to the `@aeye/docs` package: the documentation website for
the `@aeye` multi-provider AI library. Use this when you need to read, edit, add,
build, or serve documentation.

## What this package is

`@aeye/docs` (`packages/docs/`) is a **VitePress** static documentation site. It
is `private: true` and is **not published to npm** — it is built and deployed as
a website (GitHub Pages under `https://clickermonkey.github.io/aeye/`).

- Framework: [VitePress](https://vitepress.dev/) `^1.6.3` (Vue `^3.5.13`).
- Module type: ESM (`"type": "module"`).
- Site config: `packages/docs/.vitepress/config.ts`.
- Content: Markdown files (with Vue/VitePress extensions) organized into topic
  folders at the package root.
- Deployed base path: `/aeye/` (set via `base` in the config). All internal
  links in nav/sidebar are written **without** the base prefix (e.g.
  `/guides/chat`); VitePress prepends `/aeye/` at build time.

## Build & serve (real npm scripts)

From `packages/docs/` (defined in `package.json`):

```bash
# Start the local dev server with hot reload
npm run dev          # → vitepress dev

# Build the static site to .vitepress/dist/
npm run build        # → vitepress build

# Preview the built site locally
npm run preview      # → vitepress preview
```

From the monorepo root these also run via the workspace `build` aggregate:

```bash
# Builds every workspace that defines a build script, including docs
npm run build        # → npm run build --workspaces --if-present
```

Build output goes to `packages/docs/.vitepress/dist/` (gitignored build
artifacts; do not edit files there). The dev cache lives in
`.vitepress/cache/`.

## Content organization (directory map)

All content folders live directly under `packages/docs/`. Each `.md` file is a
page; its URL is its path minus the `.md` (e.g. `guides/chat.md` →
`/guides/chat`). The sidebar/nav in `.vitepress/config.ts` controls which pages
appear where.

```
packages/docs/
├── index.md                  # Home page (layout: home, hero + feature grid)
├── .vitepress/
│   ├── config.ts             # Site config: title, nav, sidebar, search, etc.
│   ├── cache/                # Dev cache (generated)
│   └── dist/                 # Build output (generated)
├── public/                   # Static assets served at site root
│   ├── llms.txt              # LLM-friendly summary of the whole library
│   └── robots.txt
├── getting-started/          # Installation, quick start, multi-provider setup
│   ├── installation.md
│   ├── quick-start.md
│   └── multi-provider.md
├── concepts/                 # Core mental model
│   ├── ai-instance.md
│   ├── providers.md
│   ├── models.md
│   ├── context.md
│   ├── cost-tracking.md
│   └── hooks.md
├── components/               # Composable building blocks
│   ├── tools.md
│   ├── prompts.md
│   ├── agents.md
│   └── composition.md
├── guides/                   # Task-oriented how-tos (chat, streaming,
│   │                         #   tool-calling, structured-output, strict-mode,
│   │                         #   image-generation, vision, speech,
│   │                         #   transcription, embeddings, reasoning,
│   │                         #   model-selection, budget, context-management,
│   │                         #   error-handling, custom-providers)
│   └── *.md
├── gin/                      # @aeye/gin language docs
│   ├── index.md              # Overview (URL: /gin/)
│   ├── types.md
│   ├── expressions.md
│   ├── registry.md
│   ├── built-ins.md
│   └── diagnostics.md
├── providers/                # Per-provider usage guides
│   ├── openai.md
│   ├── openrouter.md
│   ├── replicate.md
│   ├── aws.md
│   └── custom.md
├── reference/                # API reference
│   ├── core/                 # @aeye/core: types, tool, prompt, agent,
│   │                         #   utilities, schema
│   ├── ai/                   # @aeye/ai: ai-class, chat-api, image-api,
│   │                         #   speech-api, transcribe-api, embed-api,
│   │                         #   models-api, registry, types
│   └── providers/            # openai, openrouter, replicate, aws
└── examples/                 # End-to-end examples (basic-chat, weather-agent,
                              #   code-reviewer, todo-manager, knowledge-base,
                              #   budget-control, multi-provider, cletus, ginny)
```

### Sidebar grouping

Sidebars are keyed by URL prefix in `.vitepress/config.ts` under
`themeConfig.sidebar`. The configured groups are:

| URL prefix         | Sidebar group title              |
|--------------------|----------------------------------|
| `/getting-started/`| Getting Started                  |
| `/concepts/`       | Core Concepts                    |
| `/components/`     | Components                       |
| `/guides/`         | Guides                           |
| `/gin/`            | gin — LLM-authorable runtime     |
| `/providers/`      | Providers                        |
| `/reference/`      | @aeye/core, @aeye/ai, Providers  |
| `/examples/`       | Examples                         |

The top nav (`themeConfig.nav`) links to: Guide, Components, Providers, Gin,
API Reference, Examples.

## How to add or edit documentation

### Edit an existing page

1. Find the page by its URL: `/<prefix>/<slug>` maps to
   `packages/docs/<prefix>/<slug>.md`.
2. Edit the Markdown. Standard Markdown plus VitePress extensions are
   available (code groups, custom containers like `::: tip`, frontmatter,
   embedded Vue). Code fences should specify a language (`typescript`, `bash`,
   `json`, …).
3. Run `npm run dev` to preview; the page hot-reloads.

### Add a new page

1. Create `packages/docs/<section>/<slug>.md`. Pick the section that matches the
   content (guide, concept, reference, etc.).
2. Add the page to the correct sidebar group in
   `packages/docs/.vitepress/config.ts` so it is discoverable:

   ```ts
   '/guides/': [
     {
       text: 'Guides',
       items: [
         // ... existing items ...
         { text: 'My New Guide', link: '/guides/my-new-guide' },
       ],
     },
   ],
   ```

   Note: `link` omits the `.md` extension and the `/aeye/` base prefix.
3. If the page should be reachable from the top nav, add an entry to
   `themeConfig.nav`.
4. Preview with `npm run dev`, then `npm run build` to confirm there are no
   broken links (VitePress fails the build on dead internal links).

### Add a new section (URL prefix)

1. Create the folder and at least one `.md` file (e.g.
   `packages/docs/newsection/index.md`; an `index.md` is reachable at
   `/newsection/`).
2. Add a new sidebar key for `/newsection/` in `themeConfig.sidebar`.
3. Optionally add a nav entry.

### Conventions to follow

- Keep internal links extension-less and base-less (`/concepts/providers`, not
  `/aeye/concepts/providers.html`).
- The home page (`index.md`) uses `layout: home` frontmatter with `hero` and
  `features`; do not convert it to a normal page.
- `public/llms.txt` is a hand-maintained, LLM-friendly summary of the whole
  library. When you add major features or packages, update it to stay in sync.
- Site-wide metadata (title, description, social links, edit-link pattern,
  search provider, sitemap hostname) all live in `.vitepress/config.ts` — edit
  there, not per-page.
- The edit-link pattern points at
  `https://github.com/ClickerMonkey/aeye/edit/main/packages/docs/:path`, so the
  on-disk path under `packages/docs/` is the canonical source for every page.

## Quick reference

| Task                     | Command / Location                              |
|--------------------------|-------------------------------------------------|
| Dev server               | `npm run dev` (in `packages/docs/`)             |
| Build site               | `npm run build`                                 |
| Preview build            | `npm run preview`                               |
| Site config / nav / sidebar | `packages/docs/.vitepress/config.ts`         |
| Add a page               | new `.md` + sidebar entry in `config.ts`        |
| Static assets            | `packages/docs/public/`                         |
| Build output             | `packages/docs/.vitepress/dist/` (generated)    |
