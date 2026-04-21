/**
 * Gin - A type & expression system for LLM agents
 *
 * IMPORTANT: The interfaces below define the JSON SCHEMA for gin's types and expressions.
 * They describe the shape of serialized data — what gets stored, transmitted, and produced
 * by LLMs as structured output. Runtime class implementations will parse this JSON into
 * executable objects. All data types chosen here are JSON-compatible (no Map, Set, Date, etc.).
 *
 * Goals:
 * - Types and expressions represented as JSON (LLM structured output compatible)
 * - Go/Swift-inspired type system where every type can have props, indexing, and callability
 * - Functions are first-class; methods are just props with function types (with `this` in scope)
 * - Open extension: anyone can attach new props to existing types
 * - Type extension via `extends`: copies base type's capabilities and adds new ones
 * - Minimal expression system (~12 kinds) that covers all control flow and data access
 * - Native escape hatch for system-provided implementations
 * - LLM consumes shorthand text for brevity, emits full JSON for type definitions
 */


// ============================================================================
// TYPE SYSTEM
// ============================================================================

/**
 * The core Type definition. Every type in gin has three capabilities:
 * - props: named access (x.foo) — includes methods since functions are values
 * - get:   indexed access (x[key]) with key/value types
 * - call:  callable (x(args)) with args and return type
 *
 * Extension rules:
 * - Anyone can attach new props to any type (open extension)
 * - `extends` copies base type capabilities and adds new ones
 * - Same name + same signature = override (new implementation wins)
 * - Same name + different signature = error at registration time
 * - New name = always allowed
 */
interface Type<T = any, TOptions = {}> {
    name: string;
    docs?: string;              // documentation for the type itself
    extends?: string;
    satisfies?: string[];       // interfaces this type claims to satisfy (checked at registration)
    generic?: Record<string, Type>;
    options?: TOptions;
    init?: { docs?: string; args: Type<object>; run: Expr<void, InitScope> };   // scope: { this, args }
    props?: Record<string, Prop>;
    get?: GetSet;
    call?: Call;
}

interface Prop<T = any> {
    docs?: string;              // documentation for this prop/method
    type: Type<T>;
    get?: Expr<T, PropGetScope>;          // scope: { this, super? }
    default?: Expr<T>;
    set?: Expr<void, PropSetScope<T>>;    // scope: { this, value, super? }
}

interface GetSet<K = any, V = any> {
    docs?: string;              // documentation for indexed access
    key: Type<K>;
    value: Type<V>;
    get?: Expr<V, IndexGetScope<K>>;          // scope: { this, key, super? }
    set?: Expr<void, IndexSetScope<K, V>>;    // scope: { this, key, value, super? }
    loop?: Expr<void, LoopScope<K, V>>;       // scope: { this, yield }
}

interface Call<TArgs extends object = any, TResult = any, TError = any> {
    docs?: string;              // documentation for callable behavior
    args: Type<TArgs>;
    returns?: Type<TResult>;
    throws?: Type<TError>;      // declares this function can fail
    get?: Expr<TResult, CallGetScope<TArgs, TResult>>;     // scope: { this?, args, result, super? }
    set?: Expr<void, CallSetScope<TArgs>>;                 // scope: { this?, args, value, super? }
}

/**
 * Scope context types — describe what variables are available in each Expr position.
 *
 * `super` is available in ALL scopes when overriding an existing implementation during `extends`.
 * It references the previous implementation and can be called to delegate to it.
 *
 * These types serve as documentation at the type level — the TScope generic on Expr
 * makes it visible exactly what's in scope at each position in the Type definition.
 */
type PropGetScope<T = any>                       = { this: T; super?: () => T };
type PropSetScope<T = any, V = any>              = { this: T; value: V; super?: (value: V) => void };
type IndexGetScope<K = any>                      = { this: any; key: K; super?: (key: K) => any };
type IndexSetScope<K = any, V = any>             = { this: any; key: K; value: V; super?: (key: K, value: V) => void };
type LoopScope<K = any, V = any>                 = { this: any; yield: (key: K, value: V) => void };
type CallGetScope<TArgs = any, TResult = any>    = { this?: any; args: TArgs; result: TResult; super?: (args: TArgs) => TResult };
type CallSetScope<TArgs = any>                   = { this?: any; args: TArgs; value: any; super?: (args: TArgs, value: any) => void };
type InitScope<TArgs = any>                      = { this: any; args: TArgs };
type ErrorScope                                  = { error: any };

// ============================================================================
// VALUE
// ============================================================================

class Value<T = any> {
    constructor(readonly type: Type<T>, readonly value: T) {}
    toJSON() { return { type: this.type, value: this.value } }
}

// Examples
// Num = { type: { name: 'num', options: { min: 0 } }, value: 42 }
// Obj = { type, value: { prop: { type, value } } }
// Map = { type: { name: 'map', generic: { K: { name: 'text' }, V: { name: 'num' } } }, value: [{ key: { type, value }, value: { type, value } }] }

// ============================================================================
// EXPRESSION SYSTEM
// ============================================================================

/**
 * Base expression interface. All expressions produce a value of type T.
 * 12 expression kinds cover all control flow and data access.
 */
interface Expr<TResult = any, TScope = {}> {
    kind: string;
    comment?: string;           // code comment — for documentation/readability of expressions
}

/**
 * Path: the unified access chain for Get/Set expressions.
 * A path is a sequence of steps that chain together. All steps are objects
 * (no string | object union) for structured output compatibility.
 *
 *   x.list.map({fn: ...})[0].name  →
 *   [{prop: "list"}, {prop: "map"}, {args: {fn: ...}}, {key: 0}, {prop: "name"}]
 *
 * Each step is one of:
 * - { prop }:          prop access (x.foo)
 * - { args, catch? }:  call (x(args)) with optional inline error handling
 * - { key }:           indexed access (x[key])
 */
type PathStep = PathProp | PathCall | PathIndex;
type Path = PathStep[];

interface PathProp {
    prop: string;
}

interface PathCall {
    args: Expr<object>;
    generic?: Record<string, Type>;     // explicit generic binding (usually inferred)
    catch?: Expr<any, ErrorScope>;      // inline error handler — `error` in scope, must return same type as call
}

interface PathIndex {
    key: Expr;
}

/**
 * New: create a value of a type, optionally with an initial value.
 * { kind: 'new', type: 'number', value: 42 }
 */
interface New<T = any> extends Expr<T> {
    kind: 'new';
    type: Type<T>;
    value?: T;
}

/**
 * Get: read a value via a path chain.
 * The path resolves against the current scope.
 * { kind: 'get', path: ['user', 'name'] }  →  user.name
 * { kind: 'get', path: ['list', 'map', {args: {fn: ...}}] }  →  list.map(fn)
 */
interface Get<T = any> extends Expr<T> {
    kind: 'get';
    path: Path;
}

/**
 * Set: assign a value to a path.
 * The path must resolve to something settable (prop with set, get with set, etc.)
 * { kind: 'set', path: ['user', 'name'], value: {kind: 'new', value: 'Alice'} }
 */
interface Set<T = any> extends Expr<T> {
    kind: 'set';
    path: Path;
    value: Expr<T>;
}

/**
 * Define: introduce local variables with lexical scoping.
 * Variables are only available within the body expression.
 * { kind: 'define', vars: [{name: 'x', value: ...}], body: ... }
 */
interface Define extends Expr {
    kind: 'define';
    vars: { name: string; type?: Type; value: Expr }[];
    body: Expr;
}

/**
 * Block: a sequence of expressions. The last expression's value is the result.
 * { kind: 'block', lines: [expr1, expr2, resultExpr] }
 */
interface Block<T = any> extends Expr<T> {
    kind: 'block';
    lines: [...Expr[], Expr<T>];
}

/**
 * If: conditional branching with optional else-if chains.
 * { kind: 'if', ifs: [{condition: ..., body: ...}], else: ... }
 */
interface If<T = any> extends Expr<T> {
    kind: 'if';
    ifs: { condition: Expr<boolean>; body: Expr<T> }[];
    else?: Expr<T>;
}

/**
 * Switch: value-based branching with multiple cases.
 * Each case can match multiple values.
 * { kind: 'switch', value: ..., cases: [{equals: [...], body: ...}], else: ... }
 */
interface Switch<T = any, V = any> extends Expr<T> {
    kind: 'switch';
    value: Expr<V>;
    cases: { equals: Expr<V>[]; body: Expr<T> }[];
    else?: Expr<T>;
}

/**
 * Loop: iterate over any type that has get.loop defined.
 * The iterable's get.key type determines `key`, get.value type determines `value`.
 * { kind: 'loop', over: ..., body: ..., key: 'i', value: 'item' }
 */
interface Loop extends Expr<void> {
    kind: 'loop';
    over: Expr;
    body: Expr;
    key?: string;       // variable name for key/index, defaults to 'key'
    value?: string;     // variable name for value, defaults to 'value'
    parallel?: { concurrent?: Expr<Num>; rate?: Expr<Duration> };  // concurrency limit and/or rate limit per iteration
}

/**
 * Lambda: define a function/lambda expression.
 * Creates a callable value. When invoked, `args` and `result` are in scope.
 * If the lambda is a method (prop on a type), `this` is also in scope.
 * { kind: 'lambda', type: ..., body: ... }
 */
interface Lambda<TArgs extends object = any, TResult = any, TError = any> extends Expr {
    kind: 'lambda';
    type: Fn<TArgs, TResult, TError>;
    body: Expr<TResult>;
}

/**
 * Template: string interpolation with embedded expressions.
 * Params are resolved and interpolated into the template string.
 * { kind: 'template', template: 'Hello {name}, you have {count} items', params: ... }
 */
interface Template extends Expr<Text> {
    kind: 'template';
    template: Expr<Text>;
    params: Expr<Obj>;
}

/**
 * Flow: control flow interruption.
 * - break: exit the nearest loop
 * - continue: skip to next loop iteration
 * - return: exit the nearest function (value is the return value)
 * - throw: raise an error (error is the thrown value, must match function's throws type)
 * - exit: stop the entire program
 */
interface Flow extends Expr<never> {
    kind: 'flow';
    action: 'break' | 'return' | 'continue' | 'exit' | 'throw';
    value?: Expr;       // the value to return/yield (for return)
    error?: Expr;       // the error to throw (for throw) — type should match the function's throws declaration
}

