import type { Scope } from '../scope';
import type { Value } from '../value';

/** Extract `this` (the receiver) from a native's scope. */
export function self<T = any>(scope: Scope): T {
  return scope.get('this')!.raw as T;
}

/** Extract `this` as a Value (type-aware variant). */
export function selfValue(scope: Scope): Value {
  return scope.get('this')!;
}

/** Extract a named call argument's RAW value from scope.args. */
export function arg<T = any>(scope: Scope, name: string): T {
  const args = scope.get('args');
  if (!args) return undefined as T;
  const field = (args.raw as Record<string, unknown>)?.[name];
  if (field === undefined || field === null) return field as T;
  if (isValue(field)) return (field as Value).raw as T;
  return field as T;
}

/** Extract a named call argument as a Value wrapper (for nested ops). */
export function argValue(scope: Scope, name: string): Value | undefined {
  const args = scope.get('args');
  if (!args) return undefined;
  const field = (args.raw as Record<string, unknown>)?.[name];
  if (isValue(field)) return field as Value;
  return undefined;
}

/** Extract the optional epsilon argument (defaults to 0). */
export function epsilon(scope: Scope): number {
  const e = arg<number | undefined>(scope, 'epsilon');
  return typeof e === 'number' ? e : 0;
}

function isValue(x: unknown): boolean {
  return !!x && typeof x === 'object' && 'type' in (x as object) && 'raw' in (x as object);
}
