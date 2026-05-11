import { describe, it, expect } from 'vitest';
import { unicodeRange } from './utils';

describe('unicodeRange', () => {
  it('returns empty string for empty set', () => {
    expect(unicodeRange(new Set())).toBe('');
  });

  it('emits a single codepoint without a dash', () => {
    expect(unicodeRange(new Set(['A']))).toBe('U+41');
  });

  it('collapses consecutive codepoints into a dashed range', () => {
    expect(unicodeRange(new Set(['A', 'B', 'C']))).toBe('U+41-43');
  });

  it('keeps non-adjacent codepoints as separate ranges joined by commas', () => {
    expect(unicodeRange(new Set(['A', 'C', 'E']))).toBe('U+41,U+43,U+45');
  });

  it('mixes single codepoints and ranges', () => {
    expect(unicodeRange(new Set(['A', 'B', 'C', 'E', 'G', 'H']))).toBe('U+41-43,U+45,U+47-48');
  });

  it('sorts unsorted input before grouping', () => {
    expect(unicodeRange(new Set(['C', 'A', 'B']))).toBe('U+41-43');
  });

  it('uppercases hex digits', () => {
    expect(unicodeRange(new Set(['a']))).toBe('U+61');
    expect(unicodeRange(new Set(['z']))).toBe('U+7A');
  });

  it('handles characters outside the BMP via codePointAt', () => {
    expect(unicodeRange(new Set(['😀']))).toBe('U+1F600');
  });

  it('treats whitespace and punctuation like any other codepoint', () => {
    expect(unicodeRange(new Set([' ', '!', '"']))).toBe('U+20-22');
  });

  it('does not merge ranges across a one-codepoint gap', () => {
    expect(unicodeRange(new Set(['A', 'C']))).toBe('U+41,U+43');
  });
});
