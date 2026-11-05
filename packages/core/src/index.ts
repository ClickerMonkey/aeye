
/**
 * The core module contains types and interfaces related to AI components such as agents, tools, and chat interactions.
 * 
 * - `TContext` is a type that you decide is needed for your AI components to operate within a specific context.
 * - `TMetadata` is a type that you decide that is needed during execution/streaming to run that component with the right settings.
 */

export * from './types';
export * from './common';
export * from './to';
export * from './schema';
export * from './errors';
export * from './delivery';
export * from './tool';
export * from './prompt';
export * from './agent';