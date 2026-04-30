import {
  AliasType,
  AndType,
  AnyType,
  BoolType,
  ColorType,
  DateType,
  DurationType,
  EnumType,
  FnType,
  IfaceType,
  ListType,
  LiteralType,
  MapType,
  NotType,
  NullType,
  NullableType,
  NumType,
  ObjType,
  OptionalType,
  OrType,
  TextType,
  TimestampType,
  TupleType,
  TypType,
  Type,
  Value,
  val,
  type Prop,
  type Registry,
} from '@aeye/gin';
import type { Extension } from '@aeye/gin';

/**
 * Adapter the consumer uses to ask the user for input. A v1 text-only
 * implementation simulates `choice`/`confirm` over the same single-line
 * prompt; richer terminal UIs can drop in later without touching the
 * consumer itself.
 *
 * Every method returns `null` to signal cancellation (Ctrl-C, blank
 * answer at the top level, etc.). `consume` propagates that as `null`
 * all the way up — `fns.ask` surfaces it to the program as
 * `optional<T> = null`.
 */
export interface AskAdapter {
  text(p: { title: string; details?: string; default?: string }): Promise<string | null>;
  choice(p: { title: string; details?: string; options: string[] }): Promise<string | null>;
  confirm(p: { title: string; details?: string; default?: boolean }): Promise<boolean>;
}

/** Default adapter — wraps a single-line `ask(question): string` (the
 *  same shape `ctx.ask` exposes). Simulates choice via "1-N" picks and
 *  confirm via `(y/n)`. Empty answer is treated as cancellation, except
 *  inside `confirm` where empty falls back to the default. */
export function textAdapter(
  ask: (question: string, signal?: AbortSignal) => Promise<string>,
  signal?: AbortSignal,
): AskAdapter {
  const renderHeader = (title: string, details?: string): string =>
    details ? `${title}\n  ${details}` : title;

  return {
    async text({ title, details, default: def }) {
      const header = renderHeader(title, details);
      const prompt = def !== undefined
        ? `${header} [${def}]: `
        : `${header}: `;
      const answer = await ask(prompt, signal);
      const trimmed = answer.trim();
      if (trimmed === '' && def !== undefined) return def;
      if (trimmed === '') return null;
      return answer;
    },

    async choice({ title, details, options }) {
      if (options.length === 0) return null;
      if (options.length === 1) return options[0]!;
      const header = renderHeader(title, details);
      const list = options.map((o, i) => `  ${i + 1}) ${o}`).join('\n');
      const prompt = `${header}\n${list}\nPick (1-${options.length}): `;
      const raw = (await ask(prompt, signal)).trim();
      if (raw === '') return null;
      // Allow either the index or the literal label.
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) {
        return options[n - 1]!;
      }
      const match = options.find((o) => o === raw);
      return match ?? null;
    },

    async confirm({ title, details, default: def }) {
      const header = renderHeader(title, details);
      const hint = def === true ? '(Y/n)' : def === false ? '(y/N)' : '(y/n)';
      const raw = (await ask(`${header} ${hint}: `, signal)).trim().toLowerCase();
      if (raw === '') return def ?? false;
      return raw === 'y' || raw === 'yes' || raw === '1' || raw === 'true';
    },
  };
}

/** Caller-supplied prompt context for the top-level `consume` call. */
export interface ConsumeOptions {
  /** Headline shown before the first prompt. */
  title: string;
  /** Optional supplemental description. */
  details?: string;
}

/**
 * Walk a `Type` interactively, prompting the user for whatever pieces
 * the type needs and returning a parsed `Value` matching that type.
 *
 * Returns `null` when the user cancels at any depth — the cancellation
 * unwinds the whole walk so the caller sees a single `null`. Sub-walks
 * use the type's `docs` field (or a prop's `docs` for obj fields) as
 * the prompt details, with the type name / field name as the title;
 * authors are encouraged to put short user-facing labels in `docs`.
 *
 * The walker is type-class-driven (instanceof on each gin Type
 * subclass) — adding a new Type means adding one more branch here.
 */
