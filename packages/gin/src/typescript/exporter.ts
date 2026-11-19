/**
 * gin → runnable TypeScript.
 *
 * `Exporter` turns gin `Expr`s into TypeScript source that does what
 * `engine.run` does, plus a map of every non-native type the code refers to
 * (as `type X = …` declarations). See `index.ts` for the public surface and
 * `aeye-gin-typescript.md` for the mapping rules.
 *
 * Shape of the compiler: every expression compiles either to a VALUE (a
 * TypeScript expression, possibly after pushing statements it needs onto the
 * current statement list — `val`) or to STATEMENTS aimed at a target
 * (discard / return / assign — `stmt`). gin is expression-oriented (an `if`
 * or a `define` has a value), TypeScript is not; hoisting into the enclosing
 * statement list keeps `break` / `continue` / `return` meaningful where an
 * IIFE would swallow them. Evaluation order is gin's: when a later argument
 * needs statements or has effects, everything before it is spilled to a
 * temp first.
 */
import type { Engine } from '../engine';
import type { Registry } from '../registry';
import { Type, Prop, type PropSpec, type Call } from '../type';
import { Extension } from '../extension';
import { Expr } from '../expr';
import { Effects } from '../effects';
import { CallStep, IndexStep, PropStep, type PathStep } from '../path';
import { NewExpr } from '../exprs/new';
import { GetExpr } from '../exprs/get';
import { SetExpr } from '../exprs/set';
import { DefineExpr } from '../exprs/define';
import { BlockExpr } from '../exprs/block';
import { IfExpr } from '../exprs/if';
import { SwitchExpr } from '../exprs/switch';
import { LoopExpr } from '../exprs/loop';
import { LambdaExpr } from '../exprs/lambda';
import { TemplateExpr } from '../exprs/template';
import { FlowExpr } from '../exprs/flow';
import { NativeExpr } from '../exprs/native';
import { Value } from '../value';
import { embeddedExpr } from '../type';
import {
  AliasType, AnyType, AndType, BoolType, ColorType, DateType, DurationType, EnumType, FnType,
  IfaceType, ListType, LiteralType, MapType, NotType, NullType, NullableType, NumType, ObjType,
  OptionalType, OrType, TextType, TimestampType, TupleType, TypType, VoidType,
} from '../types';
import { PRELUDE } from './prelude';
import { TypeNames } from './names';
import { NATIVE_TS, INDEX_GET_TS, INDEX_SET_TS, access, isIdent, type NativeCtx } from './natives';

// ─── options & output ──────────────────────────────────────────────────────

export interface TypeScriptOptions {
  /** Name of the exported function. Default `main`. */
  name?: string;
  /** `'referenced'` (default): every non-native type the code refers to, transitively,
   *  lands in `types`. `'none'`: no declarations (the code still names them). */
  types?: 'referenced' | 'none';
  /** gin docs and comments as `/** … *\/` and `//`. Default true. */
  includeComments?: boolean;
  /** `'separate'` (default): helpers (prelude, `makeX` constructors, guards) are their
   *  own map, deduplicated by `joinTypeScript`. `'inline'`: prepended to `code`. */
  prelude?: 'separate' | 'inline';
  /** `'always'` (default): every function is async and every call to a function value
   *  or host member is awaited. `'auto'`: a function is async only when it awaits. */
  async?: 'always' | 'auto';
  /** Prefix declarations (types, the function, `makeX`) with `export`. Default false. */
  export?: boolean;
  /** Types of free variables that are not engine globals (what `engine.run`'s
   *  `extras` would hold). They reach the code through the `ctx` parameter. */
  scope?: Record<string, Type>;
}

export interface TypeScriptOutput {
  /** The exported function. */
  code: string;
  /** `type` declarations by name — every non-native type the code refers to. */
  types: Map<string, string>;
  /** Helpers the code calls: prelude functions, `makeX` constructors, guards. */
  helpers: Map<string, string>;
  /** The functions `code` declares, by name. */
  functions: string[];
}

export class TypeScriptExportError extends Error {
  constructor(readonly problems: string[]) {
    super(`gin → TypeScript: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n  - ${problems.join('\n  - ')}`);
    this.name = 'TypeScriptExportError';
  }
}

// ─── internal shapes ───────────────────────────────────────────────────────

/** A compiled value. */
interface Res {
  code: string;
  type: Type;
  /** Reading `code` again gives the same value and has no effect. */
  pure: boolean;
  /** A function value known to be synchronous (`false` = known async, undefined = unknown). */
  sync?: boolean;
}

interface Sym {
  ts: string;
  type: Type;
  sync?: boolean;
}

type Scope = Map<string, Sym>;

type Target = { kind: 'discard' } | { kind: 'return' } | { kind: 'assign'; name: string };

/** One function being compiled. */
class Fn {
  awaited = false;
  readonly loops: Array<'for' | 'parallel'> = [];
  constructor(
    /** Free variables resolve through `ctx` (false inside `makeX` bodies). */
    readonly ctxAllowed: boolean,
  ) {}
}

/** What a `makeX` constructor attaches. */
interface MakerInfo {
  name: string;
  /** Every member the maker attaches (own and inherited), with whether it is async. */
  members: Map<string, { kind: 'method' | 'computed'; async: boolean | 'pending' }>;
}

interface Gen {
  generics: Set<string>;
}

const TS_RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof',
  'var', 'void', 'while', 'with', 'as', 'implements', 'interface', 'let', 'package', 'private',
  'protected', 'public', 'static', 'yield', 'await', 'async', 'undefined', 'arguments', 'eval',
  'ctx', 'args', 'self', 'Promise', 'Math', 'Number', 'String', 'Boolean', 'Date', 'Map', 'Set',
  'Array', 'Object', 'JSON', 'Error', 'RegExp',
]);

const LITERAL_RE = /^(-?\d[\d.e+-]*|"(?:[^"\\]|\\.)*"|true|false|null|undefined)$/;

// ─── the exporter ──────────────────────────────────────────────────────────

export class Exporter {
  readonly registry: Registry;
  readonly types = new Map<string, string>();
  readonly helpers = new Map<string, string>();
  private readonly problems = new Set<string>();
  private readonly opt: Required<Omit<TypeScriptOptions, 'scope' | 'name'>> & { scope: Record<string, Type> };

  /** gin type name → TypeScript identifier. */
  private readonly names: TypeNames;
  /** Named types whose declaration is done or under way. */
  private readonly defined = new Set<string>();
  private readonly makers = new Map<string, MakerInfo | null>();
  private readonly guards = new Map<string, string>();
  private readonly used = new Set<string>();
  /** Free variables read by the export being compiled, gin name → type. */
  private ctxVars = new Map<string, Type>();
  private usesExit = false;

  constructor(readonly engine: Engine, options: TypeScriptOptions = {}) {
    this.registry = engine.registry;
    this.opt = {
      types: options.types ?? 'referenced',
      includeComments: options.includeComments ?? true,
      prelude: options.prelude ?? 'separate',
      async: options.async ?? 'always',
      export: options.export ?? false,
      scope: options.scope ?? {},
    };
    this.names = new TypeNames(this.registry, (t) => this.splits(this.decl(t)));
  }

  private get always(): boolean { return this.opt.async === 'always'; }
  private get exp(): string { return this.opt.export ? 'export ' : ''; }

  problem(msg: string): void { this.problems.add(msg); }

  /** Throw the collected problems, if any. */
  check(): void {
    if (this.problems.size > 0) throw new TypeScriptExportError([...this.problems]);
  }

  // ─── names ───────────────────────────────────────────────────────────────

  /** A fresh identifier based on `base`, unique across the whole export. */
  private uniq(base: string): string {
    let b = base.replace(/[^\w$]/g, '_');
    if (!/^[A-Za-z_$]/.test(b)) b = '_' + b;
    // Keep clear of the value names helpers use: `makeX`, `$isX`, the `$…` prelude.
    if (/^make[A-Z]/.test(b) || /^is[A-Z]/.test(b) || b.startsWith('$')) b = '_' + b;
    let name = TS_RESERVED.has(b) || this.used.has(b) ? `${b}_1` : b;
    for (let i = 2; this.used.has(name); i++) name = `${b}_${i}`;
    this.used.add(name);
    return name;
  }

  /** The TypeScript name of a gin type — collision-free across the registry, see `names.ts`. */
  private tsName(ginName: string): string {
    return this.names.type(ginName);
  }

