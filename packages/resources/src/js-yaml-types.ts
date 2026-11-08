/**
 * The part of js-yaml (an optional peer dependency, without types) the yaml converter uses, common to versions 3 and
 * 4. Loading with `CORE_SCHEMA` is safe in both (no custom tags, timestamps kept as strings). It is read from the
 * module's default export, which both the CommonJS build (through interop) and the ES module build have.
 */
declare module "js-yaml" {
  interface Schema {
    readonly __schema: unique symbol;
  }
  interface LoadOptions {
    schema?: Schema;
  }
  interface DumpOptions {
    schema?: Schema;
    indent?: number;
    lineWidth?: number;
    noRefs?: boolean;
  }
  interface JsYaml {
    readonly CORE_SCHEMA: Schema;
    loadAll(text: string, iterator: undefined, options?: LoadOptions): unknown[];
    dump(value: unknown, options?: DumpOptions): string;
  }
  const yaml: JsYaml;
  export default yaml;
}