/**
 * Native: escape hatch for system-provided implementations.
 * Maps to a registered native function by ID.
 * { kind: 'native', id: 'number.add' }
 */
interface Native<T = any> extends Expr<T> {
    kind: 'native';
    id: string;
    type?: Type<T>;
}


// ============================================================================
// BUILT-IN TYPE DEFINITIONS
// ============================================================================

/**
 * Void type: represents no meaningful return value.
 * Used as return type for side-effecting functions (push, clear, set, etc.)
 */
interface Void extends Type<void> {
    name: 'void';
    props: {
        toText:    { type: Fn<{}, Text>; get: Native<string> };        // always "void"
        toBoolean: { type: Fn<{}, Bool>; get: Native<boolean> };    // always false
    };
}

/**
 * Fn: the universal callable type.
 * Generic over args and result. Can declare throws for error handling.
 */
interface Fn<TArgs extends object = any, TResult = any, TError = any> extends Type {
    name: 'function';
    call: Call<TArgs, TResult, TError>;
}

/**
 * Number type with full arithmetic, comparison, and conversion props.
 * Options constrain valid values (useful for validation and LLM schema generation).
 */
interface Num extends Type<number, { min?: number; max?: number; minPrecision?: number; maxPrecision?: number; prefix?: string; suffix?: string }> {
    name: 'num';
    props: {
        // comparison
        eq:  { type: Fn<{ other: Num; epsilon?: Num }, Bool>; get: Native<boolean> };
        neq: { type: Fn<{ other: Num; epsilon?: Num }, Bool>; get: Native<boolean> };
        lt:  { type: Fn<{ other: Num; epsilon?: Num }, Bool>; get: Native<boolean> };
        lte: { type: Fn<{ other: Num; epsilon?: Num }, Bool>; get: Native<boolean> };
        gt:  { type: Fn<{ other: Num; epsilon?: Num }, Bool>; get: Native<boolean> };
        gte: { type: Fn<{ other: Num; epsilon?: Num }, Bool>; get: Native<boolean> };

        // arithmetic
        add: { type: Fn<{ other: Num }, Num>; get: Native<number> };
        sub: { type: Fn<{ other: Num }, Num>; get: Native<number> };
        mul: { type: Fn<{ other: Num }, Num>; get: Native<number> };
        div: { type: Fn<{ other: Num }, Num>; get: Native<number> };
        mod: { type: Fn<{ other: Num }, Num>; get: Native<number> };
        pow: { type: Fn<{ other: Num }, Num>; get: Native<number> };

        // unary math
        abs:  { type: Fn<{}, Num>; get: Native<number> };
        neg:  { type: Fn<{}, Num>; get: Native<number> };
        sign: { type: Fn<{}, Num>; get: Native<number> };
        sqrt: { type: Fn<{}, Num>; get: Native<number> };

        // min/max/clamp
        min:   { type: Fn<{ other: Num }, Num>; get: Native<number> };
        max:   { type: Fn<{ other: Num }, Num>; get: Native<number> };
        clamp: { type: Fn<{ min: Num; max: Num }, Num>; get: Native<number> };

        // rounding
        floor: { type: Fn<{}, Num>; get: Native<number> };
        ceil:  { type: Fn<{}, Num>; get: Native<number> };
        round: { type: Fn<{}, Num>; get: Native<number> };
        up:    { type: Fn<{ precision?: Num }, Num>; get: Native<number> };
        down:  { type: Fn<{ precision?: Num }, Num>; get: Native<number> };

        // bitwise
        bitAnd:     { type: Fn<{ other: Num }, Num>; get: Native<number> };
        bitOr:      { type: Fn<{ other: Num }, Num>; get: Native<number> };
        bitXor:     { type: Fn<{ other: Num }, Num>; get: Native<number> };
        bitNot:     { type: Fn<{}, Num>; get: Native<number> };
        shiftLeft:  { type: Fn<{ other: Num }, Num>; get: Native<number> };
        shiftRight: { type: Fn<{ other: Num }, Num>; get: Native<number> };

        // combinatorics
        gcd:    { type: Fn<{ other: Num }, Num>; get: Native<number> };
        lcm:    { type: Fn<{ other: Num }, Num>; get: Native<number> };
        choose: { type: Fn<{ k: Num }, Num>; get: Native<number> };

        // predicates
        isZero:        { type: Fn<{ epsilon?: Num }, Bool>; get: Native<boolean> };
        isPositive:    { type: Fn<{ epsilon?: Num }, Bool>; get: Native<boolean> };
        isNegative:    { type: Fn<{ epsilon?: Num }, Bool>; get: Native<boolean> };
        isOne:         { type: Fn<{ epsilon?: Num }, Bool>; get: Native<boolean> };
        isInteger:     { type: Fn<{}, Bool>; get: Native<boolean> };
        isEven:        { type: Fn<{}, Bool>; get: Native<boolean> };
        isOdd:         { type: Fn<{}, Bool>; get: Native<boolean> };
        isDivisibleBy: { type: Fn<{ other: Num; epsilon?: Num }, Bool>; get: Native<boolean> };
        delta:         { type: Fn<{ other: Num }, Num>; get: Native<number> };

        // conversion
        toText:    { type: Fn<{ precision?: Num; base?: Num }, Text>; get: Native<string> };
        toBoolean: { type: Fn<{}, Bool>; get: Native<boolean> };
    };
}

/**
 * Boolean type with logical operations and conversions.
 */
interface Bool extends Type<boolean, { trueText?: string; falseText?: string }> {
    name: 'bool';
    props: {
        eq:  { type: Fn<{ other: Bool }, Bool>; get: Native<boolean> };
        neq: { type: Fn<{ other: Bool }, Bool>; get: Native<boolean> };
        and: { type: Fn<{ other: Bool }, Bool>; get: Native<boolean> };
        or:  { type: Fn<{ other: Bool }, Bool>; get: Native<boolean> };
        not: { type: Fn<{}, Bool>; get: Native<boolean> };
        xor: { type: Fn<{ other: Bool }, Bool>; get: Native<boolean> };

        isTrue:  { type: Fn<{}, Bool>; get: Native<boolean> };
        isFalse: { type: Fn<{}, Bool>; get: Native<boolean> };

        toText:   { type: Fn<{ trueText?: Text; falseText?: Text }, Text>; get: Native<string> };
        toNumber: { type: Fn<{ trueValue?: Num; falseValue?: Num }, Num>; get: Native<number> };
    };
}

/**
 * Text type with string operations.
 */
interface Text extends Type<string, { minLength?: number; maxLength?: number; pattern?: string }> {
    name: 'text';
    get: {
        key: Num;
        value: Text;
        get: Native<string>;            // text[0] returns character
        loop: Native<void>;             // iterate over characters
    };
    props: {
        length: { type: Num; get: Native<number> };

        eq:         { type: Fn<{ other: Text }, Bool>; get: Native<boolean> };
        neq:        { type: Fn<{ other: Text }, Bool>; get: Native<boolean> };
        contains:   { type: Fn<{ search: Text }, Bool>; get: Native<boolean> };
        startsWith: { type: Fn<{ prefix: Text }, Bool>; get: Native<boolean> };
        endsWith:   { type: Fn<{ suffix: Text }, Bool>; get: Native<boolean> };

        trim:      { type: Fn<{}, Text>; get: Native<string> };
        trimStart: { type: Fn<{}, Text>; get: Native<string> };
        trimEnd:   { type: Fn<{}, Text>; get: Native<string> };
        upper:     { type: Fn<{}, Text>; get: Native<string> };
        lower:     { type: Fn<{}, Text>; get: Native<string> };

        slice:    { type: Fn<{ start: Num; end?: Num }, Text>; get: Native<string> };
        replace:  { type: Fn<{ search: Text; replacement: Text; all?: Bool }, Text>; get: Native<string> };
        split:    { type: Fn<{ separator: Text }, List<string>>; get: Native<string[]> };
        concat:   { type: Fn<{ other: Text }, Text>; get: Native<string> };
        repeat:   { type: Fn<{ count: Num }, Text>; get: Native<string> };
        padStart: { type: Fn<{ length: Num; fill?: Text }, Text>; get: Native<string> };
        padEnd:   { type: Fn<{ length: Num; fill?: Text }, Text>; get: Native<string> };

        indexOf:     { type: Fn<{ search: Text; from?: Num }, Num>; get: Native<number> };
        lastIndexOf: { type: Fn<{ search: Text; from?: Num }, Num>; get: Native<number> };

        match:   { type: Fn<{ pattern: Text }, List<string>>; get: Native<string[]> };    // regex match, returns list of matches
        test:    { type: Fn<{ pattern: Text }, Bool>; get: Native<boolean> };           // regex test

        isEmpty:    { type: Fn<{}, Bool>; get: Native<boolean> };
        isNotEmpty: { type: Fn<{}, Bool>; get: Native<boolean> };

        toNumber:  { type: Fn<{}, Num>; get: Native<number> };
        toBoolean: { type: Fn<{}, Bool>; get: Native<boolean> };
    };
}

/**
 * List type: ordered collection with generic element type V.
 * Indexable by number, iterable, with functional methods.
 */
