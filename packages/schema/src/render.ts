/**
 * Rendering: one compiled `Node` per (schema, profile). A node knows how to
 *
 * - `json()`   — emit the JSON Schema the model is given (memoized),
 * - `run()`    — validate the model's answer AND decode it into the code
 *                shape in one walk, reporting errors at the path the model
 *                wrote (wire path) and the path the code sees (code path),
 * - `encode()` — turn a code-shape value into the wire shape (examples,
 *                few-shot messages, echoing prior arguments back).
 *
 * The schema classes in `schema.ts` own their logic (`compile`); this file
 * holds the shared machinery: the compiler (refs, `$defs`, cycles, depth, the
 * JSON-text escape hatch), the walk context with copy accounting, and the
 * `Rendered` result that callers hold.
 *
 * COPY RULES (asserted in tests, tabled in DESIGN.md):
 * - A subtree whose node has `needs === false` is validated and returned as
 *   the SAME reference. No object or array is allocated for it.
 * - Default `inPlace: true` (the caller owns the `JSON.parse` result): a
 *   changed child is written back into its parent (`edits`), `null`-for-absent
 *   keys are deleted (`edits`). Parents are never copied.
 * - `inPlace: false` (copy-on-write): the first change inside an object/array
 *   clones THAT container once (`objects`/`arrays`); untouched siblings and
 *   subtrees are shared, never cloned.
 * - The only unavoidable allocations are shape changes: a record sent as
 *   `[{key, value}]` becomes one new object (values moved, not copied); a
 *   tuple sent as `{"0":…}` becomes one new array; JSON text in an escape
 *   hatch is parsed once (`parsed`).
 */
import type { Profile, View } from './profile';
import { LENIENT, viewOf } from './profile';
import type { AnySchema, Text } from './schema';

export type JsonSchema = { [key: string]: unknown };
export type PathSeg = string | number;

/** One problem with the model's answer. */
export interface Issue {
  /** Where it is in what the MODEL wrote (e.g. `['tags', 2, 'value']` for a pairs record). */
  readonly path: readonly PathSeg[];
  /** Where it is in the CODE shape (e.g. `['tags', 'urgent']`). */
  readonly codePath: readonly PathSeg[];
  readonly message: string;
}

/** Allocation counters for one `parse`. */
export interface CopyStats {
  /** Objects allocated (records from pairs, copy-on-write clones). */
  objects: number;
  /** Arrays allocated (tuples from numeric-key objects, copy-on-write clones). */
  arrays: number;
  /** In-place writes/deletes into the caller's value. */
  edits: number;
  /** JSON texts parsed (escape hatches, `json-text` any). */
  parsed: number;
}

export function formatPath(path: readonly PathSeg[]): string {
  let out = '';
  for (const seg of path) {
    out += typeof seg === 'number' ? `[${seg}]` : /^[A-Za-z_$][\w$]*$/.test(seg) ? (out ? `.${seg}` : seg) : `[${JSON.stringify(seg)}]`;
  }
  return out || '(root)';
}

/** The walk context. Paths are push/pop stacks so the happy path allocates nothing. */
export class Cx {
  readonly errors: Issue[] = [];
  readonly wire: PathSeg[] = [];
  readonly code: PathSeg[] = [];
  constructor(
    /** Mutate the caller's value (default) or copy-on-write. */
    readonly inPlace: boolean,
    /** Dry run: validate only, never write (used to pick a union option). */
    readonly dry: boolean,
    readonly stats: CopyStats,
  ) {}
  fail(message: string): void {
    this.errors.push({ path: [...this.wire], codePath: [...this.code], message });
  }
  enter(wire: PathSeg, code: PathSeg | null = wire): void {
    this.wire.push(wire);
    if (code !== null) this.code.push(code);
  }
  leave(code = true): void {
    this.wire.pop();
    if (code) this.code.pop();
  }
  /** A dry sibling sharing the current paths (for union option tests). */
  dryRun(): Cx {
    const d = new Cx(false, true, newStats());
    d.wire.push(...this.wire);
    d.code.push(...this.code);
    return d;
  }
}

export function newStats(): CopyStats {
  return { objects: 0, arrays: 0, edits: 0, parsed: 0 };
}

/** What a schema class supplies to build its node. */
export interface NodeImpl {
  /** This node itself changes the value's shape (pairs→record, null→absent, JSON text…). */
  readonly own?: boolean;
  /** Child nodes (for the `needs` fixpoint). */
  readonly deps?: readonly Node[];
  /** Automatic description text this node adds for the model, e.g. how pairs work. */
  readonly hint?: (view: View) => string | undefined;
  emit(): JsonSchema;
  run(value: unknown, cx: Cx): unknown;
  encode(value: unknown): unknown;
}

