import type { CursorTypingRefusalDto, CursorTypingStatusDto } from '@vozella/contracts';
import type { StringKey, Translate } from '../../i18n/translate';

/** Process names that read badly once `.exe` is gone. Product names are not translated. */
const KNOWN_APPS: Readonly<Record<string, string>> = {
  msedge: 'Edge',
  winword: 'Word',
  excel: 'Excel',
  powerpnt: 'PowerPoint',
  olk: 'Outlook',
  outlook: 'Outlook',
  'ms-teams': 'Teams',
  teams: 'Teams',
  code: 'VS Code',
  chatgpt: 'ChatGPT',
};

/** `chrome.exe` reads as Chrome. Null when there is no usable name: say "the app" instead. */
export function friendlyAppName(processName: string | null): string | null {
  if (processName === null) return null;
  const base = processName
    .trim()
    .replace(/\.exe$/i, '')
    .trim();
  if (base === '') return null;
  const known = KNOWN_APPS[base.toLowerCase()];
  if (known !== undefined) return known;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

const MODIFIER_CAPS: Readonly<Record<string, string>> = {
  commandorcontrol: 'Ctrl',
  cmdorctrl: 'Ctrl',
  control: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  altgr: 'AltGr',
  shift: 'Shift',
  super: 'Win',
  meta: 'Win',
  command: 'Win',
  cmd: 'Win',
};

/** The key caps of an Electron accelerator as Windows names them: `CommandOrControl` is Ctrl. */
export function acceleratorKeys(accelerator: string): string[] {
  return accelerator
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map(
      (part) => MODIFIER_CAPS[part.toLowerCase()] ?? part.charAt(0).toUpperCase() + part.slice(1),
    );
}

/** The accelerator written the way it is pressed, for sentences: "Ctrl+Alt+Space". */
export const acceleratorLabel = (accelerator: string): string =>
  acceleratorKeys(accelerator).join('+');

export interface KeyPress {
  readonly code: string;
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

export type CapturedShortcut =
  | { readonly kind: 'accelerator'; readonly value: string }
  /** Escape alone: leave the shortcut as it was. */
  | { readonly kind: 'cancel' }
  /** Only modifiers are down so far. */
  | { readonly kind: 'waiting' }
  /** No Ctrl, Alt or Win: the key would type a character in every app. */
  | { readonly kind: 'needs-modifier' }
  | { readonly kind: 'unsupported' };

const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

const NAMED_CODES: Readonly<Record<string, string>> = {
  Space: 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Delete: 'Delete',
  Backspace: 'Backspace',
  Enter: 'Enter',
};

/**
 * The accelerator key of a physical key, from `KeyboardEvent.code` so the keyboard layout does
 * not change it. Only letters, digits, function, navigation and numpad digit keys: punctuation
 * names differ between layouts and Electron, so they are refused rather than guessed.
 */
function acceleratorKeyOf(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1] ?? null;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1] ?? null;
  const numpad = /^Numpad([0-9])$/.exec(code);
  if (numpad) return `num${numpad[1] ?? ''}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return NAMED_CODES[code] ?? null;
}

/** Reads one key press of the shortcut capture into an Electron accelerator, or why not. */
export function acceleratorFromKeys(press: KeyPress): CapturedShortcut {
  const anyModifier = press.ctrlKey || press.altKey || press.shiftKey || press.metaKey;
  if (press.code === 'Escape' && !anyModifier) return { kind: 'cancel' };
  if (MODIFIER_CODES.test(press.code)) return { kind: 'waiting' };
  if (!press.ctrlKey && !press.altKey && !press.metaKey) return { kind: 'needs-modifier' };
  const key = acceleratorKeyOf(press.code);
  if (key === null) return { kind: 'unsupported' };
  const parts = [
    press.ctrlKey ? 'CommandOrControl' : null,
    press.altKey ? 'Alt' : null,
    press.shiftKey ? 'Shift' : null,
    press.metaKey ? 'Super' : null,
    key,
  ].filter((part): part is string => part !== null);
  return { kind: 'accelerator', value: parts.join('+') };
}

const appName = (processName: string | null, t: Translate): string =>
  friendlyAppName(processName) ?? t('Ui_CursorTypingAppGeneric');

const PAUSED: Readonly<Record<'own-window' | 'blocked' | 'interrupted', StringKey>> = {
  'own-window': 'Ui_CursorTypingPausedOwnWindow',
  blocked: 'Ui_CursorTypingPausedBlocked',
  interrupted: 'Ui_CursorTypingPausedInterrupted',
};

/**
 * The lasting line of the status: a shortcut another app holds, then what typing is doing. Null
 * while it is off and nothing is wrong. Refusals are separate: they answer one press.
 */
export function cursorTypingStateText(status: CursorTypingStatusDto, t: Translate): string | null {
  if (status.shortcut.status === 'unavailable') {
    return t('Ui_CursorTypingShortcutTakenShort', acceleratorLabel(status.shortcut.accelerator));
  }
  return cursorTypingTargetText(status.state, t);
}

/** What typing is doing with its target, without the shortcut: the pill mark's tooltip. */
export function cursorTypingTargetText(
  state: CursorTypingStatusDto['state'],
  t: Translate,
): string | null {
  switch (state.status) {
    case 'off':
      return null;
    case 'armed':
      return state.warning === 'speaker-unknown'
        ? t('Ui_CursorTypingSpeakerUnknown')
        : t('Ui_CursorTypingArmed', appName(state.processName, t));
    case 'paused':
      return state.reason === 'focus-changed'
        ? t('Ui_CursorTypingPausedFocus', appName(state.processName, t))
        : t(PAUSED[state.reason]);
  }
}

const REFUSALS: Readonly<Record<CursorTypingRefusalDto, StringKey>> = {
  'no-target': 'Ui_CursorTypingRefusalTarget',
  'own-window': 'Ui_CursorTypingRefusalTarget',
  blocked: 'Ui_CursorTypingPausedBlocked',
  inactive: 'Ui_CursorTypingRefusalInactive',
};

/** What to do after a press that armed nothing. */
export const cursorTypingRefusalText = (
  refusal: CursorTypingRefusalDto | null,
  t: Translate,
): string | null => (refusal === null ? null : t(REFUSALS[refusal]));

/** The discoverability line: "Ctrl+Alt+Space types at your cursor". */
export const cursorTypingHint = (accelerator: string, t: Translate): string =>
  t('Ui_CursorTypingHint', acceleratorLabel(accelerator));
