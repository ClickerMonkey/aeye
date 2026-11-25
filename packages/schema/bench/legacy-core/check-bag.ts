import z from 'zod';

/**
 * The constraints a schema's checks add up to — the fields the JSON Schema
 * converter reads for strings, numbers, arrays and tuples.
 *
 * zod 4.1 kept these on `schema._zod.bag`, filled by each check as it was
 * attached. From zod 4.6 the bag stays empty for first-party checks and zod's
 * own converter folds `def.checks` instead (`aggregateChecks`, which zod does
 * not export). {@link checkBag} is that fold, so the converter reads the same
 * facts on either version.
 */
export interface CheckBag {
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  format?: string;
  patterns?: Set<RegExp>;
  contentEncoding?: string;
}

/** The value a numeric check carries, as a plain number (bigint bounds are converted). */
function numeric(value: number | bigint | Date): number {
  return typeof value === 'number' ? value : Number(value);
}

function narrowMin(bag: CheckBag, key: 'minimum' | 'exclusiveMinimum', value: number): void {
  const current = bag[key];
  if (current === undefined || value > current) bag[key] = value;
}

function narrowMax(bag: CheckBag, key: 'maximum' | 'exclusiveMaximum', value: number): void {
  const current = bag[key];
  if (current === undefined || value < current) bag[key] = value;
}

function addPattern(bag: CheckBag, pattern: RegExp): void {
  bag.patterns ??= new Set();
  bag.patterns.add(pattern);
}

/** A first-party check's definition, discriminated by `check`. */
type CheckDef = z.core.$ZodChecks['_zod']['def'];

/**
 * Every first-party check kind. Typed against zod's own union, so a kind zod
 * adds or renames fails to compile here rather than being skipped silently.
 */
const FIRST_PARTY: Readonly<Record<CheckDef['check'], true>> = {
  less_than: true, greater_than: true, multiple_of: true, number_format: true, bigint_format: true,
  max_size: true, min_size: true, size_equals: true, max_length: true, min_length: true,
  length_equals: true, string_format: true, property: true, mime_type: true, overwrite: true,
};

function isFirstPartyKind(kind: unknown): boolean {
  return typeof kind === 'string' && Object.hasOwn(FIRST_PARTY, kind);
}

/** A check zod's first-party union describes, so its `def` narrows by `check`. */
function isFirstParty<C extends z.core.$ZodCheck<never>>(check: C): check is C & z.core.$ZodChecks {
  return isFirstPartyKind(check._zod.def.check);
}

/** A format schema (`z.email()`, `z.int()`) — a schema that is also its own first check. */
function isFormatSchema(schema: z.core.$ZodType): schema is z.core.$ZodType & z.core.$ZodChecks {
  return schema._zod.traits.has('$ZodCheck') && isFirstPartyKind(Reflect.get(schema._zod.def, 'check'));
}

/** Folds one check into the bag. Kinds with no JSON Schema meaning are ignored. */
function applyCheck(bag: CheckBag, check: z.core.$ZodChecks): void {
  const def = check._zod.def;
  switch (def.check) {
    case 'greater_than':
      narrowMin(bag, def.inclusive ? 'minimum' : 'exclusiveMinimum', numeric(def.value));
      return;
    case 'less_than':
      narrowMax(bag, def.inclusive ? 'maximum' : 'exclusiveMaximum', numeric(def.value));
      return;
    case 'multiple_of':
      bag.multipleOf ??= numeric(def.value);
      return;
    case 'number_format': {
      bag.format = def.format;
      const [min, max] = z.core.util.NUMBER_FORMAT_RANGES[def.format];
      narrowMin(bag, 'minimum', min);
      narrowMax(bag, 'maximum', max);
      return;
    }
    case 'bigint_format': {
      bag.format = def.format;
      const [min, max] = z.core.util.BIGINT_FORMAT_RANGES[def.format];
      narrowMin(bag, 'minimum', Number(min));
      narrowMax(bag, 'maximum', Number(max));
      return;
    }
    case 'min_length':
    case 'min_size':
      narrowMin(bag, 'minimum', def.minimum);
      return;
    case 'max_length':
    case 'max_size':
      narrowMax(bag, 'maximum', def.maximum);
      return;
    case 'length_equals':
      narrowMin(bag, 'minimum', def.length);
      narrowMax(bag, 'maximum', def.length);
      return;
    case 'size_equals':
      narrowMin(bag, 'minimum', def.size);
      narrowMax(bag, 'maximum', def.size);
      return;
    case 'string_format':
      bag.format = def.format;
      if (def.pattern) addPattern(bag, def.pattern);
      if (def.format === 'base64' || def.format === 'base64url') bag.contentEncoding = def.format;
      return;
    default:
      return;
  }
}

/**
 * A schema's constraints, folded from its checks. A format schema (`z.email()`,
 * `z.int()`) is its own first check, as zod treats it; anything zod still puts
 * on `_zod.bag` (third-party `onattach` hooks) is merged in last.
 */
export function checkBag(schema: z.core.$ZodType): CheckBag {
  const bag: CheckBag = {};
  const internals = schema._zod;
  if (isFormatSchema(schema)) applyCheck(bag, schema);
  for (const check of internals.def.checks ?? []) if (isFirstParty(check)) applyCheck(bag, check);

  const legacy: Readonly<Record<string, unknown>> = internals.bag;
  if (typeof legacy.minimum === 'number') narrowMin(bag, 'minimum', legacy.minimum);
  if (typeof legacy.exclusiveMinimum === 'number') narrowMin(bag, 'exclusiveMinimum', legacy.exclusiveMinimum);
  if (typeof legacy.maximum === 'number') narrowMax(bag, 'maximum', legacy.maximum);
  if (typeof legacy.exclusiveMaximum === 'number') narrowMax(bag, 'exclusiveMaximum', legacy.exclusiveMaximum);
  if (typeof legacy.multipleOf === 'number') bag.multipleOf ??= legacy.multipleOf;
  if (typeof legacy.format === 'string') bag.format ??= legacy.format;
  if (typeof legacy.contentEncoding === 'string') bag.contentEncoding ??= legacy.contentEncoding;
  if (legacy.patterns instanceof Set) {
    for (const pattern of legacy.patterns) if (pattern instanceof RegExp) addPattern(bag, pattern);
  }
  return bag;
}
