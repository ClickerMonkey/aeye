/**
 * Ollama's native API (`/api/tags`, `/api/show`, `/api/version`): which
 * models a server has, what each can do, and the context window it serves
 * each with.
 *
 * The served window is the one that matters: Ollama runs a model with its
 * Modelfile's `num_ctx` (or its own default) and silently cuts the front of
 * a longer prompt, whatever length the model was trained to, and its
 * OpenAI-compatible endpoint takes no `num_ctx`.
 */

/**
 * Where a local Ollama listens by default.
 */
export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

/**
 * The window Ollama served before 0.6 when a Modelfile set no `num_ctx`.
 */
export const OLLAMA_LEGACY_CTX = 2_048;

/**
 * The window Ollama serves from 0.6 when a Modelfile sets no `num_ctx`.
 */
export const OLLAMA_CTX = 4_096;

/**
 * What `/api/show` says about a model.
 */
export interface OllamaShow {
  // Modelfile parameters, one `name value` per line (`num_ctx 8192`)
  parameters?: string;
  // The chat template
  template?: string;
  // `<architecture>.context_length` is the trained length
  model_info?: Record<string, unknown>;
  // What the model does, on newer servers: `completion`, `tools`,
  // `thinking`, `vision`, `embedding`, `decision`
  capabilities?: string[];
  details?: { family?: string; parameter_size?: string };
}

/**
 * What `/api/tags` lists.
 */
export interface OllamaTags {
  models: Array<{ name: string; model: string }>;
}

/**
 * Ollama's native API, over an injectable `fetch`.
 */
export class OllamaApi {
  readonly baseURL: string;
  private readonly fetcher: typeof fetch;
  private readonly headers: Record<string, string>;

  /**
   * @param baseURL Where Ollama listens (its root, not `/v1`)
   * @param fetcher The `fetch` to call it with
   * @param apiKey A key, for Ollama's cloud
   */
  constructor(baseURL: string = OLLAMA_BASE_URL, fetcher: typeof fetch = fetch, apiKey?: string) {
    this.baseURL = baseURL.replace(/\/+$/, '');
    this.fetcher = fetcher;
    this.headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  }

  /**
   * The models the server has.
   */
  async tags(): Promise<OllamaTags> {
    return this.json<OllamaTags>('/api/tags');
  }

  /**
   * What one model is and can do.
   */
  async show(model: string): Promise<OllamaShow> {
    return this.json<OllamaShow>('/api/show', { model });
  }

  /**
   * The server's version (`0.6.2`).
   */
  async version(): Promise<string> {
    return (await this.json<{ version: string }>('/api/version')).version;
  }

  private async json<T>(path: string, body?: Record<string, string>): Promise<T> {
    const init: RequestInit = body === undefined
      ? { headers: this.headers }
      : { method: 'POST', headers: { ...this.headers, 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const response = await this.fetcher(`${this.baseURL}${path}`, init);
    if (!response.ok) {
      throw new Error(`Ollama ${path} answered ${response.status}`);
    }
    return response.json() as Promise<T>;
  }
}

/**
 * The `num_ctx` a Modelfile sets, if any.
 */
export function numCtxOf(show: OllamaShow): number | undefined {
  const line = show.parameters?.split('\n').map((l) => l.trim().split(/\s+/)).find(([name]) => name === 'num_ctx');
  const value = Number(line?.[1]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * The length the model was trained to (`<architecture>.context_length`).
 */
export function trainedLengthOf(show: OllamaShow): number | undefined {
  for (const [key, value] of Object.entries(show.model_info ?? {})) {
    if (key.endsWith('.context_length') && typeof value === 'number') {
      return value;
    }
  }
  return undefined;
}

/**
 * The window Ollama serves when nothing sets `num_ctx`, by its version
 * (`0.5.7` → 2048).
 */
export function servedDefault(version: string): number {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major === 0 && minor < 6 ? OLLAMA_LEGACY_CTX : OLLAMA_CTX;
}

/**
 * The window a server serves a model with when its Modelfile sets no
 * `num_ctx`: the configured one (the server may set
 * `OLLAMA_CONTEXT_LENGTH`), else Ollama's default for its version, held to
 * `max`.
 */
export function unsetWindow(version: string, configured: number | undefined, max: number = Number.POSITIVE_INFINITY): number {
  return configured ?? Math.min(max, servedDefault(version));
}

/**
 * The window a model is served with: its Modelfile's `num_ctx`, else
 * `unset` (see `unsetWindow`), never more than it was trained to.
 */
export function servedWindow(show: OllamaShow, unset: number): number {
  return Math.min(numCtxOf(show) ?? unset, trainedLengthOf(show) ?? Number.POSITIVE_INFINITY);
}

/**
 * Whether a model takes native tools: listed as an ability, or its template
 * renders `.Tools`.
 */
export function takesTools(show: OllamaShow): boolean {
  return show.capabilities?.includes('tools') ?? show.template?.includes('.Tools') ?? false;
}

/**
 * Whether a model thinks before it answers (its thinking counts against its
 * output).
 */
export function reasons(model: string, show: OllamaShow): boolean {
  return show.capabilities?.includes('thinking') ?? (/(^|[^a-z])(r1|qwq|think)/i.test(model) || (show.template?.includes('<think>') ?? false));
}
