/**
 * Model Registry
 *
 * Centralized model management with provider ordering and adapter registration.
 * Provider order ensures deterministic model resolution: first provider to return a model ID wins.
 */

import { getModel } from '@aeye/core';
import { detectTier } from './modelDetection';
import type {
  AIBaseMetadata,
  ModelCapability,
  ModelHandler,
  ModelInfo,
  ModelMetrics,
  ModelOverride,
  ModelPricing,
  ModelSelectionWeights,
  ModelSource,
  Provider,
  Providers,
  RangeConstraint,
  ScoredModel,
  SelectedModel
} from './types';

// ============================================================================
// Generic Constraint Helpers
// ============================================================================

/**
 * Recursively checks if a model value satisfies min/max constraints.
 * Returns true if the value is acceptable, false otherwise.
 * 
 * For primitive values (number, string, boolean), compares directly.
 * For objects, recursively checks all properties that exist in both min/max and modelValue.
 */
function satisfiesConstraint<T>(
  modelValue: T | undefined,
  min: T | undefined,
  max: T | undefined
): boolean {
  // If no constraints, always satisfied
  if (min === undefined && max === undefined) {
    return true;
  }
  
  // If model doesn't have the value but constraints exist, it's not satisfied
  if (modelValue === undefined) {
    return false;
  }
  
  // Handle primitive types (numbers)
  if (typeof modelValue === 'number') {
    const minNum = min as number | undefined;
    const maxNum = max as number | undefined;
    
    if (minNum !== undefined && modelValue < minNum) {
      return false;
    }
    if (maxNum !== undefined && modelValue > maxNum) {
      return false;
    }
    return true;
  }
  
  // Handle objects recursively
  if (typeof modelValue === 'object' && modelValue !== null) {
    const minObj = min as any;
    const maxObj = max as any;
    
    // Check all properties that exist in constraints
    const propsToCheck = new Set<string>();
    if (minObj && typeof minObj === 'object') {
      Object.keys(minObj).forEach(key => propsToCheck.add(key));
    }
    if (maxObj && typeof maxObj === 'object') {
      Object.keys(maxObj).forEach(key => propsToCheck.add(key));
    }
    
    for (const key of propsToCheck) {
      const modelProp = (modelValue as any)[key];
      const minProp = minObj?.[key];
      const maxProp = maxObj?.[key];
      
      if (!satisfiesConstraint(modelProp, minProp, maxProp)) {
        return false;
      }
    }
    return true;
  }
  
  // For other types, just check existence
  return true;
}

/**
 * Recursively updates min/max range values based on a model value.
 * Updates min to the minimum and max to the maximum across all models.
 * Returns the updated min and max.
 */
function calculateRange<T>(
  modelValue: T | undefined,
  currentMin: T | undefined,
  currentMax: T | undefined
): { min: T | undefined; max: T | undefined } {
  // If model doesn't have the value, return current range
  if (modelValue === undefined) {
    return { min: currentMin, max: currentMax };
  }
  
  // Handle primitive types (numbers)
  if (typeof modelValue === 'number') {
    const minNum = currentMin as number | undefined;
    const maxNum = currentMax as number | undefined;
    
    return {
      min: (minNum === undefined ? modelValue : Math.min(minNum, modelValue)) as T,
      max: (maxNum === undefined ? modelValue : Math.max(maxNum, modelValue)) as T
    };
  }
  
  // Handle objects recursively
  if (typeof modelValue === 'object' && modelValue !== null) {
    const minObj = (currentMin ?? {}) as any;
    const maxObj = (currentMax ?? {}) as any;
    const resultMin: any = { ...minObj };
    const resultMax: any = { ...maxObj };
    
    // Process all properties in modelValue
    for (const key in modelValue) {
      const modelProp = (modelValue as any)[key];
      const { min: newMin, max: newMax } = calculateRange(
        modelProp,
        minObj[key],
        maxObj[key]
      );
      
      if (newMin !== undefined) {
        resultMin[key] = newMin;
      }
      if (newMax !== undefined) {
        resultMax[key] = newMax;
      }
    }
    
    return {
      min: (Object.keys(resultMin).length > 0 ? resultMin : undefined) as T | undefined,
      max: (Object.keys(resultMax).length > 0 ? resultMax : undefined) as T | undefined
    };
  }
  
  // For other types, just return the value
  return { min: modelValue, max: modelValue };
}

