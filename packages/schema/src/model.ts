/**
 * From a model to its profiles. The family and strictness come from the
 * model's own capabilities (`@aeye/models`: `strictFormat`, `'toolsStrict'`,
 * `'structured'`, `'json'`), mirroring `@aeye/ai`'s `resolveStrictFormat` and
 * `buildSchemaBudget`, so a call site never picks a profile by hand.
 */
import { familyProfile, OPENAI_FINETUNED_STRICT, type Profile, type ProfileFamily } from './profile';
import { planRequest, type RenderedRequest, type RequestItem } from './request';

/**
 * A model, structurally — `@aeye/ai`'s `ModelInfo` (and `@aeye/models`'
 * entries with `strictSupport` applied) fit as they are.
 */
export interface ModelLike {
  readonly id: string;
  readonly provider: string;
  /** `@aeye/models` `strictSupport` pins this; `'none'` opts out. */
  readonly strictFormat?: string;
  /** `'toolsStrict'` → strict tools; `'structured'` → structured output (strict where the family has it). */
  readonly capabilities?: ReadonlySet<string> | readonly string[];
}

const PROVIDER_FAMILY: Record<string, ProfileFamily> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  gemini: 'google',
  xai: 'xai',
  'x-ai': 'xai',
  ollama: 'ollama',
};

/** The family a model's schemas are written for (see `@aeye/ai` `resolveStrictFormat`). */
export function familyOf(model: ModelLike): ProfileFamily {
  if (model.strictFormat === 'none') return model.provider === 'ollama' ? 'ollama' : 'lenient';
  if (model.strictFormat) return PROVIDER_FAMILY[model.strictFormat] ?? model.strictFormat;
  const id = model.id.replace(/^~/, '');
  if (model.provider === 'aws') {
    // Bedrock ids are `[region.]vendor.model`: Claude speaks Anthropic's dialect through Converse.
    return /(^|\.)anthropic\.claude/.test(id) ? 'anthropic' : 'lenient';
  }
  const direct = PROVIDER_FAMILY[model.provider];
  if (direct) return direct;
  // Routers (OpenRouter and the like) pass the schema through to the
  // upstream family named by the id prefix. Open-weight models under a vendor
  // prefix are served by third-party hosts with their own rules
  // (`@aeye/models` strictSupport pins them to 'none').
  if (/^(openai\/gpt-oss|google\/gemma)/.test(id)) return 'lenient';
  const slash = id.indexOf('/');
  return slash > 0 ? PROVIDER_FAMILY[id.slice(0, slash)] ?? 'lenient' : 'lenient';
}

function has(caps: ModelLike['capabilities'], cap: string): boolean {
  if (!caps) return false;
  return Array.isArray(caps) ? caps.includes(cap) : (caps as ReadonlySet<string>).has(cap);
}

/**
 * What one model reads: the profile for its tool arguments, the profile for
 * its structured output, and how output is delivered. Start a request with
 * `request(items)`.
 */
export class ModelProfile {
  constructor(
    readonly tool: Profile,
    readonly output: Profile = tool,
    /** `'prompt'` when the model has no structured output: the schema goes as prompt text. */
    readonly outputDelivery: 'structured' | 'prompt' = 'structured',
  ) {}

  /**
   * Render every schema of one request together, so the request as a whole
   * fits this model's limits (see `planRequest`). Each entry records what
   * its schema was rendered with; parse and encode through the entry.
   */
  request<const I extends readonly RequestItem[]>(items: I): RenderedRequest<I> {
    return planRequest(this, items);
  }

  /** Both kinds through one profile. */
  static of(profile: Profile): ModelProfile {
    return new ModelProfile(profile, profile);
  }
}

/**
 * The profiles for a model, from its capabilities (`@aeye/models`):
 *
 * - the family comes from `strictFormat`, else the provider, else the
 *   `vendor/` id prefix (OpenRouter passes schemas through to the upstream);
 * - tools are strict when the model has `'toolsStrict'`, except xAI, whose
 *   tools are always strict;
 * - output is strict structured output when the model has `'structured'`;
 *   with neither `'structured'` nor a family that offers non-strict output,
 *   the schema is delivered as prompt text;
 * - OpenAI fine-tunes (`ft:` ids) get the stripped fine-tune dialect;
 * - `speaks` limits the families a provider can send (others are LENIENT).
 */
export function profileFor(model: ModelLike, opts: { speaks?: ReadonlySet<string> } = {}): ModelProfile {
  let family = familyOf(model);
  if (opts.speaks && !opts.speaks.has(family)) family = 'lenient';
  const toolsStrict = family === 'xai' || has(model.capabilities, 'toolsStrict');
  const structured = has(model.capabilities, 'structured');
  const finetuned = family === 'openai' && /(^|\/)ft:/.test(model.id);
  const pick = (strict: boolean): Profile =>
    finetuned && strict ? OPENAI_FINETUNED_STRICT : familyProfile(family, strict);
  const tool = pick(toolsStrict);
  const output = pick(structured);
  // Bedrock's Converse has no non-strict json_schema (packages/aws), and a
  // model with no structured output at all gets the schema as prompt text.
  const delivery = !structured && (model.provider === 'aws' || output.alwaysStrictOutput || familyProfile(family, true).alwaysStrictOutput || !has(model.capabilities, 'json'))
    ? 'prompt'
    : 'structured';
  return new ModelProfile(tool, output, delivery);
}

