# @aeye/context

Pull **@aeye's agent context** — the flat agent-reference docs — into your repo with one command.

Each `@aeye/*` package ships LLM/agent docs as flat markdown: an `aeye-<pkg>.md` reference (some
packages add topic sub-docs like `aeye-core-tools.md`), cross-linked as flat siblings
(`./aeye-core-types.md`). Those files ship inside each installed package
(`node_modules/@aeye/core/aeye-core.md`, …). This CLI copies every installed package's doc into one
flat folder and generates an `aeye.md` index, so the links actually resolve — on GitHub, in your
editor, and when you point a coding agent at them.

## Usage

```bash
npx @aeye/context             # → ./docs
npx @aeye/context .aeye       # → any target directory
```

Run it from your project root (wherever `node_modules/` lives). Re-run after adding or upgrading
`@aeye/*` packages to resync. To wire it into your project:

```jsonc
// package.json
"scripts": { "context:sync": "aeye-context" }
```

## What it does

1. Scans `node_modules/@aeye/*` (and pnpm's virtual store) for `aeye-*.md` files and copies each,
   flat, into the target folder. Deduped by filename; direct dependencies win.
2. Writes a generated **`aeye.md`** index — a table linking to every synced doc, labelled by each
   file's title. (Unlike some monorepos, `@aeye` has no hand-written root router, so the index is
   generated from whatever is installed — it never lists docs you don't have.)

Only files are written — nothing is deleted from the target.

## Options

| Arg | Meaning |
| --- | --- |
| `[target-dir]` | Where to write the flat docs + index. Default: `docs`. |
| `--help` | Show usage. |