interface List<V = any> extends Type<V[], { minLength?: number; maxLength?: number }> {
    name: 'list';
    generic: { V: Type<V> };
    get: {
        key: Num;
        value: Type<V>;
        get: Native<V>;
        set: Native<void>;
        loop: Native<void>;             // key=index, value=element
    };
    props: {
        length: { type: Num; get: Native<number> };

        push:    { type: Fn<{ value: Type<V> }, Void>; get: Native<void> };
        pop:     { type: Optional<V>; get: Native<V | undefined> };
        shift:   { type: Optional<V>; get: Native<V | undefined> };
        unshift: { type: Fn<{ value: Type<V> }, Void>; get: Native<void> };
        insert:  { type: Fn<{ index: Num; value: Type<V> }, Void>; get: Native<void> };
        remove:  { type: Fn<{ index: Num }, Type<V>>; get: Native<V> };
        clear:   { type: Fn<{}, Void>; get: Native<void> };

        slice:   { type: Fn<{ start?: Num; end?: Num }, List<V>>; get: Native<V[]> };
        concat:  { type: Fn<{ other: List<V> }, List<V>>; get: Native<V[]> };
        reverse: { type: Fn<{}, List<V>>; get: Native<V[]> };
        flat:    { type: Fn<{}, List<Any>>; get: Native<any[]> };
        join:    { type: Fn<{ separator?: Text }, Text>; get: Native<string> };

        indexOf:    { type: Fn<{ value: Type<V> }, Num>; get: Native<number> };
        contains:   { type: Fn<{ value: Type<V> }, Bool>; get: Native<boolean> };
        unique:     { type: Fn<{}, List<V>>; get: Native<V[]> };                  // deduplicated list
        duplicates: { type: Fn<{}, List<V>>; get: Native<V[]> };                  // values that appear more than once

        // higher-order — generic R is inferred from fn return type
        map:    { type: Fn<{ fn: Fn<{ value: Type<V>; index: Num }, Any> }, List<Any>>; get: Native<any[]> };
        filter: { type: Fn<{ fn: Fn<{ value: Type<V>; index: Num }, Bool> }, List<V>>; get: Native<V[]> };
        find:   { type: Fn<{ fn: Fn<{ value: Type<V>; index: Num }, Bool> }, Optional<V>>; get: Native<V | undefined> };
        reduce: { type: Fn<{ fn: Fn<{ acc: Any; value: Type<V>; index: Num }, Any>; initial: Any }, Any>; get: Native<any> };
        some:   { type: Fn<{ fn: Fn<{ value: Type<V>; index: Num }, Bool> }, Bool>; get: Native<boolean> };
        every:  { type: Fn<{ fn: Fn<{ value: Type<V>; index: Num }, Bool> }, Bool>; get: Native<boolean> };
        sort:   { type: Fn<{ fn?: Fn<{ a: Type<V>; b: Type<V> }, Num> }, List<V>>; get: Native<V[]> };

        isEmpty:    { type: Fn<{}, Bool>; get: Native<boolean> };
        isNotEmpty: { type: Fn<{}, Bool>; get: Native<boolean> };

        first: { type: Type<V>; get: Native<V> };
        last:  { type: Type<V>; get: Native<V> };
    };
}

/**
 * Map type: key-value collection with generic key K and value V types.
 * Indexable by K, iterable over entries.
 */
interface MapType<K = string, V = any> extends Type<{ key: K; value: V }[]> {
    name: 'map';
    generic: { K: Type<K>; V: Type<V> };
    get: {
        key: Type<K>;
        value: Type<V>;
        get: Native<V>;
        set: Native<void>;
        loop: Native<void>;             // key=K, value=V
    };
    props: {
        size: { type: Num; get: Native<number> };

        has:    { type: Fn<{ key: Type<K> }, Bool>; get: Native<boolean> };
        delete: { type: Fn<{ key: Type<K> }, Bool>; get: Native<boolean> };
        clear:  { type: Fn<{}, Void>; get: Native<void> };

        keys:   { type: Fn<{}, List<K>>; get: Native<K[]> };
        values: { type: Fn<{}, List<V>>; get: Native<V[]> };

        isEmpty:    { type: Fn<{}, Bool>; get: Native<boolean> };
        isNotEmpty: { type: Fn<{}, Bool>; get: Native<boolean> };
    };
}

/**
 * Optional type: wraps another type to allow undefined.
 * Props provide safe access patterns.
 */
interface Optional<T = any> extends Type<T | undefined> {
    name: 'optional';
    generic: { T: Type<T> };
    options: { inner: Type<T> };
    props: {
        value:     { type: Type<T>; get: Native<T> };               // unwrap (throws if undefined)
        or:        { type: Fn<{ fallback: Type<T> }, Type<T>>; get: Native<T> };
        has:       { type: Fn<{}, Bool>; get: Native<boolean> };
        map:       { type: Fn<{ fn: Fn<{ value: Type<T> }, Any> }, Any>; get: Native<any> };
    };
}

/**
 * Object type: a structured type with named fields.
 * Props are the fields themselves. This is the base for user-defined types.
 */
interface Obj<T extends object = any> extends Type<T, { props: Record<string, Type> }> {
    name: 'object';
    // field props are defined per-instance via the Type.props field
    // these are common props available on all objects:
    props: {
        keys:    { type: Fn<{}, List<Text>>; get: Native<string[]> };
        values:  { type: Fn<{}, List<Any>>; get: Native<any[]> };
        entries: { type: Fn<{}, List<[Text, Any]>>; get: Native<[string, any][]> };
        has:     { type: Fn<{ key: Text }, Bool>; get: Native<boolean> };

        eq:  { type: Fn<{ other: Obj }, Bool>; get: Native<boolean> };    // deep equality
        neq: { type: Fn<{ other: Obj }, Bool>; get: Native<boolean> };

        toText: { type: Fn<{}, Text>; get: Native<string> };
    };
}

/**
 * Interface type: a structural contract (like Go interfaces / TypeScript interfaces).
 *
 * Defines required props, indexing, and/or callability that a type must have to satisfy it.
 * Satisfaction is structural — any type whose shape is a superset of the interface satisfies it
 * automatically, no explicit declaration needed (Go-style).
 *
 * Props on an interface only need `type` (the signature). If `get` is provided, it serves as
 * a default implementation that satisfying types inherit unless they override it.
 *
 * Interfaces can extend other interfaces to compose contracts.
 *
 * Example - Comparable interface:
 * {
 *   name: 'comparable',
 *   docs: 'Any type that can be compared for ordering',
 *   props: {
 *     lt:  { docs: 'Less than',    type: { name: 'function', call: { args: { name: 'object', props: { other: { type: { name: 'any' } } } }, returns: { name: 'boolean' } } } },
 *     gt:  { docs: 'Greater than', type: { name: 'function', call: { args: { name: 'object', props: { other: { type: { name: 'any' } } } }, returns: { name: 'boolean' } } } },
 *     eq:  { docs: 'Equal to',     type: { name: 'function', call: { args: { name: 'object', props: { other: { type: { name: 'any' } } } }, returns: { name: 'boolean' } } } },
 *   }
 * }
 *
 * Example - Iterable interface (requires indexed access with loop):
 * {
 *   name: 'iterable',
 *   docs: 'Any type that can be looped over',
 *   generic: { K: { name: 'any' }, V: { name: 'any' } },
 *   get: { key: { name: 'any' }, value: { name: 'any' } }     // no get impl — just the contract
 * }
 *
 * Usage as type constraint:
 *   A function arg typed as { name: 'comparable' } accepts any type that has lt/gt/eq props.
 *   number satisfies comparable. text satisfies comparable. color does not (no lt/gt).
 */
interface Iface extends Type<any> {
    name: 'interface';
    // props: required prop signatures (get optional = contract only, get provided = default impl)
    // get: required indexing capability
    // call: required callable capability
    // All inherited from Type — interface is just a Type used as a contract rather than a concrete value.
}

/**
 * Tuple type: fixed-length sequence with a known type at each position.
 * Unlike List, each element can be a different type.
 * Indexed by number (compile-time position), iterable.
 *
 * Elements are defined in options since they're fixed structure, not parameterized.
 * Example: Tuple<[number, text, boolean]> → { name: 'tuple', options: { elements: [NumberType, TextType, BooleanType] } }
 */
interface Tuple<T extends [...any[], any]> extends Type<T, { elements: {[I in keyof T]: Type<T[I]> } }> {
    name: 'tuple';
    get: {
        key: Num;
        value: Type[T[number]];                 // runtime: resolves to elements[key] type
        get: Native<any>;
        set: Native<void>;
        loop: Native<void>;             // key=index, value=element
    };
    props: {
        0: { type: Any; get: Native<any> };         // type of elements[0]
        1: { type: Any; get: Native<any> };         // type of elements[1]
        2: { type: Any; get: Native<any> };         // type of elements[2]
        // ... up to length of tuple
        length: { type: Num; get: Native<number> };

        first: { type: Type<T[0]>; get: Native<any> };         // type of elements[0]
        last:  { type: Any; get: Native<any> };         // type of elements[n-1]

        toList: { type: Fn<{}, List<T[number]>>; get: Native<any[]> };
    };
}

/**
 * Enum type: a set of named constants.
 * Values are defined in options as key-value pairs.
 * The generic V determines the value type (typically text or number).
 *
 * Example: { name: 'enum', generic: { V: {name: 'text'} }, options: { values: { RED: 'red', GREEN: 'green', BLUE: 'blue' } } }
 */
interface Enum<V = string> extends Type<V, { values: Record<string, V> }> {
    name: 'enum';
    generic: { V: Type<V> };
    props: {
        name:  { type: Text; get: Native<string> };          // the key name of the current value
        value: { type: Type<V>; get: Native<V> };                // the value itself

        eq:  { type: Fn<{ other: Type<V> }, Bool>; get: Native<boolean> };
        neq: { type: Fn<{ other: Type<V> }, Bool>; get: Native<boolean> };

        toText: { type: Fn<{}, Text>; get: Native<string> };
    };
}

/**
 * Date type: a calendar date (year, month, day) without time.
 * Internally stored as an ISO date string or structured object.
 */
interface Date extends Type<string> {
    name: 'date';
    props: {
        year:      { type: Num; get: Native<number> };
        month:     { type: Num; get: Native<number> };         // 1-12
        day:       { type: Num; get: Native<number> };         // 1-31
        dayOfWeek: { type: Num; get: Native<number> };         // 0=Sunday, 6=Saturday
        dayOfYear: { type: Num; get: Native<number> };         // 1-366

        // comparison
        eq:     { type: Fn<{ other: Date }, Bool>; get: Native<boolean> };
        neq:    { type: Fn<{ other: Date }, Bool>; get: Native<boolean> };
        before: { type: Fn<{ other: Date }, Bool>; get: Native<boolean> };
        after:  { type: Fn<{ other: Date }, Bool>; get: Native<boolean> };

        // arithmetic (returns new date)
        addDays:   { type: Fn<{ days: Num }, Date>; get: Native<string> };
        addMonths: { type: Fn<{ months: Num }, Date>; get: Native<string> };
        addYears:  { type: Fn<{ years: Num }, Date>; get: Native<string> };

        // difference
        diffDays:   { type: Fn<{ other: Date }, Num>; get: Native<number> };
        diffMonths: { type: Fn<{ other: Date }, Num>; get: Native<number> };
        diffYears:  { type: Fn<{ other: Date }, Num>; get: Native<number> };

        // conversion
        toText:      { type: Fn<{ format?: Text }, Text>; get: Native<string> };
        toTimestamp: { type: Fn<{ hour?: Num; minute?: Num; second?: Num }, Timestamp>; get: Native<string> };
    };
}