/** A compiled (schema, profile) node. */
export class Node {
  /** True when decoding may change this subtree (own change or any dependency's). */
  needs = false;
  schema: AnySchema | undefined;
  /** An outer wrapper (e.g. `.optional()` around a field) whose metadata also applies. */
  outer: AnySchema | undefined;
  private _json: JsonSchema | undefined;
  constructor(public impl: NodeImpl | undefined, readonly compiler: Compiler) {}

  get own(): boolean { return !!this.impl?.own; }
  get deps(): readonly Node[] { return this.impl?.deps ?? []; }

  json(): JsonSchema {
    if (!this._json) this._json = this.compiler.decorate(this, this.impl!.emit());
    return this._json;
  }

  run(value: unknown, cx: Cx): unknown {
    const before = cx.errors.length;
    const out = this.impl!.run(value, cx);
    if (cx.errors.length === before) this.check(out, cx, this.schema);
    if (cx.errors.length === before && this.outer) this.check(out, cx, this.outer);
    return out;
  }

  private check(value: unknown, cx: Cx, schema: AnySchema | undefined): void {
    if (!schema) return;
    for (const c of schema.checks) {
      const r = c.fn(value);
      if (r === true) continue;
      cx.fail(typeof r === 'string' ? r : c.message ?? 'Failed a check.');
    }
  }

  encode(value: unknown): unknown {
    return this.impl!.encode(value);
  }
}

/** Builds and prints a TypeScript-like shape (escape-hatch descriptions, prompt-text delivery). */
export class Printer {
  private readonly names = new Set<string>();
  constructor(readonly env: ReadonlyMap<string, AnySchema>) {}
  print(s: AnySchema): string {
    return s.print(this);
  }
  ref(name: string): string {
    this.names.add(name);
    return name;
  }
  /** The shape plus a `type X = …` line for every named type it reaches. */
  full(s: AnySchema): string {
    const head = this.print(s);
    const lines: string[] = [];
    const done = new Set<string>();
    for (let again = true; again; ) {
      again = false;
      for (const n of [...this.names]) {
        if (done.has(n)) continue;
        done.add(n);
        again = true;
        const def = this.env.get(n);
        if (def) lines.push(`type ${n} = ${def.print(this)}`);
      }
    }
    return lines.length ? `${head}\nwhere\n${lines.join('\n')}` : head;
  }
}

const CONTAINERS = new Set(['object', 'array', 'record', 'tuple']);

const nesting = new WeakMap<AnySchema, number>();
/** Container depth of a ref-free schema (memoized per instance). */
function nestingOf(s: AnySchema): number {
  let n = nesting.get(s);
  if (n === undefined) {
    n = (CONTAINERS.has(s.kind) ? 1 : 0) + Math.max(0, ...s.children().map(nestingOf));
    nesting.set(s, n);
  }
  return n;
}

/**
 * Node cache for REF-FREE schemas, keyed by schema instance then profile id.
 * A ref-free subtree renders the same whatever the bound refs are, so it is
 * compiled once per profile for as long as the schema instance lives (the
 * WeakMap lets it go with the schema). This is what makes re-binding a
 * dynamic bundle cheap: only nodes that touch a ref are rebuilt.
 */
const refFreeCache = new WeakMap<AnySchema, Map<string, Node>>();

/** Compiles schemas for one (bound env, profile). */
export class Compiler {
  readonly nodes: Node[] = [];
  /** Named types emitted into `$defs` (defs mode). */
  readonly defs = new Map<string, DefTarget>();
  readonly view: View;
  private readonly stack: string[] = [];
  private depth = 0;

  constructor(
    readonly profile: Profile,
    readonly env: ReadonlyMap<string, AnySchema>,
    /** The LENIENT rendering of the same bound env (escape hatches validate against it). */
    readonly lenient: () => Rendered<unknown>,
  ) {
    this.view = viewOf(profile);
  }

  node(impl: NodeImpl): Node {
    return new Node(impl, this);
  }

