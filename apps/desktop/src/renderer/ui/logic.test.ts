import { describe, expect, it } from 'vitest';
import { clampSize, sizeForDrag, sizeForKey } from './splitter-logic';

describe('splitter logic', () => {
  const horizontal = { min: 100, max: 300, orientation: 'horizontal' as const };

  it('clamps, and tolerates a max below the min', () => {
    expect(clampSize(50, 100, 300)).toBe(100);
    expect(clampSize(500, 100, 300)).toBe(300);
    expect(clampSize(200, 100, 50)).toBe(100);
  });

  it('steps with the arrows for the orientation, bigger with Shift', () => {
    expect(sizeForKey('ArrowRight', false, 200, horizontal)).toBe(216);
    expect(sizeForKey('ArrowLeft', true, 200, horizontal)).toBe(136);
    expect(sizeForKey('ArrowDown', false, 200, horizontal)).toBeNull();
    expect(sizeForKey('ArrowDown', false, 200, { ...horizontal, orientation: 'vertical' })).toBe(
      216,
    );
  });

  it('never leaves the limits and jumps with Home and End', () => {
    expect(sizeForKey('ArrowRight', true, 290, horizontal)).toBe(300);
    expect(sizeForKey('Home', false, 200, horizontal)).toBe(100);
    expect(sizeForKey('End', false, 200, horizontal)).toBe(300);
    expect(sizeForKey('a', false, 200, horizontal)).toBeNull();
  });

  it('follows the pointer from where the drag started', () => {
    const limits = { min: 100, max: 300 };
    expect(sizeForDrag(200, 400, 450, limits)).toBe(250);
    expect(sizeForDrag(200, 400, 100, limits)).toBe(100);
    expect(sizeForDrag(200, 400, 900, limits)).toBe(300);
  });
});