/**
 * Timestamp type: a precise point in time.
 * Extends Date — inherits year, month, day, dayOfWeek, dayOfYear, comparison,
 * date arithmetic (addDays/addMonths/addYears), diff, and toText.
 * Adds time-of-day components and duration arithmetic.
 */
interface Timestamp extends Type<string> {
    name: 'timestamp';
    extends: 'date';
    props: {
        // time-of-day components (added on top of Date's date components)
        hour:        { type: Num; get: Native<number> };          // 0-23
        minute:      { type: Num; get: Native<number> };          // 0-59
        second:      { type: Num; get: Native<number> };          // 0-59
        millisecond: { type: Num; get: Native<number> };          // 0-999

        // duration arithmetic (Date has day/month/year arithmetic, Timestamp adds ms-precision)
        addDuration: { type: Fn<{ duration: Duration }, Timestamp>; get: Native<string> };
        subDuration: { type: Fn<{ duration: Duration }, Timestamp>; get: Native<string> };
        diff:        { type: Fn<{ other: Timestamp }, Duration>; get: Native<number> };    // returns Duration

        // conversion
        toDate:  { type: Fn<{}, Date>; get: Native<string> };
        toEpoch: { type: Fn<{}, Num>; get: Native<number> };
    };
}

/**
 * Duration type: a span of time stored as milliseconds.
 * Extends number — inherits all arithmetic (add, sub, mul, div, mod, neg, abs),
 * comparison (eq, lt, gt, etc.), and predicates (isZero, isPositive, isNegative).
 * Adds component decomposition and a constructor from named parts.
 */
interface Duration extends Type<number> {
    name: 'duration';
    extends: 'number';
    init: {
        args: Type<{ days?: Num; hours?: Num; minutes?: Num; seconds?: Num; ms?: Num }>;
        run: Native<number>;            // converts components to total ms
    };
    props: {
        // total conversions (fractional)
        totalSeconds: { type: Num; get: Native<number> };
        totalMinutes: { type: Num; get: Native<number> };
        totalHours:   { type: Num; get: Native<number> };
        totalDays:    { type: Num; get: Native<number> };

        // integer components (remainder decomposition)
        days:    { type: Num; get: Native<number> };          // whole days
        hours:   { type: Num; get: Native<number> };          // 0-23
        minutes: { type: Num; get: Native<number> };          // 0-59
        seconds: { type: Num; get: Native<number> };          // 0-59
        ms:      { type: Num; get: Native<number> };          // 0-999

        // override toText for human-readable duration formatting
        toText: { type: Fn<{ format?: Text }, Text>; get: Native<string> };
    };
}

/**
 * Color type: RGBA color stored as a 32-bit integer (0xRRGGBBAA).
 * Constructable from components, manipulable via props.
 */
interface Color extends Type<number> {
    name: 'color';
    init: {
        args: Type<{ r: Num; g: Num; b: Num; a?: Num }>;
        run: Native<number>;
    };
    props: {
        // components (0-255 for rgb, 0-1 for a)
        r: { type: Num; get: Native<number>; set: Native<void> };
        g: { type: Num; get: Native<number>; set: Native<void> };
        b: { type: Num; get: Native<number>; set: Native<void> };
        a: { type: Num; get: Native<number>; set: Native<void> };

        // derived
        hue:        { type: Num; get: Native<number> };       // 0-360
        saturation: { type: Num; get: Native<number> };       // 0-1
        lightness:  { type: Num; get: Native<number> };       // 0-1

        // comparison
        eq:  { type: Fn<{ other: Color }, Bool>; get: Native<boolean> };
        neq: { type: Fn<{ other: Color }, Bool>; get: Native<boolean> };

        // manipulation
        lighten:    { type: Fn<{ amount: Num }, Color>; get: Native<number> };
        darken:     { type: Fn<{ amount: Num }, Color>; get: Native<number> };
        saturate:   { type: Fn<{ amount: Num }, Color>; get: Native<number> };
        desaturate: { type: Fn<{ amount: Num }, Color>; get: Native<number> };
        opacity:    { type: Fn<{ alpha: Num }, Color>; get: Native<number> };
        invert:     { type: Fn<{}, Color>; get: Native<number> };
        mix:        { type: Fn<{ other: Color; weight?: Num }, Color>; get: Native<number> };
        complement: { type: Fn<{}, Color>; get: Native<number> };

        // conversion
        toHex:  { type: Fn<{}, Text>; get: Native<string> };
        toRgb:  { type: Fn<{}, Text>; get: Native<string> };     // "rgb(r,g,b)"
        toHsl:  { type: Fn<{}, Text>; get: Native<string> };     // "hsl(h,s%,l%)"
        toText: { type: Fn<{}, Text>; get: Native<string> };
    };
}

/**
 * Nullable type: wraps another type to allow null.
 * Distinct from Optional (which allows undefined).
 * Useful for database values and explicit absence.
 */
interface Nullable<T = any> extends Type<T | null, { inner: Type<T> }> {
    name: 'nullable';
    generic: { T: Type<T> };
    props: {
        value:  { type: Type<T>; get: Native<T> };                  // unwrap (throws if null)
        or:     { type: Fn<{ fallback: Type<T> }, Type<T>>; get: Native<T> };
        isNull: { type: Fn<{}, Bool>; get: Native<boolean> };
        map:    { type: Fn<{ fn: Fn<{ value: Type<T> }, Any> }, Any>; get: Native<any> };
    };
}

/**
 * Null type: the unit type whose only value is null.
 * Bottom of the nullable hierarchy. Has no meaningful operations.
 */
interface Null extends Type<null> {
    name: 'null';
    props: {
        toText:    { type: Fn<{}, Text>; get: Native<string> };        // always "null"
        toBoolean: { type: Fn<{}, Bool>; get: Native<boolean> };    // always false
    };
}

/**
 * Any type: the top type. Any value satisfies this type.
 * Useful as a wildcard, escape hatch, or for untyped data.
 * Props provide runtime type checking and narrowing.
 */
interface Any extends Type<any> {
    name: 'any';
    props: {
        // runtime type interrogation
        typeOf: { type: Fn<{}, Text>; get: Native<string> };            // returns the runtime type name
        is:     { type: Fn<{ type: Text }, Bool>; get: Native<boolean> };

        // narrowing — returns Optional<T>, has value if the cast succeeds
        as: { type: Fn<{ type: Text }, Any>; get: Native<any> };

        // basic operations that work on anything
        toText:    { type: Fn<{}, Text>; get: Native<string> };
        toBoolean: { type: Fn<{}, Bool>; get: Native<boolean> };    // truthiness
        eq:        { type: Fn<{ other: Any }, Bool>; get: Native<boolean> };
        neq:       { type: Fn<{ other: Any }, Bool>; get: Native<boolean> };
    };
}

/**
 * Or type: a discriminated union. Value is exactly ONE of the inner types.
 * The runtime tracks which variant is active.
 *
 * Example: Or<[text, number]> — value is either text or number.
 * { name: 'or', options: { types: [TextType, NumberType] } }
 */
interface Or extends Type<any, { types: Type[] }> {
    name: 'or';
    props: {
        // runtime discrimination
        typeOf: { type: Fn<{}, Text>; get: Native<string> };            // which variant is active
        is:     { type: Fn<{ type: Text }, Bool>; get: Native<boolean> };

        // narrowing — returns Optional<T>
        as: { type: Fn<{ type: Text }, Any>; get: Native<any> };

        // unwrap the raw value (typed as any, caller must narrow)
        value: { type: Any; get: Native<any> };

        // pattern matching via switch is the idiomatic way to handle Or types:
        //   switch value.typeOf() { case "text": ..., case "number": ... }

        eq:     { type: Fn<{ other: Any }, Bool>; get: Native<boolean> };
        neq:    { type: Fn<{ other: Any }, Bool>; get: Native<boolean> };
        toText: { type: Fn<{}, Text>; get: Native<string> };
    };
}

/**
 * And type: an intersection type. Value must satisfy ALL inner types.
 * The resulting type merges props from all constituent types.
 *
 * Example: And<[Serializable, Comparable]> — has all props from both.
 * { name: 'and', options: { types: [SerializableType, ComparableType] } }
 *
 * Conflict resolution:
 * - Same prop name + same type = ok (shared prop)
 * - Same prop name + different type = error at registration time
 */
interface And extends Type<any, { types: Type[] }> {
    name: 'and';
    // props are merged from all constituent types at registration/resolution time
    // get/call are inherited if exactly one constituent defines them (ambiguity = error)
    props: {
        // And types expose all props from their constituents — defined dynamically
        toText: { type: Fn<{}, Text>; get: Native<string> };
    };
}

/**
 * Not type: a type exclusion/negation constraint.
 * Value can be anything EXCEPT the excluded type.
 * Useful for type narrowing and validation constraints.
 *
 * Example: Not<null> — any value except null (similar to non-nullable).
 * { name: 'not', options: { excluded: NullType } }
 *
 * Not types are primarily a validation/constraint tool:
 * - Not<null> on a function param means "this param must not be null"
 * - Not<Or<[A, B]>> means "anything except A or B"
 * At runtime, the value is whatever it is — Not just rejects excluded types.
 */
interface Not extends Type<any, { not: Type }> {
    name: 'not';
    props: {
        value:  { type: Any; get: Native<any> };
        typeOf: { type: Fn<{}, Text>; get: Native<string> };
        toText: { type: Fn<{}, Text>; get: Native<string> };
    };
}


// ============================================================================
// ERROR HANDLING
// ============================================================================

