/**
 * TEMPORARY BRIDGE: zod schemas into `@aeye/schema`.
 *
 * TODO(step 2): remove this file (and core's `zod` dependency) once
 * `@aeye/gin` and `@aeye/query` produce `a` schemas. Until then their zod
 * schemas, and the tools/prompts built on them (ginny, query's
 * `buildQueryTool`, harness), keep working: a zod schema (or a function
 * returning one) given to a `Tool` / `Prompt` is turned into an `a` bundle
 * walking its definition (`zodToA`: `z.lazy` becomes a named type), memoized
 * per zod instance. (Not via `z.toJSONSchema`: ~5 s per call on @aeye/query's schemas.) The request plans and renders it like any `a` schema; after
 * decoding, the zod schema itself parses the decoded value too, so zod's
 * refinements, defaults and transforms still apply.
 *
 * Everything else in aits passes `a` schemas.
 */
import { globalRegistry } from 'zod';
import { a, Bundle, formatErrors, type AnySchema, type Bindable, type Bound, type ErrorFormatInput, type Issue } from '@aeye/schema';

/** A zod schema, structurally (zod 4). */
export interface ZodLike<T = unknown> {
  readonly _zod: { readonly output: T; readonly def?: { readonly type?: string } };
  safeParseAsync(value: unknown): Promise<
    | { success: true; data: T }
    | { success: false; error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> } }
  >;
}

/**
 * The zod forms core still accepts during the bridge: a zod schema, or (the
 * old function form) a function returning one, `undefined` / `false` meaning
 * "not applicable here".
 */
export type ZodSchemaInput<T, A extends unknown[]> =
  | ZodLike<T>
  | ((...args: A) => ZodLike<T> | undefined | false | Promise<ZodLike<T> | undefined | false>);

/** Whether a value is a zod schema. */
export function isZodSchema(value: unknown): value is ZodLike {
  return !!value && typeof value === 'object' && '_zod' in value;
}

/** Whether a zod schema is a plain string (a prompt answering in text). */
export function isZodString(value: ZodLike): boolean {
  return value._zod.def?.type === 'string';
}

const bridged = new WeakMap<object, Bound<unknown>>();
const zodOf = new WeakMap<Bound<unknown>, ZodLike>();

/**
 * The `a` bundle of a zod schema, bound (memoized per zod instance, so a zod
 * schema built once renders once per profile).
 */
export function boundFromZod<T>(schema: ZodLike<T>): Bound<T> {
  let bound = bridged.get(schema);
  if (!bound) {
    bound = zodToA(schema).bind();
    bridged.set(schema, bound);
    zodOf.set(bound, schema);
  }
  return bound as Bound<T>;
}

/**
 * A zod schema as an `a` schema (`Bindable`), for code that hands a zod
 * schema to something taking `a` (core's Tool and Prompt take zod directly
 * during the bridge). TODO(step 2): remove.
 */
export function fromZod<T>(schema: ZodLike<T>): Bindable<T, []> {
  return { bind: () => boundFromZod(schema) } as unknown as Bindable<T, []>;
}

type ZodDef = { readonly type: string; readonly [key: string]: any };
const defOf = (s: unknown): ZodDef => (s as { _zod: { def: ZodDef } })._zod.def;

/** A walk gives up (any JSON, still checked by zod) past this many nodes: a lazy that builds fresh schemas forever. */
const MAX_NODES = 20_000;

const CONTAINERS = new Set(['object', 'union', 'intersection', 'array', 'record', 'tuple']);

