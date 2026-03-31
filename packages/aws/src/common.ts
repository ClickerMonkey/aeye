import { FoundationModelSummary } from "@aws-sdk/client-bedrock";
import { ModelCapability, ModelInfo, ModelTier } from "@aeye/ai";

export type AWSFamily = "anthropic" | "meta" | "mistral" | "cohere" | "ai21" | "amazon" | "stability" | "unknown";

/**
* Detect model family from model ID
*/
export function detectAWSFamily(modelId: string): AWSFamily {
  if (modelId.startsWith('anthropic.')) return 'anthropic';
  if (modelId.startsWith('meta.')) return 'meta';
  if (modelId.startsWith('mistral.')) return 'mistral';
  if (modelId.startsWith('cohere.')) return 'cohere';
  if (modelId.startsWith('ai21.')) return 'ai21';
  if (modelId.startsWith('amazon.')) return 'amazon';
  if (modelId.startsWith('stability.')) return 'stability';
  return 'unknown';
}

/**
* Detect capabilities from model information
*/
export function detectAWSCapabilities(model: FoundationModelSummary): Set<ModelCapability> {
  const capabilities = new Set<ModelCapability>();
  const modelId = model.modelId || '';
  const family = detectAWSFamily(modelId);
  
  // Check for chat capability (text-to-text models)
  if (
    model.inputModalities?.includes('TEXT') &&
    model.outputModalities?.includes('TEXT')
  ) {
    // Chat models
    if (
      family === 'anthropic' ||
      family === 'meta' ||
      family === 'mistral' ||
      family === 'cohere' ||
      family === 'ai21' ||
      (family === 'amazon' && modelId.includes('text'))
    ) {
      capabilities.add('chat');
      
      // Streaming support
      if (model.responseStreamingSupported) {
        capabilities.add('streaming');
      }
    }
  }
  
  // Image generation
  if (
    model.inputModalities?.includes('TEXT') &&
    model.outputModalities?.includes('IMAGE')
  ) {
    capabilities.add('image');
  }
  
  // Vision (image understanding)
  if (
    model.inputModalities?.includes('IMAGE') &&
    model.outputModalities?.includes('TEXT')
  ) {
    capabilities.add('vision');
  }
  
  // Embeddings
  if (family === 'amazon' && modelId.includes('embed')) {
    capabilities.add('embedding');
  }
  if (family === 'cohere' && modelId.includes('embed')) {
    capabilities.add('embedding');
  }
  
  // Tool calling via the Converse API - supported by chat-capable models in these families
  if (
    (family === 'anthropic' && modelId.includes('claude')) ||
    (family === 'meta' && (modelId.includes('llama3-1') || modelId.includes('llama3-2') || modelId.includes('llama3-3'))) ||
    (family === 'mistral' && modelId.includes('large')) ||
    (family === 'cohere' && (modelId.includes('command-r')))
  ) {
    capabilities.add('tools');
  }
  
  return capabilities;
}

/**
* Detect model tier based on family and model ID
*/
export function detectAWSTier(family: AWSFamily, modelId: string): ModelTier {
  let tier: ModelTier = 'efficient';
  if (family === 'anthropic' && modelId.includes('opus')) {
    tier = 'flagship';
  } else if (family === 'anthropic' && modelId.includes('sonnet')) {
    tier = 'efficient';
  } else if (family === 'anthropic' && modelId.includes('haiku')) {
    tier = 'efficient';
  } else if (family === 'meta' && (modelId.includes('405b') || modelId.includes('90b'))) {
    tier = 'flagship';
  } else if (family === 'meta' && (modelId.includes('70b') || modelId.includes('13b'))) {
    tier = 'efficient';
  } else if (family === 'meta' && (modelId.includes('8b') || modelId.includes('7b') || modelId.includes('3b') || modelId.includes('1b'))) {
    tier = 'efficient';
  } else if (family === 'mistral' && modelId.includes('large')) {
    tier = 'flagship';
  } else if (family === 'mistral' && modelId.includes('mixtral')) {
    tier = 'efficient';
  } else if (family === 'mistral' && modelId.includes('7b')) {
    tier = 'efficient';
  } else if (family === 'cohere' && modelId.includes('plus')) {
    tier = 'flagship';
  } else {
    tier = 'efficient';
  }
  
  return tier;
};