  /** Compile a schema; `outer` is a wrapper whose metadata/checks also apply (an optional field). */
  compile(s: AnySchema, outer?: AnySchema): Node {
    // A model sees the narrower `forModels` variant; its output fits the original.
    if (this.profile.audience !== 'people' && s.meta.forModels) {
      const { forModels, ...rest } = s.meta;
      const m = forModels as AnySchema;
      s = m.meta.description === undefined && rest.description !== undefined ? m.describe(rest.description) : m;
    }
    const container = CONTAINERS.has(s.kind);
    if (container && this.profile.maxDepth !== undefined && this.depth >= this.profile.maxDepth) {
      return this.escape(s, `Nested too deep for this model to describe directly.`);
    }
    // Ref-free and certain not to hit the depth limit below here → the node is the same in every bind.
    const cacheable = !outer && s.refNames().size === 0
      && (this.profile.maxDepth === undefined || this.depth + nestingOf(s) < this.profile.maxDepth);
    if (cacheable) {
      const hit = refFreeCache.get(s)?.get(this.profile.id);
      if (hit) return hit;
    }
    if (container) this.depth++;
    const n = s.compile(this);
    if (container) this.depth--;
    n.schema = s;
    n.outer = outer;
    this.nodes.push(n);
    if (cacheable) {
      let m = refFreeCache.get(s);
      if (!m) refFreeCache.set(s, (m = new Map()));
      m.set(this.profile.id, n);
    }
    return n;
  }

  /** A use of a named type. */
  ref(name: string): Node {
    const s = this.env.get(name);
    if (!s) throw new Error(`@aeye/schema: ref "${name}" is not defined (the chain's types should have prevented this).`);
    const p = this.profile;
    if (this.stack.includes(name)) {
      if (p.defs && p.recursion) return this.defRef(name, this.defs.get(name)!);
      return this.escape(s, `"${name}" contains itself, which this model cannot describe directly.`, name);
    }
    if (p.defs) {
      const existing = this.defs.get(name);
      if (existing) return this.defRef(name, existing);
      const target = new DefTarget(this);
      this.defs.set(name, target);
      this.stack.push(name);
      target.target = this.compile(s);
      this.stack.pop();
      this.nodes.push(target);
      return this.defRef(name, target);
    }
    this.stack.push(name);
    const n = this.compile(s);
    this.stack.pop();
    return n;
  }

  private defRef(name: string, def: DefTarget): Node {
    const n = this.node({
      deps: [def],
      emit: () => ({ $ref: `#/$defs/${name}` }),
      run: (v, cx) => def.run(v, cx),
      encode: (v) => def.encode(v),
    });
    this.nodes.push(n);
    (n as RefNode).refName = name;
    return n;
  }

  /**
   * The escape hatch: a string holding JSON text in the CODE shape, used for
   * whatever the profile cannot express (recursion, depth, "any"). The JSON
   * text is parsed once and validated by the LENIENT rendering of the same
   * schema, so nothing is lost — only moved into a string.
   */
  escape(s: AnySchema, why: string, name?: string): Node {
    const shape = new Printer(this.env).full(name ? this.env.get(name)! : s);
    let inner: Node | undefined;
    const lenientNode = () => (inner ??= this.lenient().nodeFor(s));
    const n = this.node({
      own: true,
      emit: () => ({ type: 'string', description: `${why} Write it as JSON text of this TypeScript type:\n${shape}` }),
      run: (v, cx) => {
        if (typeof v !== 'string') {
          cx.fail('Expected a string of JSON text.');
          return v;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(v);
        } catch (e) {
          cx.fail(`Not valid JSON text: ${(e as Error).message}`);
          return v;
        }
        cx.stats.parsed++;
        cx.enter('(json)', null);
        const sub = cx.dry ? cx : cx;
        const out = lenientNode().run(parsed, sub);
        cx.leave(false);
        return out;
      },
      encode: (v) => JSON.stringify(v),
    });
    this.nodes.push(n);
    return n;
  }

  /** A node for a ref-free subschema in this compiler, compiled on demand (after `finish`). */
  late(s: AnySchema): Node {
    const n = this.compile(s);
    this.finish();
    return n;
  }

  /** Least fixpoint of `needs = own || any(dep.needs)` (handles cycles). */
  finish(): void {
    for (let changed = true; changed; ) {
      changed = false;
      for (const n of this.nodes) {
        if (n.needs) continue;
        if (n.own || n.deps.some((d) => d.needs)) {
          n.needs = true;
          changed = true;
        }
      }
    }
  }

  /** Text of a `Text` for this profile. */
  text(t: Text | undefined): string | undefined {
    return t === undefined ? undefined : typeof t === 'function' ? t(this.view) : t;
  }

  /** Add description, examples and title to an emitted schema. */
  decorate(node: Node, json: JsonSchema): JsonSchema {
    const parts: string[] = [];
    const metas = [node.schema?.meta, node.outer?.meta];
    let title: string | undefined;
    const examples: unknown[] = [];
    for (const m of metas) {
      if (!m) continue;
      const d = this.text(m.description);
      if (d) parts.push(d);
      if (m.title) title = m.title;
      if (m.examples) for (const e of m.examples) examples.push(node.encode(e));
    }
    const hint = node.impl?.hint?.(this.view);
    if (hint) parts.push(hint);
    const prior = typeof json.description === 'string' ? json.description : undefined;
    if (prior) parts.push(prior);
    const out: JsonSchema = { ...json };
    if (title) out.title = title;
    if (examples.length) {
      if (this.profile.examples === 'keyword') out.examples = examples;
      else if (this.profile.examples === 'description')
        parts.push(`Example${examples.length > 1 ? 's' : ''}: ${examples.map((e) => JSON.stringify(e)).join(' ; ')}`);
    }
    if (parts.length) out.description = parts.join('\n');
    return out;
  }
}

