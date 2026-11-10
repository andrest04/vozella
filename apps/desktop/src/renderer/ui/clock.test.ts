import { describe, expect, it } from 'vitest';
import { formatClock } from './clock';

describe('formatClock', () => {
  it('formats minutes, hours and bad input', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65.9)).toBe('1:05');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(Number.NaN)).toBe('0:00');
    expect(formatClock(-3)).toBe('0:00');
  });
});
