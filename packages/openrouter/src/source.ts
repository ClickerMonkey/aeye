/**
 * OpenRouter Model Source
 *
 * Fetches model information from OpenRouter API to enrich all providers
 * with comprehensive model metadata (pricing, capabilities, ZDR support).
 */

import type { ModelInfo, ModelSource } from '@aeye/ai';
import { convertOpenRouterModel } from './openrouter';
import { OpenRouterModel, ZDRModel } from './types';

/**
 * Configuration for OpenRouter model source
 */
export interface OpenRouterSourceConfig {
  apiKey?: string;
  includeZDR?: boolean;
}

/**
 * Fetch ZDR (Zero Data Retention) compliant models
 */
export async function fetchZDRModels(apiKey?: string): Promise<Set<string>> {
  try {
    const effectiveKey = apiKey ?? process.env.OPENROUTER_API_KEY;
    const response = await fetch('https://openrouter.ai/api/v1/endpoints/zdr', {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': effectiveKey ? `Bearer ${effectiveKey}` : undefined,
      },
    });

    if (!response.ok) {
      console.warn('Failed to fetch ZDR models from OpenRouter');
      return new Set();
    }

    const data = (await response.json()) as { data: ZDRModel[] };
    // The model_name field contains the model ID in provider/model format
    return new Set(data.data.map((model) => model.model_name));
  } catch (error) {
    console.warn('Error fetching ZDR models:', error);
    return new Set();
  }
}

/**
 * Fetch all OpenRouter models: chat, and also image, speech, transcription,
 * and embedding models, which the default listing leaves out.
 */
export async function fetchModels(apiKey?: string): Promise<OpenRouterModel[]> {
  const effectiveKey = apiKey ?? process.env.OPENROUTER_API_KEY;
  const response = await fetch('https://openrouter.ai/api/v1/models?output_modalities=all', {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': effectiveKey ? `Bearer ${effectiveKey}` : undefined,
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.statusText}`);
  }
  const data = (await response.json()) as { data: OpenRouterModel[] };
  return data.data;
}

/**
 * OpenRouter model source implementation
 */
export class OpenRouterModelSource implements ModelSource {
  readonly name = 'openrouter';
  private config: OpenRouterSourceConfig;

  constructor(config: OpenRouterSourceConfig = {}) {
    this.config = config;
  }

  async fetchModels(config?: Record<string, unknown>): Promise<ModelInfo[]> {
    const effectiveConfig = { ...this.config, ...config } as OpenRouterSourceConfig;

    try {
      // Fetch both models and ZDR models in parallel if ZDR is enabled
      const [models, zdrModels] = await Promise.all([
        fetchModels(effectiveConfig.apiKey),
        effectiveConfig.includeZDR !== false ? fetchZDRModels(effectiveConfig.apiKey) : Promise.resolve(new Set<string>()),
      ]);

      // Convert models and update ZDR support
      return models.map((model) => convertOpenRouterModel(model, zdrModels));
    } catch (error) {
      console.error('Failed to fetch models from OpenRouter:', error);
      throw error;
    }
  }
}
