/**
 * Import a JSON Schema from outside (MCP tool `inputSchema`/`outputSchema`,
 * elicitation forms, OpenAPI bodies) as an `a` bundle — no zod round trip.
 * `$defs`/`definitions` become named types; `$ref` becomes `a.ref`, so
 * recursive outside schemas stay recursive and then render per profile like
 * any other bundle. The static type is `unknown` unless the caller asserts
 * one (`fromJSONSchema<MyArgs>(json)`) — an outside schema has no TS type.
 *
 * Covered: type (incl. arrays of types), properties/required,
 * additionalProperties (record or closed), items/prefixItems, enum, const,
 * anyOf/oneOf, nullable via type ['x','null'], $ref to #/$defs|definitions
 * and '#', min/max constraints, description, title, examples.
 * allOf (an intersection: objects merge), not, if/then/else (said in words
 * where a dialect lacks them, always validated), patternProperties and a
 * schema-valued additionalProperties next to properties (extra keys).
 * Not covered (reported in `report.unsupported`, left unchecked):
 * dependentSchemas, dependentRequired, external $refs.
 */
import {
  AnyType, ArrayType, BooleanType, ConditionalType, EnumType, IntersectionType, LiteralType, NotType, NullType, NullableType,
  NumberType, ObjectType, OptionalType, RecordType, RefType, StringType, TupleType, UnionType, type AnySchema, type LiteralValue,
} from './schema';
import { Bundle } from './module';

type J = { [key: string]: any } | boolean;

export interface ImportReport {
  /** Keywords that could not be represented exactly. */
  readonly unsupported: string[];
}