export async function consume(
  type: Type,
  opts: ConsumeOptions,
  adapter: AskAdapter,
  registry: Registry,
): Promise<Value | null> {
  // Resolve aliases / extensions before dispatching so the structural
  // form drives the flow.
  const t = unwrap(type);

  // Leaf-text-like — read a string, parse via the type. Re-prompt up
  // to 3 times on parse error.
  if (t instanceof TextType
   || t instanceof NumType
   || t instanceof DateType
   || t instanceof TimestampType
   || t instanceof DurationType
   || t instanceof ColorType) {
    return promptLeaf(t, opts, adapter, 3);
  }

  if (t instanceof BoolType) {
    const ans = await adapter.confirm({ title: opts.title, details: detailsFor(opts.details, t) });
    return val(registry.bool(), ans);
  }

  if (t instanceof NullType) return val(registry.null(), null);
  if (t instanceof Type && t.name === 'void') return val(registry.void(), undefined);
  if (t instanceof AnyType) {
    const raw = await adapter.text({ title: opts.title, details: detailsFor(opts.details, t) });
    if (raw === null) return null;
    // Try JSON, fall back to the literal string.
    try { return val(registry.any(), JSON.parse(raw)); }
    catch { return val(registry.any(), raw); }
  }

  if (t instanceof EnumType) {
    const opt = t as { options: { values: Record<string, unknown> } };
    const labels = Object.keys(opt.options.values);
    const picked = await adapter.choice({
      title: opts.title,
      details: detailsFor(opts.details, t),
      options: labels,
    });
    if (picked === null) return null;
    const value = opt.options.values[picked];
    return t.parse(value);
  }

  if (t instanceof LiteralType) {
    // Literal — there's only one valid value; no prompt.
    return val(t, (t as unknown as { literal: unknown }).literal);
  }

  if (t instanceof OptionalType || t instanceof NullableType) {
    const inner = (t as unknown as { inner: Type }).inner;
    const give = await adapter.confirm({
      title: `${opts.title} — provide a value?`,
      details: detailsFor(opts.details, t),
    });
    if (!give) {
      return t instanceof OptionalType
        ? val(t, undefined)
        : val(t, null);
    }
    const inner_value = await consume(inner, { title: opts.title, details: opts.details }, adapter, registry);
    if (inner_value === null) return null;
    return val(t, inner_value.raw);
  }

  if (t instanceof ListType) {
    const item = (t as unknown as { item: Type }).item;
    const itemOpts = (t as unknown as { options: { minLength?: number; maxLength?: number } }).options;
    const min = itemOpts.minLength ?? 0;
    const max = itemOpts.maxLength ?? Infinity;
    const items: Value[] = [];
    while (items.length < max) {
      // Below min: don't even ask, just keep going.
      // At-or-above min: confirm whether to add another.
      if (items.length >= min) {
        const more = await adapter.confirm({
          title: `${opts.title} — add ${items.length === 0 ? 'an' : 'another'} item?`,
          details: detailsFor(opts.details, t),
          default: items.length < min,
        });
        if (!more) break;
      }
      const itemTitle = `${opts.title}[${items.length}]`;
      const itemValue = await consume(item, { title: itemTitle, details: docsFor(item) }, adapter, registry);
      if (itemValue === null) return null;
      items.push(itemValue);
    }
    return val(t, items);
  }

  if (t instanceof TupleType) {
    const elems = (t as unknown as { elements: Type[] }).elements;
    const out: Value[] = [];
    for (let i = 0; i < elems.length; i++) {
      const elem = elems[i]!;
      const v = await consume(elem, {
        title: `${opts.title}[${i}]`,
        details: docsFor(elem),
      }, adapter, registry);
      if (v === null) return null;
      out.push(v);
    }
    return val(t, out as [Value, ...Value[]]);
  }

  if (t instanceof ObjType || t instanceof IfaceType) {
    const fields = (t instanceof ObjType
      ? (t as unknown as { fields: Record<string, Prop> }).fields
      : (t as unknown as { _props: Record<string, Prop> })._props);
    const out: Record<string, Value> = {};
    for (const [name, prop] of Object.entries(fields)) {
      const v = await consume(prop.type, {
        title: `${opts.title}.${name}`,
        // Prop docs win over type docs — they describe THIS field's role
        // in the parent shape, which is more specific.
        details: prop.docs ?? docsFor(prop.type),
      }, adapter, registry);
      if (v === null) return null;
      out[name] = v;
    }
    return val(t, out);
  }

  if (t instanceof MapType) {
    const keyT = (t as unknown as { key: Type }).key;
    const valT = (t as unknown as { value: Type }).value;
    const m = new Map<unknown, [Value, Value]>();
    while (true) {
      const more = await adapter.confirm({
        title: `${opts.title} — add ${m.size === 0 ? 'an' : 'another'} entry?`,
        details: detailsFor(opts.details, t),
      });
      if (!more) break;
      const k = await consume(keyT, { title: `${opts.title} key`, details: docsFor(keyT) }, adapter, registry);
      if (k === null) return null;
      const v = await consume(valT, { title: `${opts.title} value`, details: docsFor(valT) }, adapter, registry);
      if (v === null) return null;
      m.set(k.raw, [k, v]);
    }
    return val(t, m);
  }

  if (t instanceof OrType) {
    const variants = (t as unknown as { variants: Type[] }).variants;
    const labels = variants.map((v) => v.toCode());
    const picked = await adapter.choice({
      title: `${opts.title} — pick a variant`,
      details: detailsFor(opts.details, t),
      options: labels,
    });
    if (picked === null) return null;
    const idx = labels.indexOf(picked);
    const variant = variants[idx]!;
    const inner = await consume(variant, { title: opts.title, details: docsFor(variant) }, adapter, registry);
    if (inner === null) return null;
    return val(t, inner.raw);
  }

  if (t instanceof AndType) {
    // Intersection — usually structurally equal to the first part. If
    // there's a more nuanced merge needed, the LLM should declare an
    // Extension instead.
    const parts = (t as unknown as { parts: Type[] }).parts;
    const first = parts[0];
    if (!first) return val(t, null);
    return consume(first, opts, adapter, registry);
  }

  if (t instanceof NotType) {
    // Can't generate a "not-X" UI. Fall back to text + permissive parse.
    const raw = await adapter.text({ title: opts.title, details: detailsFor(opts.details, t) });
    if (raw === null) return null;
    return val(t, raw);
  }

  if (t instanceof TypType) {
    // v1: pick a registered type by name. Inline-Extension authoring
    // is out of scope.
    const names = registry.namedTypeList().map((nt) => nt.name);
    const builtins = registry.typeClasses().map((c) => c.NAME);
    const all = Array.from(new Set([...names, ...builtins])).sort();
    const picked = await adapter.choice({
      title: `${opts.title} — pick a type`,
      details: detailsFor(opts.details, t),
      options: all,
    });
    if (picked === null) return null;
    return t.parse({ name: picked });
  }

  if (t instanceof FnType) {
    throw new Error(`fns.ask: cannot prompt for a function type — ${t.toCode()}`);
  }

  // Unknown leaf. Best effort: text + parse.
  return promptLeaf(t, opts, adapter, 3);
}

