import { describe, expect, it } from 'vitest';
import { classifyCommittedLine, LINE_SELF_MIN_SHARE } from './line-source';
import { LOCAL_SPEAKER_MIN_SHARE } from './local-speaker';

/** A share function that answers `value` and remembers the spans it was asked about. */
function shareOf(value: number | null) {
  const asked: [number, number][] = [];
  const share = (startMs: number, endMs: number): number | null => {
    asked.push([startMs, endMs]);
    return value;
  };
  return { share, asked };
}

describe('classifyCommittedLine', () => {
  it('uses the same threshold that names the local speaker', () => {
    expect(LINE_SELF_MIN_SHARE).toBe(LOCAL_SPEAKER_MIN_SHARE);
  });

  it('is unknown for a transcript header and never asks for a share', () => {
    const { share, asked } = shareOf(1);
    expect(classifyCommittedLine('Recorded 2026-11-26 10:00', share)).toBe('unknown');
    expect(classifyCommittedLine('Ended 2026-11-26 10:30', share)).toBe('unknown');
    expect(asked).toEqual([]);
  });

  it('is unknown for a line without a stamp', () => {
    const { share, asked } = shareOf(1);
    expect(classifyCommittedLine('hola', share)).toBe('unknown');
    expect(classifyCommittedLine('', share)).toBe('unknown');
    expect(asked).toEqual([]);
  });

  it('is unknown when no share is available', () => {
    expect(classifyCommittedLine('[00:01.00-00:02.50] hola', shareOf(null).share)).toBe('unknown');
  });

  it('asks for the span of the stamp', () => {
    const { share, asked } = shareOf(1);
    classifyCommittedLine('[00:01.00-00:02.50] hola', share);
    expect(asked).toEqual([[1000, 2500]]);
  });

  it('is self at or above the threshold', () => {
    expect(classifyCommittedLine('[00:01.00-00:02.50] hola', shareOf(0.9).share)).toBe('self');
    expect(classifyCommittedLine('[00:01.00-00:02.50] hola', shareOf(0.5).share)).toBe('self');
  });

  it('is others below the threshold', () => {
    expect(classifyCommittedLine('[00:01.00-00:02.50] hola', shareOf(0.49).share)).toBe('others');
    expect(classifyCommittedLine('[00:01.00-00:02.50] hola', shareOf(0).share)).toBe('others');
  });

  it('decides tagged lines by the share, not by the tag', () => {
    expect(classifyCommittedLine('[00:00.00-00:01.00] [ You ] hola', shareOf(0.1).share)).toBe(
      'others',
    );
    expect(
      classifyCommittedLine('[00:00.00-00:01.00] [ Speaker-1 ] hola', shareOf(0.9).share),
    ).toBe('self');
  });

  it('reads a starred line like the line under the star', () => {
    const { share, asked } = shareOf(0.8);
    expect(classifyCommittedLine('* [00:01.00-00:02.00] hola', share)).toBe('self');
    expect(asked).toEqual([[1000, 2000]]);
  });

  it('passes a zero-length stamp through as the point it sits on', () => {
    const { share, asked } = shareOf(1);
    expect(classifyCommittedLine('[00:01.00-00:01.00] sí', share)).toBe('self');
    expect(asked).toEqual([[1000, 1000]]);
  });
});
