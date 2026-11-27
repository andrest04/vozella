import type { CursorTypingStatusDto } from '@vozella/contracts';
import { describe, expect, it } from 'vitest';
import { createTranslator } from '../../i18n/translate';
import {
  acceleratorFromKeys,
  acceleratorKeys,
  cursorTypingHint,
  cursorTypingRefusalText,
  cursorTypingStateText,
  friendlyAppName,
} from './cursor-typing-text';

const en = createTranslator('en');
const es = createTranslator('es');

const status = (over: Partial<CursorTypingStatusDto> = {}): CursorTypingStatusDto => ({
  state: { status: 'off' },
  shortcut: { status: 'registered', accelerator: 'CommandOrControl+Alt+Space' },
  lastRefusal: null,
  ...over,
});

const armed = (processName: string | null, warning: 'speaker-unknown' | null = null) =>
  ({ status: 'armed', source: 'others', processName, warning }) as const;

const paused = (
  reason: 'focus-changed' | 'own-window' | 'blocked' | 'interrupted',
  processName: string | null = 'chrome.exe',
) => ({ status: 'paused', source: 'others', processName, reason, warning: null }) as const;

describe('friendlyAppName', () => {
  it('drops the .exe and capitalises the first letter', () => {
    expect(friendlyAppName('chrome.exe')).toBe('Chrome');
    expect(friendlyAppName('notepad.EXE')).toBe('Notepad');
    expect(friendlyAppName('Slack.exe')).toBe('Slack');
  });

  it('names the common apps whose process name reads badly', () => {
    expect(friendlyAppName('msedge.exe')).toBe('Edge');
    expect(friendlyAppName('WINWORD.EXE')).toBe('Word');
    expect(friendlyAppName('ms-teams.exe')).toBe('Teams');
  });

  it('gives null for a missing or blank name, so the caller says "the app"', () => {
    expect(friendlyAppName(null)).toBeNull();
    expect(friendlyAppName('  ')).toBeNull();
    expect(friendlyAppName('.exe')).toBeNull();
  });
});

describe('acceleratorKeys', () => {
  it('shows CommandOrControl as Ctrl on Windows', () => {
    expect(acceleratorKeys('CommandOrControl+Alt+Space')).toEqual(['Ctrl', 'Alt', 'Space']);
    expect(acceleratorKeys('CmdOrCtrl+Shift+K')).toEqual(['Ctrl', 'Shift', 'K']);
  });

  it('shows Super as Win and keeps other keys, ignoring blanks', () => {
    expect(acceleratorKeys('Super+Alt+f5')).toEqual(['Win', 'Alt', 'F5']);
    expect(acceleratorKeys(' Control + Up ')).toEqual(['Ctrl', 'Up']);
    expect(acceleratorKeys('')).toEqual([]);
  });
});

describe('acceleratorFromKeys', () => {
  const press = (code: string, mods: Partial<Record<'ctrl' | 'alt' | 'shift' | 'meta', boolean>>) =>
    acceleratorFromKeys({
      code,
      key: code,
      ctrlKey: mods.ctrl ?? false,
      altKey: mods.alt ?? false,
      shiftKey: mods.shift ?? false,
      metaKey: mods.meta ?? false,
    });

  it('builds an Electron accelerator with the modifiers in a fixed order', () => {
    expect(press('Space', { ctrl: true, alt: true })).toEqual({
      kind: 'accelerator',
      value: 'CommandOrControl+Alt+Space',
    });
    expect(press('KeyK', { shift: true, ctrl: true })).toEqual({
      kind: 'accelerator',
      value: 'CommandOrControl+Shift+K',
    });
    expect(press('Digit7', { meta: true })).toEqual({ kind: 'accelerator', value: 'Super+7' });
    expect(press('F9', { alt: true })).toEqual({ kind: 'accelerator', value: 'Alt+F9' });
    expect(press('ArrowUp', { alt: true })).toEqual({ kind: 'accelerator', value: 'Alt+Up' });
  });

  it('cancels on Escape without modifiers', () => {
    expect(press('Escape', {})).toEqual({ kind: 'cancel' });
  });

  it('waits while only modifiers are down', () => {
    expect(press('ControlLeft', { ctrl: true })).toEqual({ kind: 'waiting' });
    expect(press('AltRight', { alt: true, ctrl: true })).toEqual({ kind: 'waiting' });
  });

  it('refuses a key without Ctrl, Alt or Win; Shift alone does not count', () => {
    expect(press('KeyA', {})).toEqual({ kind: 'needs-modifier' });
    expect(press('KeyA', { shift: true })).toEqual({ kind: 'needs-modifier' });
    expect(press('Space', {})).toEqual({ kind: 'needs-modifier' });
  });

  it('refuses keys an accelerator cannot name safely', () => {
    expect(press('Semicolon', { ctrl: true })).toEqual({ kind: 'unsupported' });
    expect(press('Tab', { alt: true })).toEqual({ kind: 'unsupported' });
  });
});

describe('cursorTypingStateText', () => {
  it('is null while off with the shortcut held', () => {
    expect(cursorTypingStateText(status(), en)).toBeNull();
  });

  it('names the target app while armed, or "the app" when it is unknown', () => {
    expect(cursorTypingStateText(status({ state: armed('chrome.exe') }), en)).toBe(
      'Typing into Chrome',
    );
    expect(cursorTypingStateText(status({ state: armed(null) }), es)).toBe('Escribiendo en la app');
  });

  it('puts the missing microphone first while armed', () => {
    expect(
      cursorTypingStateText(status({ state: armed('chrome.exe', 'speaker-unknown') }), en),
    ).toBe("No microphone: can't tell who's speaking");
  });

  it('says why typing is paused', () => {
    expect(cursorTypingStateText(status({ state: paused('focus-changed') }), en)).toBe(
      'Paused: go back to Chrome to continue',
    );
    expect(cursorTypingStateText(status({ state: paused('focus-changed') }), es)).toBe(
      'En pausa: vuelve a Chrome para continuar',
    );
    expect(cursorTypingStateText(status({ state: paused('blocked') }), en)).toBe(
      "Can't type into apps running as administrator",
    );
    expect(cursorTypingStateText(status({ state: paused('interrupted') }), en)).toBe(
      'A line was cut off',
    );
    expect(cursorTypingStateText(status({ state: paused('own-window') }), en)).toBe(
      'Click into another app first',
    );
  });

  it('reports a shortcut another app holds before anything else', () => {
    expect(
      cursorTypingStateText(
        status({
          state: armed('chrome.exe'),
          shortcut: { status: 'unavailable', accelerator: 'CommandOrControl+Alt+Space' },
        }),
        en,
      ),
    ).toBe('Another app uses Ctrl+Alt+Space');
  });
});

describe('cursorTypingRefusalText', () => {
  it('turns each refusal into a short instruction', () => {
    expect(cursorTypingRefusalText(null, en)).toBeNull();
    expect(cursorTypingRefusalText('no-target', en)).toBe('Put your cursor in another app first');
    expect(cursorTypingRefusalText('own-window', en)).toBe('Put your cursor in another app first');
    expect(cursorTypingRefusalText('blocked', en)).toBe(
      "Can't type into apps running as administrator",
    );
    expect(cursorTypingRefusalText('inactive', es)).toBe('Primero empieza una grabación');
  });
});

describe('cursorTypingHint', () => {
  it('shows the shortcut as it is pressed', () => {
    expect(cursorTypingHint('CommandOrControl+Alt+Space', en)).toBe(
      'Ctrl+Alt+Space types at your cursor',
    );
  });
});