export function fromJSONSchema<T = unknown>(schema: J, report: ImportReport = { unsupported: [] }): Bundle<T, []> {
  const root = typeof schema === 'object' ? schema : {};
  const rawDefs: Record<string, J> = { ...(root.definitions ?? {}), ...(root.$defs ?? {}) };
  const defs: Record<string, AnySchema> = {};
  let usesRoot = false;

  const refName = (ref: string): string => {
    if (ref === '#') { usesRoot = true; return '__root'; }
    const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
    if (!m) { report.unsupported.push(`$ref ${ref}`); return '__any'; }
    return m[1]!.replace(/~1/g, '/').replace(/~0/g, '~');
  };

  const conv = (j: J): AnySchema => {
    if (j === true || j === undefined) return new AnyType();
    if (j === false) return new UnionType([new NullType()]).refine(() => false, 'No value is allowed here.');
    const { allOf, not, if: cond, then, else: otherwise, ...rest } = j;
    const bare = Object.keys(rest).every((k) => ['description', 'title', 'examples', '$comment', 'default'].includes(k));
    let s: AnySchema = convBody(rest);
    if (Array.isArray(allOf) && allOf.length) {
      const members = (allOf as J[]).map(conv);
      const all = bare ? members : [s, ...members];
      s = all.length === 1 ? all[0]! : new IntersectionType(all as [AnySchema, ...AnySchema[]]);
    }
    if (not !== undefined) s = new NotType(conv(not), s);
    if (cond !== undefined) s = new ConditionalType(s, conv(cond), then !== undefined ? conv(then) : undefined, otherwise !== undefined ? conv(otherwise) : undefined);
    for (const k of ['dependentSchemas', 'dependentRequired']) if (k in j) report.unsupported.push(k);
    if (typeof j.description === 'string') s = s.describe(j.description);
    if (typeof j.title === 'string') s = s.title(j.title);
    if (Array.isArray(j.examples)) s = s.example(...j.examples);
    return s;
  };

  const convBody = (j: { [key: string]: any }): AnySchema => {
    if (typeof j.$ref === 'string') return new RefType(refName(j.$ref));
    if ('const' in j) return new LiteralType(j.const as LiteralValue);
    if (Array.isArray(j.enum)) {
      const vals = j.enum as unknown[];
      const strings = vals.filter((v): v is string => typeof v === 'string');
      const hasNull = vals.includes(null);
      const base: AnySchema = strings.length === vals.length - (hasNull ? 1 : 0) && strings.length
        ? new EnumType(strings as [string, ...string[]])
        : new UnionType(vals.filter((v) => v !== null).map((v) => new LiteralType(v as LiteralValue)) as unknown as [AnySchema, ...AnySchema[]]);
      return hasNull ? new NullableType(base) : base;
    }
    const alts = j.anyOf ?? j.oneOf;
    if (Array.isArray(alts)) {
      const opts = (alts as J[]).map(conv);
      const nonNull = opts.filter((o) => !(o instanceof NullType));
      const u = nonNull.length === 1 ? nonNull[0]! : new UnionType(nonNull as [AnySchema, ...AnySchema[]]);
      return nonNull.length < opts.length ? new NullableType(u) : u;
    }
    if (Array.isArray(j.type)) {
      const types = j.type as string[];
      const nonNull = types.filter((t) => t !== 'null');
      const parts = nonNull.map((t) => convBody({ ...j, type: t }));
      const u = parts.length === 1 ? parts[0]! : parts.length ? new UnionType(parts as [AnySchema, ...AnySchema[]]) : new NullType();
      return types.includes('null') && parts.length ? new NullableType(u) : u;
    }
    // A type-less schema whose keywords only apply to one type (e.g. an allOf
    // member `{ minLength: 2 }`) is read as that type.
    const type = j.type ?? implied(j);
    switch (type) {
      case 'string': {
        let s = new StringType();
        if (typeof j.minLength === 'number') s = s.min(j.minLength);
        if (typeof j.maxLength === 'number') s = s.max(j.maxLength);
        if (typeof j.pattern === 'string') s = s.pattern(j.pattern);
        if (typeof j.format === 'string') s = s.format(j.format);
        return s;
      }
      case 'number':
      case 'integer': {
        let s = new NumberType({ int: j.type === 'integer' });
        if (typeof j.minimum === 'number') s = s.min(j.minimum);
        if (typeof j.maximum === 'number') s = s.max(j.maximum);
        return s;
      }
      case 'boolean': return new BooleanType();
      case 'null': return new NullType();
      case 'array': {
        if (Array.isArray(j.prefixItems) && j.prefixItems.length) return new TupleType((j.prefixItems as J[]).map(conv) as [AnySchema, ...AnySchema[]]);
        let s = new ArrayType(conv(j.items ?? true));
        if (typeof j.minItems === 'number') s = s.min(j.minItems);
        if (typeof j.maxItems === 'number') s = s.max(j.maxItems);
        return s;
      }
      case 'object':
      default: {
        if (type === undefined && !j.properties && !j.patternProperties && j.additionalProperties === undefined && !j.required) return new AnyType();
        // `{ type: 'object' }` and nothing else: ANY object (MCP tools with no declared args).
        if (!j.properties && !j.patternProperties && j.additionalProperties === undefined && !j.required) return new RecordType(new AnyType());
        const props: Record<string, J> = j.properties ?? {};
        const required = new Set<string>(j.required ?? []);
        const ap = j.additionalProperties;
        const pp = j.patternProperties as Record<string, J> | undefined;
        if (!Object.keys(props).length && !pp && ap !== undefined && ap !== false && ap !== true) return new RecordType(conv(ap));
        const shape: Record<string, AnySchema> = {};
        for (const [k, p] of Object.entries(props)) shape[k] = required.has(k) ? conv(p) : new OptionalType(conv(p));
        // `required` may name keys `properties` doesn't describe.
        for (const k of required) if (!(k in shape)) shape[k] = new AnyType();
        let o: ObjectType<any, any> = new ObjectType(shape);
        if (pp) o = o.patterns(Object.fromEntries(Object.entries(pp).map(([p, v]) => [p, conv(v)])));
        if (ap !== undefined && typeof ap === 'object') o = o.rest(conv(ap));
        return ap === false ? o.strict() : o;
      }
    }
  };

  for (const [name, d] of Object.entries(rawDefs)) defs[name] = conv(d);
  const { $defs: _a, definitions: _b, ...body } = root;
  const top = conv(body);
  if (usesRoot) defs.__root = top;
  if (report.unsupported.includes('$ref') || Object.values(defs).some(() => false)) defs.__any = new AnyType();
  for (const n of [top, ...Object.values(defs)].flatMap((s) => [...s.refNames()])) {
    if (n in defs) continue;
    if (!n.startsWith('__')) report.unsupported.push(`$ref to a missing definition "${n}" (any JSON instead)`);
    defs[n] = new AnyType().describe(`Unknown reference ${n}.`);
  }
  return new Bundle<T, []>(defs, usesRoot ? new RefType('__root') : top);
}

/** The one JSON type a type-less schema's keywords apply to, if any. */
function implied(j: { [key: string]: any }): string | undefined {
  if (['minLength', 'maxLength', 'pattern', 'format'].some((k) => k in j)) return 'string';
  if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'].some((k) => k in j)) return 'number';
  if (['items', 'prefixItems', 'minItems', 'maxItems'].some((k) => k in j)) return 'array';
  if (['properties', 'required', 'patternProperties', 'additionalProperties'].some((k) => k in j)) return 'object';
  return undefined;
}