/**
 * Recursively calculates a normalized score based on how close modelValue is to target.
 * Returns a score between 0 and 1, where 1 is closest to target.
 * 
 * For primitive values, normalizes distance between min and max.
 * For objects, calculates the average score across all defined numeric properties.
 * Returns undefined if target is not specified or if no valid scores can be calculated.
 */
function calculateScore<T>(
  modelValue: T | undefined,
  target: T | undefined,
  min: T | undefined,
  max: T | undefined
): number | undefined {
  // If no target or no model value, can't calculate score
  if (target === undefined || modelValue === undefined) {
    return undefined;
  }
  
  // Handle primitive types (numbers)
  if (typeof modelValue === 'number' && typeof target === 'number') {
    const minNum = min as number | undefined;
    const maxNum = max as number | undefined;
    
    // Need both min and max to normalize
    if (minNum === undefined || maxNum === undefined) {
      return undefined;
    }
    
    // If min and max are the same, perfect score if value matches
    const range = maxNum - minNum;
    if (range === 0) {
      return modelValue === target ? 1 : 0;
    }
    
    // Calculate normalized distance from target
    const distance = Math.abs(target - modelValue);
    const normalizedDistance = distance / range;
    
    // Score is 1 - normalizedDistance, clamped to [0, 1]
    return Math.max(0, Math.min(1, 1 - normalizedDistance));
  }
  
  // Handle objects recursively
  if (typeof modelValue === 'object' && modelValue !== null && typeof target === 'object' && target !== null) {
    const targetObj = target as any;
    const minObj = min as any;
    const maxObj = max as any;
    
    const scores: number[] = [];
    
    // Calculate scores for all properties in target
    for (const key in targetObj) {
      const modelProp = (modelValue as any)[key];
      const targetProp = targetObj[key];
      const minProp = minObj?.[key];
      const maxProp = maxObj?.[key];
      
      const score = calculateScore(modelProp, targetProp, minProp, maxProp);
      if (score !== undefined) {
        scores.push(score);
      }
    }
    
    // Return average of all defined scores
    if (scores.length === 0) {
      return undefined;
    }
    
    return scores.reduce((sum, score) => sum + score, 0) / scores.length;
  }
  
  // For other types, can't calculate meaningful score
  return undefined;
}

// ============================================================================
// Provider Capability Detection
// ============================================================================

/**
 * Determines which capabilities a provider supports based on its defined methods.
 * Treats streaming and non-streaming methods as equivalent for capability detection.
 *
 * This is useful for:
 * - Filtering providers during model selection
 * - Validating provider compatibility before requests
 * - Displaying provider capabilities in UI
 *
 * @param provider - The provider to inspect
 * @returns Set of capabilities the provider supports
 *
 * @example Basic usage
 * ```typescript
 * import { OpenAIProvider } from '@aeye/openai';
 * import { getProviderCapabilities } from '@aeye/ai';
 *
 * const openai = new OpenAIProvider({ apiKey: '...' });
 * const caps = getProviderCapabilities(openai);
 * console.log(caps);
 * // Set(['chat', 'streaming', 'image', 'audio', 'hearing', 'embedding'])
 * ```
 *
 * @example Checking specific capability
 * ```typescript
 * const openrouter = new OpenRouterProvider({ apiKey: '...' });
 * const caps = getProviderCapabilities(openrouter);
 *
 * if (caps.has('image')) {
 *   console.log('Provider supports image generation');
 * } else {
 *   console.log('Provider does not support image generation');
 * }
 * // Output: "Provider does not support image generation"
 * ```
 *
 * @example Filtering providers by capability
 * ```typescript
 * const providers = { openai, openrouter, anthropic };
 * const imageProviders = Object.entries(providers)
 *   .filter(([name, provider]) => getProviderCapabilities(provider).has('image'))
 *   .map(([name]) => name);
 * console.log(imageProviders); // ['openai']
 * ```
 */