/** How many places each zod instance is used in (lazies followed once). */
function countUses(root: unknown): Map<unknown, number> {
  const uses = new Map<unknown, number>();
  const stack: unknown[] = [root];
  let budget = MAX_NODES * 4;
  while (stack.length && budget-- > 0) {
    const s = stack.pop();
    const n = (uses.get(s) ?? 0) + 1;
    uses.set(s, n);
    if (n > 1) continue;
    const d = defOf(s);
    const kids: unknown[] = [];
    switch (d.type) {
      case 'array': kids.push(d.element); break;
      case 'tuple': kids.push(...d.items); break;
      case 'object': kids.push(...Object.values(d.shape as object)); if (d.catchall) kids.push(d.catchall); break;
      case 'record': kids.push(d.valueType); break;
      case 'union': kids.push(...d.options); break;
      case 'intersection': kids.push(d.left, d.right); break;
      case 'optional': case 'nullable': case 'default': case 'prefault': case 'nonoptional': case 'readonly': case 'catch': kids.push(d.innerType); break;
      case 'pipe': kids.push(d.in); break;
      case 'lazy': kids.push(d.getter()); break;
    }
    stack.push(...kids);
  }
  return uses;
}

/**
 * A zod schema as an `a` bundle, by walking its definition: the model-facing
 * shape (descriptions, checks, optional/nullable/default, unions, records,
 * tuples, recursion through `z.lazy` as named types). What has no `a` form
 * (transforms, custom checks, refinements) is left to zod, which parses the
 * decoded value afterwards. A pipe is the shape the model writes: its input.
 */
