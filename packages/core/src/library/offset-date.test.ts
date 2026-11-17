import { describe, expect, it } from 'vitest';
import { formatOffsetDate, normalizeOffsetDate, parseOffsetDate } from './offset-date';

describe('offset dates', () => {
  it('writes ISO-8601 with milliseconds and a numeric offset', () => {
    const parsed = parseOffsetDate('2026-09-01T12:00:00.000+00:00');
    expect(parsed).not.toBeNull();
    expect(formatOffsetDate(parsed!)).toBe('2026-09-01T12:00:00.000+00:00');
  });

  it('reads seven fraction digits written earlier and writes them back to the millisecond', () => {
    expect(normalizeOffsetDate('2026-09-02T09:30:00.1234567-05:00')).toBe(
      '2026-09-02T09:30:00.123-05:00',
    );
    expect(normalizeOffsetDate('2026-09-01T12:00:00.0000000+00:00')).toBe(
      '2026-09-01T12:00:00.000+00:00',
    );
  });

  it('accepts Z, short fractions, a space separator and compact offsets', () => {
    expect(normalizeOffsetDate('2026-09-01T12:00:00Z')).toBe('2026-09-01T12:00:00.000+00:00');
    expect(normalizeOffsetDate('2026-09-01 12:00:00.5+0530')).toBe('2026-09-01T12:00:00.500+05:30');
  });

  it('is stable: writing what it wrote changes nothing', () => {
    const once = normalizeOffsetDate('2026-09-02T09:30:00.1234567-05:00');
    expect(normalizeOffsetDate(once ?? '')).toBe(once);
  });

  it('computes the instant from the offset', () => {
    const parsed = parseOffsetDate('2026-09-01T12:00:00-05:00')!;
    expect(new Date(parsed.ms).toISOString()).toBe('2026-09-01T17:00:00.000Z');
    expect(parsed.offsetMinutes).toBe(-300);
  });

  it('reads a value without an offset in the supplied local zone', () => {
    const parsed = parseOffsetDate('2026-09-01T12:00:00', () => 120)!;
    expect(parsed.offsetMinutes).toBe(120);
    expect(new Date(parsed.ms).toISOString()).toBe('2026-09-01T10:00:00.000Z');
  });

  it.each([
    '',
    'yesterday',
    '2026-13-01T00:00:00Z',
    '2026-02-30T00:00:00Z',
    '2026-09-01T25:00:00Z',
  ])('rejects %j', (text) => {
    expect(parseOffsetDate(text)).toBeNull();
  });
});
