/**
 * Optional peer dependencies, loaded on first use. A missing package is not an error: the loader gives undefined and
 * the converter or parser that needs it declines or reports itself unsupported.
 */

/** A cached loader for an optional module: the module once it has loaded, or undefined when it is not installed. */
export function optionalModule<T>(load: () => Promise<T>): () => Promise<T | undefined> {
  let loading: Promise<T | undefined> | undefined;
  return () => {
    loading ??= load().catch(() => undefined);
    return loading;
  };
}

/** The error thrown when a format's optional dependency is not installed. */
export function missingDependency(packageName: string, format: string): Error {
  return new Error(`${packageName} is not installed. Install it to read ${format} resources: npm install ${packageName}`);
}
