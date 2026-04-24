import type { Registry, Value, Type } from '@aeye/gin';
import { val } from '@aeye/gin';

export function createFetchImpl(registry: Registry) {
  return async (argsValue: Value): Promise<Value> => {
    const args = argsValue.raw as Record<string, Value>;
    const url = (args['url']?.raw ?? '') as string;
    const method = ((args['method']?.raw as string | null) ?? 'get').toUpperCase();

    const headersRaw = args['headers']?.raw as Record<string, Value> | null | undefined;
    const headersObj: Record<string, string> = {};
    if (headersRaw && typeof headersRaw === 'object') {
      for (const [k, v] of Object.entries(headersRaw)) {
        headersObj[k] = (v instanceof Object && 'raw' in v ? (v as Value).raw : v) as string;
      }
    }

    const bodyRaw = args['body']?.raw;
    let bodyStr: string | undefined;
    if (bodyRaw !== undefined && bodyRaw !== null) {
      bodyStr = typeof bodyRaw === 'string' ? bodyRaw : JSON.stringify(bodyRaw);
    }

    const outputType = args['output']?.raw as Type | undefined;

    let bodyText = '';
    try {
      const resp = await globalThis.fetch(url, {
        method,
        headers: Object.keys(headersObj).length > 0 ? headersObj : undefined,
        body: bodyStr,
      });
      bodyText = await resp.text();
    } catch (e: unknown) {
      bodyText = e instanceof Error ? e.message : String(e);
    }

    if (outputType) {
      try {
        const bodyJson = JSON.parse(bodyText);
        return outputType.parse(bodyJson);
      } catch { /* fall through to text */ }
    }

    return val(registry.text(), bodyText);
  };
}

export function registerFetchType(registry: Registry) {
  const httpMethod = registry.enum(
    { get: 'get', post: 'post', put: 'put', patch: 'patch', delete: 'delete', head: 'head' },
    registry.text(),
  );

  return registry.fn(
    registry.obj({
      url:     { type: registry.text(), docs: 'URL to fetch' },
      method:  { type: registry.optional(httpMethod) },
      headers: { type: registry.optional(registry.map(registry.text(), registry.text())) },
      body:    { type: registry.optional(registry.any()) },
      output:  {
        type: registry.optional(registry.typ(registry.generic('R'))),
        docs: 'gin Type to parse the JSON response body through — unifies R in the return type.',
      },
    }),
    registry.generic('R'),
    undefined,
    { R: registry.text() },
  );
}