  helper(name: string): string {
    if (this.helpers.has(name)) return name;
    const h = PRELUDE[name];
    if (!h) throw new Error(`gin → TypeScript: no prelude helper '${name}'`);
    for (const d of h.deps ?? []) this.helper(d);
    this.helpers.set(name, h.code);
    return name;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TYPES
  // ═══════════════════════════════════════════════════════════════════════

  /** The TypeScript type for `t`, defining any named type it reaches. */
  ref(t: Type, g: Gen = { generics: new Set() }): string {
    if (t instanceof AliasType) {
      const n = (t.options as { name: string }).name;
      if (g.generics.has(n)) return n;
      const s = t.simplify();
      if (s !== t && !(s instanceof AliasType)) return this.ref(s, g);
      const looked = this.registry.lookup(n);
      if (looked && !(looked instanceof AliasType)) return this.ref(looked, g);
      return 'any';
    }
    if (t instanceof Extension) return this.namedRef(t, g);
    if (t instanceof AnyType) return 'any';
    if (t instanceof VoidType) return 'void';
    if (t instanceof NullType) return 'null';
    if (t instanceof BoolType) return 'boolean';
    if (t instanceof NumType || t instanceof DurationType || t instanceof ColorType) return 'number';
    if (t instanceof TextType) return 'string';
    if (t instanceof DateType || t instanceof TimestampType) return 'Date';
    if (t instanceof ListType) return arrayOf(this.ref(t.item, g));
    if (t instanceof MapType) return `Map<${this.ref(t.key, g)}, ${this.ref(t.value, g)}>`;
    if (t instanceof TupleType) return `[${t.elements.map((e) => this.ref(e, g)).join(', ')}]`;
    if (t instanceof OptionalType) return union([this.ref(t.inner, g), 'undefined']);
    if (t instanceof NullableType) return union([this.ref(t.inner, g), 'null']);
    if (t instanceof OrType) return union(t.variants.map((v) => this.ref(v, g)));
    if (t instanceof AndType) return t.parts.map((p) => paren(this.ref(p, g))).join(' & ') || 'unknown';
    if (t instanceof EnumType) {
      const vs = Object.values(t.options.values).map((v) => JSON.stringify(v));
      return vs.length ? vs.join(' | ') : 'never';
    }
    if (t instanceof LiteralType) return JSON.stringify(t.literal);
    if (t instanceof FnType) {
      const call = t.call();
      return call ? this.fnSig(call, g, 'unknown', t.generic) : '(...args: any[]) => any';
    }
    if (t instanceof ObjType) return this.objLiteralType(Object.entries(t.fields), g);
    if (t instanceof IfaceType) {
      const members = this.members(Object.entries(t._props), g, undefined);
      if (t._call) members.push(`(${this.params(t._call.args, g)}): ${this.returns(t._call, g, 'unknown')}`);
      return braces(members);
    }
    if (t instanceof NotType || t instanceof TypType) return 'unknown';
    return 'any';
  }

  /** The declaration that `t` is a use of (a specialization shares its declaration's name). */
  private decl(t: Extension): Extension {
    const looked = this.registry.lookup(t.name);
    return looked instanceof Extension && looked.name === t.name ? looked : t;
  }

  /**
   * A reference to a named type. `data: true` names its fields-only type
   * (`PersonData`) instead — the type itself when it has no members to split off.
   */
  private namedRef(t: Extension, g: Gen, data = false): string {
    // A use-site narrowing (`PlayerText{maxLength=40}`) is the target type.
    if (t.local.useSite) {
      return t.original instanceof Extension ? this.namedRef(t.original, g, data) : this.ref(t.original, g);
    }
    const decl = this.decl(t);
    this.define(decl);
    const name = data && this.splits(decl) ? this.dataName(decl) : this.tsName(decl.name);
    const params = Object.keys(decl.generic ?? {});
    if (params.length === 0) return name;
    const args = params.map((p) => {
      const b = t.generic?.[p];
      if (b && !Type.isGenericPlaceholder(p, b)) return this.ref(b, g);
      return g.generics.has(p) ? p : 'any';
    });
    return args.every((a) => a === 'any') ? name : `${name}<${args.join(', ')}>`;
  }

  /** Ensure a named type's declaration (and its `makeX`) exist. */
  define(decl: Extension): void {
    if (this.defined.has(decl.name)) return;
    this.defined.add(decl.name);
    const maker = this.maker(decl);
    this.declaration(decl, maker);
  }

  /** The surface of a named type as its definition shows it. */
  private surface(decl: Extension): Array<[string, Prop]> {
    const props = (decl as unknown as { definitionProps(): Record<string, Prop | PropSpec> }).definitionProps();
    return Object.entries(props).map(([k, p]) => [k, Prop.from(p)]);
  }

  private definitionCall(decl: Extension): Call | undefined {
    return (decl as unknown as { definitionCall(): Call | undefined }).definitionCall();
  }

  /**
   * Does this named type split into `XData` (its stored fields) and `X`
   * (`XData` plus its members)? Yes for an object type with a method, a
   * computed prop or a call signature — its own or inherited.
   */
  private splits(decl: Extension): boolean {
    if (!isObjLike(decl.base)) return false;
    if (this.definitionCall(decl) || this.surface(decl).some(([, p]) => isMember(p))) return true;
    const original = decl.original;
    return original instanceof Extension && !original.local.useSite && this.splits(this.decl(original));
  }

  /** Members of `decl` and its named bases with no gin body — the value must already carry them. */
  private carriedMembers(decl: Extension): Array<[string, Prop]> {
    const out = new Map<string, Prop>();
    const seen = new Set<string>(); // a derived type's member shadows its base's
    for (let t: Type = decl; t instanceof Extension && !t.local.useSite; t = t.original) {
      for (const [k, p] of this.surface(this.decl(t))) {
        if (seen.has(k)) continue;
        seen.add(k);
        if (isMember(p) && !(p.get && !(p.get instanceof NativeExpr))) out.set(k, p);
      }
    }
    return [...out];
  }

  private dataName(decl: Extension): string {
    return this.names.dataName(decl.name);
  }

  /** Write the declaration of a named type — two (`XData`, `X`) when it {@link splits}. */
  private declaration(decl: Extension, maker: MakerInfo | undefined): void {
    if (this.opt.types === 'none') return;
    const name = this.tsName(decl.name);
    const generic = decl.generic ?? {};
    const g: Gen = { generics: new Set(Object.keys(generic)) };
    const params = this.genericParams(generic, g);
    if (!this.splits(decl)) {
      this.types.set(name, this.singleDeclaration(decl, maker));
      return;
    }
    const targs = Object.keys(generic).length ? `<${Object.keys(generic).join(', ')}>` : '';
    const original = decl.original;
    const baseNamed = original instanceof Extension && !original.local.useSite;
    const props = this.surface(decl);
    const fields = this.members(props.filter(([, p]) => !isMember(p)), g, maker);
    const members = this.members(props.filter(([, p]) => isMember(p)), g, maker);
    const call = this.definitionCall(decl);
    if (call) members.push(`(${this.params(call.args, g)}): ${this.returns(call, g, 'unknown')}`);

    // PersonData — the stored fields, a base's included.
    const dataName = this.dataName(decl);
    const dataParts: string[] = [];
    if (baseNamed) dataParts.push(this.namedRef(original, g, true));
    if (fields.length || dataParts.length === 0) dataParts.push(braces(fields));
    const dataDocs = [`The stored fields of ${name}${maker ? ` — what \`${maker.name}\` takes` : ''}.`];
    this.types.set(dataName, `${this.docBlock(dataDocs)}${this.exp}type ${dataName}${params} = ${dataParts.join(' & ')};`);

    // Person — the fields plus the members (a base's members come with the base).
    const parts: string[] = [];
    if (baseNamed) parts.push(this.namedRef(original, g));
    parts.push(`${dataName}${targs}`);
    if (members.length) parts.push(braces(members));
    this.types.set(name, `${this.docBlock(this.typeDocs(decl))}${this.exp}type ${name}${params} = ${parts.join(' & ')};`);
  }

  private typeDocs(decl: Extension): string[] {
    const docs: string[] = [];
    if (decl.docs) docs.push(decl.docs);
    if (decl.local.options && Object.keys(decl.local.options).length > 0) {
      docs.push(`gin: ${decl.base.toCode(undefined, { includeComments: false })}`);
    }
    if (decl.local.constraint) {
      docs.push(`constraint: ${decl.local.constraint.toCode(this.registry, { expectsValue: true, includeComments: false })}`);
    }
    return docs;
  }

  private singleDeclaration(decl: Extension, maker: MakerInfo | undefined): string {
    const name = this.tsName(decl.name);
    const generic = decl.generic ?? {};
    const g: Gen = { generics: new Set(Object.keys(generic)) };
    const params = this.genericParams(generic, g);
    const docs = this.typeDocs(decl);

    const original = decl.original;
    const baseNamed = original instanceof Extension && !original.local.useSite;
    const objLike = isObjLike(decl.base);
    const call = this.definitionCall(decl);
    const members = objLike || baseNamed ? this.members(this.surface(decl), g, maker) : [];
    if (call) members.push(`(${this.params(call.args, g)}): ${this.returns(call, g, 'unknown')}`);

    let body: string;
    if (baseNamed) {
      const baseRef = this.ref(original, g);
      body = members.length ? `${baseRef} & ${braces(members)}` : baseRef;
    } else if (objLike) {
      body = braces(members);
    } else {
      body = this.ref(decl.base, g);
      if (members.length) body = `${paren(body)} & ${braces(members)}`;
    }
    return `${this.docBlock(docs)}${this.exp}type ${name}${params} = ${body};`;
  }

  private genericParams(generic: Record<string, Type>, g: Gen): string {
    const keys = Object.keys(generic);
    if (keys.length === 0) return '';
    return `<${keys.map((k) => {
      const c = generic[k]!;
      if (Type.isGenericPlaceholder(k, c)) return `${k} = any`;
      const bound = this.ref(c, g);
      return `${k} extends ${bound} = ${bound}`;
    }).join(', ')}>`;
  }

  /** Members of an object-like type, one per prop. */
  private members(props: Array<[string, Prop]>, g: Gen, maker: MakerInfo | undefined): string[] {
    const out: string[] = [];
    for (const [name, prop] of props) {
      const key = isIdent(name) ? name : JSON.stringify(name);
      const docs: string[] = [];
      if (prop.docs) docs.push(prop.docs);
      const call = prop.type.call();
      const info = maker?.members.get(name);
      if (call && (prop.get || prop.type instanceof FnType)) {
        // A method (a member with a body) or a function-valued field.
        const kind = info ? (info.async === false ? 'sync' : 'async') : this.hostMemberKind(prop);
        out.push(`${this.docLine(docs)}${key}: ${this.fnSig(call, g, kind, prop.type.generic)}`);
        continue;
      }
      if (prop.get) {
        const t = this.ref(prop.type, g);
        out.push(`${this.docLine(docs)}readonly ${key}: ${info?.async === true ? `Promise<${t}>` : t}`);
        continue;
      }
      const optional = prop.type.isOptional();
      const t = optional ? prop.type.required() : prop.type;
      const c = constraintDoc(t);
      if (c) docs.push(c);
      out.push(`${this.docLine(docs)}${key}${optional ? '?' : ''}: ${this.ref(t, g)}`);
    }
    return out;
  }

  /** Whether a member implemented OUTSIDE the export (a host native, a function-valued field) is async. */
  private hostMemberKind(prop: Prop): 'sync' | 'async' | 'unknown' {
    if (this.always) return 'async';
    if (prop.get instanceof NativeExpr && !NATIVE_TS[prop.get.id]) {
      return (prop.get.effects() & (Effects.EXTERNAL | Effects.SYSTEM)) ? 'async' : 'sync';
    }
    if (prop.get instanceof NativeExpr) return 'sync';
    return 'unknown';
  }

  private objLiteralType(fields: Array<[string, Prop]>, g: Gen): string {
    return braces(this.members(fields, g, undefined));
  }

  /** `(args: {…}) => R` for a call signature. */
  private fnSig(call: Call, g: Gen, kind: 'sync' | 'async' | 'unknown', generic?: Record<string, Type>): string {
    const keys = Object.keys(generic ?? {});
    const inner: Gen = keys.length ? { generics: new Set([...g.generics, ...keys]) } : g;
    const tparams = keys.length ? this.genericParams(generic!, inner) : '';
    return `${tparams}(${this.params(call.args, inner)}) => ${this.returns(call, inner, kind)}`;
  }

  private returns(call: Call, g: Gen, kind: 'sync' | 'async' | 'unknown'): string {
    const r = call.returns ? this.ref(call.returns, g) : 'any';
    if (kind === 'sync') return r;
    if (kind === 'async' || this.always) return `Promise<${r}>`;
    return `${paren(r)} | Promise<${r}>`;
  }

  /** The parameter list for a gin args type: one `args` object. */
  private params(args: Type, g: Gen): string {
    if (args instanceof ObjType) {
      const fields = Object.entries(args.fields);
      if (fields.length === 0) return '';
      const allOptional = fields.every(([, p]) => p.type.isOptional() || p.default !== undefined);
      return `args${allOptional ? '?' : ''}: ${this.objLiteralType(fields, g)}`;
    }
    if (args instanceof AnyType || args instanceof VoidType) return '';
    return `args: ${this.ref(args, g)}`;
  }

  /** The parameter list of a function DEFINITION: an all-optional args object defaults to `{}`. */
  private defParams(args: Type, g: Gen): string {
    const p = this.params(args, g);
    return p.startsWith('args?:') ? `args:${p.slice(6)} = {}` : p;
  }

  private docBlock(lines: string[]): string {
    if (!this.opt.includeComments || lines.length === 0) return '';
    const flat = lines.flatMap((l) => l.split('\n'));
    if (flat.length === 1) return `/** ${esc(flat[0]!)} */\n`;
    return `/**\n${flat.map((l) => ` * ${esc(l)}`).join('\n')}\n */\n`;
  }

  private docLine(lines: string[]): string {
    if (!this.opt.includeComments || lines.length === 0) return '';
    return `/** ${esc(lines.join(' · ').replace(/\n/g, ' '))} */ `;
  }

  // ─── makers ──────────────────────────────────────────────────────────────

  /**
   * A named type whose methods / computed props are written in gin gets a
   * `makeX(data)` constructor that attaches the compiled bodies, so a value
   * of it carries its members the way the type declares them.
   */
  private maker(decl: Extension): MakerInfo | undefined {
    if (this.makers.has(decl.name)) return this.makers.get(decl.name) ?? undefined;
    const surface = (decl as unknown as { definitionProps(): Record<string, Prop | PropSpec> }).definitionProps();
    const own = Object.entries(surface)
      .map(([k, p]) => [k, Prop.from(p)] as [string, Prop])
      .filter(([, p]) => p.get && !(p.get instanceof NativeExpr));
    const base = decl.original instanceof Extension && !decl.original.local.useSite
      ? this.maker(this.decl(decl.original)) : undefined;
    if (own.length === 0 && !base) { this.makers.set(decl.name, null); return undefined; }
    if (!isObjLike(decl.base)) {
      this.problem(`type '${decl.name}': members written in gin on a non-object type are not supported`);
      this.makers.set(decl.name, null);
      return undefined;
    }

    const info: MakerInfo = { name: `make${this.tsName(decl.name)}`, members: new Map(base?.members ?? []) };
    for (const [k, p] of own) info.members.set(k, { kind: p.type.call() ? 'method' : 'computed', async: 'pending' });
    this.makers.set(decl.name, info);

    const generic = decl.generic ?? {};
    const g: Gen = { generics: new Set(Object.keys(generic)) };
    const tparams = this.genericParams(generic, g);
    const targs = Object.keys(generic).length ? `<${Object.keys(generic).join(', ')}>` : '';
    const typeName = `${this.tsName(decl.name)}${targs}`;
    this.define(decl); // the type text reads the members' async flags — compiled below first
    // A maker's names are its own: compiling it in a fresh name space makes its
    // text the same in every export, so `joinTypeScript` can dedupe it.
    const outerUsed = new Set(this.used);
    this.used.clear();
    const self = 'self';
    const lines: string[] = [];
    lines.push(base
      ? `const ${self} = ${base.name}(data) as ${typeName};`
      : `const ${self} = data as ${typeName};`);
    for (const [k, p] of own) {
      const f = new Fn(false);
      const body: string[] = [];
      const scope: Scope = new Map([['this', { ts: self, type: decl }]]);
      const call = p.type.call();
      if (call) {
        const fname = this.uniq(k);
        scope.set('args', { ts: 'args', type: call.args });
        scope.set('recurse', { ts: fname, type: p.type });
        this.stmt(p.get!, scope, f, body, { kind: 'return' });
        const isAsync = this.always || f.awaited;
        info.members.set(k, { kind: 'method', async: isAsync });
        const params = this.defParams(call.args, g);
        lines.push(`${access(self, k)} = ${isAsync ? 'async ' : ''}function ${fname}(${params}) {`);
        lines.push(...indent(body), '};');
      } else {
        this.stmt(p.get!, scope, f, body, { kind: 'return' });
        info.members.set(k, { kind: 'computed', async: f.awaited });
        lines.push(`Object.defineProperty(${self}, ${JSON.stringify(k)}, {`);
        lines.push(`  get: ${f.awaited ? 'async ' : ''}() => {`, ...indent(indent(body)), '  },');
        lines.push('  enumerable: false,', '  configurable: true,', '});');
      }
    }
    lines.push(`return ${self};`);
    this.used.clear();
    for (const n of outerUsed) this.used.add(n);
    // Members the maker cannot attach (host natives, function-valued fields) come in with the data.
    const carried = this.members(this.carriedMembers(decl), g, info);
    const dataType = `${this.dataName(decl)}${targs}${carried.length ? ` & ${braces(carried)}` : ''}`;
    const code = [
      `/** Attach ${decl.name}'s gin-written members to its data. */`,
      `${this.exp}function ${info.name}${tparams}(data: ${dataType}): ${typeName} {`,
      ...indent(lines),
      '}',
    ].join('\n');
    this.helpers.set(info.name, code);
    // Re-render the declaration now the members' async flags are known.
    this.declaration(decl, info);
    return info;
  }

  // ─── guards ──────────────────────────────────────────────────────────────

  /** A `(v: unknown): v is T` structural guard for `t` (for `is<T>` / `as<T>`). */
  private guard(t: Type): string {
    const ts = this.ref(t);
    const key = ts;
    const existing = this.guards.get(key);
    if (existing) return existing;
    const name = t instanceof Extension ? `$is${this.tsName(this.decl(t).name)}` : `$is_${hash(ts)}`;
    this.guards.set(key, name);
    const body = this.checkExpr(t, 'v', 0, true);
    this.helpers.set(name, `function ${name}(v: unknown): v is ${ts} {\n  return ${body};\n}`);
    return name;
  }

  private checkExpr(t: Type, v: string, depth: number, top = false): string {
    const x = `x${depth}`;
    if (t instanceof AliasType) {
      const s = t.simplify();
      return s !== t ? this.checkExpr(s, v, depth) : 'true';
    }
    if (t instanceof Extension) {
      if (!top) return `${this.guard(t)}(${v})`;
      return this.checkExpr(t.base, v, depth);
    }
    if (t instanceof NumType || t instanceof DurationType || t instanceof ColorType) return `typeof ${v} === "number"`;
    if (t instanceof TextType) return `typeof ${v} === "string"`;
    if (t instanceof BoolType) return `typeof ${v} === "boolean"`;
    if (t instanceof NullType) return `${v} === null`;
    if (t instanceof VoidType) return `${v} === undefined`;
    if (t instanceof DateType || t instanceof TimestampType) return `${v} instanceof Date`;
    if (t instanceof FnType) return `typeof ${v} === "function"`;
    if (t instanceof MapType) return `${v} instanceof Map`;
    if (t instanceof ListType) {
      const item = this.checkExpr(t.item, x, depth + 1);
      return item === 'true' ? `Array.isArray(${v})` : `(Array.isArray(${v}) && ${v}.every((${x}: unknown) => ${item}))`;
    }
    if (t instanceof TupleType) {
      const parts = t.elements.map((e, i) => this.checkExpr(e, `${v}[${i}]`, depth + 1));
      return `(Array.isArray(${v}) && ${v}.length === ${t.elements.length}${parts.map((p) => ` && ${p}`).join('')})`;
    }
    if (t instanceof OptionalType) return `(${v} === undefined || ${this.checkExpr(t.inner, v, depth)})`;
    if (t instanceof NullableType) return `(${v} === null || ${this.checkExpr(t.inner, v, depth)})`;
    if (t instanceof OrType) return `(${t.variants.map((p) => this.checkExpr(p, v, depth)).join(' || ')})`;
    if (t instanceof AndType) return `(${t.parts.map((p) => this.checkExpr(p, v, depth)).join(' && ')})`;
    if (t instanceof EnumType) return `${JSON.stringify(Object.values(t.options.values))}.includes(${v} as any)`;
    if (t instanceof LiteralType) return `${v} === ${JSON.stringify(t.literal)}`;
    if (t instanceof ObjType || t instanceof IfaceType) {
      const fields = t instanceof ObjType ? Object.entries(t.fields) : Object.entries(t._props);
      const parts = [`typeof ${v} === "object"`, `${v} !== null`];
      for (const [k, p] of fields) {
        if (p.get || p.type.call()) continue;
        const fv = `(${v} as any)${isIdent(k) ? '.' + k : `[${JSON.stringify(k)}]`}`;
        parts.push(p.type.isOptional()
          ? `(${fv} === undefined || ${this.checkExpr(p.type.required(), fv, depth + 1)})`
          : this.checkExpr(p.type, fv, depth + 1));
      }
      return `(${parts.join(' && ')})`;
    }
    return 'true';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // EXPRESSIONS
  // ═══════════════════════════════════════════════════════════════════════

  /** Compile one export: a lambda becomes `function name(args, ctx)`, anything else `function name(ctx)`. */
  exportFunction(expr: Expr, name: string): string {
    this.ctxVars = new Map();
    this.usesExit = false;
    // The export keeps the name it was asked for — callers import it by that name.
    if (!isIdent(name) || TS_RESERVED.has(name)) this.problem(`'${name}' is not usable as a function name`);
    const fnName = name;
    this.used.add(name);
    const f = new Fn(true);
    const body: string[] = [];
    let params: string[] = [];
    let ret = '';
    if (expr instanceof LambdaExpr) {
      const call = expr.fnType.call();
      const g: Gen = { generics: new Set(Object.keys(expr.fnType.generic ?? {})) };
      const scope: Scope = new Map([
        ['args', { ts: 'args', type: call?.args ?? this.registry.obj({}) }],
        ['recurse', { ts: fnName, type: expr.fnType }],
      ]);
      if (expr.constraint) this.constraint(expr.constraint, scope, f, body);
      this.stmt(expr.body, scope, f, body, { kind: 'return' });
      params = [(call ? this.defParams(call.args, g) : '') || 'args: {} = {}'];
      if (call?.returns) ret = this.ref(call.returns, g);
    } else {
      this.stmt(expr, new Map(), f, body, { kind: 'return' });
    }
    const isAsync = this.always || f.awaited;
    if (this.ctxVars.size > 0) {
      const ctxType = this.names.fresh(`${pascal(name)}Ctx`);
      const fields = [...this.ctxVars].map(([k, t]) => {
        const gl = this.engine.getGlobal(k);
        const docs = gl?.docs ? [gl.docs] : [];
        return `${this.docLine(docs)}${isIdent(k) ? k : JSON.stringify(k)}: ${this.ref(t)}`;
      });
      this.types.set(ctxType, `${this.docBlock([`Free variables ${name} reads (engine globals and run extras).`])}${this.exp}type ${ctxType} = ${braces(fields)};`);
      params.push(`ctx: ${ctxType}`);
    }
    let lines = body;
    if (this.usesExit) {
      const ex = this.helper('$Exit');
      lines = ['try {', ...indent(body), '} catch ($exit) {', `  if ($exit instanceof ${ex}) return $exit.value as any;`, '  throw $exit;', '}'];
    }
    const retAnn = ret ? `: ${isAsync ? `Promise<${ret}>` : ret}` : '';
    const docs = expr.comment ? this.docBlock([expr.comment]) : '';
    return [
      `${docs}${this.exp}${isAsync ? 'async ' : ''}function ${fnName}(${params.join(', ')})${retAnn} {`,
      ...indent(lines),
      '}',
    ].join('\n');
  }

  private constraint(c: Expr, s: Scope, f: Fn, out: string[]): void {
    const r = this.val(c, s, f, out);
    const text = JSON.stringify(`lambda constraint failed: ${c.toCode(this.registry, { expectsValue: true, includeComments: false })}`);
    out.push(`if (${r.code} !== true) throw new Error(${text});`);
  }

  // ─── statements ──────────────────────────────────────────────────────────

  stmt(e: Expr, s: Scope, f: Fn, out: string[], target: Target): void {
    if (e.comment && this.opt.includeComments) out.push(...e.comment.split('\n').map((l) => `// ${l}`));
    if (e instanceof BlockExpr) {
      if (e.lines.length === 0) return this.finish('undefined', out, target, true);
      e.lines.forEach((line, i) =>
        this.stmt(line, s, f, out, i === e.lines.length - 1 ? target : { kind: 'discard' }));
      return;
    }
    if (e instanceof DefineExpr) {
      const inner = this.defineVars(e, s, f, out);
      return this.stmt(e.body, inner, f, out, target);
    }
    if (e instanceof IfExpr) return this.ifStmt(e, s, f, out, target);
    if (e instanceof SwitchExpr) return this.switchStmt(e, s, f, out, target);
    if (e instanceof LoopExpr) {
      this.loop(e, s, f, out);
      if (target.kind === 'assign') out.push(`${target.name} = undefined;`);
      return;
    }
    if (e instanceof FlowExpr) return this.flow(e, s, f, out);
    if (e instanceof SetExpr) {
      this.set(e, s, f, out);
      return this.finish('true', out, target, true);
    }
    const r = this.val(e, s, f, out);
    this.finish(r.code, out, target, r.pure);
  }

  /** Deliver a value to a statement target. */
  private finish(code: string, out: string[], target: Target, pure: boolean): void {
    if (target.kind === 'return') {
      if (code !== 'undefined') out.push(`return ${unparen(code)};`);
    } else if (target.kind === 'assign') {
      out.push(`${target.name} = ${unparen(code)};`);
    } else if (!pure) {
      out.push(`${unparen(code)};`);
    }
  }

  private defineVars(e: DefineExpr, s: Scope, f: Fn, out: string[]): Scope {
    const inner: Scope = new Map(s);
    for (const v of e.vars) {
      const r = this.val(v.value, inner, f, out);
      const ts = this.uniq(v.name);
      const type = v.type ?? r.type;
      const ann = v.type ? `: ${this.ref(v.type)}` : '';
      out.push(`let ${ts}${ann} = ${unparen(r.code)};`);
      inner.set(v.name, { ts, type, sync: r.sync });
    }
    return inner;
  }

  private ifStmt(e: IfExpr, s: Scope, f: Fn, out: string[], target: Target): void {
    const emit = (i: number, into: string[]): void => {
      if (i >= e.ifs.length) {
        if (e.otherwise) this.stmt(e.otherwise, s, f, into, target);
        return;
      }
      const br = e.ifs[i]!;
      const c = this.val(br.condition, s, f, into);
      const body: string[] = [];
      this.stmt(br.body, s, f, body, target);
      into.push(`if (${unparen(c.code)}) {`, ...indent(body), '}');
      const rest: string[] = [];
      emit(i + 1, rest);
      if (rest.length === 0) return;
      // `else if` when the next branch is a bare `if` chain, `else { … }` otherwise.
      if (rest[0]!.startsWith('if (') && closesAtEnd(rest)) {
        into[into.length - 1] = `} else ${rest[0]}`;
        into.push(...rest.slice(1));
      } else {
        into[into.length - 1] = '} else {';
        into.push(...indent(rest), '}');
      }
    };
    emit(0, out);
  }

  private switchStmt(e: SwitchExpr, s: Scope, f: Fn, out: string[], target: Target): void {
    const v = this.spill(this.val(e.value, s, f, out), out, 'sw');
    const chain: string[] = [];
    e.cases.forEach((c, i) => {
      const buf: string[] = [];
      const eqs = c.equals.map((x) => this.val(x, s, f, buf).code);
      if (buf.length) this.problem('switch: a case value that needs statements is not supported');
      const body: string[] = [];
      this.stmt(c.body, s, f, body, target);
      const cond = eqs.length ? eqs.map((q) => `${v} === ${q}`).join(' || ') : 'false';
      chain.push(`${i === 0 ? 'if' : '} else if'} (${cond}) {`, ...indent(body));
    });
    if (e.otherwise) {
      const body: string[] = [];
      this.stmt(e.otherwise, s, f, body, target);
      if (chain.length === 0) { out.push(...body); return; }
      chain.push('} else {', ...indent(body));
    }
    if (chain.length) out.push(...chain, '}');
  }

  private flow(e: FlowExpr, s: Scope, f: Fn, out: string[]): void {
    const loop = f.loops[f.loops.length - 1];
    switch (e.action) {
      case 'break':
        if (loop === 'for') out.push('break;');
        else this.problem(loop === 'parallel' ? 'flow: break inside a parallel loop is not supported' : 'flow: break outside a loop');
        return;
      case 'continue':
        if (loop === 'for') out.push('continue;');
        else if (loop === 'parallel') out.push('return;');
        else this.problem('flow: continue outside a loop');
        return;
      case 'return': {
        if (loop === 'parallel') this.problem('flow: return inside a parallel loop is not supported');
        const v = e.value ? this.val(e.value, s, f, out).code : undefined;
        out.push(v && v !== 'undefined' ? `return ${unparen(v)};` : 'return;');
        return;
      }
      case 'exit': {
        const v = e.value ? this.val(e.value, s, f, out).code : 'undefined';
        this.usesExit = true;
        out.push(`throw new ${this.helper('$Exit')}(${unparen(v)});`);
        return;
      }
      case 'throw': {
        const v = e.error ? this.val(e.error, s, f, out).code : 'undefined';
        out.push(`throw new ${this.helper('$Throw')}(${unparen(v)});`);
        return;
      }
    }
  }

  // ─── loops ───────────────────────────────────────────────────────────────

  private loop(e: LoopExpr, s: Scope, f: Fn, out: string[]): void {
    const overT = this.registry.any();
    const over0 = this.typeOfExpr(e.over, s);
    const gs = over0.get();
    const loopId = gs?.loop instanceof NativeExpr ? gs.loop.id : undefined;
    const keyName = e.keyName ?? 'key';
    const valueName = e.valueName ?? 'value';
    const k = this.uniq(keyName);
    const v = this.uniq(valueName);
    const inner: Scope = new Map(s);
    inner.set(keyName, { ts: k, type: gs?.key ?? overT });
    inner.set(valueName, { ts: v, type: gs?.value ?? overT });

    if (e.parallel) return this.parallelLoop(e, s, f, out, inner, loopId, k, v, !!gs?.loopDynamic);

    const body: string[] = [];
    f.loops.push('for');
    this.stmt(e.body, inner, f, body, { kind: 'discard' });
    f.loops.pop();

    if (gs?.loopDynamic) {
      // `over` is re-read every round; the loop runs while it is truthy.
      const cond: string[] = [];
      const c = this.val(e.over, s, f, cond);
      out.push(`for (let ${k} = 0; ; ${k}++) {`, ...indent(cond), `  const ${v} = ${unparen(c.code)};`, `  if (!${v}) break;`, ...indent(body), '}');
      return;
    }
    const over = this.spill(this.val(e.over, s, f, out), out, 'over');
    switch (loopId) {
      case 'list.iterate':
      case 'tuple.iterate':
        out.push(`for (let ${k} = 0; ${k} < ${over}.length; ${k}++) {`, `  const ${v} = ${over}[${k}];`, ...indent(body), '}');
        return;
      case 'text.chars':
        out.push(`for (let ${k} = 0; ${k} < ${over}.length; ${k}++) {`, `  const ${v} = ${over}[${k}]!;`, ...indent(body), '}');
        return;
      case 'map.iterate':
        out.push(`for (const [${k}, ${v}] of ${over}) {`, ...indent(body), '}');
        return;
      case 'num.loop': {
        const n = this.uniq('count');
        out.push(`for (let ${k} = 0, ${n} = Math.abs(Math.trunc(${over})); ${k} < ${n}; ${k}++) {`,
          `  const ${v} = ${over} < 0 ? -${k} : ${k};`, ...indent(body), '}');
        return;
      }
      case 'object.iterate': {
        const fields = JSON.stringify(dataFields(over0));
        out.push(`for (const ${k} of ${fields}) {`, `  const ${v} = (${over} as any)[${k}];`, `  if (${v} === undefined) continue;`, ...indent(body), '}');
        return;
      }
      default:
        this.problem(`loop: iterating '${over0.toCode()}' is not supported (only built-in iterables)`);
    }
  }

  private parallelLoop(e: LoopExpr, s: Scope, f: Fn, out: string[], inner: Scope,
    loopId: string | undefined, k: string, v: string, dynamic: boolean): void {
    if (dynamic) { this.problem('loop: a parallel while-loop is not supported'); return; }
    const conc = e.parallel?.concurrent ? this.val(e.parallel.concurrent, s, f, out).code : 'undefined';
    const rate = e.parallel?.rate ? this.val(e.parallel.rate, s, f, out).code : 'undefined';
    const over0 = this.typeOfExpr(e.over, s);
    const over = this.spill(this.val(e.over, s, f, out), out, 'over');
    let items: string;
    switch (loopId) {
      case 'list.iterate': case 'tuple.iterate': items = `${over}.entries()`; break;
      case 'text.chars': items = `${over}.split("").entries()`; break;
      case 'map.iterate': items = over; break;
      case 'num.loop': items = `Array.from({ length: Math.abs(Math.trunc(${over})) }, (_, i) => [i, ${over} < 0 ? -i : i] as [number, number])`; break;
      case 'object.iterate': items = `${JSON.stringify(dataFields(over0))}.map((f) => [f, (${over} as any)[f]] as [string, any]).filter((e) => e[1] !== undefined)`; break;
      default:
        this.problem(`loop: iterating '${over0.toCode()}' is not supported (only built-in iterables)`);
        return;
    }
    const body: string[] = [];
    const cb = new Fn(f.ctxAllowed);
    cb.loops.push('parallel');
    this.stmt(e.body, inner, cb, body, { kind: 'discard' });
    f.awaited = true;
    out.push(`await ${this.helper('$parallel')}(${items}, ${conc}, ${rate}, async (${k}, ${v}) => {`, ...indent(body), '});');
  }

  // ─── values ──────────────────────────────────────────────────────────────

  val(e: Expr, s: Scope, f: Fn, out: string[]): Res {
    if (e instanceof NewExpr) return this.newValue(e, s, f, out);
    if (e instanceof GetExpr) return this.path(e.path.steps, s, f, out);
    if (e instanceof SetExpr) {
      this.set(e, s, f, out);
      return { code: 'true', type: this.registry.bool(), pure: true };
    }
    if (e instanceof LambdaExpr) return this.lambda(e, s, f);
    if (e instanceof TemplateExpr) return this.template(e, s, f, out);
    if (e instanceof BlockExpr) {
      if (e.lines.length === 0) return { code: 'undefined', type: this.registry.void(), pure: true };
      for (const line of e.lines.slice(0, -1)) this.stmt(line, s, f, out, { kind: 'discard' });
      return this.val(e.lines[e.lines.length - 1]!, s, f, out);
    }
    if (e instanceof DefineExpr) return this.val(e.body, this.defineVars(e, s, f, out), f, out);
    if (e instanceof IfExpr) return this.ifValue(e, s, f, out);
    if (e instanceof SwitchExpr || e instanceof LoopExpr) {
      const t = this.uniq('v');
      out.push(`let ${t};`);
      this.stmt(e, s, f, out, { kind: 'assign', name: t });
      return { code: t, type: this.typeOfExpr(e, s), pure: true };
    }
    if (e instanceof FlowExpr) {
      this.flow(e, s, f, out);
      return { code: 'undefined as never', type: this.registry.void(), pure: true };
    }
    if (e instanceof NativeExpr) {
      this.problem(`native '${e.id}' used directly as an expression is not supported`);
      return { code: 'undefined as any', type: this.registry.any(), pure: true };
    }
    this.problem(`expression kind '${e.kind}' is not supported`);
    return { code: 'undefined as any', type: this.registry.any(), pure: true };
  }

  private ifValue(e: IfExpr, s: Scope, f: Fn, out: string[]): Res {
    // A ternary when nothing in it needs a statement; an if-chain into a temp otherwise.
    const bufs: string[][] = [];
    const parts = e.ifs.map((b) => {
      const cb: string[] = []; const c = this.val(b.condition, s, f, cb);
      const bb: string[] = []; const v = this.val(b.body, s, f, bb);
      bufs.push(cb, bb);
      return { cb, c, bb, v };
    });
    const eb: string[] = [];
    const ev = e.otherwise ? this.val(e.otherwise, s, f, eb) : undefined;
    bufs.push(eb);
    const type = this.typeOfExpr(e, s);
    if (bufs.every((b) => b.length === 0)) {
      let code = ev ? ev.code : 'undefined';
      for (let i = parts.length - 1; i >= 0; i--) code = `${parts[i]!.c.code} ? ${parts[i]!.v.code} : ${code}`;
      return { code: `(${code})`, type, pure: parts.every((p) => p.c.pure && p.v.pure) && (ev?.pure ?? true) };
    }
    const t = this.uniq('v');
    out.push(`let ${t};`);
    const emit = (i: number, into: string[]): void => {
      if (i >= parts.length) {
        if (ev) into.push(...eb, `${t} = ${unparen(ev.code)};`);
        return;
      }
      const p = parts[i]!;
      into.push(...p.cb, `if (${unparen(p.c.code)}) {`, ...indent([...p.bb, `${t} = ${unparen(p.v.code)};`]), '}');
      const rest: string[] = [];
      emit(i + 1, rest);
      if (rest.length) {
        into[into.length - 1] = '} else {';
        into.push(...indent(rest), '}');
      }
    };
    emit(0, out);
    return { code: t, type, pure: true };
  }

  private template(e: TemplateExpr, s: Scope, f: Fn, out: string[]): Res {
    const text = this.registry.text();
    const params = e.params ? this.val(e.params, s, f, out) : undefined;
    const p = params ? this.spill(params, out, 'params') : undefined;
    const literal = e.template instanceof NewExpr && typeof e.template.value === 'string' ? e.template.value : undefined;
    if (literal === undefined) {
      const t = this.val(e.template, s, f, out);
      return { code: `${this.helper('$template')}(${t.code}, ${p ?? 'undefined'} as any)`, type: text, pure: false };
    }
    const fields = params ? dataFieldTypes(params.type) : undefined;
    let code = '`';
    let last = 0;
    for (const m of literal.matchAll(/\{(\w+)\}/g)) {
      code += escTemplate(literal.slice(last, m.index));
      last = m.index! + m[0].length;
      const name = m[1]!;
      let part: { code: string; type: Type } | undefined;
      if (p && fields?.has(name)) part = { code: access(p, name), type: fields.get(name)! };
      else if (p && !fields) part = { code: `(${p} as any)[${JSON.stringify(name)}]`, type: this.registry.any() };
      else {
        const sym = this.lookup(name, s, f);
        if (sym) part = { code: sym.ts, type: sym.type };
      }
      if (part) code += '${' + (plainText(part.type) ? part.code : `${this.helper('$str')}(${part.code})`) + '}';
    }
    code += escTemplate(literal.slice(last)) + '`';
    return { code, type: text, pure: true };
  }

  private lambda(e: LambdaExpr, s: Scope, f: Fn): Res {
    const call = e.fnType.call();
    const g: Gen = { generics: new Set(Object.keys(e.fnType.generic ?? {})) };
    const fname = this.uniq('recurse');
    const inner = new Fn(f.ctxAllowed);
    const scope: Scope = new Map(s);
    scope.set('args', { ts: 'args', type: call?.args ?? this.registry.obj({}) });
    scope.set('recurse', { ts: fname, type: e.fnType });
    const body: string[] = [];
    if (e.constraint) this.constraint(e.constraint, scope, inner, body);
    this.stmt(e.body, scope, inner, body, { kind: 'return' });
    const isAsync = this.always || inner.awaited;
    const fullParams = call ? this.defParams(call.args, g) : '';
    const ret = call?.returns ? `: ${isAsync ? `Promise<${this.ref(call.returns, g)}>` : this.ref(call.returns, g)}` : '';
    const tparams = Object.keys(e.fnType.generic ?? {}).length ? this.genericParams(e.fnType.generic!, g) : '';
    const usesRecurse = body.some((l) => new RegExp(`\\b${fname.replace(/\$/g, '\\$')}\\b`).test(l));
    let code: string;
    if (usesRecurse) {
      code = [`${isAsync ? 'async ' : ''}function ${fname}${tparams}(${fullParams})${ret} {`, ...indent(body), '}'].join('\n');
    } else if (body.length === 1 && body[0]!.startsWith('return ') && !body[0]!.includes('\n')) {
      let x = body[0]!.slice(7, -1);
      if (x.startsWith('{')) x = `(${x})`;
      code = `${isAsync ? 'async ' : ''}${tparams}(${fullParams})${ret} => ${x}`;
    } else {
      code = [`${isAsync ? 'async ' : ''}${tparams}(${fullParams})${ret} => {`, ...indent(body), '}'].join('\n');
    }
    return { code: `(${code})`, type: e.fnType, pure: true, sync: !isAsync };
  }

  // ─── new ─────────────────────────────────────────────────────────────────

  private newValue(e: NewExpr, s: Scope, f: Fn, out: string[]): Res {
    const t = e.type;
    const init = t.init();
    if (e.value !== undefined && init) {
      const id = init.run instanceof NativeExpr ? init.run.id : undefined;
      if (id !== 'duration.init' && id !== 'color.init') {
        this.problem(`new ${t.toCode()}: a constructor written in gin is not supported`);
        return { code: 'undefined as any', type: t, pure: true };
      }
      const args = this.literal(init.args.parse(e.value).toLogical(), init.args);
      const helper = this.helper(id === 'duration.init' ? '$duration' : '$color');
      return { code: `${helper}.init(${args})`, type: t, pure: true };
    }
    if (e.value === undefined) {
      const code = this.construct(t, this.literal(new Value(t, t.create()).toLogical(), t));
      return { code, type: t, pure: !code.startsWith('make') };
    }
    const filled = this.fill(e.value, t, s, f, out);
    return { code: filled.code, type: t, pure: filled.pure };
  }

  /** A `new` payload, type-driven: any slot may hold an Expr, at any depth. Slots run in order. */
  private fill(value: unknown, t: Type, s: Scope, f: Fn, out: string[]): { code: string; pure: boolean } {
    const expr = value instanceof Expr ? value : embeddedExpr(value, t.scope ?? this.registry);
    if (expr) {
      const r = this.val(expr, s, f, out);
      return { code: r.code, pure: r.pure };
    }
    if (!hasExpr(value, this.registry)) {
      // All data: parse it as gin would and write the logical value.
      try {
        const code = this.construct(t, this.literal(t.parse(value).toLogical(), t));
        return { code, pure: !code.startsWith('make') };
      } catch (err) {
        this.problem(`new ${t.toCode()}: ${err instanceof Error ? err.message : String(err)}`);
        return { code: 'undefined as any', pure: true };
      }
    }
    if (t instanceof AliasType) return this.fill(value, t.simplify(), s, f, out);
    if (t instanceof OptionalType || t instanceof NullableType) {
      if (value === undefined) return { code: 'undefined', pure: true };
      if (value === null) return { code: 'null', pure: true };
      return this.fill(value, t.inner, s, f, out);
    }
    const slots = (pairs: Array<[string | undefined, unknown, Type]>): Array<{ key?: string; code: string }> => {
      const results = this.ordered(pairs.map(([key, v, st]) => (buf: string[]) => {
        const r = this.fill(v, st, s, f, buf);
        return { code: r.code, pure: r.pure, key };
      }), out);
      return results;
    };
    if (t instanceof ListType && Array.isArray(value)) {
      const items = slots(value.map((v) => [undefined, v, t.item]));
      return { code: `[${items.map((i) => i.code).join(', ')}]`, pure: false };
    }
    if (t instanceof TupleType && Array.isArray(value)) {
      const items = slots(value.map((v, i) => [undefined, v, t.elements[i] ?? this.registry.any()]));
      return { code: `[${items.map((i) => i.code).join(', ')}] as ${this.ref(t)}`, pure: false };
    }
    if (t instanceof MapType && Array.isArray(value)) {
      const pairs: Array<[string | undefined, unknown, Type]> = [];
      for (const entry of value) {
        const [k, v] = Array.isArray(entry) ? entry : [(entry as any)?.key, (entry as any)?.value];
        pairs.push([undefined, k, t.key], [undefined, v, t.value]);
      }
      const items = slots(pairs);
      const entries: string[] = [];
      for (let i = 0; i < items.length; i += 2) entries.push(`[${items[i]!.code}, ${items[i + 1]!.code}]`);
      return { code: `new Map<${this.ref(t.key)}, ${this.ref(t.value)}>([${entries.join(', ')}])`, pure: false };
    }
    const fields = objFields(t);
    if (fields && value && typeof value === 'object' && !Array.isArray(value)) {
      const input = value as Record<string, unknown>;
      const pairs: Array<[string | undefined, unknown, Type]> = [];
      const defaults: Array<[string, Expr]> = [];
      for (const [name, prop] of fields) {
        if (name in input) pairs.push([name, input[name], prop.type]);
        else if (prop.default) defaults.push([name, prop.default]);
      }
      const items = slots(pairs);
      for (const [name, d] of defaults) items.push({ key: name, code: this.val(d, s, f, out).code });
      const body = items.map((i) => `${isIdent(i.key!) ? i.key : JSON.stringify(i.key)}: ${i.code}`);
      return { code: this.construct(t, `{ ${body.join(', ')} }`), pure: false };
    }
    this.problem(`new ${t.toCode()}: payload shape not supported`);
    return { code: 'undefined as any', pure: true };
  }

  /** Wrap a literal in its type: `makeX(…)` for a type with gin-written members, `(… as T)` for composites. */
  private construct(t: Type, literal: string): string {
    const named = t instanceof Extension && !t.local.useSite ? this.decl(t) : undefined;
    if (named) {
      this.define(named);
      // gin finds a host member in the registry; a TypeScript value has to carry it,
      // and nothing here can supply it.
      const carried = this.carriedMembers(named).map(([k]) => k);
      if (carried.length) {
        this.problem(`new ${named.name}: its host member${carried.length > 1 ? 's' : ''} ${carried.join(', ')} `
          + `cannot be supplied in TypeScript — build the value on the host (\`make${this.tsName(named.name)}\` / \`${this.dataName(named)}\`) and pass it in`);
      }
      const m = this.maker(named);
      if (m) return `${m.name}(${literal})`;
    }
    if (literal.startsWith('[') || literal.startsWith('{') || named) {
      return `(${literal} as ${this.ref(t)})`;
    }
    return literal;
  }

  /** A logical JS value as a TypeScript literal. */
  private literal(v: unknown, t: Type): string {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (typeof v === 'number') return Object.is(v, -0) ? '-0' : Number.isFinite(v) ? String(v) : v > 0 ? 'Infinity' : v < 0 ? '-Infinity' : 'NaN';
    if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (v instanceof Date) return `new Date(${JSON.stringify(v.toISOString())})`;
    const inner = t instanceof Extension ? t.base : t instanceof OptionalType || t instanceof NullableType ? t.inner : t;
    if (v instanceof Map) {
      const kt = inner instanceof MapType ? inner.key : this.registry.any();
      const vt = inner instanceof MapType ? inner.value : this.registry.any();
      const entries = [...v].map(([k, x]) => `[${this.literal(k, kt)}, ${this.literal(x, vt)}]`);
      return `new Map<${this.ref(kt)}, ${this.ref(vt)}>([${entries.join(', ')}])`;
    }
    if (Array.isArray(v)) {
      if (inner instanceof TupleType) return `[${v.map((x, i) => this.literal(x, inner.elements[i] ?? this.registry.any())).join(', ')}]`;
      const it = inner instanceof ListType ? inner.item : this.registry.any();
      return `[${v.map((x) => this.literal(x, it)).join(', ')}]`;
    }
    if (typeof v === 'object') {
      const fields = new Map(objFields(t) ?? []);
      const parts = Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .map(([k, x]) => `${isIdent(k) ? k : JSON.stringify(k)}: ${this.literal(x, fields.get(k)?.type ?? this.registry.any())}`);
      return `{ ${parts.join(', ')} }`;
    }
    return 'undefined';
  }

  // ─── set ─────────────────────────────────────────────────────────────────

  private set(e: SetExpr, s: Scope, f: Fn, out: string[]): void {
    const steps = e.path.steps;
    const value = this.val(e.value, s, f, out);
    if (steps.length === 1 && steps[0] instanceof PropStep) {
      const name = steps[0].prop;
      const sym = this.lookup(name, s, f);
      if (!sym) { this.problem(`set: unknown variable '${name}'`); return; }
      out.push(`${sym.ts} = ${unparen(value.code)};`);
      return;
    }
    // gin evaluates the value before walking the target.
    const v = LITERAL_RE.test(value.code) ? value.code : this.spill(value, out, 'value');
    const last = steps[steps.length - 1]!;
    if (last instanceof CallStep) { this.problem('set: assigning through a method call is not supported'); return; }
    const recv = this.path(steps.slice(0, -1), s, f, out);
    if (last instanceof PropStep) {
      const prop = recv.type.prop(last.prop);
      if (prop?.set) { this.problem(`set: prop '${last.prop}' has a gin setter, which is not supported`); return; }
      if (prop?.get && !prop.type.call()) { this.problem(`set: prop '${last.prop}' is computed and cannot be assigned`); return; }
      out.push(`${access(recv.code, last.prop)} = ${v};`);
      return;
    }
    if (last instanceof IndexStep) {
      const key = this.val(last.key, s, f, out).code;
      const gs = recv.type.get();
      const id = gs?.set instanceof NativeExpr ? gs.set.id : undefined;
      const emit = id ? INDEX_SET_TS[id] : undefined;
      if (!emit) { this.problem(`set: indexed assignment on '${recv.type.toCode()}' is not supported`); return; }
      out.push(`${emit({ self: recv.code, key, value: v, helper: (n) => this.helper(n) })};`);
    }
  }

  // ─── paths ───────────────────────────────────────────────────────────────

  private lookup(name: string, s: Scope, f: Fn): Sym | undefined {
    const sym = s.get(name);
    if (sym) return sym;
    const global = this.engine.getGlobal(name);
    const extra = this.opt.scope[name];
    const type = extra ?? global?.type;
    if (!type) return undefined;
    if (!f.ctxAllowed) {
      this.problem(`'${name}' is read inside a gin-written member, where only this / args / recurse are in scope`);
      return { ts: 'undefined as any', type };
    }
    this.ctxVars.set(name, type);
    return { ts: access('ctx', name), type };
  }

  private path(steps: ReadonlyArray<PathStep>, s: Scope, f: Fn, out: string[]): Res {
    let cur: Res | undefined;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      if (step instanceof PropStep) {
        if (!cur) {
          const sym = this.lookup(step.prop, s, f);
          if (!sym) {
            this.problem(`unknown variable '${step.prop}'`);
            cur = { code: 'undefined as any', type: this.registry.any(), pure: true };
          } else {
            cur = { code: sym.ts, type: sym.type, pure: true, sync: sym.sync };
          }
          continue;
        }
        this.touch(cur.type);
        const prop = cur.type.prop(step.prop);
        if (!prop) {
          this.problem(`no prop '${step.prop}' on '${cur.type.toCode()}' (the TypeScript export dispatches on the static type)`);
          cur = { code: access(cur.code, step.prop), type: this.registry.any(), pure: false };
          continue;
        }
        const propType = prop.type instanceof AliasType ? prop.type.simplify(cur.type.scope) : prop.type;
        const next = steps[i + 1];
        if (next instanceof CallStep && propType.call()) {
          cur = this.invoke(cur, step.prop, prop, propType, next, s, f, out);
          i++;
          continue;
        }
        if (!(next instanceof CallStep) && isAutoCallable(propType)) {
          cur = this.invoke(cur, step.prop, prop, propType, new CallStep({}), s, f, out);
          continue;
        }
        cur = this.readProp(cur, step.prop, prop, propType, f, out);
        continue;
      }
      if (!cur) { this.problem('path: must start with a variable'); return { code: 'undefined as any', type: this.registry.any(), pure: true }; }
      if (step instanceof IndexStep) {
        this.touch(cur.type);
        const recv = cur;
        const buf: string[] = [];
        const key = this.val(step.key, s, f, buf);
        const self = buf.length || !key.pure ? this.spill(recv, out, 'recv') : recv.code;
        out.push(...buf);
        const gs = recv.type.get();
        const id = gs?.get instanceof NativeExpr ? gs.get.id : undefined;
        const emit = id ? INDEX_GET_TS[id] : undefined;
        if (!emit) this.problem(`indexing '${recv.type.toCode()}' is not supported`);
        cur = {
          code: emit ? emit({ self, key: key.code, helper: (n) => this.helper(n) }) : 'undefined as any',
          type: gs?.value ?? this.registry.any(),
          pure: false,
        };
        continue;
      }
      if (step instanceof CallStep) {
        // Calling a function VALUE (a lambda in a var, `recurse`, a fn-typed field already read).
        const callType = cur.type;
        let callScope = callType.scope;
        try { callScope = step.callSiteScope(callType); } catch (err) { this.problem(String(err instanceof Error ? err.message : err)); }
        const call = callType.call(callScope);
        if (call?.get) this.problem(`calling a '${callType.toCode()}' value implemented in gin is not supported`);
        const { recv, args } = this.orderedArgs(cur, step.args, s, f, out);
        const argObj = argsObject(args, call);
        let code = `${recv}(${argObj})`;
        if (cur.sync !== true) code = this.aw(code, f);
        const ret = call?.returns?.simplify(callScope) ?? call?.returns ?? this.registry.any();
        cur = step.catch_ ? this.withCatch(code, step.catch_, ret, s, f, out) : { code, type: ret, pure: false };
      }
    }
    return cur ?? { code: 'undefined as any', type: this.registry.any(), pure: true };
  }

  /** Make sure a named type reached through a path is declared. */
  private touch(t: Type): void {
    if (t instanceof Extension && !t.local.useSite) this.define(this.decl(t));
  }

  private readProp(cur: Res, name: string, prop: Prop, propType: Type, f: Fn, out: string[]): Res {
    const id = prop.get instanceof NativeExpr ? prop.get.id : undefined;
    const emit = id ? NATIVE_TS[id] : undefined;
    if (emit) {
      return { code: emit(this.nativeCtx(cur, {}, undefined, f, out)), type: propType, pure: cur.pure };
    }
    let code = access(cur.code, name);
    if (prop.get && this.memberAsync(cur.type, name, prop, 'computed')) code = this.aw(code, f);
    return { code, type: propType, pure: cur.pure && !prop.get };
  }

  private invoke(cur: Res, name: string, prop: Prop, propType: Type, step: CallStep, s: Scope, f: Fn, out: string[]): Res {
    let callScope = propType.scope;
    try { callScope = step.callSiteScope(propType); } catch (err) { this.problem(String(err instanceof Error ? err.message : err)); }
    const call = propType.call(callScope);
    const ret = call?.returns?.simplify(callScope) ?? call?.returns ?? this.registry.any();
    const id = prop.get instanceof NativeExpr ? prop.get.id : undefined;
    const emit = id ? NATIVE_TS[id] : undefined;
    const { recv, args } = this.orderedArgs(cur, step.args, s, f, out);
    let code: string;
    if (emit) {
      const bound = step.generic?.T ? this.registry.parse(step.generic.T, callScope) : undefined;
      code = emit(this.nativeCtx({ ...cur, code: recv }, args, bound, f, out));
    } else {
      code = `${access(recv, name)}(${argsObject(args, call)})`;
      if (this.memberAsync(cur.type, name, prop, 'method')) code = this.aw(code, f);
    }
    if (step.catch_) return this.withCatch(code, step.catch_, ret, s, f, out);
    return { code, type: ret, pure: !!emit && cur.pure && Object.values(args).every((a) => a.pure) && !(id && isMutating(id)) };
  }

  /** Does calling / reading this member need an `await`? */
  private memberAsync(owner: Type, name: string, prop: Prop, kind: 'method' | 'computed'): boolean {
    if (prop.get && !(prop.get instanceof NativeExpr)) {
      const decl = owner instanceof Extension ? this.decl(owner) : undefined;
      const info = this.findMember(decl, name);
      if (info) return info.async !== false;
      return kind === 'method' ? true : false;
    }
    if (kind === 'computed') return false;
    const k = this.hostMemberKind(prop);
    return k !== 'sync';
  }

  private findMember(decl: Extension | undefined, name: string): { async: boolean | 'pending' } | undefined {
    for (let t: Type | undefined = decl; t instanceof Extension; t = t.original) {
      const info = this.makers.get(this.decl(t).name)?.members.get(name);
      if (info) return info;
    }
    return undefined;
  }

  /**
   * Compile call arguments in order. When any argument needs statements or
   * has effects, the receiver and every effectful argument are spilled to
   * temps first, so gin's left-to-right order holds whatever the native
   * template does with them.
   */
  private orderedArgs(cur: Res, argExprs: Record<string, Expr>, s: Scope, f: Fn, out: string[]):
    { recv: string; args: Record<string, Res> } {
    const compiled = Object.entries(argExprs).map(([k, e]) => {
      const buf: string[] = [];
      return { k, r: this.val(e, s, f, buf), buf };
    });
    const needSpill = compiled.some((c) => c.buf.length > 0 || !c.r.pure);
    const recv = needSpill && !LITERAL_RE.test(cur.code) ? this.spill(cur, out, 'recv') : cur.code;
    const args: Record<string, Res> = {};
    for (const c of compiled) {
      out.push(...c.buf);
      args[c.k] = needSpill && !c.r.pure && c.r.sync === undefined
        ? { ...c.r, code: this.spill(c.r, out, c.k), pure: true }
        : c.r;
    }
    return { recv, args };
  }

  /** Run slot compilers in order, spilling earlier impure slots when a later one needs statements. */
  private ordered<T extends { code: string; pure: boolean }>(fns: Array<(buf: string[]) => T>, out: string[]): T[] {
    const done = fns.map((fn) => { const buf: string[] = []; return { r: fn(buf), buf }; });
    const lastStmt = done.reduce((acc, d, i) => (d.buf.length ? i : acc), -1);
    return done.map((d, i) => {
      out.push(...d.buf);
      if (i < lastStmt && !d.r.pure && !LITERAL_RE.test(d.r.code)) {
        const t = this.uniq('slot');
        out.push(`const ${t} = ${unparen(d.r.code)};`);
        return { ...d.r, code: t, pure: true };
      }
      return d.r;
    });
  }

  private nativeCtx(cur: Res, args: Record<string, Res>, bound: Type | undefined, f: Fn, out: string[]): NativeCtx {
    let selfCode = cur.code;
    const argCode: Record<string, string> = {};
    for (const [k, a] of Object.entries(args)) argCode[k] = a.code;
    return {
      self: () => selfCode,
      once: () => {
        if (!isIdent(selfCode)) selfCode = this.spill({ ...cur, code: selfCode }, out, 'recv');
        return selfCode;
      },
      discard: () => {
        if (!cur.pure) out.push(`${unparen(selfCode)};`);
      },
      arg: (n) => argCode[n],
      argOnce: (n) => {
        const a = argCode[n];
        if (a === undefined || isIdent(a)) return a;
        argCode[n] = this.spill({ ...args[n]!, code: a }, out, n);
        return argCode[n];
      },
      fn: (n) => {
        const a = args[n];
        if (!a) return undefined;
        return { code: a.code, sync: !this.always && a.sync === true };
      },
      helper: (n) => this.helper(n),
      aw: (code) => this.aw(code, f),
      selfType: cur.type,
      fields: () => dataFields(cur.type),
      guard: () => (bound ? this.guard(bound) : undefined),
      staticTypeName: () => staticTypeName(cur.type),
    };
  }

  private withCatch(code: string, handler: Expr, ret: Type, s: Scope, f: Fn, out: string[]): Res {
    const t = this.uniq('result');
    const e = this.uniq('e');
    const err = this.uniq('error');
    const thr = this.helper('$Throw');
    out.push(`let ${t};`, 'try {', `  ${t} = ${unparen(code)};`, `} catch (${e}) {`, `  if (!(${e} instanceof ${thr})) throw ${e};`);
    const inner: string[] = [`const ${err} = ${e}.error as any;`];
    const scope: Scope = new Map(s);
    scope.set('error', { ts: err, type: this.registry.any() });
    const h = this.val(handler, scope, f, inner);
    inner.push(`${t} = ${unparen(h.code)};`);
    out.push(...indent(inner), '}');
    return { code: t, type: ret, pure: true };
  }

  private aw(code: string, f: Fn): string {
    f.awaited = true;
    return `(await ${code})`;
  }

  /** Bind a value to a temp const unless it is already a name or literal. */
  private spill(r: Res, out: string[], base: string): string {
    if (isIdent(r.code) || LITERAL_RE.test(r.code)) return r.code;
    const t = this.uniq(base);
    out.push(`const ${t} = ${unparen(r.code)};`);
    return t;
  }

  private typeOfExpr(e: Expr, s: Scope): Type {
    const locals = new Map<string, Type>();
    for (const [name, g] of this.engine.getGlobals()) locals.set(name, g.type);
    for (const [name, t] of Object.entries(this.opt.scope)) locals.set(name, t);
    for (const [name, sym] of s) locals.set(name, sym.type);
    try { return e.typeOf(this.engine, locals); } catch { return this.registry.any(); }
  }
}

// ─── small helpers ─────────────────────────────────────────────────────────

function isAutoCallable(propType: Type): boolean {
  const call = propType.call();
  if (!call) return false;
  if (!(call.args instanceof ObjType)) return true;
  return Object.values(call.args.fields).every((p) => p.type.isOptional());
}

/** A member (method, computed prop, function-valued field) rather than a stored field. */
function isMember(p: Prop): boolean {
  return !!p.get || p.type instanceof FnType;
}

function isObjLike(t: Type): boolean {
  if (t instanceof ObjType || t instanceof IfaceType) return true;
  if (t instanceof Extension) return isObjLike(t.base);
  return false;
}

/** The declared fields of an obj-like type (own, base, local), in declaration order. */
function objFields(t: Type): Array<[string, Prop]> | undefined {
  if (t instanceof ObjType) return Object.entries(t.fields);
  if (t instanceof IfaceType) return Object.entries(t._props);
  if (t instanceof Extension) {
    const base = objFields(t.base);
    if (!base) return undefined;
    const map = new Map(base);
    for (const [k, p] of Object.entries(t.local.props ?? {})) map.set(k, Prop.from(p));
    return [...map];
  }
  return undefined;
}

/** Names of the stored (data) fields of an obj-like type. */
function dataFields(t: Type): string[] {
  return (objFields(t) ?? []).filter(([, p]) => !p.get && !p.type.call()).map(([k]) => k);
}

function dataFieldTypes(t: Type): Map<string, Type> | undefined {
  const fields = objFields(t);
  if (!fields) return undefined;
  return new Map(fields.filter(([, p]) => !p.get).map(([k, p]) => [k, p.type]));
}

function staticTypeName(t: Type): string | undefined {
  if (t instanceof AnyType || t instanceof OrType || t instanceof AndType || t instanceof NotType
    || t instanceof AliasType || t instanceof OptionalType || t instanceof NullableType) return undefined;
  return t.name;
}

/** Text that `${…}` stringifies the way gin's template does (no null/undefined to blank). */
function plainText(t: Type): boolean {
  const base = t instanceof Extension ? t.base : t;
  return base instanceof TextType || base instanceof NumType || base instanceof BoolType || base instanceof EnumType;
}

function isMutating(id: string): boolean {
  return /\.(push|pop|shift|unshift|insert|remove|clear|delete|indexSet|setAt)$/.test(id);
}

/** Does a `new` payload contain an Expr anywhere? */
function hasExpr(value: unknown, registry: Registry): boolean {
  if (value instanceof Expr) return true;
  if (!value || typeof value !== 'object') return false;
  if (!Array.isArray(value) && typeof (value as { kind?: unknown }).kind === 'string'
    && registry.exprClass((value as { kind: string }).kind)) return true;
  return Object.values(value as Record<string, unknown>).some((v) => hasExpr(v, registry));
}

/** The object literal passed to a call: `{ a: x, b: y }`, or nothing when there are no args to pass. */
function argsObject(args: Record<string, Res>, call: Call | undefined): string {
  const entries = Object.entries(args);
  if (entries.length === 0) {
    const fields = call?.args instanceof ObjType ? Object.values(call.args.fields) : [];
    const required = fields.some((p) => !p.type.isOptional() && p.default === undefined);
    return required ? '{} as any' : '';
  }
  return `{ ${entries.map(([k, a]) => (k === a.code ? k : `${isIdent(k) ? k : JSON.stringify(k)}: ${unparen(a.code)}`)).join(', ')} }`;
}

function constraintDoc(t: Type): string | undefined {
  const opts = t.options as Record<string, unknown> | undefined;
  if (!opts || typeof opts !== 'object' || Object.keys(opts).length === 0) return undefined;
  if (!(t instanceof NumType || t instanceof TextType || t instanceof ListType || t instanceof DateType || t instanceof TimestampType)) return undefined;
  return `gin: ${t.toCode(undefined, { includeComments: false })}`;
}

export function indent(lines: string[]): string[] {
  return lines.flatMap((l) => l.split('\n')).map((l) => (l ? `  ${l}` : l));
}

function closesAtEnd(lines: string[]): boolean {
  return lines[lines.length - 1] === '}';
}

function braces(members: string[]): string {
  if (members.length === 0) return '{}';
  const one = `{ ${members.join('; ')} }`;
  if (one.length <= 80 && !one.includes('\n') && !one.includes('/**')) return one;
  return `{\n${indent(members.map((m) => `${m};`)).join('\n')}\n}`;
}

function paren(s: string): string {
  return s.includes('=>') || s.includes(' | ') || s.includes(' & ') ? `(${s})` : s;
}

function union(parts: string[]): string {
  const flat: string[] = [];
  for (const p of parts.map((x) => (x.includes('=>') ? `(${x})` : x))) if (!flat.includes(p)) flat.push(p);
  return flat.join(' | ');
}

function arrayOf(s: string): string {
  return /^[\w$.]+(<.*>)?$/.test(s) && !s.includes(' ') ? `${s}[]` : `Array<${s}>`;
}

function unparen(code: string): string {
  if (!code.startsWith('(') || !code.endsWith(')')) return code;
  // Only strip when the outer parens are one matched pair.
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0 && i < code.length - 1) return code; }
    else if (ch === '"' || ch === '`' || ch === "'") return code;
  }
  return code.slice(1, -1);
}

function esc(s: string): string {
  return s.replace(/\*\//g, '*\\/');
}

function escTemplate(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function pascal(s: string): string {
  const p = s.replace(/[^\w$]+(.)/g, (_, c: string) => c.toUpperCase());
  return p.charAt(0).toUpperCase() + p.slice(1);
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
