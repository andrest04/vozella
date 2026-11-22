import { describe, expect, it } from 'vitest';
import { cutPrefix, cutTail } from './utf16-cut';

describe('utf16-cut', () => {
  it('keeps short text and plain cuts count UTF-16 units', () => {
    expect(cutPrefix('abcdef', 3)).toBe('abc');
    expect(cutTail('abcdef', 3)).toBe('def');
    expect(cutPrefix('abc', 3)).toBe('abc');
    expect(cutTail('abc', 5)).toBe('abc');
  });

  it('never leaves half of an emoji at the cut', () => {
    expect(cutPrefix('ab😀cd', 3)).toBe('ab');
    expect(cutPrefix('ab😀cd', 4)).toBe('ab😀');
    expect(cutTail('ab😀cd', 3)).toBe('cd');
    expect(cutTail('ab😀cd', 4)).toBe('😀cd');
  });

  it('drops the whole pair when the limit falls on its first or last unit', () => {
    expect(cutPrefix('😀😀', 1)).toBe('');
    expect(cutPrefix('😀😀', 3)).toBe('😀');
    expect(cutTail('😀😀', 1)).toBe('');
    expect(cutTail('😀😀', 3)).toBe('😀');
  });

  it('keeps a pair that ends exactly at the limit', () => {
    expect(cutPrefix('a😀b', 3)).toBe('a😀');
    expect(cutTail('a😀b', 3)).toBe('😀b');
  });

  it('only drops a unit that would split a pair, not a lone surrogate already in the text', () => {
    expect(cutPrefix('ab\ud83dc', 3)).toBe('ab\ud83d');
    expect(cutTail('a\ude00bc', 3)).toBe('\ude00bc');
  });

  it('handles zero and negative limits', () => {
    expect(cutPrefix('abc', 0)).toBe('');
    expect(cutPrefix('abc', -1)).toBe('');
    expect(cutTail('abc', 0)).toBe('');
    expect(cutTail('abc', -1)).toBe('');
  });
});
