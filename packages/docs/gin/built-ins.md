# Built-in Types

`createRegistry()` ships with the catalog below — the surface every gin program starts with. Each type's section is the same `toCodeDefinition` output an LLM sees in its prompt, so what you read here is what the LLM reads when authoring programs.

These types can all be **extended** (real subtyping, see [Extensions in Type System](./types.md#extensions)) or **augmented** (gap-filling additions of props / get / call / init, see [Augmentations](./types.md#augmentations)). Augmentations of built-ins flow through every consumer — path-walks dispatch against augmented props, static analysis sees them, code rendering shows them.

## Foundational

```text
type any {
  toAny(): any
  typeOf(): text
  is<T>(): bool
  as<T>(): optional<T>
  toText(): text
  toBool(): bool
  eq(other: any): bool
  neq(other: any): bool
}

type void {
  toAny(): any
  toText(): text
  toBool(): bool
}

type null {
  toAny(): any
  toText(): text
  toBool(): bool
}
```

`any` is the universal escape hatch. `void` is the bottom for procedures that return nothing. `null` is the explicit null marker (distinct from `optional`'s "no value").

## Primitives

```text
type bool {
  [key: num{whole=true, min=0}]: bool
  toAny(): any
  eq(other: bool): bool
  neq(other: bool): bool
  and(other: bool): bool
  or(other: bool): bool
  xor(other: bool): bool
  not(): bool
  toText(): text
  toNum(): num
}

type num {
  [key: num{whole=true, min=0}]: num
  toAny(): any
  eq(other: num, epsilon?: num): bool
  neq(other: num, epsilon?: num): bool
  lt(other: num): bool
  lte(other: num): bool
  gt(other: num): bool
  gte(other: num): bool
  add(other: num): num
  sub(other: num): num
  mul(other: num): num
  div(other: num): num
  mod(other: num): num
  pow(other: num): num
  abs(): num
  neg(): num
  sign(): num
  sqrt(): num
  min(other: num): num
  max(other: num): num
  clamp(min: num, max: num): num
  floor(): num
  ceil(): num
  round(): num
  isZero(): bool
  isPositive(): bool
  isNegative(): bool
  isInteger(): bool
  isEven(): bool
  isOdd(): bool
  toText(precision?: num): text
  toBool(): bool
}

type text {
  [key: num]: text{minLength=1, maxLength=1}
  toAny(): any
  length: num
  eq(other: text): bool
  neq(other: text): bool
  contains(search: text): bool
  startsWith(prefix: text): bool
  endsWith(suffix: text): bool
  trim(): text
  trimStart(): text
  trimEnd(): text
  upper(): text
  lower(): text
  slice(start: num, end?: num): text
  replace(search: text, replacement: text): text
  split(separator: text): list<text>
  concat(other: text): text
  repeat(count: num): text
  indexOf(search: text, from?: num): num
  lastIndexOf(search: text, from?: num): num
  match(pattern: text): list<text>
  test(pattern: text): bool
  isEmpty(): bool
  isNotEmpty(): bool
  toNum(): num
  toBool(): bool
}
```

`bool` has `loopDynamic` get semantics — a `loop over: <bool>` re-evaluates the bool each iteration (while-loop). `text[i]` returns a one-character text constrained by `minLength=1, maxLength=1`.

## Collections

```text
type list<V> {
  [key: num{whole=true, min=0}]: V
  length: num
  at(index: num): optional<V>
  push(value: V): void
  pop(): optional<V>
  shift(): optional<V>
  unshift(value: V): void
  insert(index: num, value: V): void
  remove(index: num): V
  clear(): void
  slice(start?: num, end?: num): list<V>
  concat(other: list<V>): list<V>
  reverse(): list<V>
  join(separator?: text): text
  indexOf(value: V): num
  contains(value: V): bool
  unique(): list<V>
  duplicates(): list<V>
  map<R>(fn: (value: V, index: num): R): list<R>
  filter(fn: (value: V, index: num): bool): list<V>
  find(fn: (value: V, index: num): bool): optional<V>
  reduce<R>(fn: (acc: R, value: V, index: num): R, initial: R): R
  some(fn: (value: V, index: num): bool): bool
  every(fn: (value: V, index: num): bool): bool
  sort(fn?: (a: V, b: V): num): list<V>
  isEmpty(): bool
  isNotEmpty(): bool
  first?: V
  last?: V
}

type map<K, V> {
  [key: K]: V
  size: num
  at(key: K): optional<V>
  has(key: K): bool
  delete(key: K): bool
  clear(): void
  keys(): list<K>
  values(): list<V>
  isEmpty(): bool
  isNotEmpty(): bool
}

type tuple<...elements> {
  [key: num]: <element-union>
  length: num
  first: <head>
  last: <tail>
  toList(): list<element-union>
}

type obj {
  keys(): list<text>
  values(): list<any>
  entries(): list<tuple<text, any>>
  has(key: text): bool
  eq(other: any): bool
  neq(other: any): bool
  toText(): text
}
```

Both `list` and `map` define `loop` get expressions, so they iterate via `{kind: 'loop', over: <list/map>, body: ...}` directly — `key` binds the index/key, `value` binds the element. `obj` has dynamic prop access through `keys()` / `values()` / `entries()`.

## Container modifiers

```text
type optional<T> {
  value: T
  has(): bool
  or(fallback: T): T
  map<R>(fn: (value: T): R): optional<R>
}

type nullable<T> {
  value: T
  isNull(): bool
  or(fallback: T): T
  map<R>(fn: (value: T): R): nullable<R>
}
```

`optional<T>` is "T or absent" (used for "missing" — a method that might not return a value). `nullable<T>` is "T or null" (used when null is a meaningful value).

## Type-system constructors

```text
type or<...variants>      // union; props/get/call when ALL variants share them
type and<...parts>        // intersection; props from ANY part
type not<excluded>        // any value EXCEPT one matching excluded
type literal<T>           // one specific constant value of T
type enum<V>              // named constants of value type V
type function             // see "call" — args/returns/throws/generic
type interface            // structural contract; props/get/call only
type typ<T>               // a value that IS a Type, constrained by T
type alias                // bare-name reference / generic placeholder
```

These are the building blocks for parameterized signatures. `typ<T>` is the type of "a type that satisfies T" — used to pass types as values into `fns.fetch({output: typ<MyType>})`-style callsites.

## Date & time

```text
type date {
  year, month, day, dayOfWeek, dayOfYear   // num
  eq, neq, before, after                    // (other: date) → bool
  addDays/Months/Years, diffDays/Months/Years
  toText(format?): text
}

type timestamp {
  year..millisecond                         // num
  eq, before, after                         // (other: timestamp) → bool
  addDuration, subDuration, diff
  toDate(): date
  toEpoch(): num
  toText(format?): text
}

type duration {
  new(days?, hours?, minutes?, seconds?, ms?)
  totalSeconds, totalMinutes, totalHours, totalDays
  days, hours, minutes, seconds, ms
  toText(format?): text
}
```

`duration` ships with `init`, so `new duration({hours: 2, minutes: 30})` runs the constructor.

## Color

```text
type color {
  new(r, g, b, a?)
  r, g, b, a, hue, saturation, lightness    // num
  eq, neq                                    // (other: color) → bool
  lighten, darken, saturate, desaturate, opacity, invert, mix, complement
  toHex, toRgb, toHsl, toText               // → text
}
```

Like `duration`, `color` ships with `init` — `new color({r: 255, g: 0, b: 0})` packs the channels.

## Augmenting built-ins

Built-ins aren't sealed. You can augment any of them to add app-specific helpers without subclassing:

```typescript
r.augment('text', {
  props: {
    truncate: r.method(
      r.obj({ max: { type: r.num({ whole: true, min: 1 }) } }),
      r.text(),
      'text.truncate',
    ),
  },
});
r.setNative('text.truncate', (scope, reg) => {
  const self = scope.get('this')!.raw as string;
  const max = (scope.get('args')!.raw as { max: { raw: number } }).max.raw;
  return val(reg.text(), self.length > max ? self.slice(0, max) + '…' : self);
});

// LLM-authored:
//   "hello world".truncate(5)  →  "hello…"
```

The augmented method shows up in `text.toCodeDefinition()` next time it's rendered, which means it shows up in the LLM's prompt schema for free. No second prompt to reference, no hardcoded list to maintain.

## Read next

- [Type System](./types.md) — props / get / call / init, generics, extensions, augmentations.
- [Expressions](./expressions.md) — the 12 expression kinds.
- [Registry](./registry.md) — registration patterns and native bindings.
- [Diagnostics](./diagnostics.md) — formatting validation problems.