interface RefNode extends Node {
  refName?: string;
}

/** The `$defs` entry of a named type; filled in after its body compiles (cycles point at it first). */
export class DefTarget extends Node {
  target!: Node;
  constructor(compiler: Compiler) {
    super(undefined, compiler);
  }
  override get own(): boolean { return false; }
  override get deps(): readonly Node[] { return this.target ? [this.target] : []; }
  override json(): JsonSchema { return this.target.json(); }
  override run(v: unknown, cx: Cx): unknown { return this.target.run(v, cx); }
  override encode(v: unknown): unknown { return this.target.encode(v); }
}

/** Successful or failed parse. */
export type ParseResult<Out> =
  | { readonly ok: true; readonly value: Out; readonly stats: CopyStats }
  | { readonly ok: false; readonly issues: readonly Issue[]; readonly message: string; readonly stats: CopyStats };

/** A schema rendered for one profile: JSON schema + codec + validation, memoized. */
export class Rendered<Out> {
  declare readonly _out: Out;
  private _json: JsonSchema | undefined;
  constructor(readonly compiler: Compiler, readonly root: Node) {}

  get profile(): Profile { return this.compiler.profile; }

  /** The JSON Schema the model is given. A root ref is inlined (tool params must be an object). */
  get jsonSchema(): JsonSchema {
    if (this._json) return this._json;
    const root = this.root;
    const refName = (root as RefNode).refName;
    const body = refName ? this.compiler.defs.get(refName)!.json() : root.json();
    const defs: Record<string, JsonSchema> = {};
    for (const [name, def] of this.compiler.defs) defs[name] = def.json();
    this._json = this.compiler.defs.size ? { ...body, $defs: defs } : body;
    return this._json;
  }

  /**
   * Validate + decode the model's answer (already `JSON.parse`d). With
   * `inPlace` (default) the value is decoded in place and returned; see the
   * copy rules at the top of this file.
   */
  parse(wire: unknown, opts?: { inPlace?: boolean }): ParseResult<Out> {
    const stats = newStats();
    const cx = new Cx(opts?.inPlace ?? true, false, stats);
    const value = this.root.run(wire, cx);
    if (cx.errors.length) {
      return { ok: false, issues: cx.errors, message: formatIssues(cx.errors), stats };
    }
    return { ok: true, value: value as Out, stats };
  }

  /** `JSON.parse` then decode in place (we own the parsed value). */
  parseText(text: string): ParseResult<Out> {
    let wire: unknown;
    try {
      wire = JSON.parse(text);
    } catch (e) {
      const issues = [{ path: [], codePath: [], message: `Not valid JSON: ${(e as Error).message}` }];
      return { ok: false, issues, message: formatIssues(issues), stats: newStats() };
    }
    return this.parse(wire);
  }

  /** Code shape → the shape this model writes (few-shot examples, echoing prior args). */
  encode(value: Out): unknown {
    return this.root.encode(value);
  }

  /** Node for a subschema in this rendering (escape hatches use the LENIENT one). */
  nodeFor(s: AnySchema): Node {
    return this.compiler.late(s);
  }

  /** The whole shape as TypeScript-like text (prompt-text delivery). */
  typescript(): string {
    const s = this.root.schema!;
    return new Printer(this.compiler.env).full(s);
  }
}

/** The message a model is shown for its mistakes — paths are where IT wrote them. */
export function formatIssues(issues: readonly Issue[]): string {
  return issues.map((i) => `- at ${formatPath(i.path)}: ${i.message}`).join('\n');
}

/** Wrap an emitted schema so it also accepts `null`. */
export function withNull(j: JsonSchema): JsonSchema {
  if (typeof j.type === 'string' && !('$ref' in j) && !('anyOf' in j)) {
    const out: JsonSchema = { ...j, type: [j.type, 'null'] };
    if (Array.isArray(j.enum)) out.enum = [...j.enum, null];
    return out;
  }
  const { description, ...rest } = j;
  return description === undefined
    ? { anyOf: [rest, { type: 'null' }] }
    : { anyOf: [rest, { type: 'null' }], description };
}

export { LENIENT };
