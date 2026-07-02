/**
 * Example 01 — defining Types.
 *
 * Two ways to get a `Type`:
 *  1. Hand-written `TypeDef` JSON (the `user` / `order` / `product` fixture).
 *  2. `inferType(name, rows)` — derive a `TypeDef` straight from raw JSON rows
 *     (field names, field types, and nullability are all inferred).
 */
import { inferType } from '../src/index';
import { createExampleFixture, userRows } from './schema';
import type { ExampleReport } from './_util';

export async function run(): Promise<ExampleReport> {
  const { user, order, product } = createExampleFixture();
  const output: string[] = [];

  for (const type of [user, order, product]) {
    const fields = type.fields.map((f) => `${f.name}:${f.fieldType.kind}${f.nullable ? '?' : ''}`);
    output.push(`${type.name} (${type.label ?? '—'}) → ${fields.join(', ')}`);
  }

  // Infer a Type purely from the raw user rows — no hand-written schema.
  const inferred = inferType('userInferred', userRows);
  const inferredFields = inferred.fields.map(
    (f) => `${f.name}:${f.type.kind}${f.nullable ? '?' : ''}`,
  );
  output.push(`inferType('userInferred') → ${inferredFields.join(', ')}`);
  output.push(`inferred count=${inferred.count}, bytes≈${inferred.bytes}`);

  return { title: 'Define types (hand-written + inferType)', output, errors: 0 };
}
