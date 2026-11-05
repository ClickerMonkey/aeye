/**
 * AI Common Helper Tests
 */

import { clampReasoningEffort } from '../common';

describe('clampReasoningEffort', () => {
  it('keeps an accepted effort', () => {
    expect(clampReasoningEffort('high', ['low', 'medium', 'high'])).toBe('high');
  });

  it('keeps any effort when acceptance is unknown', () => {
    expect(clampReasoningEffort('max')).toBe('max');
    expect(clampReasoningEffort('max', [])).toBe('max');
  });

  it('moves to the nearest accepted effort', () => {
    expect(clampReasoningEffort('max', ['low', 'medium', 'high'])).toBe('high');
    expect(clampReasoningEffort('none', ['low', 'medium', 'high'])).toBe('low');
  });

  it('prefers the lower effort on a tie', () => {
    expect(clampReasoningEffort('medium', ['low', 'high'])).toBe('low');
  });

  it('keeps reasoning on unless none is asked for', () => {
    // DeepSeek V4 takes none, high and xhigh; GPT-5.4 has no minimal
    expect(clampReasoningEffort('low', ['none', 'high', 'xhigh'])).toBe('high');
    expect(clampReasoningEffort('minimal', ['none', 'low', 'medium', 'high', 'xhigh'])).toBe('low');
    expect(clampReasoningEffort('none', ['none', 'high'])).toBe('none');
    expect(clampReasoningEffort('low', ['none'])).toBe('none');
  });
});
