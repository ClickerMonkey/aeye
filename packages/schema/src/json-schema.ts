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
 * Not covered (reported, falls back to any JSON with a description):
 * allOf with more than one member, if/then/else, not, patternProperties,
 * dependentSchemas. See DESIGN.md open questions.
 */
import {
  AnyType, ArrayType, BooleanType, EnumType, LiteralType, NullType, NullableType, NumberType, ObjectType,
  OptionalType, RecordType, RefType, StringType, TupleType, UnionType, type AnySchema, type LiteralValue,
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
    let s = convBody(j);
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
    if (Array.isArray(j.allOf)) {
      if (j.allOf.length === 1) return conv(j.allOf[0]);
      report.unsupported.push('allOf');
      return new AnyType().describe('Must satisfy all of: ' + JSON.stringify(j.allOf));
    }
    for (const k of ['if', 'not', 'patternProperties', 'dependentSchemas']) if (k in j) report.unsupported.push(k);
    if (Array.isArray(j.type)) {
      const types = j.type as string[];
      const nonNull = types.filter((t) => t !== 'null');
      const parts = nonNull.map((t) => convBody({ ...j, type: t }));
      const u = parts.length === 1 ? parts[0]! : parts.length ? new UnionType(parts as [AnySchema, ...AnySchema[]]) : new NullType();
      return types.includes('null') && parts.length ? new NullableType(u) : u;
    }
    switch (j.type) {
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
        if (j.type === undefined && !j.properties && j.additionalProperties === undefined) return new AnyType();
        const props: Record<string, J> = j.properties ?? {};
        const required = new Set<string>(j.required ?? []);
        const ap = j.additionalProperties;
        if (!Object.keys(props).length && ap !== undefined && ap !== false) return new RecordType(conv(ap));
        const shape: Record<string, AnySchema> = {};
        for (const [k, p] of Object.entries(props)) shape[k] = required.has(k) ? conv(p) : new OptionalType(conv(p));
        const o = new ObjectType(shape);
        return ap === false ? o.strict() : o;
      }
    }
  };

  for (const [name, d] of Object.entries(rawDefs)) defs[name] = conv(d);
  const { $defs: _a, definitions: _b, ...body } = root;
  const top = conv(body);
  if (usesRoot) defs.__root = top;
  if (report.unsupported.includes('$ref') || Object.values(defs).some(() => false)) defs.__any = new AnyType();
  for (const n of [top, ...Object.values(defs)].flatMap((s) => [...s.refNames()])) if (!(n in defs)) defs[n] = new AnyType().describe(`Unknown reference ${n}.`);
  return new Bundle<T, []>(defs, usesRoot ? new RefType('__root') : top);
}