/** Read a string, parse via the type. Re-prompt up to `maxAttempts`
 *  times on parse error, surfacing the parser's message. */
async function promptLeaf(
  t: Type,
  opts: ConsumeOptions,
  adapter: AskAdapter,
  maxAttempts: number,
): Promise<Value | null> {
  let lastError = '';
  for (let i = 0; i < maxAttempts; i++) {
    const details = lastError
      ? `${opts.details ?? docsFor(t) ?? ''}\n  (last attempt: ${lastError})`.trim()
      : detailsFor(opts.details, t);
    const raw = await adapter.text({ title: opts.title, details });
    if (raw === null) return null;
    try {
      // Heuristic: numeric-leafs accept both numeric strings and JSON.
      // For text-leafs the raw string IS the answer.
      const parsed = parseLeafInput(t, raw);
      return t.parse(parsed);
    } catch (e: unknown) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return null;
}

function parseLeafInput(t: Type, raw: string): unknown {
  if (t instanceof NumType) {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`'${raw}' is not a number`);
    return n;
  }
  return raw;
}

/** Resolve aliases / unwrap extensions to the structural form so the
 *  walker dispatches on the underlying class. */
function unwrap(t: Type): Type {
  // AliasType.simplify resolves through scope to the target.
  let cur: Type = t;
  if (cur instanceof AliasType) {
    cur = cur.simplify();
  }
  // Extension — defer to base for the structural shape. The
  // Extension's narrowed options ride along through `parse`, so the
  // value the consumer constructs still gets validated against the
  // Extension's constraints when the caller (fns.ask) wraps the final
  // value in `t.parse(...)`.
  if (isExtension(cur)) {
    return unwrap(cur.base);
  }
  return cur;
}

function isExtension(t: Type): t is Extension {
  // Avoid importing Extension just for the check at runtime (it's
  // also fine to import — but this keeps the consumer's surface
  // narrow). Identify Extensions by their `base` field shape.
  return 'base' in (t as object) && t.constructor.name === 'Extension';
}

/** Pick a useful `details` string: caller-supplied wins, type docs
 *  next, blank otherwise. */
function detailsFor(callerDetails: string | undefined, t: Type): string | undefined {
  if (callerDetails && callerDetails.length > 0) return callerDetails;
  return docsFor(t);
}

function docsFor(t: Type): string | undefined {
  const d = (t as unknown as { docs?: string }).docs;
  return d && d.length > 0 ? d : undefined;
}