export function zodToA(root: unknown): Bundle<unknown, []> {
  const defs: Record<string, AnySchema> = {};
  const lazies = new Map<unknown, string>();
  let nodes = 0;

  // One `a` schema per zod instance: a shared fragment stays one instance (rendered once).
  const done = new Map<unknown, AnySchema>();
  // A container used in more than one place becomes a named type, so it's written once (`$defs`).
  const uses = countUses(root);
  let shared = 0;
  const walk = (s: unknown): AnySchema => {
    const hit = done.get(s);
    if (hit) return hit;
    if (++nodes > MAX_NODES) return a.unknown();
    // A zod id or aid (`.meta({ id })`, `.meta({ aid })` as gin and query name their types) names the type;
    // else a shared container gets a name.
    const meta = globalRegistry.get(s as never) as { id?: unknown; aid?: unknown } | undefined;
    const id = meta?.id ?? meta?.aid;
    const named = typeof id === 'string' && !(id in defs) ? id
      : (uses.get(s) ?? 0) > 1 && CONTAINERS.has(defOf(s).type) ? `S${++shared}` : undefined;
    if (named) {
      done.set(s, a.ref(named));
      defs[named] = a.unknown();
    }
    let out = convert(s);
    const description = (s as { description?: string }).description;
    if (description) out = out.describe(description);
    if (named) {
      defs[named] = out;
      return a.ref(named);
    }
    done.set(s, out);
    return out;
  };

  const checks = (d: ZodDef) => (d.checks ?? []).map((c: unknown) => defOf(c));

  const convert = (s: unknown): AnySchema => {
    const d = defOf(s);
    switch (d.type) {
      case 'string': {
        let t = a.string();
        const format = (s as { _zod: { def: { format?: string; pattern?: RegExp } } })._zod.def;
        if (format.format && format.format !== 'regex') t = t.format(format.format === 'url' ? 'uri' : format.format);
        for (const c of checks(d)) {
          if (c.check === 'min_length') t = t.min(c.minimum);
          else if (c.check === 'max_length') t = t.max(c.maximum);
          else if (c.check === 'length_equals') t = t.min(c.length).max(c.length);
          else if (c.check === 'string_format' && c.format === 'regex' && c.pattern) t = t.pattern(c.pattern);
          else if (c.check === 'string_format' && c.format && c.format !== 'regex') t = t.format(c.format === 'url' ? 'uri' : c.format);
        }
        if (format.format === 'regex' && format.pattern) t = t.pattern(format.pattern);
        return t;
      }
      case 'number':
      case 'int': {
        let n = d.type === 'int' ? a.int() : a.number();
        for (const c of checks(d)) {
          if (c.check === 'number_format' && /int/.test(String(c.format))) n = n.int();
          else if (c.check === 'greater_than') n = c.inclusive ? n.min(Number(c.value)) : n.gt(Number(c.value));
          else if (c.check === 'less_than') n = c.inclusive ? n.max(Number(c.value)) : n.lt(Number(c.value));
        }
        return n;
      }
      case 'boolean': return a.boolean();
      case 'null': return a.null();
      case 'date': return a.string().format('date-time');
      case 'literal': {
        const values = (d.values as unknown[]).filter((v): v is string | number | boolean | null => v === null || ['string', 'number', 'boolean'].includes(typeof v));
        return values.length === 1 ? a.literal(values[0]!) : values.length ? a.union(values.map(v => a.literal(v))) : a.unknown();
      }
      case 'enum': {
        const values = Object.values(d.entries as Record<string, unknown>);
        return values.every(v => typeof v === 'string') ? a.enum(values as string[]) : a.union(values.map(v => a.literal(v as string | number)));
      }
      case 'array': {
        let arr = a.array(walk(d.element));
        for (const c of checks(d)) {
          if (c.check === 'min_length') arr = arr.min(c.minimum);
          else if (c.check === 'max_length') arr = arr.max(c.maximum);
        }
        return arr;
      }
      case 'tuple': {
        const items = (d.items as unknown[]).map(walk);
        return items.length ? a.tuple(items as [AnySchema, ...AnySchema[]]) : a.array(a.unknown()).max(0);
      }
      case 'object': {
        const shape: Record<string, AnySchema> = {};
        for (const [key, value] of Object.entries(d.shape as Record<string, unknown>)) shape[key] = walk(value);
        const obj = a.object(shape);
        const catchall = d.catchall ? defOf(d.catchall) : undefined;
        if (catchall && catchall.type !== 'never') return obj.rest(walk(d.catchall));
        return catchall?.type === 'never' ? obj.strict() : obj;
      }
      case 'record': {
        const key = defOf(d.keyType);
        const value = walk(d.valueType);
        return key.type === 'enum' && Object.values(key.entries).every(v => typeof v === 'string')
          ? a.record(a.enum(Object.values(key.entries) as string[]), value)
          : a.record(value);
      }
      case 'union': {
        const options = (d.options as unknown[]).map(walk);
        if (!options.length) return a.never();
        // A zod discriminated union keeps its tag (options are objects or named types).
        if (typeof d.discriminator === 'string' && options.every(o => o.kind === 'object' || o.kind === 'ref')) {
          return a.discriminatedUnion(d.discriminator, options as never);
        }
        return a.union(options);
      }
      case 'intersection': return a.intersection([walk(d.left), walk(d.right)]);
      case 'optional': return a.optional(walk(d.innerType));
      case 'nullable': return a.nullable(walk(d.innerType));
      case 'default':
      case 'prefault':
        // The model may leave it out; zod writes the default in afterwards.
        return a.optional(walk(d.innerType));
      case 'nonoptional':
      case 'readonly':
      case 'catch':
        return walk(d.innerType);
      case 'pipe': return walk(d.in);
      case 'lazy': {
        let name = lazies.get(s);
        if (!name) {
          name = `Z${lazies.size + 1}`;
          lazies.set(s, name);
          defs[name] = a.unknown();
          defs[name] = walk(d.getter());
        }
        return a.ref(name);
      }
      default:
        // any, unknown, custom, transform, and what has no JSON shape.
        return a.unknown();
    }
  };

  const top = walk(root);
  return new Bundle<unknown, []>(defs, top);
}


/** The zod schema a bridged bound came from. */
export function zodOfBound(bound: Bound<unknown>): ZodLike | undefined {
  return zodOf.get(bound);
}

/**
 * Runs the zod schema over a value `@aeye/schema` already decoded (zod's
 * refinements, defaults, transforms). A failure is told to the model in the
 * same error format as any other.
 */
export async function finishZod(
  bound: Bound<unknown>,
  value: unknown,
  wire: unknown,
  format: ErrorFormatInput | undefined,
  label: string,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  const zod = zodOf.get(bound);
  if (!zod) {
    return { ok: true, value };
  }
  const result = await zod.safeParseAsync(value);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  const issues: Issue[] = result.error.issues.map(issue => {
    const path = issue.path.filter((seg): seg is string | number => typeof seg !== 'symbol');
    return { path, codePath: path, message: issue.message };
  });
  return { ok: false, message: formatErrors(issues, wire, format, label) };
}
