/**
 * Integration Test Setup
 *
 * Loads environment variables and provides utilities for conditional test execution
 */

import { describe } from '@jest/globals';
import dotenv from 'dotenv';
import path from 'path';

// Load .env.test from root directory
dotenv.config({ path: path.resolve(__dirname, '../../../.env.test') });

/**
 * Get API key from environment
 */
export const getAPIKey = (provider: string): string => {
  const envVar = `${provider.toUpperCase()}_API_KEY`;
  const key = process.env[envVar];

  if (!key) {
    throw new Error(
      `Missing ${envVar} in environment. ` +
      `Add it to .env.test or set it as an environment variable.`
    );
  }

  return key;
};

/**
 * Check if API key is available
 */
export const hasAPIKey = (provider: string): boolean => {
  const envVar = `${provider.toUpperCase()}_API_KEY`;
  return !!process.env[envVar];
};

/**
 * Skip test suite if API key is not available
 */
export const skipIfNoAPIKey = (provider: string): typeof describe.skip => {
  if (!hasAPIKey(provider)) {
    console.warn(`Skipping ${provider} tests - no API key found`);
    return describe.skip;
  }
  return describe;
};