/**
 * Error handling in gin is inline and granular:
 *
 * 1. Functions declare they can fail:
 *    call: { args: ..., returns: ..., throws: ErrorType, get: ... }
 *
 * 2. Callers handle errors at the call site via `catch` on PathCall:
 *    { args: {...}, catch: fallbackExpr }
 *    The catch expression has `error` (of the throws type) in scope.
 *    Its result replaces the call result. Execution continues normally.
 *
 * 3. Unhandled errors propagate up the call chain.
 *    If no catch is found, execution stops (like exit).
 *
 * Example - file read with fallback:
 *   get path: ["file", "read", {args: {path: "data.txt"}, catch: {kind: "new", value: ""}}, "lines"]
 *   → file.read({path: "data.txt"}) catch → "".lines()
 *
 * This avoids try/catch nesting, makes error handling visible at each call site,
 * and is type-safe: catch must return the same type as the function's returns.
 */


// ============================================================================
// RUNTIME ARCHITECTURE (class stubs)
// ============================================================================

/**
 * Global: a named, typed value available in every scope's root.
 *
 * Globals are NOT reserved scope names (this, args, result, key, value, yield, super).
 * They are user/developer/runtime-defined values injected into the root scope before execution.
 * Accessed via normal Get paths: ["constants", "MAX_AMOUNT"] or ["fns", "findPerson", {args: {id: ...}}].
 *
 * Globals can be:
 * - Constants:  { type: Num, value: 1000 }
 * - Functions:  { type: Fn<{ id: Text }, Optional<Obj>>, value: nativeFn }
 * - Namespaces: { type: Obj with props } — group related globals under a name
 * - Runtime-provided: injected by the host environment (e.g., current user, config, API clients)
 *
 * Example registration:
 *   registry.registerGlobal('constants', { type: { name: 'object', props: { MAX_AMOUNT: { type: { name: 'number' } } } }, value: { MAX_AMOUNT: 1000 } })
 *   registry.registerGlobal('fns', { type: { name: 'object', props: { findPerson: { type: { name: 'function', ... } } } }, value: { findPerson: ... } })
 *   registry.registerGlobal('user', { type: UserType, value: currentUser })
 *
 * In expressions:
 *   { kind: 'get', path: ['constants', 'MAX_AMOUNT'] }
 *   { kind: 'get', path: ['fns', 'findPerson', {args: {id: {kind: 'new', value: '123'}}}] }
 *   { kind: 'get', path: ['user', 'name'] }
 */
interface Global {
    docs?: string;
    type: Type;
    value?: any;                // if known at registration time (constants); may be set at runtime
}

/**
 * Scope: lexical variable bindings with parent chain.
 * Each Define/Lambda/Loop creates a child scope.
 *
 * The root scope contains:
 * - All registered globals (constants, fns, runtime values, etc.)
 * - Reserved names injected per-context (this, args, result, key, value, yield, super)
 *
 * Child scopes inherit from parent. Define/Lambda/Loop create children.
 */
interface Scope {
    parent?: Scope;
    vars: Record<string, { type: Type; value: any }>;
    get(name: string): any;
    set(name: string, value: any): void;
    child(vars?: Record<string, { type: Type; value: any }>): Scope;
}

/**
 * RuntimeType: the runtime backing for a Type definition.
 * Knows how to serialize, validate, and create instances.
 */
interface RuntimeType<T = any> {
    type: Type<T>;
    create(options?: any): T;
    validate(value: any): value is T;
    toJSON(value: T): any;
    fromJSON(json: any): T;
    equals(a: T, b: T): boolean;
    compare(a: T, b: T): number;
    clone(value: T): T;
}

/**
 * Registry: all registered types, extensions, and native implementations.
 * The central authority for type resolution and native function lookup.
 */
interface Registry {
    // type management
    registerType(type: Type, runtime: RuntimeType): void;
    getType(name: string): Type | undefined;
    getRuntime(name: string): RuntimeType | undefined;

    // open extension
    extendType(name: string, props: Record<string, Prop>): void;

    // native implementations
    registerNative(id: string, fn: (scope: Scope) => any): void;
    getNative(id: string): ((scope: Scope) => any) | undefined;

    // generic resolution
    resolveGeneric(type: Type, bindings: Record<string, Type>): Type;

    // interfaces
    registerInterface(iface: Iface): void;
    getInterface(name: string): Iface | undefined;
    satisfies(type: Type, iface: string): boolean;          // structural check: does type satisfy interface?
    getTypesFor(iface: string): Type[];                     // all registered types that satisfy this interface

    // globals — dev/runtime-defined values available in every root scope
    // names must not collide with reserved scope names (this, args, result, key, value, yield, super)
    registerGlobal(name: string, global: Global): void;
    getGlobal(name: string): Global | undefined;
    getGlobals(): Record<string, Global>;
}

/**
 * Engine: parses JSON into runtime objects and executes expressions.
 * The main entry point for running gin programs.
 */
interface Engine {
    registry: Registry;

    // parsing
    parseType(json: any): Type;
    parseExpr(json: any): Expr;

    // execution — root scope is auto-populated with registered globals
    run(expr: Expr, scope?: Scope): Promise<any>;
    eval(expr: Expr, scope: Scope): Promise<any>;

    // creates a root scope pre-populated with all registered globals
    createRootScope(extras?: Record<string, { type: Type; value: any }>): Scope;

    // type checking
    typeOf(expr: Expr, scope: Scope): Type;
    validate(expr: Expr, scope: Scope): ValidationError[];
}

interface ValidationError {
    path: string;
    message: string;
    severity: 'error' | 'warning' | 'info';
}


// ============================================================================
// USAGE EXAMPLES (as JSON)
// ============================================================================

/**
 * Example 1: Simple arithmetic
 * gin:   x.add({other: 5}).mul({other: 2})
 * json:
 * { kind: 'get', path: [
 *   {prop: 'x'}, {prop: 'add'}, {args: {other: {kind: 'new', type: {name: 'number'}, value: 5}}},
 *   {prop: 'mul'}, {args: {other: {kind: 'new', type: {name: 'number'}, value: 2}}}
 * ]}
 */

/**
 * Example 2: List map with lambda
 * gin:   items.map({fn: (value, index) => value.name.upper()})
 * json:
 * { kind: 'get', path: [
 *   {prop: 'items'}, {prop: 'map'}, {args: {fn:
 *     {kind: 'lambda', type: {name: 'function', call: {args: {name: 'object', props: {value: {type: {name: 'text'}}, index: {type: {name: 'number'}}}}}},
 *      body: {kind: 'get', path: [{prop: 'value'}, {prop: 'name'}, {prop: 'upper'}, {args: {}}]}}
 *   }}
 * ]}
 */

/**
 * Example 3: Error handling inline
 * gin:   file.read({path: "config.json"}) catch(error) { defaults }
 * json:
 * { kind: 'get', path: [
 *   {prop: 'file'}, {prop: 'read'},
 *   {args: {path: {kind: 'new', value: 'config.json'}}, catch: {kind: 'get', path: [{prop: 'defaults'}]}}
 * ]}
 */

/**
 * Example 4: Define + If + Loop
 * gin:   define total = 0; loop items as i, item { if item.active() { total = total.add({other: item.price}) } }; total
 * json:
 * { kind: 'define', vars: [{name: 'total', value: {kind: 'new', type: {name: 'number'}, value: 0}}],
 *   body: { kind: 'block', lines: [
 *     { kind: 'loop', over: {kind: 'get', path: [{prop: 'items'}]}, key: 'i', value: 'item',
 *       body: { kind: 'if', ifs: [{
 *         condition: {kind: 'get', path: [{prop: 'item'}, {prop: 'active'}, {args: {}}]},
 *         body: {kind: 'set', path: [{prop: 'total'}], value:
 *           {kind: 'get', path: [{prop: 'total'}, {prop: 'add'}, {args: {other: {kind: 'get', path: [{prop: 'item'}, {prop: 'price'}]}}}]}}
 *       }]}
 *     },
 *     { kind: 'get', path: [{prop: 'total'}] }
 *   ]}
 * }
 */

/**
 * Example 5: LLM defining a new type via structured output
 * The LLM emits this JSON to define a "Temperature" type that extends number:
 * {
 *   name: 'temperature',
 *   extends: 'number',
 *   options: { min: -273.15, suffix: '°C' },
 *   props: {
 *     toFahrenheit: {
 *       type: { name: 'function', call: { args: { name: 'object', props: {} }, returns: { name: 'number' } } },
 *       get: { kind: 'get', path: [{prop: 'this'}, {prop: 'mul'}, {args: {other: {kind: 'new', value: 1.8}}}, {prop: 'add'}, {args: {other: {kind: 'new', value: 32}}}] }
 *     },
 *     toKelvin: {
 *       type: { name: 'function', call: { args: { name: 'object', props: {} }, returns: { name: 'number' } } },
 *       get: { kind: 'get', path: [{prop: 'this'}, {prop: 'add'}, {args: {other: {kind: 'new', value: 273.15}}}] }
 *     }
 *   }
 * }
 */

/**
 * Example 6: Using globals
 * gin:   constants.MAX_AMOUNT.gt({other: total})
 * json:
 * { kind: 'get', path: [
 *   {prop: 'constants'}, {prop: 'MAX_AMOUNT'}, {prop: 'gt'},
 *   {args: {other: {kind: 'get', path: [{prop: 'total'}]}}}
 * ]}
 *
 * gin:   fns.findPerson({id: userId})
 * json:
 * { kind: 'get', path: [
 *   {prop: 'fns'}, {prop: 'findPerson'},
 *   {args: {id: {kind: 'get', path: [{prop: 'userId'}]}}}
 * ]}
 */


/**
 * Implementation plans:
 *
 */


// ============================================================================
// EXPANGINE TYPE SYSTEM — REFERENCE NOTES
// ============================================================================

