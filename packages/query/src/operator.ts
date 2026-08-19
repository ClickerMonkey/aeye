/**
 * REGISTERED OPERATORS — `&&`, `<->`, `@>`: a name whose SQL a DECLARATION
 * supplies, per dialect.
 *
 * A domain's predicates were already reachable as ordinary scalar FUNCTIONS
 * (`ST_Contains(a, b)` registers and emits today, with no library change). What
 * a function declaration cannot express is the OTHER half of every real SQL
 * domain: the infix operators, which have no call form at all — `a && b` is not
 * `&&(a, b)` in any dialect — and whose SQL differs by dialect, which
 * `FunctionDef.sql` (a NAME, never a template) has no way to say.
 *
 * ONE NEW EXPR KIND, NOT N REGISTERED EXPR CLASSES. `ExprKind` gains exactly one
 * member, once, at this package's own hand (`operator`), and the operator
 * VOCABULARY is what a third party opens — precisely the relationship
 * `function-call` already has to `registerFunction`. The alternative,
 * `defineExpr`, is parse DISPATCH for a whole `ExprDef.kind`: registering one
 * re-points every program's parse in that registry, and it asks a declarer to
 * implement `resolve` / `validateWalk` / `evaluate` / `cost` / `selectivity` /
 * `toSQL` / `toJSON` / `clone` / `toCode` / `SHAPE` — ten members for `a && b`,
 * where a function author writes one JSON object.
 *
 * THE DECLARATION IS PURE JSON, so it persists, crosses the wire and reaches a
 * model; the `run` half is code, registered separately
 * (`registry.registerOperatorRun`), exactly as `FunctionRun` sits beside
 * `FunctionDef`. That split is not symmetry — it is what lets a consumer store a
 * catalog of operators in a database and replay it at boot.
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY, each because nothing would read it:
 *
 *  - **`precedence`.** Every emit template ships PARENTHESIZED (checked at
 *    registration, see {@link compileEmit}), and there is no text parser in this
 *    package — the authoring surface is JSON, so an operator is function-shaped
 *    on the wire and precedence never arises at parse. That leaves `toCode()`,
 *    which renders the WIRE shape (`&&(left: …, right: …)`) rather than infix,
 *    because rendering infix needs the declared operand ORDER and `toCode` has
 *    no registry to look it up in — an infix rendering in AUTHORED order would
 *    silently swap `<->`'s operands. With no infix rendering anywhere, a
 *    `precedence` number has no reader at all. It comes back with a text DSL, if
 *    one ever arrives.
 *  - **`indexed`.** The cost model's {@link import('./cost').IndexProbe} means
 *    "this column is bound to N POINT values", which is what an index PREFIX
 *    reduction is computed from. A bounding-box overlap is not that, so
 *    crediting it would claim a reduction that does not apply. Declare
 *    {@link OperatorDef.selectivity} instead, which the same model reads and
 *    which says the true thing.
 *  - **`changes`.** `QueryReferences` enumerates the FUNCTIONS a query invokes
 *    and `changeInterval` folds their `changes`; there is no operator channel,
 *    so a declared `changes` would be silently ignored. Adding one is a change
 *    to a public result shape and belongs with the in-memory work, not here.
 */
import type { Cost } from './cost';
import { ZERO_COST } from './cost';
import { didYouMean } from './aids';
import type { FieldType } from './field-type';
import { validateNamedCall, type CallVocabulary, type DeclaredArg } from './function';
import { QueryTypeError, type Problems } from './problem';
import type { Registry } from './registry';
import type { ResolvedType } from './resolved-type';
import type { FieldTypeDef } from './schema';
import { isSlot, scanTemplate, templateSlotNames, type Template } from './sql-template';

