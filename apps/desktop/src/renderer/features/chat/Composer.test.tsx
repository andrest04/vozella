// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { RefObject } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Providers } from '../../app/test-providers';
import { Composer } from './Composer';

afterEach(() => {
  cleanup();
});

describe('Composer model chip slot', () => {
  it('hands the chip the whole composer box, so its popup can open above the message field', () => {
    let box: RefObject<HTMLElement | null> | null = null;
    render(
      <Providers locale="en">
        <Composer
          draft=""
          onDraftChange={() => undefined}
          onSend={() => undefined}
          onStop={() => undefined}
          isSending={false}
          recipes={[]}
          modelPicker={(composerBox) => {
            box = composerBox;
            return <button type="button">Model</button>;
          }}
        />
      </Providers>,
    );

    const anchor = (box as RefObject<HTMLElement | null> | null)?.current ?? null;
    expect(anchor).toBe(screen.getByTestId('BoxMeetingChatComposer'));
    expect(anchor?.contains(screen.getByTestId('TxtMeetingChat'))).toBe(true);
    expect(anchor?.contains(screen.getByRole('button', { name: 'Model' }))).toBe(true);
  });
});
