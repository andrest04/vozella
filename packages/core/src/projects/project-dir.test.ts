import { describe, expect, it } from 'vitest';
import { allocateProjectDir, isSafeProjectDir, sanitizeDirName } from './project-dir';

describe('isSafeProjectDir', () => {
  it.each(['Universidad', 'Universidad/Cálculo', 'a b/c d', 'x'.repeat(100)])(
    'accepts %s',
    (dir) => {
      expect(isSafeProjectDir(dir)).toBe(true);
    },
  );

  it.each([
    ['empty', ''],
    ['absolute posix', '/etc'],
    ['drive letter', 'C:/Windows'],
    ['colon', 'a:b'],
    ['backslash', 'a\\b'],
    ['trailing slash', 'a/'],
    ['empty segment', 'a//b'],
    ['dot segment', 'a/./b'],
    ['dot-dot segment', '../x'],
    ['meta directory', '.vozella'],
    ['dot-prefixed nested segment', 'a/.hidden'],
    ['device name', 'CON'],
    ['device name with extension', 'aux.txt'],
    ['numbered device', 'Lpt3'],
    ['nested device', 'ok/NUL'],
    ['trailing dot', 'abc.'],
    ['trailing space', 'abc '],
    ['nested trailing dot', 'a/b.'],
    ['forbidden character', 'a<b'],
    ['question mark', 'what?'],
    ['control character', 'a\u0001b'],
    ['over 260 characters', 'x'.repeat(261)],
  ])('rejects %s', (_label, dir) => {
    expect(isSafeProjectDir(dir)).toBe(false);
  });
});

describe('sanitizeDirName', () => {
  it('removes forbidden characters and collapses whitespace', () => {
    expect(sanitizeDirName('  Plan:  Q4 / "Final"?  ')).toBe('Plan Q4 Final');
  });
  it('strips leading dots and trailing dots and spaces', () => {
    expect(sanitizeDirName('..hidden.. ')).toBe('hidden');
    expect(sanitizeDirName('name. . ')).toBe('name');
  });
  it('cuts at 80 characters without leaving a trailing space', () => {
    const out = sanitizeDirName(`${'a'.repeat(79)} bbbb`);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith(' ')).toBe(false);
  });
  it('turns an empty result into Project', () => {
    expect(sanitizeDirName('???')).toBe('Project');
    expect(sanitizeDirName('...')).toBe('Project');
    expect(sanitizeDirName('')).toBe('Project');
  });
  it('suffixes Windows reserved names, with or without extension', () => {
    expect(sanitizeDirName('CON')).toBe('CON project');
    expect(sanitizeDirName('nul.txt')).toBe('nul project.txt');
    expect(sanitizeDirName('com1')).toBe('com1 project');
  });
  it('keeps accents and everyday punctuation', () => {
    expect(sanitizeDirName('Producto Q4 – Cálculo (v2)')).toBe('Producto Q4 – Cálculo (v2)');
  });
  it('always yields a safe single segment', () => {
    for (const name of [
      'CON',
      'nul.txt',
      'a/b',
      '  ',
      '..',
      'x'.repeat(500),
      'tab\there',
      'Inbox',
    ]) {
      expect(isSafeProjectDir(sanitizeDirName(name))).toBe(true);
    }
  });
});

describe('allocateProjectDir', () => {
  it('uses the sanitized name when it is free', () => {
    expect(allocateProjectDir('Producto', [])).toBe('Producto');
  });
  it('treats Inbox as taken, ignoring case and accents', () => {
    expect(allocateProjectDir('Inbox', [])).toBe('Inbox 2');
    expect(allocateProjectDir('INBOX', [])).toBe('INBOX 2');
  });
  it('compares folded: case and accents', () => {
    expect(allocateProjectDir('cálculo', ['Calculo'])).toBe('cálculo 2');
  });
  it('treats existing library entries as taken, including legacy Meetings and Recordings', () => {
    expect(allocateProjectDir('Meetings', ['Meetings', 'Recordings'])).toBe('Meetings 2');
    expect(allocateProjectDir('Recordings', ['Meetings', 'Recordings'])).toBe('Recordings 2');
  });
  it('treats the first segment of a nested frozen dir as taken, so no child or prefix is possible', () => {
    expect(allocateProjectDir('Universidad', ['Universidad/Cálculo'])).toBe('Universidad 2');
  });
  it('treats a nested frozen dir itself as taken', () => {
    expect(allocateProjectDir('Cálculo', ['Universidad/Cálculo'])).toBe('Cálculo');
  });
  it('tries suffixes in order and skips the ones taken', () => {
    expect(allocateProjectDir('Foo', ['Foo', 'foo 2', 'FOO 3'])).toBe('Foo 4');
  });
  it('handles reserved names and trailing dots', () => {
    expect(allocateProjectDir('NUL', [])).toBe('NUL project');
    expect(allocateProjectDir('Trabajo...', ['Trabajo'])).toBe('Trabajo 2');
  });
  it('keeps the result within the safe limits for very long names', () => {
    const dir = allocateProjectDir('x'.repeat(200), ['x'.repeat(80)]);
    expect(dir).toBe(`${'x'.repeat(80)} 2`);
    expect(isSafeProjectDir(dir)).toBe(true);
  });
});