/**
 * Source: `expangine-runtime/src/Type.ts` and `expangine-runtime/src/types/*.ts`
 *
 * Expangine is the prior-art runtime whose shape informs gin. The sections below
 * document (1) the abstract `Type<D, O>` contract every type must fulfill, and
 * (2) how each concrete type satisfies that contract. Gin's JSON-first design
 * collapses most of these abstract methods into declarative `props`, `get`,
 * `call`, and `init` fields — but the underlying concerns (validation, sub-typing,
 * normalization, compat checks, expression synthesis) are the same.
 *
 * -------------------------------------------------------------------------
 * THE ABSTRACT `Type<D, O>` CONTRACT
 * -------------------------------------------------------------------------
 *
 * Two layers: an *instance* side (`abstract class Type<D, O>`) describing a
 * specific typed value, and a *class* side (`interface TypeClass<T, D, O>`)
 * describing registration, decoding, and auto-describe behavior.
 *
 *   `D` — the runtime data shape an instance validates/produces (e.g. number, string, T[]).
 *   `O` — the options/config that parameterize this instance (e.g. { min?, max? }).
 *
 * Abstract instance methods (every type MUST implement):
 *
 *   getId()                          // string id — matches TypeClass.id
 *   getOperations()                  // Record<string, OperationGeneric> — ops registered for this type
 *   merge(type)                      // fold another instance of same type into this one (widen constraints)
 *   getSubType(expr, def, context)   // sub-type reached by an expression (e.g. a specific prop)
 *   getSubTypes(def)                 // TypeSub[] enumerating reachable sub-types
 *   getExactType(value)              // narrow self to the exact type that matches `value`
 *   getSimplifiedType()              // collapse wrappers / redundant layers
 *   isDeepCompatible(other, options) // protected; called by isCompatible after pre-checks
 *   isOptional()                     // does this allow undefined?
 *   isSimple()                       // primitive-ish (no children)?
 *   traverse(traverser)              // visit children with Traverser pattern
 *   setParent(parent?)               // wire .parent on self & children
 *   removeDescribedRestrictions()    // strip constraints inferred by describe (loosen)
 *   getCreateExpression()            // Expression that constructs a default value
 *   getValidateExpression()          // Expression that validates a value
 *   getCompareExpression()           // Expression that compares two values
 *   isValid(value)                   // runtime type guard
 *   normalize(value)                 // coerce into canonical form
 *   newInstance() / clone()          // fresh/cloned type instance
 *   encode()                         // JSON-round-trippable shape
 *   create()                         // default value of type D
 *   random(rnd)                      // random value of type D
 *   fromJson(json) / toJson(value)   // domain serialization (vs encode, which is for the TYPE)
 *
 * Overridable (with sensible defaults on the base class):
 *
 *   getChildType(name) → undefined           // for object/list/tuple/map: name → Type
 *   getChildTypes() → []                      // enumerate child keys
 *   getRequired() → this                      // strip Optional/null tolerance
 *   isWrapper() → false / getWrappedType() → this   // Enum, Entity, etc.
 *   acceptsOtherTypes() → false               // relax strict-mode isCompatible checks
 *   getParentOfType<T>(klass)                  // walk .parent chain (base impl)
 *   getValueChangeExpression(newValue, from?, to?) → newValue   // hook for parent to rewrite on child change
 *   getValueChangeAt(newValue)                 // base impl: walks up parents calling the above
 *   getPath() / getTypeFromPath(path) / getTypeFromStep(step) / getRootType()   // path utilities
 *
 * Class-side shape (`TypeClass<T, D, O>`):
 *
 *   id, baseType, operations, computeds
 *   decode(data, types) → T          // build instance from array form
 *   encode(type) → any[]             // inverse of decode
 *   describePriority + describe(data, describer, cache)   // auto-infer a type from a sample value
 *   register() / registered           // one-time side-effects (register ops etc.)
 *   new(options, ...)                 // constructor
 *
 * `isCompatible(other, options)` is concrete on the base class and wraps
 * `isDeepCompatible`. Short-circuits: same-instance → true; non-exact +
 * other.isWrapper() → unwrap & retry; strict + different class + !acceptsOtherTypes → false.
 * Convenience wrappers: `acceptsType`, `acceptsData`, `exactType`, `exactData`.
 *
 * -------------------------------------------------------------------------
 * CONCRETE TYPES — per-method behavior
 * -------------------------------------------------------------------------
 *
 * Format: `D`, `O`, then notable method implementations. Trivial methods
 * (no-op setParent, passthrough encode, etc.) are omitted.
 *
 * ─── AnyType ──────────────────────────────────────────────────────────────
 *   D=any, O={}.
 *   isCompatible overridden to always return true (accepts anything).
 *   isValid: true. isSimple: false. create: ''. random: null.
 *   No children; getSubType/getSubTypes empty. Compare via AnyOps.cmp.
 *
 * ─── BooleanType ──────────────────────────────────────────────────────────
 *   D=boolean, O={ true?: Record<string,true>; false?: Record<string,true> }.
 *   Options let strings (e.g. "yes","no") be treated as boolean aliases.
 *   isValid: boolean OR alias match. normalize: alias → boolean.
 *   isDeepCompatible: exact class match in strict mode. isSimple: true.
 *   create: false. random: rnd(0,1,true) === 1. Registered with DataTypes
 *   for compare/equals.
 *
 * ─── ColorType (extends ObjectType) ───────────────────────────────────────
 *   D={ r, g, b, a? }, O={ hasAlpha?: boolean }.
 *   Inherits Object shape; children are the RGBA component Numbers.
 *   isValid/normalize iterate pluggable color-space parsers (hex, rgb(), hsl(), …).
 *   isDeepCompatible: accepts ObjectType whose props match color shape.
 *   removeDescribedRestrictions: clears hasAlpha. componentType is a
 *   static Number[0..255, whole].
 *
 * ─── DateType ─────────────────────────────────────────────────────────────
 *   D=Date, O={ parseAsUTC?, validateMin?, validateMax?, forceMin?, forceMax?,
 *              forceStartOf?, forceEndOf?, withTime? }.
 *   isValid: parse + check validate bounds. normalize: clamp to force bounds
 *   + startOf/endOf unit rounding. merge: union min/max. isDeepCompatible:
 *   compare withTime flag + bounds. create: new Date(). random: pick in range.
 *   JSON: { $any: 'date', value: ISO }.
 *
 * ─── EnumType<K, V> ───────────────────────────────────────────────────────
 *   D=V, O={ key: Type<K>; value: Type<V>; constants: Map<K,V> }.
 *   isWrapper: true; getWrappedType / getSimplifiedType → value type.
 *   isValid: value type valid AND value ∈ constants.values().
 *   getChildTypes traverses both key & value types. getValueChangeExpression
 *   rewrites writes by mapping through constants.
 *
 * ─── EntityType ───────────────────────────────────────────────────────────
 *   D=any, O=string (entity name). Provider injected in ctor.
 *   Pure lazy proxy: every method delegates to provider.getType(name).
 *   isWrapper: true. acceptsOtherTypes: true. getSimplifiedType returns self
 *   (keeps the name indirection intact).
 *
 * ─── FunctionType<P, R> ───────────────────────────────────────────────────
 *   D=FunctionValue (Expression | FunctionInterface | string),
 *   O={ params: Record<name, FunctionTypeProvider<T,P>>; returns?: FunctionTypeProvider<R,P> }.
 *   Params are THUNKS: `(resolvedParams) => Type` — so later params can depend
 *   on earlier ones. getOverloaded replaces GenericType children with concrete
 *   types once known. isDeepCompatible: param types compat pairwise (handling
 *   optional tail params) + return type compat. getOperations: {} (no ops).
 *   No random/fromJson/toJson (functions are opaque here).
 *
 * ─── GenericType ──────────────────────────────────────────────────────────
 *   D=any, O={ path: TypeChild[]; base?: Type }.
 *   A type variable resolved by walking up .parent to the nearest FunctionType
 *   and following `path` into its params (else falls back to `base`, else Any).
 *   isWrapper: true; isCompatible: always true. traverse: no-op.
 *
 * ─── ID (constants file) ──────────────────────────────────────────────────
 *   Not a Type class — string constants: 'bool', 'num', 'text', '?', 'list',
 *   'obj', 'map', 'set', 'tuple', 'enum', 'date', 'color', 'any', 'null',
 *   'not', 'many', 'fn', 'gen', 'entity', 'ref', etc. Used as TypeClass.id.
 *
 * ─── ListType<I> ──────────────────────────────────────────────────────────
 *   D=I[], O={ item: Type<I>; min?: number; max?: number }.
 *   getSubType: numeric index → item; 'length' → LENGTH sentinel; enum-of-index → item.
 *   getSubTypes: required indices [0..min-1] + optional via Types.INDEX + 'length'.
 *   isValid: Array.isArray + length bounds + every item valid.
 *   normalize: map item.normalize. isDeepCompatible: item compat + length bounds
 *   subset. getValidateExpression checks items non-null. Validation expression
 *   integrates with DefinitionProvider (listItemOptional).
 *
 * ─── ManyType<M> ──────────────────────────────────────────────────────────
 *   D=M (any of), O=Type[] (alternatives).
 *   Union semantics. getOperations: UNION of all option ops.
 *   isValid / getExactType: first option that matches. isDeepCompatible:
 *   any option compatible. isOptional: all options optional. getSimplifiedType:
 *   single option → that option, else self. getRequired: Many of each.getRequired().
 *   getValueChangeExpression emits a conditional cast when the active variant changes.
 *
 * ─── MapType<K, V> ────────────────────────────────────────────────────────
 *   D=Map<K,V>, O={ key: Type<K>; value: Type<V> }.
 *   getSubType: key-matching expression → value type. getSubTypes: single
 *   { key, value } entry. isValid: Map or plain object + every pair valid.
 *   normalize → ES6 Map with normalized pairs. Serialization:
 *   { $any: 'map', value: [[k, v], ...] }. Dual-rep (Map | Object).
 *
 * ─── NotType ──────────────────────────────────────────────────────────────
 *   D=any, O=Type[] (excluded types).
 *   isValid: none of the options validate. normalize: null if any option
 *   matches. isDeepCompatible: no option compat. isOptional: true.
 *   getOperations: {}. All expressions = NoExpression. create/random: null.
 *
 * ─── NullType ─────────────────────────────────────────────────────────────
 *   D=null|undefined, O=null (singleton). isOptional/isValid: true for
 *   null/undefined only. isDeepCompatible: other NullType only. isSimple: true.
 *   newInstance/clone return self.
 *
 * ─── NumberType ───────────────────────────────────────────────────────────
 *   D=number, O={ min?, max?, whole? }.
 *   isValid: number + bounds + (whole → integer). merge: union of [min,max] + AND
 *   of whole. isDeepCompatible: type match + (value mode → range containment).
 *   isSimple: true. create: 0. random: rnd(min ?? 0, max ?? 10, whole ?? false).
 *   Uses EQUALS_EPSILON for float compare. DataTypes handlers for number & bigint.
 *
 * ─── ObjectType<D, O> ─────────────────────────────────────────────────────
 *   D=Record<string, any>, O={ props: TypeMapFor<D> }. The core composite.
 *   getSubType: constant-string prop lookup (no dynamic keys). getSubTypes:
 *   one TypeSub per prop. traverse: steps into each prop with setter callback.
 *   isValid: object + every declared prop valid (supports '*' wildcard prop).
 *   normalize: map prop.normalize. isDeepCompatible: pairwise prop compat.
 *   getChildTypes: Object.keys(props). DataTypes: json, copy, compare, equals, accessor.
 *
 * ─── OptionalType<T> ──────────────────────────────────────────────────────
 *   D=T|undefined|null, O=Type<T>  (options IS the inner type, not wrapped).
 *   isOptional: true. getRequired: inner type. isWrapper: false (intentionally —
 *   it's treated as a distinct type, not transparent to simplification).
 *   isValid/normalize: accept null/undefined, else delegate to inner.
 *   getValidateExpression: OR(isUndefined, inner.validate).
 *   getValueChangeExpression: apply inner transform only if inner validates.
 *   random: ~30% → undefined.
 *
 * ─── ReferenceType ────────────────────────────────────────────────────────
 *   D=any, O=string (ref name). Like EntityType but resolves via
 *   TypeProvider.getData(name) → ReferenceData. isWrapper: false (but proxies).
 *   acceptsOtherTypes: true. getSimplifiedType delegates (unlike Entity).
 *
 * ─── SetType<V> ───────────────────────────────────────────────────────────
 *   D=Set<V>, O={ value: Type<V> }.
 *   Unique-member collection. isValid: Set instance + every member valid.
 *   normalize: build new Set with normalized members. isDeepCompatible: value
 *   type compat. JSON: { $any: 'set', value: [...] }. getValueChangeExpression
 *   maps transform over members.
 *
 * ─── TextType ─────────────────────────────────────────────────────────────
 *   D=string, O={ min?, max?, requireUpper?, requireLower?, forceUpper?,
 *                forceLower?, matches?: RegExp }.
 *   isValid: string + length + case predicates + regex. normalize: apply
 *   forceUpper/forceLower. merge: intersect constraints. isDeepCompatible:
 *   all constraints satisfied. getSubType: 'length' → LENGTH; numeric → CHAR.
 *   create: ''. random: random chars respecting constraints. regex round-trips
 *   as [source, flags]. Accessor exposes individual characters.
 *
 * ─── TupleType<E> ─────────────────────────────────────────────────────────
 *   D=E (heterogeneous array), O=Type[] (per-position).
 *   Fixed length, positional. getSubType: numeric index → elements[i];
 *   'length' → LENGTH; enum-of-valid-indices merged. getSubTypes: each index
 *   + length + an index-enum. isValid: array + exact length + each element valid.
 *   normalize: map element.normalize pairwise. merge: no-op (positions are fixed).
 *   isDeepCompatible: pairwise element compat. getSimplifiedType: self.
 *
 * -------------------------------------------------------------------------
 * CROSS-CUTTING PATTERNS → GIN MAPPING
 * -------------------------------------------------------------------------
 *
 * 1. Wrapper types (Optional, Enum, Entity, Reference, Generic)
 *    → in gin: single-generic type + `props.value` / `props.or` / narrowing helpers.
 *    Gin drops `isWrapper()` as an explicit flag; wrapping is just composition.
 *
 * 2. Constraint types (Number, Text, Date, List)
 *    → in gin: `options` carries the constraints, native get/validate enforces.
 *    No separate getValidateExpression — validation is a Native prop impl.
 *
 * 3. Composite types (Object, Map, List, Tuple, Set, Function)
 *    → in gin: `props` for named access, `get` for indexed access, `call` for
 *    callability. `getChildTypes/getSubTypes` collapse into prop/get metadata.
 *    `traverse` is replaced by walking the declarative structure.
 *
 * 4. Union (Many) / negation (Not)
 *    → in gin: `Or` and `Not` types. Operation merging is implicit: prop
 *    lookup on `Or` requires the prop to exist on all variants.
 *
 * 5. Lazy resolution (Entity, Reference, Generic, Function params)
 *    → in gin: `Registry.getType(name)` + generic resolution via `Registry.resolveGeneric`.
 *    FunctionTypeProvider thunks are replaced by type-level generics on `Call`.
 *
 * 6. Expression synthesis
 *    → Expangine: each type emits three Expressions (create/validate/compare)
 *    woven into a larger Expression program.
 *    → Gin: Expressions access behavior through PATH chains against a Type's
 *    `props`/`get`/`call`, backed by Native impls. The "create expression" is
 *    `{ kind: 'new', type, value? }`; validate/compare live as props (`eq`,
 *    `is`, etc.) — no per-type emission step is needed.
 *
 * 7. merge() vs. extends
 *    → Expangine's `merge` widens options when two samples are folded together
 *    during describe(). Gin's `extends` is a declarative inheritance directive
 *    processed at registration — there is no runtime merge step.
 *
 * 8. describe() / describePriority
 *    → Expangine auto-infers a Type from a sample value with priority tiebreaks.
 *    Gin has no equivalent yet: types are declared up-front (by devs or by LLMs
 *    via structured output), not inferred from data. A future `describe` pass
 *    would use the same priority idea to pick (e.g.) Num over Text for "42".
 */


