import { describe, expect, it } from 'vitest';
import { createSseParser } from './sse';

describe('createSseParser', () => {
  it('reads data and event lines of one event', () => {
    const parser = createSseParser();
    expect(parser.push('event: ping\ndata: {"a":1}\n\n')).toEqual([
      { event: 'ping', data: '{"a":1}' },
    ]);
  });

  it('keeps an event split mid-line across chunks until its blank line arrives', () => {
    const parser = createSseParser();
    expect(parser.push('data: {"te')).toEqual([]);
    expect(parser.push('xt":"hi"}\n')).toEqual([]);
    expect(parser.push('\ndata: [DO')).toEqual([{ event: null, data: '{"text":"hi"}' }]);
    expect(parser.push('NE]\n\n')).toEqual([{ event: null, data: '[DONE]' }]);
  });

  it('accepts CRLF line endings and joins multi-line data', () => {
    const parser = createSseParser();
    expect(parser.push('data: one\r\ndata: two\r\n\r\n')).toEqual([
      { event: null, data: 'one\ntwo' },
    ]);
  });

  it('ignores comments and events without data', () => {
    const parser = createSseParser();
    expect(parser.push(': keep-alive\n\nevent: x\n\n')).toEqual([]);
  });

  it('flushes a last event that has no closing blank line', () => {
    const parser = createSseParser();
    expect(parser.push('data: tail')).toEqual([]);
    expect(parser.flush()).toEqual([{ event: null, data: 'tail' }]);
  });
});
