/**
 * Compile-time checks run under the strictest settings a consumer may use
 * (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`): every provider
 * class is a `Provider` as it stands, with no cast or delegate. A class that
 * declares an optional member as `T | undefined` (for example
 * `defaultMetadata?: Provider['defaultMetadata']`) fails here.
 *
 * Run with `npm run test:types` at the repository root.
 */
import type { Provider } from '@aeye/ai';
import { OpenAIProvider } from '@aeye/openai';
import { OpenRouterProvider } from '@aeye/openrouter';
import { ReplicateProvider } from '@aeye/replicate';
import { AWSBedrockProvider } from '@aeye/aws';

export const openai: Provider = new OpenAIProvider({ apiKey: 'key' });
export const openrouter: Provider = new OpenRouterProvider({ apiKey: 'key' });
export const replicate: Provider = new ReplicateProvider({ apiKey: 'key' });
export const bedrock: Provider = new AWSBedrockProvider({ region: 'us-east-1' });