/**
* Convert AWS Bedrock model to ModelInfo format
*/
export function convertAWSModel(model: FoundationModelSummary): ModelInfo | null {
  const modelId = model.modelId;
  if (!modelId) return null;
  
  const family = detectAWSFamily(modelId);
  const capabilities = detectAWSCapabilities(model);
  const tier = detectAWSTier(family, modelId);
  const metadata = MODEL_METADATA[modelId] || {};
  
  return {
    provider: 'aws',
    id: modelId,
    name: model.modelName || modelId,
    capabilities,
    tier,
    contextWindow: 0,
    pricing: {},
    ...metadata,
    metadata: {
      modelArn: model.modelArn,
      providerName: model.providerName,
      responseStreamingSupported: model.responseStreamingSupported,
      customizationsSupported: model.customizationsSupported,
      inferenceTypesSupported: model.inferenceTypesSupported,
      inputModalities: model.inputModalities,
      outputModalities: model.outputModalities,
    },
  };
}


const MODEL_METADATA: Record<string, Partial<ModelInfo>> = {
  // Anthropic Claude Sonnet
  'anthropic.claude-3-sonnet-20240229-v1:0': { pricing: { text: { input: 3, output: 15 } }, contextWindow: 200000, maxOutputTokens: 4096 },
  'anthropic.claude-3-5-sonnet-20240620-v1:0': { pricing: { text: { input: 3, output: 15 } }, contextWindow: 200000, maxOutputTokens: 8192 },
  'anthropic.claude-3-5-sonnet-20241022-v2:0': { pricing: { text: { input: 3, output: 15 } }, contextWindow: 200000, maxOutputTokens: 8192 },
  'anthropic.claude-3-7-sonnet-20250219-v1:0': { pricing: { text: { input: 3, output: 15 } }, contextWindow: 200000, maxOutputTokens: 8192 },
  'anthropic.claude-sonnet-4-20250514-v1:0': { pricing: { text: { input: 3, output: 15 } }, contextWindow: 200000, maxOutputTokens: 16384 },
  'anthropic.claude-sonnet-4-5-20250929-v1:0': { pricing: { text: { input: 3, output: 15 } }, contextWindow: 200000, maxOutputTokens: 16384 },

  // Anthropic Claude Haiku
  'anthropic.claude-3-haiku-20240307-v1:0': { pricing: { text: { input: 0.25, output: 1.25 } }, contextWindow: 200000, maxOutputTokens: 4096 },
  'anthropic.claude-3-haiku-20240307-v1:0:48k': { pricing: { text: { input: 0.25, output: 1.25 } }, contextWindow: 200000, maxOutputTokens: 8192 },
  'anthropic.claude-haiku-4-5-20251001-v1:0': { pricing: { text: { input: 1, output: 5 } }, contextWindow: 200000, maxOutputTokens: 16384 },
  // Anthropic Claude Opus
  'anthropic.claude-3-opus-20240229-v1:0': { pricing: { text: { input: 15, output: 75 } }, contextWindow: 200000, maxOutputTokens: 4096 },
  'anthropic.claude-opus-4-20250514-v1:0': { pricing: { text: { input: 15, output: 75 } }, contextWindow: 200000, maxOutputTokens: 16384 },
  'anthropic.claude-opus-4-1-20250805-v1:0': { pricing: { text: { input: 15, output: 75 } }, contextWindow: 200000, maxOutputTokens: 16384 },
  // Anthropic Claude 2.x
  'anthropic.claude-v2:1': { pricing: { text: { input: 8, output: 24 } }, contextWindow: 100000, maxOutputTokens: 4096 },
  'anthropic.claude-v2': { pricing: { text: { input: 8, output: 24 } }, contextWindow: 100000, maxOutputTokens: 4096 },
  'anthropic.claude-instant-v1': { pricing: { text: { input: 0.8, output: 2.4 } }, contextWindow: 100000, maxOutputTokens: 4096 },
  
  // Meta Llama 3.2
  'meta.llama3-2-1b-instruct-v1:0': { pricing: { text: { input: 0.1, output: 0.1 } }, contextWindow: 128000, maxOutputTokens: 2048 },
  'meta.llama3-2-3b-instruct-v1:0': { pricing: { text: { input: 0.15, output: 0.15 } }, contextWindow: 128000, maxOutputTokens: 2048 },
  'meta.llama3-2-11b-instruct-v1:0': { pricing: { text: { input: 0.35, output: 0.35 } }, contextWindow: 128000, maxOutputTokens: 2048 },
  'meta.llama3-2-90b-instruct-v1:0': { pricing: { text: { input: 2.65, output: 2.65 } }, contextWindow: 128000, maxOutputTokens: 2048 },
  // Meta Llama 3.1
  'meta.llama3-1-8b-instruct-v1:0': { pricing: { text: { input: 0.3, output: 0.6 } }, contextWindow: 128000, maxOutputTokens: 2048 },
  'meta.llama3-1-70b-instruct-v1:0': { pricing: { text: { input: 2.65, output: 3.5 } }, contextWindow: 128000, maxOutputTokens: 2048 },
  'meta.llama3-1-405b-instruct-v1:0': { pricing: { text: { input: 5.32, output: 16 } }, contextWindow: 128000, maxOutputTokens: 2048 },
  // Meta Llama 3
  'meta.llama3-8b-instruct-v1:0': { pricing: { text: { input: 0.3, output: 0.6 } }, contextWindow: 128000, maxOutputTokens: 2048 },
  'meta.llama3-70b-instruct-v1:0': { pricing: { text: { input: 2.65, output: 3.5 } }, contextWindow: 128000, maxOutputTokens: 2048 },
  // Meta Llama 2
  'meta.llama2-13b-chat-v1': { pricing: { text: { input: 0.75, output: 1 } }, contextWindow: 128000, maxOutputTokens: 4096 },
  'meta.llama2-70b-chat-v1': { pricing: { text: { input: 1.95, output: 2.56 } }, contextWindow: 128000, maxOutputTokens: 4096 },
  // Mistral AI
  'mistral.mistral-7b-instruct-v0:2': { pricing: { text: { input: 0.15, output: 0.2 } }, contextWindow: 128000, maxOutputTokens: 2048 },
  'mistral.mixtral-8x7b-instruct-v0:1': { pricing: { text: { input: 0.45, output: 0.7 } }, contextWindow: 128000, maxOutputTokens: 2048 },
  'mistral.mistral-large-2402-v1:0': { pricing: { text: { input: 4, output: 12 } }, contextWindow: 200000, maxOutputTokens: 8192 },
  'mistral.mistral-large-2407-v1:0': { pricing: { text: { input: 3, output: 9 } }, contextWindow: 200000, maxOutputTokens: 8192 },
  // Cohere
  'cohere.command-text-v14': { pricing: { text: { input: 1.5, output: 2 } }, contextWindow: 128000, maxOutputTokens: 2048 },
  'cohere.command-light-text-v14': { pricing: { text: { input: 0.3, output: 0.6 } }, contextWindow: 128000, maxOutputTokens: 2048 },
  'cohere.command-r-v1:0': { pricing: { text: { input: 0.5, output: 1.5 } }, contextWindow: 128000, maxOutputTokens: 2048 },
  'cohere.command-r-plus-v1:0': { pricing: { text: { input: 3, output: 15 } }, contextWindow: 128000, maxOutputTokens: 2048 },
  // Amazon Titan Text
  'amazon.titan-embed-text-v2:0': { pricing: { embeddings: { cost: 0.135 } }, contextWindow: 8000, maxOutputTokens: 0 },
};