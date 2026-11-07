import { describe, expect, it } from 'vitest';
import { formatDevVersion, parseDescribe, readDevVersion } from './dev-version';

describe('parseDescribe', () => {
  it('reads the tag version, the commits since it and the short sha', () => {
    expect(parseDescribe('v0.9.7-51-gb64ffb3\n')).toEqual({
      version: '0.9.7',
      commits: 51,
      sha: 'b64ffb3',
    });
  });

  it('rejects output that is not a long describe', () => {
    expect(parseDescribe('b64ffb3')).toBeNull();
    expect(parseDescribe('v0.9.7')).toBeNull();
  });
});

describe('formatDevVersion', () => {
  it('appends the commits since the tag', () => {
    expect(formatDevVersion({ version: '0.9.7', commits: 51, sha: 'b64ffb3' })).toBe(
      '0.9.7+51 (b64ffb3, dev)',
    );
  });

  it('shows the bare tag version exactly at the tag', () => {
    expect(formatDevVersion({ version: '0.9.7', commits: 0, sha: 'b64ffb3' })).toBe(
      '0.9.7 (b64ffb3, dev)',
    );
  });
});

describe('readDevVersion', () => {
  it('uses git describe when a release tag is reachable', () => {
    const asked: string[][] = [];
    const version = readDevVersion((args) => {
      asked.push(args);
      return 'v0.9.7-3-gabc1234\n';
    }, '0.0.1');
    expect(version).toBe('0.9.7+3 (abc1234, dev)');
    expect(asked[0]).toEqual(['describe', '--tags', '--long', '--match', 'v[0-9]*']);
  });

  it('falls back to the package version and the sha when there is no tag', () => {
    const version = readDevVersion((args) => {
      if (args[0] === 'describe') throw new Error('No names found');
      return 'abc1234\n';
    }, '0.9.7');
    expect(version).toBe('0.9.7 (abc1234, dev)');
  });

  it('falls back to the package version alone when git is unavailable', () => {
    const version = readDevVersion(() => {
      throw new Error('ENOENT');
    }, '0.9.7');
    expect(version).toBe('0.9.7 (dev)');
  });
});