export function getProviderCapabilities(provider: Provider): Set<ModelCapability> {
  const capabilities = new Set<ModelCapability>();

  // chat - Basic text completion
  if (provider.createExecutor !== undefined || provider.createStreamer !== undefined) {
    capabilities.add('chat');
  }

  // streaming - Real-time response streaming
  if (provider.createStreamer !== undefined) {
    capabilities.add('streaming');
  }

  // image - Image generation (DALL-E, Stable Diffusion, etc.)
  // Either method counts as supporting the capability
  if (provider.generateImage !== undefined || provider.generateImageStream !== undefined) {
    capabilities.add('image');
  }
  if (provider.editImage !== undefined || provider.editImageStream !== undefined) {
    capabilities.add('image');
  }

  // vision - Image understanding/analysis
  // Note: vision is a model capability, not a provider method
  // Vision is handled through chat messages with image content
  // It cannot be detected from provider methods alone
  capabilities.add('vision');

  // audio - Text-to-speech synthesis
  if (provider.speech !== undefined) {
    capabilities.add('audio');
  }

  // hearing - Speech-to-text transcription
  if (provider.transcribe !== undefined || provider.transcribeStream !== undefined) {
    capabilities.add('hearing');
  }

  // embedding - Text embeddings for semantic search
  if (provider.embed !== undefined) {
    capabilities.add('embedding');
  }

  // tools - Function/tool calling
  // Note: This is typically a model capability, not detected from provider methods
  // Function calling is handled through createExecutor with tools parameter
  capabilities.add('tools');

  // json - JSON output mode
  // Note: This is a model capability, not a provider method
  capabilities.add('json');

  // structured - Structured output with schemas
  // Note: This is a model capability, not a provider method
  capabilities.add('structured');

  // reasoning - Extended reasoning (like OpenAI o1)
  // Note: This is a model capability, not a provider method
  capabilities.add('reasoning');

  // zdr - Zero data retention
  // Note: This is a privacy/compliance feature, not detected from provider methods
  capabilities.add('zdr');

  return capabilities;
}

// ============================================================================
// Model Registry
// ============================================================================

export class ModelRegistry<
  TProviders extends Providers,
  TProviderKey extends keyof TProviders & string = keyof TProviders & string,
  TProvider extends TProviders[TProviderKey] = TProviders[TProviderKey]