/**
 * Allowed charset for a registered operator NAME — the SQL operator punctuation,
 * and NOTHING that could be read as an identifier.
 *
 * This is the set PostgreSQL itself allows in `CREATE OPERATOR`
 * (`+ - * / < > = ~ ! @ # % ^ & | ` ?`), which is the honest answer to "what will
 * a dialect actually accept": every engine with user-definable operators draws
 * from that punctuation, and no engine accepts a bare word as an infix operator
 * without quoting rules of its own. The 63-character cap is Postgres's
 * `NAMEDATALEN - 1`; a longer name could not be created there in the first place.
 *
 * IT IS DISJOINT FROM `FUNCTION_NAME_PATTERN` (`^[A-Za-z_][A-Za-z0-9_.]*$`), and
 * that is the point rather than a side effect. The two registries are separate
 * maps looked up by different expr kinds, so overlapping charsets would let one
 * name mean two callables — and a model reading `describeEngine` would see
 * `overlaps` in the operators block and in the functions block with no way to
 * tell which `kind` reaches which. A WORD operator (`OVERLAPS`, `IS DISTINCT
 * FROM`) is therefore spelled one of the two ways that already work: as a
 * function, or as the literal text of an emit template under a punctuation name.
 *
 * The COMMENT sequences are refused separately ({@link refuseCommentSequence}) —
 * they are drawn from this very charset, and `--` is not an operator anywhere,
 * it is the start of a line comment.
 */
