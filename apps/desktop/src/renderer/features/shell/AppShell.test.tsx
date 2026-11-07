import { describe, expect, it } from 'vitest';
import { pageColumn } from '../../ui';
import { contentColumn } from './AppShell';

describe('contentColumn', () => {
  it.each(['/record', '/settings', '/session', '/gallery'])(
    '%s gets the page column: centered, capped at the page width, same padding',
    (pathname) => {
      expect(contentColumn(pathname)).toBe(pageColumn);
    },
  );

  it('the page column caps the content at the page token with the padding outside it', () => {
    expect(pageColumn).toContain('mx-auto');
    expect(pageColumn).toContain('w-full');
    expect(pageColumn).toContain('px-10');
    expect(pageColumn).toContain('max-w-[calc(var(--container-page)+var(--spacing)*20)]');
  });

  it('the Library fills the area with its own panes, no cap and no padding', () => {
    const library = contentColumn('/library');
    expect(library).not.toMatch(/max-w-/);
    expect(library).not.toMatch(/px-10/);
  });
});
