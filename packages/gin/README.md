GIN programming language

This language is stored as JSON to be easily developed by AI where it can be interpreted in any language.
The core types and core functions are a foundation for the user and AI to build upon.
The instruction set is simple, most of the functionality lies in methods that exist on types.

```ts
interface Type<T = any> {
    name: string;
    fromJSON(config: P);
    toJSON(): any;
    toSchema(): z.ZodSchema;
    validate(value: T): true | Error;
    parse(value: string): number | Error;
    merge(other: Type);
    isDeepCompatible(other: Type, options: TypeCompatibleOptions): boolean;
    getNexts(mem?: Memory): [string, Type][]
    getNext(name: string, mem?: Memory): Type
}
class TypeObject<O extends object = object> extends Type<O> {}
class TypeNumber extends Type<number> {}
class TypeInterface extends Type<any> {}
class TypeString extends Type<string> {}
class TypeList<T> extends Type<T[]> {}

type Memory = TypeObject<{
    input: TypeObject;
    output: TypeAny;
    global:
}>
interface Memory<I extends object = object, O extends object = object> {
    vars: Record<string, any>
    input: I
    output: O
    global: Record<string, any>
}
interface Value<T> {
    get(): Promise<T>;
    set?(value: T): void;
    type(): Type<T>;
}
interface System {
    types(): Type<any>[]
    memory(): Memory
}
interface Instruction<T> {
    kind: string;
    get(os: System): Promise<T>;
    set?:(os: System, value: T): Promise<void>;
}
interface If<T = any> extends Instruction<T> { kind: 'if', ifs: { condition: Instruction<boolean>, then: Instruction<T> }[], else?: Instruction<T> }
interface Set<T> extends Instruction<T> { kind: 'set', path: { name: string, args?: Instruction<object> }[], value: Instruction<T> }
interface Get<T> extends Instruction<T> { kind: 'get', path: { name: string, args?: Instruction<object> }[] }
interface Define extends Instruction<void> { kind: 'define', vars: { name: string, value: Instruction<any> }[] }
interface New<T> extends Instruction<T> { kind: 'new', type: Type<T>, value?: T }
interface Loop<T, V> extends Instruction<T> { kind: 'loop', var?: { name: string, value: Instruction<V> }, condition: Instruction<boolean>, end?: Instruction<V>, then: Instruction<T> }
interface Template extends Instruction<string> { kind: 'template', template: string, args: Instruction<object> }
interface Switch<T, V> extends Instruction<T> { kind: 'switch', value: Instruction<V>, cases: { equals: Instruction<V>[], then: Instruction<T> }[], otherwise?: Instruction<T> }
interface Copy<T> extends Instruction<T> { kind: 'copy', value: Instruction<V>, deep?: boolean }
interface Return extends Instruction<void> { kind: 'return' }


// gin defs
gin.addNativeType<number>({
    kind: 'number',
    parse: 
})
gin.addNativeFunction({
    name: 'sqrt',
    params: gin.object({
        value: gin.number()
    }),
    returns: gin.number(),
})
gin.addNativeFunction({
    name: 'length',
    templates: {
        T: gin.interface({ length: gin.number() }),
    },
    params: ({T}) => gin.object({
        value: T
    }),
    returns: gin.number(),
})

// gin TypeScript runtime
const run = new GinRuntime(gin)
run.setNativeFunction('sqrt', ({ value }) => Math.sqrt(value))
run.setNativeFunction('length', ({ value }) => value.length)

```

