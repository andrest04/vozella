// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../library/library-test-kit';
import { Composer } from './Composer';
import { composerFit } from './composer-fit';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('composerFit', () => {
  it('an empty draft keeps one line and no scrollbar, whatever the placeholder measures', () => {
    expect(composerFit('', 64)).toEqual({ height: 32, overflowY: 'hidden' });
  });

  it('grows with typed lines and hides the scrollbar below the maximum', () => {
    expect(composerFit('a\nb\nc', 72)).toEqual({ height: 72, overflowY: 'hidden' });
  });

  it('caps the height at the maximum and scrolls only past it', () => {
    expect(composerFit('a', 96)).toEqual({ height: 96, overflowY: 'hidden' });
    expect(composerFit('a', 140)).toEqual({ height: 96, overflowY: 'auto' });
  });

  it('never shrinks below one line', () => {
    expect(composerFit('a', 10)).toEqual({ height: 32, overflowY: 'hidden' });
  });
});

function Harness({ initial }: { initial: string }) {
  const [draft, setDraft] = useState(initial);
  return (
    <Providers locale="es">
      <Composer
        draft={draft}
        onDraftChange={setDraft}
        onSend={() => undefined}
        onStop={() => undefined}
        isSending={false}
        recipes={[]}
      />
    </Providers>
  );
}

const field = () => screen.getByTestId<HTMLTextAreaElement>('TxtMeetingChat');

describe('Composer message box sizing', () => {
  it('the empty box stays one line without a scrollbar even if the placeholder wraps', () => {
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(52);
    render(<Harness initial="" />);
    expect(field().style.height).toBe('32px');
    expect(field().style.overflowY).toBe('hidden');
  });

  it('long typed text caps at the maximum height and scrolls', () => {
    vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(200);
    render(<Harness initial={'line\n'.repeat(10)} />);
    expect(field().style.height).toBe('96px');
    expect(field().style.overflowY).toBe('auto');
  });

  it('the placeholder truncates on one line', () => {
    render(<Harness initial="" />);
    expect(field().className).toContain('placeholder:truncate');
  });
});
