/**
 * Chat API strict tri-state tests.
 *
 * Verifies that:
 * - `tool.strict === true` adds `'toolsStrict'` to REQUIRED (hard filter).
 * - `tool.strict === <number>` adds `'toolsStrict'` to OPTIONAL (preference).
 * - `tool.strict === false` adds nothing (neither required nor optional).
 * - default-omitted strict (which Tool.compile maps to `1`) lands in OPTIONAL.
 * - mixed: at least one `true` → required wins regardless of other tools.
 */

import z from 'zod';
import { AI } from '../ai';
import { ChatAPI } from '../apis/chat';
import type { ModelCapability, ModelParameter, Request } from '../types';
import { createMockProvider } from './mocks/provider.mock';

// Subclass to expose protected methods for direct testing.
class TestChatAPI extends ChatAPI<any> {
  exposedRequired(provided: ModelCapability[], request: Request): ModelCapability[] {
    return this.getRequiredCapabilities(provided, request, false);
  }
  exposedOptional(provided: ModelCapability[], request: Request): ModelCapability[] {
    return this.getOptionalCapabilities(provided, request, false);
  }
  exposedRequiredParams(provided: ModelParameter[], request: Request): ModelParameter[] {
    return this.getRequiredParameters(provided, request, false);
  }
  exposedOptionalParams(provided: ModelParameter[], request: Request): ModelParameter[] {
    return this.getOptionalParameters(provided, request, false);
  }
}

function makeChatAPI(): TestChatAPI {
  const ai = AI.with().providers({ mock: createMockProvider({ name: 'mock' }) }).create({});
  return new TestChatAPI(ai);
}

function toolDef(name: string, strict: boolean | number | undefined): Request['tools'][0] {
  return {
    name,
    description: `${name} tool`,
    parameters: z.object({ x: z.string() }),
    strict,
  };
}

describe('ChatAPI strict tri-state', () => {
  describe('getRequiredCapabilities', () => {
    it('adds toolsStrict when any tool has strict === true (hard requirement)', () => {
      const api = makeChatAPI();
      const required = api.exposedRequired([], {
        messages: [],
        tools: [toolDef('a', true), toolDef('b', false)],
      });
      expect(required).toContain('toolsStrict');
    });

    it('does NOT add toolsStrict when no tool has strict === true', () => {
      const api = makeChatAPI();
      const required = api.exposedRequired([], {
        messages: [],
        tools: [toolDef('a', 5), toolDef('b', undefined), toolDef('c', false)],
      });
      expect(required).not.toContain('toolsStrict');
    });

    it('does NOT add toolsStrict when there are no tools', () => {
      const api = makeChatAPI();
      const required = api.exposedRequired([], {
        messages: [],
      });
      expect(required).not.toContain('toolsStrict');
    });

    it('adds tools capability whenever there are tools', () => {
      const api = makeChatAPI();
      const required = api.exposedRequired([], {
        messages: [],
        tools: [toolDef('a', false)],
      });
      expect(required).toContain('tools');
    });
  });

  describe('getOptionalCapabilities', () => {
    it('adds toolsStrict when any tool has numeric strict > 0', () => {
      const api = makeChatAPI();
      const optional = api.exposedOptional([], {
        messages: [],
        tools: [toolDef('a', 5)],
      });
      expect(optional).toContain('toolsStrict');
    });

    it('adds toolsStrict for default-omitted strict (treated as priority 1)', () => {
      const api = makeChatAPI();
      const optional = api.exposedOptional([], {
        messages: [],
        tools: [toolDef('a', undefined)],
      });
      expect(optional).toContain('toolsStrict');
    });

    it('does NOT add toolsStrict when all tools are strict: false', () => {
      const api = makeChatAPI();
      const optional = api.exposedOptional([], {
        messages: [],
        tools: [toolDef('a', false), toolDef('b', false)],
      });
      expect(optional).not.toContain('toolsStrict');
    });

    it('does NOT add toolsStrict when all tools are hard `true` (already required)', () => {
      // Hard `true` items already register in REQUIRED — including them in
      // OPTIONAL too would be redundant but harmless. Current implementation
      // intentionally skips them in optional path.
      const api = makeChatAPI();
      const optional = api.exposedOptional([], {
        messages: [],
        tools: [toolDef('a', true), toolDef('b', true)],
      });
      expect(optional).not.toContain('toolsStrict');
    });
  });

  describe('mixed scenarios', () => {
    it('hard `true` on one tool puts toolsStrict in REQUIRED even when others are numeric', () => {
      const api = makeChatAPI();
      const required = api.exposedRequired([], {
        messages: [],
        tools: [toolDef('a', true), toolDef('b', 5), toolDef('c', false)],
      });
      expect(required).toContain('toolsStrict');
    });

    it('all-numeric tools puts toolsStrict in OPTIONAL only', () => {
      const api = makeChatAPI();
      const req = api.exposedRequired([], {
        messages: [],
        tools: [toolDef('a', 5), toolDef('b', 1)],
      });
      const opt = api.exposedOptional([], {
        messages: [],
        tools: [toolDef('a', 5), toolDef('b', 1)],
      });
      expect(req).not.toContain('toolsStrict');
      expect(opt).toContain('toolsStrict');
    });
  });

  describe('parameter mirror', () => {
    it("adds 'toolsStrict' to optional parameters for numeric strict", () => {
      const api = makeChatAPI();
      const optParams = api.exposedOptionalParams([], {
        messages: [],
        tools: [toolDef('a', 5)],
      });
      expect(optParams).toContain('toolsStrict');
    });

    it("does NOT add 'toolsStrict' to optional parameters for strict: false", () => {
      const api = makeChatAPI();
      const optParams = api.exposedOptionalParams([], {
        messages: [],
        tools: [toolDef('a', false)],
      });
      expect(optParams).not.toContain('toolsStrict');
    });
  });
});