> {

  private models: Map<string, ModelInfo<TProviderKey>> = new Map(); // key: "provider/model"
  private modelHandlers: Map<string, ModelHandler> = new Map();
  private providers: Map<TProviderKey, TProvider> = new Map();
  private providerCapabilities: Map<TProviderKey, Set<ModelCapability>> = new Map();
  private modelSources: ModelSource[] = [];
  private modelOverrides: ModelOverride[];
  private defaultCostPerMillionTokens: number;
  private defaultWeights?: ModelSelectionWeights;
  private weightProfiles: Record<string, ModelSelectionWeights>;

  constructor(
    providers: TProviders,
    modelOverrides: ModelOverride[] = [],
    defaultCostPerMillionTokens: number = 5.0,
    modelSources: ModelSource[] = [],
    defaultWeights?: ModelSelectionWeights,
    weightProfiles: Record<string, ModelSelectionWeights> = {}
  ) {
    // Store providers
    this.providers = new Map(Object.entries(providers)) as Map<TProviderKey, TProvider>;

    // Pre-compute provider capabilities for efficient lookup during selection
    for (const [providerName, provider] of this.providers.entries()) {
      const capabilities = getProviderCapabilities(provider);
      this.providerCapabilities.set(providerName, capabilities);
    }

    // Set provider order (determines which provider "wins" for duplicate model IDs)
    this.modelOverrides = modelOverrides;
    this.defaultCostPerMillionTokens = defaultCostPerMillionTokens;
    this.modelSources = modelSources;
    this.defaultWeights = defaultWeights;
    this.weightProfiles = weightProfiles;
  }

  /**
   * Add model sources to the registry
   */
  addModelSources(sources: ModelSource[]): void {
    this.modelSources.push(...sources);
  }

  /**
   * Register a model in the registry
   *
   * Always registers under two keys:
   * - model.id (e.g., "gpt-4" or "openai/gpt-4")
   * - provider/model.id (e.g., "openai/gpt-4" or "openrouter/openai/gpt-4")
   *
   * On collision, models are merged
   */
  registerModel(model: ModelInfo<TProviderKey>): void {
    const processedModel = this.applyOverrides(model);

    // Register under both keys
    const keys = [
      model.id,                              // "gpt-4" or "openai/gpt-4"
      `${model.provider}/${model.id}`,       // "openai/gpt-4" or "openrouter/openai/gpt-4"
    ];

    for (const key of keys) {
      if (this.models.has(key)) {
        // Merge with existing
        const existing = this.models.get(key)!;
        const merged = this.mergeModelInfo(existing, processedModel);
        this.models.set(key, merged);
      } else {
        this.models.set(key, processedModel);
      }
    }
  }

  /**
   * Register multiple models
   */
  registerModels(models: ModelInfo<TProviderKey>[]): void {
    for (const model of models) {
      this.registerModel(model);
    }
  }

  /**
   * Get a model by ID (checks all providers in order)
   */
  getModel(id: string): ModelInfo<TProviderKey> | undefined {
    // Try with provider prefix first
    if (id.includes('/')) {
      return this.models.get(id);
    }

    let priorityProvider = 10;
    let priorityModel: ModelInfo<TProviderKey> | undefined = undefined;

    // Try each provider in order
    for (const [providerName, provider] of this.providers.entries()) {
      const key = `${providerName as string}/${id}`;
      const priority = provider.priority ?? 10;
      const model = this.models.get(key);
      if (model && (!priorityModel || priority < priorityProvider)) {
        priorityModel = model;
        priorityProvider = priority;
      }
    }

    return priorityModel;
  }

  /**
   * Gets the provider to use for a given model ID
   * 
   * @param id 
   * @returns 
   */
  getProviderFor(id: string): [TProviderKey, TProvider] | [] {
    let priorityProvider: TProvider | undefined = undefined;
    let priorityKey: TProviderKey | undefined = undefined;

    for (const [providerKey, provider] of this.providers.entries()) {
      const providerName = provider.name;
      if (id.startsWith(`${providerName}/`) || id.startsWith(`${providerKey}/`)) {
        return [providerKey, provider];
      }
      const priority = provider.priority ?? 10;
      if (!priorityProvider || priority < (priorityProvider.priority ?? 10)) {
        priorityProvider = provider;
        priorityKey = providerKey;
      }
    }

    return priorityKey && priorityProvider ? [priorityKey, priorityProvider] : [];
  }

  /**
   * List all models
   */
  listModels(): ModelInfo<TProviderKey>[] {
    return Array.from(this.models.values());
  }

  /**
   * List models for which we have providers
   */
  providedModels(): ModelInfo<TProviderKey>[] {
    return this.listModels().filter(model => this.providers.has(model.provider as TProviderKey));
  }

  /**
   * Search and score models based on criteria
   */
  searchModels(metadata: AIBaseMetadata<TProviders>): ScoredModel<TProviderKey>[] {
    // Filter list by models we have providers for
    const providedModels = this.providedModels();

    // Step 1: Filter to applicable models
    const applicableModels: Array<{ model: ModelInfo<TProviderKey>; applicability: NonNullable<ReturnType<typeof this.isModelApplicable>> }> = [];
    
    for (const model of providedModels) {
      const applicability = this.isModelApplicable(model, metadata);
      if (applicability) {
        applicableModels.push({ model, applicability });
      }
    }

    // If no applicable models, return empty
    if (applicableModels.length === 0) {
      return [];
    }

    // Step 2: Calculate ranges across all applicable models
    let rangeMin: Partial<ModelInfo<TProviderKey>> = {};
    let rangeMax: Partial<ModelInfo<TProviderKey>> = {};

    for (const { model } of applicableModels) {
      // Calculate range for pricing
      if (model.pricing) {
        const { min, max } = calculateRange(model.pricing, rangeMin.pricing, rangeMax.pricing);
        rangeMin.pricing = min;
        rangeMax.pricing = max;
      }

      // Calculate range for contextWindow
      if (model.contextWindow) {
        const { min, max } = calculateRange(model.contextWindow, rangeMin.contextWindow, rangeMax.contextWindow);
        rangeMin.contextWindow = min;
        rangeMax.contextWindow = max;
      }

      // Calculate range for maxOutputTokens
      if (model.maxOutputTokens) {
        const { min, max } = calculateRange(model.maxOutputTokens, rangeMin.maxOutputTokens, rangeMax.maxOutputTokens);
        rangeMin.maxOutputTokens = min;
        rangeMax.maxOutputTokens = max;
      }

      // Calculate range for metrics
      if (model.metrics) {
        const { min, max } = calculateRange(model.metrics, rangeMin.metrics, rangeMax.metrics);
        rangeMin.metrics = min;
        rangeMax.metrics = max;
      }
    }

    // Step 3: Score all applicable models with ranges
    const scored: ScoredModel<TProviderKey>[] = [];

    for (const { model, applicability } of applicableModels) {
      const result: ScoredModel<TProviderKey> = {
        model,
        score: 0,
        matchedRequired: applicability.matchedRequired,
        matchedOptional: applicability.matchedOptional,
        missingRequired: applicability.missingRequired,
      };

      // Determine weights
      let weights: ModelSelectionWeights;
      if (metadata.weights) {
        weights = metadata.weights;
      } else if (metadata.weightProfile && this.weightProfiles[metadata.weightProfile]) {
        weights = this.weightProfiles[metadata.weightProfile];
      } else if (this.defaultWeights) {
        weights = this.defaultWeights;
      } else {
        weights = { cost: 0.5, speed: 0.3, accuracy: 0.2 };
      }

      result.score = this.calculateWeightedScore(model, weights, metadata, rangeMin, rangeMax);
      
      if (result.score > 0) {
        scored.push(result);
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored;
  }

  /**
   * Select best model based on criteria
   */
  selectModel(criteria: AIBaseMetadata<TProviders>): SelectedModel<TProviders, TProviderKey> | undefined {
    // If model explicitly specified, use it
    const model = getModel(criteria.model);
    const modelId = model?.id;

    if (modelId) {
      const model = this.getModel(modelId);
      if (!model) {
        return undefined;
      }

      const provider = this.providers.get(model.provider);
      if (!provider) {
        return undefined;
      }

      // Check if model is applicable
      const applicability = this.isModelApplicable(model, criteria);
      if (!applicability) {
        return undefined;
      }

      return {
        model,
        provider,
        providerConfig: provider.config,
        score: 1.0,
      };
    }

    // Search and score all compatible models
    const scored = this.searchModels(criteria);
    if (scored.length === 0) {
      return undefined;
    }

    const best = scored[0];
    const provider = this.providers.get(best.model.provider);
    if (!provider) {
      return undefined;
    }

    return {
      model: best.model,
      provider,
      providerConfig: provider.config,
      score: best.score,
    };
  }

  /**
   * Register a model handler
   */
  registerHandler(handler: ModelHandler<any>): void {
    handler.models.forEach(model => this.modelHandlers.set(model, handler));
  }

  /**
   * Get handler for a model
   */
  getHandler(provider: string, model: string): ModelHandler | undefined {
    return this.modelHandlers.get(model) ?? this.modelHandlers.get(`${provider}/${model}`);
  }

  /**
   * Get provider info
   */
  getProvider(name: TProviderKey): TProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Get pre-computed capabilities for a provider
   * @param name - Provider name
   * @returns Set of capabilities the provider supports, or undefined if provider not found
   */
  getProviderCapabilities(name: TProviderKey): Set<ModelCapability> | undefined {
    return this.providerCapabilities.get(name);
  }

  /**
   * Check if a model is applicable given the criteria.
   * Returns null if not applicable, or an object with matched capabilities if applicable.
   */
  private isModelApplicable(
    model: ModelInfo<TProviderKey>,
    criteria: AIBaseMetadata<TProviders>
  ): { matchedRequired: ModelCapability[]; matchedOptional: ModelCapability[]; missingRequired: ModelCapability[] } | null {
    // Check provider allowlist/blocklist
    if (criteria.providers) {
      if (criteria.providers.deny?.includes(model.provider)) {
        return null;
      }
      if (criteria.providers.allow && !criteria.providers.allow.includes(model.provider)) {
        return null;
      }
    }

    const matchedRequired: ModelCapability[] = [];
    const matchedOptional: ModelCapability[] = [];
    const missingRequired: ModelCapability[] = [];

    // Check required capabilities against both model AND provider
    if (criteria.required) {
      const providerCaps = this.providerCapabilities.get(model.provider);

      for (const cap of criteria.required) {
        // Check if model has the capability
        const modelHasCap = model.capabilities.has(cap);

        // Check if provider supports the capability
        // If provider capabilities are not cached, assume it's supported (backward compatibility)
        const providerSupportsCap = !providerCaps || providerCaps.has(cap);

        // Both model AND provider must support the capability
        if (modelHasCap && providerSupportsCap) {
          matchedRequired.push(cap);
        } else {
          missingRequired.push(cap);
        }
      }

      // If any required capabilities are missing, not applicable
      if (missingRequired.length > 0) {
        return null;
      }
    }

    // Check optional capabilities
    if (criteria.optional) {
      for (const cap of criteria.optional) {
        if (model.capabilities.has(cap)) {
          matchedOptional.push(cap);
        }
      }
    }

    // Check required parameters
    if (criteria.requiredParameters && criteria.requiredParameters.length > 0) {
      const optionalParams = criteria.optionalParameters || [];

      for (const param of criteria.requiredParameters) {
        // If this param is marked as optional, skip the requirement check
        if (optionalParams.includes(param)) {
          continue;
        }

        // Check if model supports this parameter
        const modelSupportsParam = model.supportedParameters?.has(param) ?? false;

        if (!modelSupportsParam) {
          // Required parameter not supported by model
          return null;
        }
      }
    }

    // Check pricing constraints
    if (!satisfiesConstraint(model.pricing, criteria.pricing?.min, criteria.pricing?.max)) {
      return null;
    }

    // Check context window constraints
    if (!satisfiesConstraint(model.contextWindow, criteria.contextWindow?.min, criteria.contextWindow?.max)) {
      return null;
    }

    // Check output tokens constraints
    if (!satisfiesConstraint(model.maxOutputTokens, criteria.outputTokens?.min, criteria.outputTokens?.max)) {
      return null;
    }

    // Check metrics constraints
    if (!satisfiesConstraint(model.metrics, criteria.metrics?.min, criteria.metrics?.max)) {
      return null;
    }

    if (criteria.tier && model.tier !== criteria.tier) {
      return null;
    }

    return { matchedRequired, matchedOptional, missingRequired };
  }

  /**
   * Score a model against criteria
   * @param skipApplicabilityCheck - If true, skips the applicability check (used when already filtered)
   * @param rangeMin - Minimum values across all applicable models (for target scoring)
   * @param rangeMax - Maximum values across all applicable models (for target scoring)
   */
  private scoreModel(
    model: ModelInfo<TProviderKey>,
    criteria: AIBaseMetadata<TProviders>,
    skipApplicabilityCheck: boolean = false,
    rangeMin?: Partial<ModelInfo<TProviderKey>>,
    rangeMax?: Partial<ModelInfo<TProviderKey>>
  ): ScoredModel<TProviderKey> {
    const result: ScoredModel<TProviderKey> = {
      model,
      score: 0,
      matchedRequired: [],
      matchedOptional: [],
      missingRequired: [],
    };

    // Check if model is applicable (unless already checked)
    if (!skipApplicabilityCheck) {
      const applicability = this.isModelApplicable(model, criteria);
      if (!applicability) {
        return result; // score = 0
      }
      result.matchedRequired = applicability.matchedRequired;
      result.matchedOptional = applicability.matchedOptional;
      result.missingRequired = applicability.missingRequired;
    }

    // Determine weights with priority: metadata.weights > weightProfile > defaultWeights
    let weights: ModelSelectionWeights;
    if (criteria.weights) {
      weights = criteria.weights;
    } else if (criteria.weightProfile && this.weightProfiles[criteria.weightProfile]) {
      weights = this.weightProfiles[criteria.weightProfile];
    } else if (this.defaultWeights) {
      weights = this.defaultWeights;
    } else {
      weights = { cost: 0.5, speed: 0.3, accuracy: 0.2 };
    }

    result.score = this.calculateWeightedScore(model, weights, criteria, rangeMin, rangeMax);

    return result;
  }

  /**
   * Calculate weighted score for a model
   * @param rangeMin - Minimum values across all applicable models (for target scoring)
   * @param rangeMax - Maximum values across all applicable models (for target scoring)
   */
  private calculateWeightedScore(
    model: ModelInfo,
    weights: ModelSelectionWeights,
    metadata: AIBaseMetadata<TProviders>,
    rangeMin?: Partial<ModelInfo<TProviderKey>>,
    rangeMax?: Partial<ModelInfo<TProviderKey>>
  ): number {
    let score = 0;
    let weighted = 0;

    // Cost score with optional target-based scoring
    if (weights.cost) {
      let costScore: number | undefined;
      
      // If target pricing specified and we have range, use target-based scoring
      if (metadata.pricing?.target && rangeMin && rangeMax) {
        costScore = calculateScore(
          model.pricing,
          metadata.pricing.target,
          rangeMin.pricing,
          rangeMax.pricing
        );
      }
      
      // Fallback to default scoring if no target or no range
      if (costScore === undefined) {
        // Extract average cost for simple scoring
        const inputCost = model.pricing?.text?.input ?? 0;
        const outputCost = model.pricing?.text?.output ?? 0;
        const avgCost = (inputCost + outputCost) / 2;
        
        if (avgCost > 0) {
          // Default: lower cost is better
          costScore = 1 / (1 + avgCost / 10);
        }
      }
      
      if (costScore !== undefined) {
        score += weights.cost * costScore;
        weighted++;
      }
    }

    // Speed score with optional target-based scoring
    if (weights.speed) {
      let speedScore: number | undefined;
      
      // If target metrics specified and we have range, use target-based scoring
      if (metadata.metrics?.target && rangeMin && rangeMax) {
        speedScore = calculateScore(
          model.metrics,
          metadata.metrics.target,
          rangeMin.metrics,
          rangeMax.metrics
        );
      }
      
      // Fallback to default scoring if no target or no range
      if (speedScore === undefined && model.metrics?.tokensPerSecond !== undefined) {
        // Default: higher speed is better (normalize to 0-1)
        speedScore = Math.min(model.metrics.tokensPerSecond / 100, 1);
      }
      
      if (speedScore !== undefined) {
        score += weights.speed * speedScore;
        weighted++;
      }
    }

    // Accuracy score - use metrics if available, otherwise tier-based
    if (weights.accuracy) {
      if (model.metrics?.accuracyScore) {
        score += weights.accuracy * model.metrics.accuracyScore;
        weighted++;
      } else if (model.tier) {
        // Fallback to tier-based accuracy when metrics not available
        const tierScore = model.tier === 'flagship' ? 1.0 : model.tier === 'efficient' ? 0.7 : 0.5;
        score += weights.accuracy * tierScore;
        weighted++;
      }
    }

    // Context window score with optional target-based scoring
    if (weights.contextWindow) {
      let contextScore: number | undefined;
      
      // If target context window specified and we have range, use target-based scoring
      if (metadata.contextWindow?.target && rangeMin && rangeMax) {
        contextScore = calculateScore(
          model.contextWindow,
          metadata.contextWindow.target,
          rangeMin.contextWindow,
          rangeMax.contextWindow
        );
      }
      
      // Fallback to default scoring if no target or no range
      if (contextScore === undefined && model.contextWindow > 0) {
        // Default: larger context window is better (normalize to 0-1)
        contextScore = Math.min(model.contextWindow / 100000, 1);
      }
      
      if (contextScore !== undefined) {
        score += weights.contextWindow * contextScore;
        weighted++;
      }
    }

    // Optional capabilities multiplier - models matching more optional caps get a score multiplier
    // This ensures optional capabilities are strongly preferred
    if (metadata.optional && metadata.optional.length > 0) {
      const optionalMatches = metadata.optional.filter(cap => model.capabilities.has(cap)).length;
      const matchRatio = optionalMatches / metadata.optional.length;
      // Apply 1.0x to 2.0x multiplier based on optional capability match rate
      // This allows optional caps to overcome significant cost differences
      const multiplier = 1.0 + matchRatio;
      score *= multiplier;
    }

    // Optional parameters bonus - models supporting optional parameters get a score boost
    if (metadata.optionalParameters && metadata.optionalParameters.length > 0) {
      let supportedOptionalParams = 0;
      for (const param of metadata.optionalParameters) {
        if (model.supportedParameters?.has(param)) {
          supportedOptionalParams++;
        }
      }
      const matchRatio = supportedOptionalParams / metadata.optionalParameters.length;
      // Apply 1.0x to 1.5x multiplier based on optional parameter match rate
      const multiplier = 1.0 + (matchRatio * 0.5);
      score *= multiplier;
    }

    return weighted === 0 ? Math.max(0.0000001, score) : score;
  }

  /**
   * Apply overrides to a model
   */
  private applyOverrides(model: ModelInfo<TProviderKey>): ModelInfo<TProviderKey> {
    let result = { ...model };

    for (const override of this.modelOverrides) {
      // Check if override matches
      if (override.provider && override.provider !== model.provider) {
        continue;
      }
      if (override.modelId && override.modelId !== model.id) {
        continue;
      }
      if (override.modelPattern && !override.modelPattern.test(model.id)) {
        continue;
      }

      // Apply overrides
      result = {
        ...result,
        ...override.overrides,
        // Merge nested objects
        pricing: { ...result.pricing, ...override.overrides.pricing },
        metrics: { ...result.metrics, ...override.overrides.metrics },
        metadata: { ...result.metadata, ...override.overrides.metadata },
      };
    }

    return result;
  }

  /**
   * Merge two ModelInfo objects intelligently
   * Prefers non-default values and combines capabilities
   */
  private mergeModelInfo(base: ModelInfo<TProviderKey>, source: ModelInfo<TProviderKey>): ModelInfo<TProviderKey> {
    // Merge capabilities
    const mergedCapabilities = new Set([...base.capabilities, ...source.capabilities]);

    // Merge pricing (prefer source if it has non-zero values)
    const mergedPricing = { ...base.pricing, ...source.pricing };

    // Merge metrics (prefer source if available)
    const mergedMetrics = source.metrics ?? base.metrics;

    // Merge metadata (combine, source takes priority for conflicts)
    const mergedMetadata = {
      ...base.metadata,
      ...source.metadata,
    };

    return {
      id: base.id,
      provider: base.provider,
      name: source.name || base.name,
      capabilities: mergedCapabilities,
      tier: source.tier !== 'experimental' ? source.tier : base.tier,
      pricing: mergedPricing,
      contextWindow: source.contextWindow > 0 ? source.contextWindow : base.contextWindow,
      maxOutputTokens: source.maxOutputTokens ?? base.maxOutputTokens,
      metrics: mergedMetrics,
      metadata: mergedMetadata,
    };
  }

  /**
   * Refresh models from all providers and model sources
   */
  async refresh(): Promise<void> {
    this.models.clear();

    // Step 1: Fetch from model sources (e.g., OpenRouter)
    const sourceModels = new Map<string, ModelInfo<TProviderKey>>();
    for (const source of this.modelSources) {
      try {
        const models = await source.fetchModels() as ModelInfo<TProviderKey>[];
        for (const model of models) {
          const key = `${model.provider}/${model.id}`;
          sourceModels.set(key, model);
        }
      } catch (error) {
        console.error(`Failed to fetch models from source ${source.name}:`, error);
      }
    }

    const providers = Array.from(this.providers.entries());
    providers.sort((a, b) => {
      const priorityA = a[1].priority ?? 10;
      const priorityB = b[1].priority ?? 10;
      return priorityA - priorityB;
    });

    // Step 2: Fetch from each provider and merge with source models
    for (const [providerName, provider] of providers) {
      
      try {
        // Skip if provider doesn't implement listModels
        if (!provider.listModels) {
          continue;
        }

        const modelInfos = await provider.listModels();

        // For each model from provider
        for (const modelInfo of modelInfos) {
          // Create key for looking up source info
          const key = `${providerName as string}/${modelInfo.id}`;

          // Create base model with defaults
          let fullModel: ModelInfo<TProviderKey> = {
            id: modelInfo.id,
            provider: providerName,
            name: modelInfo.name || modelInfo.id,
            capabilities: modelInfo.capabilities || new Set(['chat', 'streaming'] as ModelCapability[]),
            tier: modelInfo.tier || detectTier(modelInfo.name || modelInfo.id),
            pricing: modelInfo.pricing || {
              inputTokensPer1M: this.defaultCostPerMillionTokens,
              outputTokensPer1M: this.defaultCostPerMillionTokens * 2,
            },
            contextWindow: modelInfo.contextWindow || 8192,
            maxOutputTokens: modelInfo.maxOutputTokens,
            metrics: modelInfo.metrics,
            metadata: modelInfo.metadata || {},
          };

          // Merge with source model info if available
          const sourceModel = sourceModels.get(key);
          if (sourceModel) {
            fullModel = this.mergeModelInfo(fullModel, sourceModel);
          }

          this.registerModel(fullModel);
        }
      } catch (error) {
        // Continue with other providers if one fails
        console.error(`Failed to fetch models from ${providerName}:`, error);
      }
    }

    // Step 3: Register any source models that weren't in providers
    for (const [key, sourceModel] of sourceModels.entries()) {
      if (!this.models.has(key)) {
        this.registerModel(sourceModel);
      }
    }
  }

}
