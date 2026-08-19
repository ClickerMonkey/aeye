/**
 * A3 — types that were reachable only STRUCTURALLY are now exported by name.
 *
 * `RelationBacking` in particular is the type a consumer needs to write the
 * composite-FK / custom-`ON` escape hatch the package documents; without an
 * export, every call site had to re-declare a structural twin that can drift
 * from the real one. This test is a compile-time assertion in test's clothing:
 * if an export is dropped, `tsc` fails on the import, not on an expectation.
 *
 * CAVEAT (pre-existing): `tsconfig.json` EXCLUDES every `.test.ts` file, so
 * `npm run typecheck` never sees this file and vitest only transpiles it — the
 * "compile-time assertion" is currently only as strong as someone compiling the
 * tests deliberately, and several literals below (`DefaultOrder`,
 * `DefaultOrderTerm`, `RelationOn`) do NOT match their real shapes. What the
 * test still proves at RUNTIME is that the named bindings resolve through the
 * barrel; a dropped TYPE export is caught only by the import failing to resolve.
 *
 * 0.6.1 adds the two names A3 missed: `SqlParamValue` (the value bound to a
 * `toSQL` param — a scalar, or the keyed object a relation identity binds as)
 * and `DrillValue` (the same widening on `drillDownInto`'s params), which the
 * consuming product was spelling structurally as
 * `NonNullable<ToSqlOptions['params']>[string]`.
 */
import { describe, it, expect } from 'vitest';
import * as pkg from '../index';
import type {
  RelationBacking,
  RelationOn,
  RelationOnPair,
  SearchBacking,
  SemanticBacking,
  DefaultOrder,
  DefaultOrderTerm,
  DefaultOrderDir,
  DefaultOrderScope,
  RelationKeyPair,
  RelationResolved,
  SqlParamValue,
  DrillValue,
  OperatorDef,
  OperatorOperandDef,
  Template,
  TemplatePart,
  DeclaredArg,
  ResolvedParam,
  CallVocabulary,
} from '../index';
import { IndexPart, Index, renameSource, aliasedDigest, relationKeyColumns, relationOf, valueFieldType } from '../index';
import { checkFieldType, checkOperator, checkLatticeLaws } from '../conformance';
import { TextFieldType } from '../field-types/index';

describe('A3 — the public barrel', () => {
  it('exports the previously structural-only TYPES (compile-time)', () => {
    // Each alias is USED, so an unexported name is a type error above.
    const keys: RelationBacking = { keys: [{ local: 'a', foreign: 'b' }] };
    const on: RelationOn = { sql: () => undefined };
    const pair: RelationOnPair = { localField: 'a', foreignField: 'b' };
    const search: SearchBacking = { vectorField: 'tsv' };
    const semantic: SemanticBacking = { vectorField: 'embedding' };
    const dir: DefaultOrderDir = { dir: 'asc' };
    const term: DefaultOrderTerm = { ...dir, expr: () => undefined };
    const scope: DefaultOrderScope = 'result';
    const order: DefaultOrder = { terms: [term], applyTo: scope };
    const keyPair: RelationKeyPair = { local: 'a', foreign: 'b', keyType: new TextFieldType() };
    const resolved: RelationResolved = {
      source: 's', field: 'f', keyField: 'a', keyType: keyPair.keyType,
      to: 't', count: 1, belongsTo: true, keys: [keyPair],
    };
    // 0.6.1: the two A3 missed. Both widened for a RELATION IDENTITY — a keyed
    // object where a bare scalar used to be the only shape.
    const sqlParam: SqlParamValue = { tenantId: 3, userId: 1 };
    const drill: DrillValue = { id: 'userB' };
    expect([keys, on, pair, search, semantic, order, resolved, sqlParam, drill].every((v) => v !== undefined)).toBe(true);
  });

  it('exports the previously unexported VALUES', () => {
    expect(typeof IndexPart).toBe('function');
    expect(typeof renameSource).toBe('function');
    expect(typeof aliasedDigest).toBe('function');
    expect(typeof relationKeyColumns).toBe('function');
    expect(typeof relationOf).toBe('function');
    expect(typeof valueFieldType).toBe('function');
    // And they are the same bindings the barrel re-exports.
    expect(pkg.IndexPart).toBe(IndexPart);
    expect(pkg.Index).toBe(Index);
  });

  it('exports the CONFORMANCE surface, which `@aeye/query/conformance` also names', () => {
    // The subpath resolves to THIS bundle rather than to one of its own, so the
    // barrel is where the bindings live and this is the test that proves the
    // subpath has something to resolve TO. (A second SELF-CONTAINED bundle is
    // disqualifying — measured: its own `ArrayFieldType` makes every cross-copy
    // `instanceof` false, and the harness then reports a spurious `top-identity`
    // violation for a correct type. See the note on the re-export in `index.ts`,
    // and `scripts/check-dist.mjs`, which exercises the built artifact this test
    // cannot see.)
    for (const name of ['checkFieldType', 'checkOperator', 'checkLatticeLaws', 'topsByKind'] as const) {
      expect(typeof pkg[name]).toBe('function');
    }
    expect(Array.isArray(pkg.DEFAULT_SAMPLES)).toBe(true);
    // And they are the SAME bindings the module itself exports — ONE copy of the
    // harness, which is the half that matters: a second copy would carry its own
    // `TextFieldType`, every `instanceof` across the two would answer `false`,
    // and the harness would report spurious failures for correct types.
    expect(pkg.checkFieldType).toBe(checkFieldType);
    expect(pkg.checkOperator).toBe(checkOperator);
    expect(pkg.checkLatticeLaws).toBe(checkLatticeLaws);
  });

  it('exports the OPERATOR surface — the declaration, the compiled form, and the template scanner', () => {
    // A declaration is what a consumer PERSISTS, so its type has to be nameable
    // without spelling it structurally; the compiled class is what
    // `registry.operator(name)` hands back; and the scanner is what a dialect
    // author needs to walk a compiled `emit` without re-deriving what a slot is.
    const decl: OperatorDef = {
      name: '&&',
      operands: [{ name: 'left', type: 'any' }, { name: 'right', type: 'any' } satisfies OperatorOperandDef],
      output: { kind: 'bool' },
      instructions: 'Bounding-box overlap.',
      emit: { postgres: '({left} && {right})' },
    };
    const template: Template = pkg.scanTemplate(decl.emit['postgres']!, (slot) => ({ slot }));
    const part: TemplatePart = template[0]!;
    expect(pkg.isSlot(part)).toBe(false);
    expect([...pkg.templateSlotNames(template)]).toEqual(['left', 'right']);
    expect(typeof pkg.QueryOperator).toBe('function');
    expect(pkg.OPERATOR_NAME_PATTERN.test(decl.name)).toBe(true);
    // The shared named-call vocabulary both a function and an operator validate
    // through — exported so a consumer can see what `ResolvedParam` /
    // `DeclaredArg` actually are rather than restating them.
    const declared: DeclaredArg = { name: 'left', fieldType: undefined };
    const param: ResolvedParam = { ...declared, optional: false };
    const words: CallVocabulary = { noun: 'Operator', supplied: 'Operand', declared: 'operand', code: 'operator' };
    expect([declared, param, words].every((v) => v !== undefined)).toBe(true);
    expect(typeof pkg.validateNamedCall).toBe('function');
  });
});
