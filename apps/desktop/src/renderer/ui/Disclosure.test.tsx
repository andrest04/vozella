// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Disclosure } from './Disclosure';

describe('Disclosure', () => {
  it('is collapsed by default and toggles on activation', async () => {
    render(
      <Disclosure title="Instructions" testId="d">
        <p>Body text</p>
      </Disclosure>,
    );
    const details = screen.getByTestId<HTMLDetailsElement>('d');
    expect(details.open).toBe(false);
    const summary = screen.getByText('Instructions');
    expect(summary.closest('summary')).toHaveAccessibleName('Instructions');
    await userEvent.click(summary);
    expect(details.open).toBe(true);
    await userEvent.click(summary);
    expect(details.open).toBe(false);
  });

  it('can start open', () => {
    render(
      <Disclosure title="Context files" defaultOpen testId="d">
        <p>Body text</p>
      </Disclosure>,
    );
    expect(screen.getByTestId<HTMLDetailsElement>('d').open).toBe(true);
  });
});