export const OPERATOR_NAME_PATTERN = /^[+\-*/<>=~!@#%^&|`?]{1,63}$/;

/**
 * Sequences that START A COMMENT in SQL, refused inside an operator name and
 * inside an emit template's literal text.
 *
 * `--` and `/*` are made of the same punctuation an operator name is drawn from,
 * so the name charset cannot exclude them: `&&--` matches
 * {@link OPERATOR_NAME_PATTERN} exactly. Emitted, it comments out the REST OF THE
 * QUERY — every clause after it, including the closing parenthesis of whatever
 * wrapped it. That is not injection (the declarer wrote it) but it is a
 * guaranteed-broken query whose failure points nowhere near the declaration, and
 * refusing it costs a declarer nothing: a genuine minus-then-negate is written
 * `{left} - -{right}`, with the space that SQL requires anyway.
 *
 * Postgres applies the same rule to `CREATE OPERATOR` for the same reason.
 */
const COMMENT_SEQUENCES: readonly string[] = ['--', '/*', '*/'];

/** The statement terminator, refused in an emit template — see {@link compileEmit}. */
const STATEMENT_TERMINATOR = ';';

/** The SQL string-literal quote, whose occurrences an emit template must BALANCE. */
const STRING_QUOTE = "'";

/**
 * One operand a registered operator declares — the same relationship
 * `FunctionParamDef` has to a function, and deliberately the same vocabulary: an
 * operand's `type` is an ordinary {@link FieldTypeDef}, so it is validated,
 * described, meet-checked and round-tripped by machinery that already exists.
 *
 * There is no `optional`. An operator's arity is FIXED by the SQL it emits — the
 * template names every operand, and a template that could drop one would emit a
 * dangling `&&` — so "supplied or not" is not a question a declaration gets to
 * leave open. That is the one place this shape deliberately differs from
 * `FunctionParamDef`.
 */
export interface OperatorOperandDef {
  /** The operand's name — the key a call writes in `args`, and the template's `{slot}`. */
  readonly name: string;
  /**
   * The operand's declared type, or `'any'` to accept every field type. `'any'`
   * declares nothing to check a call against AND nothing to type a bare bind
   * param from, so it is a real widening rather than a shorthand.
   */
  readonly type: FieldTypeDef | 'any';
}

/**
 * A registered operator's DECLARATION — pure JSON, persistable, replayable, and
 * the thing a model is shown.
 */
export interface OperatorDef {
  /**
   * The operator, spelled as SQL spells it (`&&`, `<->`, `@>`). Held to
   * {@link OPERATOR_NAME_PATTERN}; it is the registry key AND the token a model
   * writes in `{ kind: 'operator', op: '&&' }`, and it renders VERBATIM
   * everywhere either of them reads it.
   */
  readonly name: string;
  /** The operands, in declared order. At least one; an operand-less operator is a constant, i.e. a function. */
  readonly operands: readonly OperatorOperandDef[];
  /**
   * The type the operator PRODUCES. Concrete — never `'inferred'`, unlike
   * `FunctionDef.output`: an operator's whole reason to exist is that its
   * meaning is not derivable from its operands (`<->` takes two geometries and
   * yields a NUMBER), so inferring it from the first argument would be wrong far
   * more often than right.
   */
  readonly output: FieldTypeDef;
  /**
   * What the operator MEANS, for a model. REQUIRED, and deliberately stricter
   * than `FunctionDef.instructions`, which is optional. Measured: an
   * undocumented registered item renders as a bare signature beside documented
   * siblings, and a model choosing among four PostGIS predicates from that
   * listing is guessing. The expensive failure is not the ~25 tokens of the
   * line, it is the validate-fail retry that carries the WHOLE schema a second
   * time.
   */
  readonly instructions: string;
  /**
   * Worked examples as RAW JSON strings (the `FunctionDef.examples` contract),
   * rendered under the signature by `describeOperators` and round-tripped by
   * {@link QueryOperator.toJSON}.
   */
  readonly examples?: readonly string[];
  /**
   * Per-dialect emission, keyed by `Dialect.name`. `{operandName}` slots are
   * replaced by that operand's already-emitted SQL fragment.
   *
   * A DIALECT WITH NO ENTRY IS UNSUPPORTED, and emitting for it is REFUSED
   * rather than degraded — see `OperatorExpr.toSQL`. The base dialect degrades
   * silently for BUILTINS whose semantics this package owns and documents
   * (`dateAdd` → the input date unchanged, `arrayContains` → `(1 = 0)`); that is
   * portable-SQL policy for a function whose degrade is written down and tested.
   * A third party cannot document a degrade this package never sees, and `&&`
   * degrading to `(1 = 0)` returns ZERO ROWS for a query the caller believed
   * ran.
   */
  readonly emit: Readonly<Record<string, string>>;
  /**
   * The fraction of rows this operator keeps as a WHERE predicate — the same
   * declared-fact idiom as `FunctionDef.cost`. Defaults to 1 (keeps everything),
   * which is what an undeclared predicate already costs.
   */
  readonly selectivity?: number;
  /** Intrinsic per-call cost beyond the operands' own (default none). */
  readonly cost?: Cost;
  /**
   * Who declared it — surfaced when a SECOND declarer claims the same name, so
   * the refusal names the incumbent instead of just the collision.
   */
  readonly declaredBy?: string;
}

/**
 * Every key a declaration may carry. An unknown one is REFUSED rather than
 * ignored, for the reason `FieldTypeRefinementDef`'s equivalent list is: a key
 * that is silently dropped is a fact its declarer believes is in force and is
 * not — and TypeScript's excess-property check only fires on an INLINE literal,
 * so `registerOperator(JSON.parse(stored))`, which is the road this shape is
 * DESIGNED for, would not catch it.
 */
const DECLARATION_KEYS = [
  'name',
  'operands',
  'output',
  'instructions',
  'examples',
  'emit',
  'selectivity',
  'cost',
  'declaredBy',
] as const;

/** {@link DECLARATION_KEYS} as a membership test over an arbitrary key string. */
const DECLARATION_KEY_SET: ReadonlySet<string> = new Set<string>(DECLARATION_KEYS);

/**
 * Keys §6 of the design plan specified that this release deliberately does NOT
 * ship, so their refusal says WHY instead of "unknown" — see the module docs.
 *
 * A `Map`, not an object literal: it is indexed by an ARBITRARY key taken off a
 * caller's declaration, and `{}['toString']` is a function.
 */
const DECLINED_KEYS: ReadonlyMap<string, string> = new Map([
  ['precedence', 'emit templates ship PARENTHESIZED and `toCode()` renders the wire shape, so nothing reads a precedence'],
  ['indexed', 'an index probe means "bound to N POINT values"; declare `selectivity` instead'],
  ['changes', '`QueryReferences` has no operator channel, so a declared value would be silently ignored'],
]);

type Assert<T extends true> = T;
/** `DECLARATION_KEYS` covers the declaration exactly — neither list may drift. */
type _DeclarationKeysAreExact = Assert<
  Exclude<keyof OperatorDef, (typeof DECLARATION_KEYS)[number]> extends never
    ? (typeof DECLARATION_KEYS)[number] extends keyof OperatorDef ? true : false
    : false
>;

/** Throw a declaration-defect `QueryTypeError` for operator `name`. */
function refuse(name: string, path: (string | number)[], message: string): never {
  throw new QueryTypeError({
    path: ['registerOperator', name, ...path],
    code: 'operator.bad-declaration',
    severity: 'error',
    message,
  });
}

/**
 * A COMPILED operator — the declaration plus its operand / output types parsed
 * and its emit templates split.
 *
 * Built only by {@link QueryOperator.compile} (via `Registry.registerOperator`),
 * so an instance in hand has already passed every registration-time check.
 *
 * COMPILED EAGERLY, unlike `QueryFunction`, which the engine builds lazily on
 * first call. The difference is deliberate and it is the step-2 lesson applied:
 * a defect found at the CALL has no declaration to attribute it to, and an emit
 * template is only ever wrong at the declaration. It costs one ordering rule —
 * every field-type refinement an operand names must be registered first — which
 * is the same rule a Type already lives under, and it is enforced with the
 * message that road already has (`field-type.unknown-refinement`). Compiling
 * does NOT freeze the refinement vocabulary: the operand types parse through the
 * registry's unflagged road, so a refinement may still be registered afterwards.
 */
export class QueryOperator {
  private constructor(
    /** The operator as SQL spells it — the registry key and the wire `op`. */
    readonly name: string,
    /** The declared operands, in order, each type parsed (`undefined` for `'any'`). */
    readonly operands: readonly DeclaredArg[],
    /** The type this operator produces. */
    readonly output: FieldType,
    /** What it means, for a model. */
    readonly instructions: string,
    /** Worked examples as raw JSON strings, or `undefined`. */
    readonly examples: readonly string[] | undefined,
    /** Per dialect name, the compiled emit template. */
    private readonly emits: ReadonlyMap<string, Template>,
    /** The declared WHERE selectivity (1 when undeclared). */
    readonly selectivity: number,
    /** The declared intrinsic cost (zero when undeclared). */
    readonly cost: Cost,
    /** Who declared it, when they said. */
    readonly declaredBy: string | undefined,
    /** The declaration verbatim, for {@link toJSON} — a declaration round-trips as itself. */
    private readonly def: OperatorDef,
  ) {
    // Built in the BODY, not as a field initializer: under `useDefineForClassFields`
    // (which `target: es2024` implies) a field initializer runs BEFORE the
    // parameter properties are assigned, so an initializer reading `this.operands`
    // would see `undefined`.
    this.operandsByName = new Map(operands.map((o) => [o.name, o]));
  }

  /** The dialect names this operator declares SQL for, in declaration order. */
  dialects(): string[] {
    return [...this.emits.keys()];
  }

  /**
   * The declared operand named `name`, or `undefined`.
   *
   * Read at EMIT as well as at validate: an operand's declared type is what lets
   * a document operand bind through its type's own `cast` template rather than
   * through the dialect's default json cast (see `OperatorExpr.toSQL`). A map
   * rather than a scan because an emit walks every slot of every operator
   * occurrence in a statement.
   */
  operand(name: string): DeclaredArg | undefined {
    return this.operandsByName.get(name);
  }

  /** {@link operands} keyed by name, built once in the constructor (see {@link operand}). */
  private readonly operandsByName: ReadonlyMap<string, DeclaredArg>;

  /**
   * Validate a call's named operands — the same three checks a function call is
   * held to (`operator.missing-arg` / `.unknown-arg` / `.arg-type`), through the
   * shared {@link validateNamedCall} rather than a second copy of them.
   *
   * NO INTERACTION WITH A TYPE'S DECLARED `compare`, and that is a decision
   * rather than an omission. `compare` says which arms of the CLOSED builtin
   * comparison grammar (`= <> < <= > >=`, LIKE, and through the shared gate
   * BETWEEN / IN / containment) mean anything for a type. An operator is not one
   * of those nine: it declares its own operands and its own meaning, so a type
   * declaring `equality: false` is exactly the type an operator is FOR —
   * `Geometry` refuses `=` because comparing two geometries for equality is
   * meaningless, and `&&` is what a caller reaches for instead. Gating operators
   * on `compare` would delete the mechanism that makes an honest declaration
   * usable at all.
   */
  validateCall(
    namedArgs: ReadonlyMap<string, ResolvedType>,
    p: Problems,
    paramArgs: ReadonlySet<string>,
  ): void {
    validateNamedCall(OPERATOR_CALL_WORDS, this.name, this.operands, namedArgs, p, paramArgs);
  }

  /** The compiled emit template for `dialect`, or `undefined` when it declares none. */
  emitFor(dialect: string): Template | undefined {
    return this.emits.get(dialect);
  }

  /**
   * The declaration this was compiled from — byte-identical, so a consumer that
   * persisted a catalog reads back exactly what it wrote. (Unlike
   * `QueryFunction.toJSON`, which RE-EMITS from parsed parts; there is nothing
   * to gain here from re-deriving a def the registry already holds, and
   * re-deriving is how a round-trip acquires drift.)
   */
  toJSON(): OperatorDef {
    return this.def;
  }

  /**
   * Validate and compile a declaration. Every check refuses rather than warns:
   * an operator that registered half-broken would be wrong in every query that
   * ever named it, and the SQL half of it would be wrong at a point with no
   * declaration in sight.
   */
  static compile(
    def: OperatorDef,
    registry: Registry,
    /**
     * How an operand's declared type becomes a `FieldType`. Supplied by the
     * registry rather than taken off it, because compiling must NOT freeze the
     * refinement vocabulary — a registry that refused every later
     * `registerFieldType` merely because an operator was declared would make the
     * two registrations order-coupled for no reason.
     */
    parseFieldType: (json: FieldTypeDef) => FieldType,
  ): QueryOperator {
    const { name } = def;
    if (typeof name !== 'string' || !OPERATOR_NAME_PATTERN.test(name)) {
      refuse(
        String(name),
        [],
        `Operator name ${JSON.stringify(name)} must match ${OPERATOR_NAME_PATTERN.source} — the SQL ` +
          'operator punctuation, and nothing an identifier could be. A WORD operator is spelled either as ' +
          'a function (`registerFunction`) or as the literal text of an `emit` template under a ' +
          'punctuation name; the two name spaces are kept disjoint so one spelling can never mean two ' +
          'callables.',
      );
    }
    refuseCommentSequence(name, [], name, 'An operator name');
    const existing = registry.operator(name);
    if (existing) {
      refuse(
        name,
        [],
        `\`${name}\` is already registered as an operator` +
          `${existing.declaredBy !== undefined ? ` by ${existing.declaredBy}` : ''}. The second ` +
          'declaration is refused rather than allowed to shadow the first: a stored query naming it would ' +
          'silently change meaning depending on which package registered last.',
      );
    }
    for (const key of Object.keys(def)) {
      if (DECLARATION_KEY_SET.has(key)) continue;
      const declined = DECLINED_KEYS.get(key);
      refuse(
        name,
        [key],
        `Unknown declaration key \`${key}\`.` +
          `${declined !== undefined
            ? ` It is deliberately not declarable: ${declined}.`
            : didYouMean(key, [...DECLARATION_KEYS])} ` +
          `A declaration carries only: ${DECLARATION_KEYS.join(', ')}.`,
      );
    }
    if (typeof def.instructions !== 'string' || def.instructions.trim() === '') {
      refuse(
        name,
        ['instructions'],
        '`instructions` is required and must be non-empty. An undocumented operator renders as a bare ' +
          'signature beside documented siblings, and a model choosing among them guesses — which costs a ' +
          'whole validate-fail retry carrying the entire schema.',
      );
    }
    if (def.selectivity !== undefined && (!Number.isFinite(def.selectivity) || def.selectivity < 0 || def.selectivity > 1)) {
      refuse(
        name,
        ['selectivity'],
        `\`selectivity\` is the FRACTION of rows this operator keeps, so it must be between 0 and 1; got ` +
          `${JSON.stringify(def.selectivity)}.`,
      );
    }

    const operands = compileOperands(name, def.operands, parseFieldType);
    let output: FieldType;
    try {
      output = parseFieldType(def.output);
    } catch (err) {
      refuse(name, ['output'], `\`output\` is not a valid field type: ${err instanceof Error ? err.message : String(err)}`);
    }

    const emits = compileEmit(name, def.emit, operands.map((o) => o.name));

    return new QueryOperator(
      name,
      operands,
      output,
      def.instructions,
      def.examples,
      emits,
      def.selectivity ?? DEFAULT_SELECTIVITY,
      def.cost ?? ZERO_COST,
      def.declaredBy,
      def);
  }
}

/** The words an OPERATOR call's diagnostics use (see {@link CallVocabulary}). */
const OPERATOR_CALL_WORDS: CallVocabulary = {
  noun: 'Operator',
  supplied: 'Operand',
  declared: 'operand',
  code: 'operator',
};

/**
 * What an operator keeps when it declares nothing — everything. The neutral
 * element of the cost model's multiplication, so an undeclared operator costs
 * exactly what an undeclared predicate already did.
 */
const DEFAULT_SELECTIVITY = 1;

/** Parse the declared operands, refusing a shape that could not be called. */
function compileOperands(
  name: string,
  declared: readonly OperatorOperandDef[] | undefined,
  parseFieldType: (json: FieldTypeDef) => FieldType,
): DeclaredArg[] {
  if (!Array.isArray(declared) || declared.length === 0) {
    refuse(
      name,
      ['operands'],
      '`operands` must be a non-empty array of `{ name, type }`. An operator with no operands produces ' +
        'the same value for every row, which is a zero-argument FUNCTION — register it with ' +
        '`registerFunction`, where a call form already exists.',
    );
  }
  const operands: DeclaredArg[] = [];
  const seen = new Set<string>();
  for (const [index, operand] of declared.entries()) {
    if (operand === null || typeof operand !== 'object' || typeof operand.name !== 'string') {
      refuse(name, ['operands', index], 'Each operand must be declared as `{ name, type }`.');
    }
    // An operand name is a TEMPLATE SLOT and a key a model writes in `args`, so
    // it is held to the same charset a refinement's own options are — and to the
    // same rule for the same reason: `{a-b}` in a template is unreadable, and a
    // name that needs quoting in JSON is a name a model will get wrong.
    if (!OPERAND_NAME_PATTERN.test(operand.name)) {
      refuse(
        name,
        ['operands', index, 'name'],
        `Operand name ${JSON.stringify(operand.name)} must match ${OPERAND_NAME_PATTERN.source} — it is a ` +
          'template slot name and a key a model writes in `args`.',
      );
    }
    if (seen.has(operand.name)) {
      refuse(
        name,
        ['operands', index, 'name'],
        `Operand \`${operand.name}\` is declared twice. Two operands of one name are one template slot ` +
          'and one `args` key, so the second could never be supplied or emitted.',
      );
    }
    seen.add(operand.name);
    if (operand.type === 'any') {
      operands.push({ name: operand.name, fieldType: undefined });
      continue;
    }
    try {
      operands.push({ name: operand.name, fieldType: parseFieldType(operand.type) });
    } catch (err) {
      refuse(
        name,
        ['operands', index, 'type'],
        `Operand \`${operand.name}\` does not declare a valid field type: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return operands;
}

/**
 * Allowed charset for an OPERAND name — an identifier, because it is a JSON key
 * a model writes and a `{slot}` a template reads. Deliberately the refinement
 * option rule (`REFINEMENT_NAME_PATTERN`) restated as a local constant rather
 * than imported: the two guard different vocabularies that happen to agree
 * today, and coupling them would make a change to one silently change the other.
 */
const OPERAND_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Compile each dialect's emit template.
 *
 * WHAT IS AND IS NOT GUARDED HERE, stated plainly. A template's SLOTS are filled
 * with already-emitted `SqlText` fragments — a bound parameter, a quoted
 * identifier — never with author values, so unlike a refinement's `sql` / `cast`
 * there is no VALUE injection surface to close. What is left is the template
 * BODY, which the declarer wrote; this is a NAME-AND-SHAPE gate on it, not a
 * sandbox. A consumer registering an operator holds real library objects and can
 * reach around any check here; what is shut is the accidental class — a
 * declaration doing ordinary work that emits something nobody would have chosen.
 *
 * Five rules, each with its own failure it prevents:
 *
 *  1. **Every slot names a declared operand** (with a `didYouMean`). A slot that
 *     named nothing would otherwise emit `{lft}` into SQL verbatim.
 *  2. **Every declared operand appears at least once.** A dropped operand is an
 *     argument the query supplied, validation type-checked, and emission
 *     discarded — the same defect a `cast` template that never names `{value}`
 *     has, and refused in the same place.
 *  3. **The template is PARENTHESIZED.** This is what makes a `precedence`
 *     declaration unnecessary rather than merely unread: a parenthesized
 *     fragment composes correctly inside ANY surrounding expression, so no
 *     declaration can be wrong about binding. A function-shaped emission (a
 *     dialect with no infix form spelling `&&` as `ST_Intersects(a, b)`) is
 *     already atomic, and is written with the redundant pair —
 *     `(ST_Intersects({left}, {right}))` — because one rule with no exception is
 *     worth more than the character it costs.
 *  4. **No comment sequence and no statement terminator.** Both silently swallow
 *     the rest of the emitted query; see {@link COMMENT_SEQUENCES}.
 *  5. **Balanced parentheses, and an EVEN number of single quotes.** An
 *     unbalanced paren or an unterminated string literal is a syntax error a
 *     hundred lines from the declaration that caused it.
 */
function compileEmit(
  name: string,
  declared: Readonly<Record<string, string>> | undefined,
  operandNames: readonly string[],
): Map<string, Template> {
  const entries = Object.entries(declared ?? {});
  if (entries.length === 0) {
    // The example is built from THIS declaration's own operand names — they are
    // compiled before the emit templates, so there is always at least one, and a
    // worked example in the declarer's own vocabulary beats a generic one.
    refuse(
      name,
      ['emit'],
      '`emit` must declare SQL for at least one dialect, keyed by `Dialect.name` (e.g. ' +
        `\`{ postgres: '({${operandNames.join(`} ${name} {`)}})' }\`). ` +
        'An operator with no emission can never reach a database.',
    );
  }
  const known = new Set(operandNames);
  const compiled = new Map<string, Template>();
  for (const [dialect, template] of entries) {
    const path = ['emit', dialect];
    if (typeof template !== 'string' || template.trim() === '') {
      refuse(name, path, `Emit template for dialect \`${dialect}\` must be a non-empty string.`);
    }
    refuseCommentSequence(name, path, template, 'An emit template');
    if (template.includes(STATEMENT_TERMINATOR)) {
      refuse(
        name,
        path,
        `Emit template ${JSON.stringify(template)} contains \`${STATEMENT_TERMINATOR}\`. A template is a ` +
          'FRAGMENT spliced into a larger statement, so a terminator inside it ends that statement early ' +
          'and leaves whatever followed as a second one.',
      );
    }
    if (count(template, STRING_QUOTE) % 2 !== 0) {
      refuse(
        name,
        path,
        `Emit template ${JSON.stringify(template)} has an odd number of \`'\` quotes, so it opens a string ` +
          'literal it never closes — every character of the query after it would be read as part of that ' +
          'string.',
      );
    }
    if (!parenthesized(template)) {
      refuse(
        name,
        path,
        `Emit template ${JSON.stringify(template)} must be wrapped in its own balanced parentheses — ` +
          `write \`(${template})\`. A parenthesized fragment composes correctly inside ANY surrounding ` +
          'expression, which is what makes a declared precedence unnecessary: with it, no declaration can ' +
          'be wrong about how the operator binds.',
      );
    }
    const parts = scanTemplate(template, (slot) => {
      if (known.has(slot)) return { slot };
      refuse(
        name,
        path,
        `Emit template ${JSON.stringify(template)} names \`{${slot}}\`, which is not a declared operand of ` +
          `\`${name}\`.${didYouMean(slot, operandNames)} (declared: ${operandNames.join(', ')}).`,
      );
    });
    // A RESIDUE check, because the scanner only sees a CLOSED `{…}`: an unclosed
    // or nested brace never reaches the resolver above and would sail through as
    // literal text, straight into emitted SQL — `({left} && {right} {oops)`
    // registered clean and emitted `… && $1 {oops)`, and `(x{q{a}})` emitted a
    // literal `{q`. That is exactly what the unknown-slot refusal exists to
    // prevent, reached by the one road it cannot see. A brace in emitted SQL is
    // never something a declarer meant, so the whole character is refused rather
    // than an escape being invented for it.
    for (const part of parts) {
      if (isSlot(part) || !part.text.includes('{')) continue;
      const attempted = unclosedSlotName(part.text);
      refuse(
        name,
        path,
        `Emit template ${JSON.stringify(template)} carries a \`{\` that opens no slot — a slot is a ` +
          `CLOSED \`{operandName}\`, so this one would be spliced into the emitted SQL verbatim.` +
          `${didYouMean(attempted, operandNames)} (declared: ${operandNames.join(', ')}).`,
      );
    }
    const placed = templateSlotNames(parts);
    const missing = operandNames.filter((operand) => !placed.has(operand));
    if (missing.length > 0) {
      refuse(
        name,
        path,
        `Emit template ${JSON.stringify(template)} never names ${missing.map((m) => `\`{${m}}\``).join(', ')}, ` +
          'so that operand would be validated and then discarded — the query would supply an expression ' +
          'the SQL never mentions. Every declared operand must appear in every dialect it is emitted for.',
      );
    }
    compiled.set(dialect, parts);
  }
  return compiled;
}

/** Refuse `text` if it carries a SQL comment opener — see {@link COMMENT_SEQUENCES}. */
function refuseCommentSequence(
  name: string,
  path: (string | number)[],
  text: string,
  subject: string,
): void {
  for (const sequence of COMMENT_SEQUENCES) {
    if (!text.includes(sequence)) continue;
    refuse(
      name,
      path,
      `${subject} may not contain \`${sequence}\`: it opens (or closes) a SQL COMMENT, so everything after ` +
        `it in the emitted query — including whatever wrapped this fragment — is silently discarded. ` +
        `${sequence === '--' ? 'A minus followed by a negation is written `- -`, with the space SQL requires anyway.' : 'Write the fragment without a comment.'}`,
    );
  }
}

/**
 * The identifier a stray `{` looks like it was reaching for — the run of
 * name characters after the first unclosed brace — so the refusal can suggest a
 * real operand instead of only naming the character. `''` when there is nothing
 * name-shaped after it, which `didYouMean` answers for with no suggestion.
 */
function unclosedSlotName(text: string): string {
  /* v8 ignore next -- the caller only asks about text containing `{`, and group 1 always participates, so both fallbacks are type narrowings rather than cases */
  return /\{([A-Za-z0-9_]*)/.exec(text)?.[1] ?? '';
}

/** How many times `needle` occurs in `text`. */
function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * Whether `template` is wrapped in its OWN balanced parentheses — it opens with
 * `(`, closes with `)`, and that pair is the same one.
 *
 * The depth walk is what distinguishes `({a} && {b})` from `({a}) && ({b})`:
 * both start with `(` and end with `)`, and only the first is one atom. Parens
 * inside a string literal are not excluded, because a template is refused above
 * unless its quotes are balanced and this is a shape gate rather than a parser —
 * the failure it would miss is a declarer writing `'('` inside a literal, which
 * makes the check STRICTER, never looser.
 *
 * INDEXED BY UTF-16 CODE UNIT, deliberately, because the position is compared
 * against `trimmed.length` — which is also UTF-16. Iterating `[...trimmed]`
 * instead yields CODE-POINT indices, and the two disagree the moment a template
 * contains an astral character: `'({left} && {right} 𝕏)'` put the final `)` at
 * code-point index 20 against a length of 22, so the "closed early" return fired
 * and a legally-wrapped template was refused — with a message about parentheses,
 * which is the wrong thing to point a declarer at. A surrogate half is never `(`
 * or `)`, so a code-unit walk cannot mis-read one.
 *
 * There is deliberately NO `depth < 0` guard: the leading `(` puts the walk at
 * depth 1, and the "closed early" return below fires the first time it comes
 * back to 0, so depth can never reach -1. A guard for it would be a branch no
 * input can take — and an unreachable branch in a safety check is worse than
 * none, because it reads as a case someone considered and handled.
 */
function parenthesized(template: string): boolean {
  const trimmed = template.trim();
  if (!trimmed.startsWith('(') || !trimmed.endsWith(')')) return false;
  let depth = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    // Back to depth 0 before the end ⇒ the opening paren closed early, so the
    // trailing `)` belongs to a different pair.
    if (depth === 0 && index < trimmed.length - 1) return false;
  }
  return depth === 0;
}
