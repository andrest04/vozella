import { describe, expect, it } from 'vitest';
import type { NextSessionDateStore } from '../library/ports';
import {
  nextSessionKey,
  readNextSessionDates,
  rememberedNextSessionDate,
  usableNextSessionDate,
  withNextSessionDate,
} from './next-session';

const RECORDED = '2026-11-04T23:30:00.0000000-05:00'; // Wednesday Nov 4, local day

describe('nextSessionKey', () => {
  it('trims, lowercases and collapses spaces', () => {
    expect(nextSessionKey('  Diseño   de\tSoftware \n')).toBe('diseño de software');
    expect(nextSessionKey('Weekly Sync')).toBe(nextSessionKey('weekly  sync'));
  });
});

describe('usableNextSessionDate', () => {
  it('keeps a date strictly after the meeting local day', () => {
    expect(usableNextSessionDate('2026-11-05', RECORDED)).toBe('2026-11-05');
  });

  it('drops a stale date: the meeting day itself or earlier, in the meeting offset', () => {
    // 23:30 at -05:00 is Nov 5 in UTC, but the meeting day is Nov 4.
    expect(usableNextSessionDate('2026-11-04', RECORDED)).toBeUndefined();
    expect(usableNextSessionDate('2026-10-28', RECORDED)).toBeUndefined();
  });

  it('drops a missing or invalid date, and any date for an unreadable recordedAt', () => {
    expect(usableNextSessionDate(null, RECORDED)).toBeUndefined();
    expect(usableNextSessionDate('2026-02-30', RECORDED)).toBeUndefined();
    expect(usableNextSessionDate('2026-11-20', 'not a date')).toBeUndefined();
  });
});

describe('raw settings helpers', () => {
  it('reads only well-formed entries', () => {
    expect(
      readNextSessionDates({
        nextSessionDates: { a: '2026-11-05', b: 'soon', c: 3, d: '2026-13-01' },
      }),
    ).toEqual({ a: '2026-11-05' });
    expect(readNextSessionDates({})).toEqual({});
    const hostile = JSON.parse('{"nextSessionDates":{"__proto__":"2026-11-05"}}') as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(readNextSessionDates(hostile))).toBe(Object.prototype);
    expect(readNextSessionDates({ nextSessionDates: ['x'] })).toEqual({});
  });

  it('writes one entry and keeps every other key', () => {
    const raw = { uiLanguage: 'es', nextSessionDates: { a: '2026-11-05' } };
    expect(withNextSessionDate(raw, 'b', '2026-11-12')).toEqual({
      uiLanguage: 'es',
      nextSessionDates: { a: '2026-11-05', b: '2026-11-12' },
    });
    expect(raw.nextSessionDates).toEqual({ a: '2026-11-05' });
  });
});

describe('rememberedNextSessionDate', () => {
  const store = (dates: Record<string, string>, fail = false): NextSessionDateStore => ({
    loadNextSessionDate: (key) =>
      fail ? Promise.reject(new Error('locked')) : Promise.resolve(dates[key] ?? null),
    rememberNextSessionDate: () => Promise.resolve(),
  });

  it('looks the title up by its key and drops a stale date', async () => {
    expect(
      await rememberedNextSessionDate(
        store({ 'weekly sync': '2026-11-11' }),
        ' Weekly  Sync',
        RECORDED,
      ),
    ).toBe('2026-11-11');
    expect(
      await rememberedNextSessionDate(
        store({ 'weekly sync': '2026-11-01' }),
        'Weekly Sync',
        RECORDED,
      ),
    ).toBeUndefined();
  });

  it('no store or a failing read is no remembered date', async () => {
    expect(await rememberedNextSessionDate(undefined, 'Weekly Sync', RECORDED)).toBeUndefined();
    expect(
      await rememberedNextSessionDate(store({}, true), 'Weekly Sync', RECORDED),
    ).toBeUndefined();
  });
});
