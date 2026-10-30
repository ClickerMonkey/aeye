/**
 * OpenRouter Model Source
 *
 * Fetches model information from OpenRouter API to enrich all providers
 * with comprehensive model metadata (pricing, capabilities, ZDR support).
 */

import type { ModelInfo, ModelSource } from '@aeye/ai';
import { convertOpenRouterModel } from './openrouter';
import type { OpenRouterEndpoint, OpenRouterModel } from './types';

const API = 'https://openrouter.ai/api/v1';

/**
 * Configuration for OpenRouter model source
 */
export interface OpenRouterSourceConfig {
  apiKey?: string;
  includeZDR?: boolean;
}

/**
 * Live performance of a model across the providers serving it.
 */
export interface OpenRouterMetrics {
  // Best median latency to first token, in milliseconds
  latency?: number;
  // Best median throughput, in tokens per second
  throughput?: number;
  // Best uptime over the last 30 minutes, as a percentage
  uptime?: number;
}

/**
 * GET an OpenRouter API path, authenticated when a key is available, and
 * read its JSON body as the documented shape. Undefined when the request
 * fails.
 */
async function get<T>(path: string, apiKey?: string): Promise<T | undefined> {
  const key = apiKey ?? process.env.OPENROUTER_API_KEY;
  const response = await fetch(`${API}${path}`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
  return response.ok ? JSON.parse(await response.text()) : undefined;
}

/**
 * Fetch ZDR (Zero Data Retention) compliant models
 */
export async function fetchZDRModels(apiKey?: string): Promise<Set<string>> {
  try {
    const body = await get<{ data: OpenRouterEndpoint[] }>('/endpoints/zdr', apiKey);
    if (!body) {
      console.warn('Failed to fetch ZDR models from OpenRouter');
      return new Set();
    }
    // The model_name field contains the model ID in provider/model format
    return new Set(body.data.map((model) => model.model_name));
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
  const body = await get<{ data: OpenRouterModel[] }>('/models?output_modalities=all', apiKey);
  if (!body) {
    throw new Error('Failed to fetch OpenRouter models');
  }
  return body.data;
}

/**
 * Fetch a model's live performance: the best of each metric across the
 * providers serving it, since routing favors the better endpoints.
 */
export async function fetchEndpointMetrics(modelId: string, apiKey?: string): Promise<OpenRouterMetrics | null> {
  const body = await get<{ data: { endpoints: OpenRouterEndpoint[] } }>(`/models/${modelId}/endpoints`, apiKey);
  if (!body) {
    return null;
  }
  const best = (values: Array<number | null | undefined>, pick: (...values: number[]) => number) => {
    const known = values.filter((value): value is number => typeof value === 'number');
    return known.length ? pick(...known) : undefined;
  };
  const endpoints = body.data.endpoints;
  return {
    latency: best(endpoints.map(e => e.latency_last_30m?.p50), Math.min),
    throughput: best(endpoints.map(e => e.throughput_last_30m?.p50), Math.max),
    uptime: best(endpoints.map(e => e.uptime_last_30m), Math.max),
  };
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

  async fetchModels(config?: OpenRouterSourceConfig): Promise<ModelInfo[]> {
    const { apiKey, includeZDR } = { ...this.config, ...config };

    try {
      const [models, zdrModels] = await Promise.all([
        fetchModels(apiKey),
        includeZDR !== false ? fetchZDRModels(apiKey) : new Set<string>(),
      ]);

      return models.map((model) => convertOpenRouterModel(model, zdrModels));
    } catch (error) {
      console.error('Failed to fetch models from OpenRouter:', error);
      throw error;
    }
  }
}
