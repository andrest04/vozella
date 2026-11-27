import { describe, expect, it } from 'vitest';
import { FakeTextInjector } from './fake-text-injector';

describe('FakeTextInjector', () => {
  it('records every typed string in order', () => {
    const injector = new FakeTextInjector();
    injector.typeText('hola');
    injector.typeText('qué tal');
    expect(injector.typed).toEqual(['hola', 'qué tal']);
  });

  it('reports two key events per UTF-16 unit, all sent', () => {
    const result = new FakeTextInjector().typeText('a😀');
    expect(result).toEqual({ sent: 6, expected: 6 });
  });

  it('starts on a foreign, unblocked notepad target', () => {
    expect(new FakeTextInjector().foregroundTarget()).toMatchObject({
      processName: 'notepad.exe',
      isOwnProcess: false,
      blocked: false,
      menuOpen: false,
      modifiersHeld: false,
    });
  });

  it('can report no foreground window', () => {
    const injector = new FakeTextInjector();
    injector.target = null;
    expect(injector.foregroundTarget()).toBeNull();
  });

  it('can simulate a short count while still recording the attempt', () => {
    const injector = new FakeTextInjector();
    injector.respond = (text) => ({ sent: 0, expected: text.length * 2 });
    expect(injector.typeText('hi')).toEqual({ sent: 0, expected: 4 });
    expect(injector.typed).toEqual(['hi']);
  });
});