// ============================================================================
// GIN TYPE — REVISED RUNTIME CLASS  (signatures only)
// ============================================================================

/**
 * The Type class for gin — with three-mode access, Extension, and a
 * TypeBuilder factory.
 *
 * Design shifts from expangine's abstract Type<D, O>:
 *
 *  (1) Navigation matches gin's THREE access modes (.name / [key] / (args)) —
 *      not a single "children" concept. Each mode has its own COMPUTED spec
 *      method. They're methods (not fields) so composite types derive them:
 *
 *          props()    Record<string, Prop>      for .name access
 *          get()      GetSet | undefined         for [key] access
 *          call()     Call   | undefined         for (args) invocation
 *          init()     Init   | undefined         for { kind: 'new' } construction
 *
 *      Derivation examples (Or/And follow TypeScript A|B / A&B semantics):
 *
 *          Or<[A,B]>   (like A | B)
 *              props()  = names in BOTH; per-name prop.type = A.type | B.type
 *              get()    = present iff both have get; key = intersection,
 *                         value = union (A.get.value | B.get.value)
 *              call()   = present iff both callable; args = intersection,
 *                         returns = union (A.returns | B.returns)
 *              init()   = present iff both have init; args = intersection
 *              → value dispatches to the active variant at runtime
 *
 *          And<[A,B]>  (like A & B)
 *              props()  = names in EITHER; per-name prop.type = A.type & B.type
 *                         (same-name different-type = error at build unless
 *                          intersectable)
 *              get/call/init likewise merge — args union, returns intersection
 *
 *          Optional<T>     props() = { value, or, has, map } overlay (not T's)
 *          Extension<T>    props() = { ...base.props(), ...local.props }
 *
 *  (2) Extension is a first-class Type subclass — the runtime manifestation
 *      of the declarative `extends` field. Holds (base, local) and delegates
 *      via the computed spec methods. Chain-able (base can be Extension too).
 *
 *  (3) TypeBuilder (conventionally `types`) is the factory everyone uses to
 *      construct Types. No code imports concrete type classes — kills circular
 *      deps and lets built-ins be swapped. Parses JSON schemas via `from()`.
 *
 *  (4) Path walking is composable: follow(step) resolves ONE PathStep;
 *      at(path) folds it over a whole Path. Replaces child/children/sub/subs.
 *
 * Value-side stays minimal: valid / parse / dump / create / random.
 * Everything else (eq, compare, clone-a-value, add, map…) is a PROP invoked
 * through Expr paths, not a method on Type.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *
 * abstract class Type<T = any, O = any> {
 *
 *     // ─── identity / config ────────────────────────────────────────────
 *     readonly name: string;
 *     readonly options: O;
 *     readonly priority: number;              // describe() tiebreak — higher wins
 *     readonly docs?: string;
 *
 *     // ─── value operations (raw T) ─────────────────────────────────────
 *     abstract valid(raw: unknown): raw is T;
 *     abstract parse(json: unknown): Value<T>;
 *     abstract dump(raw: T): unknown;
 *     abstract create(): T;
 *     abstract random(rnd: Rnd): T;
 *
 *     // ─── type ↔ type relations ────────────────────────────────────────
 *     abstract compatible(other: Type, opts?: CompatOptions): boolean;
 *     accepts(other: Type): boolean;          // compatible(other, { strict: true })
 *     exact(other: Type): boolean;            // compatible(other, { strict: true, exact: true })
 *     flexible(): boolean;                    // cross-class acceptor (Any, Ref, …)
 *
 *     // ─── type algebra ─────────────────────────────────────────────────
 *     abstract or(other: Type<T>): Type<T>;   // widen / merge (same class)
 *     simplify(): Type;                       // canonical form
 *     required(): Type;                       // strip Optional / Nullable
 *
 *     // ─── options narrowing (used by Extension, TypeBuilder.extend) ────
 *     abstract narrow(options: Partial<O>): O;
 *     //   Merges `options` on top of this.options, enforcing per-type
 *     //   directional rules (Num.min ≥, Num.max ≤, regex ⊂ regex, etc.).
 *     //   Throws if the merge would WIDEN the constraint space.
 *     //   Returns the merged, narrower options. Used everywhere one type
 *     //   inherits/refines another's options.
 *
 *     // ─── effective access specs (computed; composite types override) ──
 *     abstract props(): Record<string, Prop>;
 *     abstract get():   GetSet | undefined;
 *     abstract call():  Call   | undefined;
 *     abstract init():  Init   | undefined;
 *
 *     prop(name: string): Prop | undefined;   // convenience over props()
 *
 *     // ─── path walking (default impls compose the spec methods) ────────
 *     follow(step: PathStep): Type | undefined;
 *     //   {prop}  → this.prop(step.prop)?.type
 *     //   {args}  → this.call()?.returns
 *     //   {key}   → this.get()?.value       (Tuple overrides for positional)
 *
 *     at(path: Path): Type | undefined;       // path.reduce((t,s) => t?.follow(s), this)
 *
 *     // ─── schema round-trip ────────────────────────────────────────────
 *     abstract encode(): object;              // Type → Type<T,O> JSON schema shape
 *     abstract clone(): Type<T, O>;           // deep copy the TYPE
 *
 *     // ─── type inference from sample data (optional) ───────────────────
 *     describe?(data: unknown, cache?: Map<unknown, Type>): Type | undefined;
 * }
 *
 *
 * // ─── EXTENSION ─────────────────────────────────────────────────────────
 *
 * /**
 *  * Extension<T, O> — runtime class for any type declared with `extends`.
 *  *
 *  * Lifecycle:
 *  *   1. LLM (or developer) emits a Type JSON with extends:
 *  *        { name: 'temperature', extends: 'number',
 *  *          options: { min: -273.15, suffix: '°C' },
 *  *          props:   { toFahrenheit: {...}, toKelvin: {...} } }
 *  *
 *  *   2. Registry resolves `extends` to the base runtime Type and constructs:
 *  *        new Extension({ base: <Num runtime>, name: 'temperature',
 *  *                        local: { options, props } })
 *  *
 *  *   3. At use-site, computed specs delegate with local overlay:
 *  *        props()  ⟹ { ...base.props(), ...local.props }   // local wins per key
 *  *        get()    ⟹ local.get  ?? base.get()
 *  *        call()   ⟹ local.call ?? base.call()
 *  *        init()   ⟹ local.init ?? base.init()
 *  *        options  ⟹ narrowed view over base.options  (see rule below)
 *  *
 *  *      Value ops delegate to base, enforcing tighter local constraints:
 *  *        valid(x)  ⟹ base.valid(x)  && enforce(local.options, x)
 *  *        parse(j)  ⟹ base.parse(j)   then re-validate against local
 *  *        dump(v)   ⟹ base.dump(v)
 *  *        create()  ⟹ local.init?.run() ?? base.create()
 *  *        random()  ⟹ base.random() (local options narrow the bounds)
 *  *
 *  * Options narrowing rule (enforced at registration):
 *  *   local.options MAY ONLY TIGHTEN base.options — never widen.
 *  *   Extension's constructor runs:
 *  *       this.options = local.options ? base.narrow(local.options) : base.options
 *  *   — delegating the per-type directional check to the base's narrow():
 *  *     - Num.min / max / whole: local.min ≥ base.min, local.max ≤ base.max,
 *  *                              local.whole ⇒ base.whole (or base unset)
 *  *     - Text.minLength / maxLength / pattern: same directional logic
 *  *     - List.minLength / maxLength: same
 *  *   narrow() throws on a widening attempt, which surfaces as a registration
 *  *   error. This preserves the invariant that every Extension value is also
 *  *   a valid base value — the foundation for Extension being compatible
 *  *   with its base in non-exact mode.
 *  *
 *  * Overriding:
 *  *   local.props.foo REPLACES base.props.foo. The override reaches the
 *  *   prior impl via the `super?` field already defined in PropGet/Set/
 *  *   IndexGet/Set/CallGet/Set scopes at the top of this file. So
 *  *   `super(args)` in a Lambda body = "call the base's version".
 *  *
 *  * Compatibility:
 *  *   Extension is compatible with its base in non-exact mode (covariant).
 *  *   Another Extension sharing an ancestor + compatible local overrides is
 *  *   also compatible. `exact: true` breaks both (requires literal match).
 *  *
 *  * Multi-level:
 *  *   base can itself be an Extension. Resolution walks the chain; it can
 *  *   be flattened at registration for lookup performance.
 *  *\/
 * abstract class Extension<T = any, O = any> extends Type<T, O> {
 *
 *     readonly base: Type<T>;                 // the type being extended
 *     readonly local: {                       // what's NEW or OVERRIDDEN here
 *         options?: Partial<O>;
 *         props?:   Record<string, Prop>;
 *         get?:     GetSet;
 *         call?:    Call;
 *         init?:    Init;
 *     };
 *
 *     // All Type methods inherited. Default impls on Extension implement the
 *     // "delegate to base, overlay local" pattern — concrete subclasses
 *     // rarely need to override anything.
 * }
 *
 *
 * // ─── TYPE BUILDER ──────────────────────────────────────────────────────
 *
 * /**
 *  * TypeBuilder — factory for constructing runtime Type instances.
 *  *
 *  * Conventionally passed as `types`. Code that needs to BUILD a type takes
 *  * a TypeBuilder rather than importing concrete classes. Benefits:
 *  *   (a) eliminates circular deps between type modules,
 *  *   (b) lets tests inject a mock / trimmed-down builder,
 *  *   (c) single entry point for parsing LLM-emitted JSON (`from`).
 *  *
 *  * Usage:
 *  *   function userType(types: TypeBuilder): Type {
 *  *       return types.obj({
 *  *           name: { type: types.text() },
 *  *           age:  { type: types.optional(types.num({ min: 0 })) },
 *  *           tags: { type: types.list(types.text()) }
 *  *       });
 *  *   }
 *  *\/
 * interface TypeBuilder {
 *
 *     // primitives
 *     any():  Type<any>;
 *     void(): Type<void>;
 *     null(): Type<null>;
 *     bool(options?: BoolOptions):    Type<boolean>;
 *     num(options?:  NumOptions):     Type<number>;
 *     text(options?: TextOptions):    Type<string>;
 *
 *     // containers
 *     list<V>(item: Type<V>, options?: ListOptions):            Type<V[]>;
 *     map<K, V>(key: Type<K>, value: Type<V>):                  Type;
 *     set<V>(value: Type<V>):                                   Type<Set<V>>;
 *     tuple<T extends any[]>(elements: { [I in keyof T]: Type<T[I]> }): Type<T>;
 *     obj<T extends object>(props: Record<string, Prop>):       Type<T>;
 *
 *     // modifiers
 *     optional<T>(inner: Type<T>):    Type<T | undefined>;
 *     nullable<T>(inner: Type<T>):    Type<T | null>;
 *     or(variants: Type[]):           Type;
 *     and(parts: Type[]):             Type;
 *     not(excluded: Type):            Type;
 *
 *     // constants
 *     enum<V>(values: Record<string, V>, value: Type<V>): Type<V>;
 *
 *     // temporal
 *     date():      Type<string>;
 *     timestamp(): Type<string>;
 *     duration():  Type<number>;
 *
 *     // visual
 *     color(options?: ColorOptions): Type<number>;
 *
 *     // callables
 *     fn<A extends object, R = any, E = any>(
 *         args: Type<A>,
 *         returns?: Type<R>,
 *         throws?: Type<E>
 *     ): Type;
 *
 *     // interfaces (structural contracts)
 *     iface(spec: Partial<Type>): Type;
 *
 *     // references & generics
 *     ref(name: string):     Type;         // look up a registered type by name
 *     generic(name: string): Type;         // placeholder bound at call site
 *
 *     // extension — runtime `extends`
 *     extend<T, O>(
 *         base: Type<T> | string,          // type instance or registered name
 *         local: {
 *             name: string;
 *             docs?: string;
 *             options?: Partial<O>;
 *             props?: Record<string, Prop>;
 *             get?:   GetSet;
 *             call?:  Call;
 *             init?:  Init;
 *         }
 *     ): Extension<T, O>;
 *
 *     // parse — JSON Type schema → runtime Type instance
 *     from(json: unknown): Type;
 * }
 *
 *
 * // ─── SUPPORTING TYPES ──────────────────────────────────────────────────
 *
 * interface CompatOptions {
 *     strict?: boolean;    // require same class (no cross-class structural match)
 *     value?:  boolean;    // enforce options constraints (ranges, regex, bounds)
 *     exact?:  boolean;    // no unwrapping (Optional<T> not compatible with T)
 * }
 *
 * interface Init<TArgs extends object = any> {
 *     docs?: string;
 *     args:  Type<TArgs>;
 *     run:   Expr<void, InitScope<TArgs>>;
 * }
 *
 * type Rnd = (min: number, max: number, whole: boolean) => number;
 *
 *
 * ───────────────────────────────────────────────────────────────────────────
 *
 * EXPANGINE → GIN METHOD MAPPING  (updated cheat sheet)
 *
 *   isValid                   →  valid
 *   isCompatible              →  compatible
 *   isDeepCompatible          →  (internal to compatible)
 *   acceptsType               →  accepts
 *   acceptsData               →  accepts with { value: true }
 *   exactType                 →  exact
 *   acceptsOtherTypes         →  flexible
 *   merge                     →  or
 *   getSimplifiedType         →  simplify
 *   getRequired               →  required
 *   fromJson                  →  parse
 *   toJson                    →  dump
 *   newInstance / clone       →  clone
 *   TypeClass.encode          →  encode
 *   describePriority          →  priority (field)
 *   describe                  →  describe
 *   getOperations             →  props()                (operations ARE props)
 *
 *   getChildType (.name)      →  prop(name)
 *   getChildType ([key])      →  get()?.value
 *   getChildTypes             →  Object.keys(props())
 *   getSubType(expr)          →  follow(step)
 *   getSubTypes               →  enumerate props() / get() / call()
 *
 *   TypeClass.register w/ base→  Extension + TypeBuilder.extend()
 *   super calls on overrides  →  super? scope field (already in poc scope types)
 *
 *   getExactType              →  DROPPED (values carry their type)
 *   getCreateExpression       →  DROPPED (init.run + { kind: 'new' })
 *   getValidateExpression     →  DROPPED (props / native validation)
 *   getCompareExpression      →  DROPPED (props.eq / lt / …)
 *   traverse / setParent      →  DROPPED (declarative walk; scope owns parent)
 *   getValueChangeExpression  →  DROPPED (prop.set / get.set handle writes)
 *   isWrapper / getWrappedType→  DROPPED (wrapping is composition; no flag)
 *   isOptional / isSimple     →  DROPPED (read from structure)
 *   getPath / getRootType     →  DROPPED (engine / scope concern)
 *   normalize                 →  folded into parse
 */