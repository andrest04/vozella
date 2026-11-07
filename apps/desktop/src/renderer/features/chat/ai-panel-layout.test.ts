import { describe, expect, it } from 'vitest';
import {
  DOCK_MIN_CONTENT_WIDTH,
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  dockMaxWidth,
  isPanelToggle,
  overlayMaxWidth,
  panelMode,
  parseStoredOpen,
  parseStoredWidth,
} from './ai-panel-layout';

const key = (overrides: Partial<Parameters<typeof isPanelToggle>[0]>) => ({
  key: 'j',
  ctrlKey: true,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...overrides,
});

describe('panelMode', () => {
  it('keeps 400 px for the content beside a docked panel', () => {
    expect(DOCK_MIN_CONTENT_WIDTH).toBe(400);
  });

  it('docks while the content keeps at least 400 px beside the panel', () => {
    expect(panelMode(780, 380)).toBe('dock');
    expect(panelMode(920, 520)).toBe('dock');
    // The window minimum leaves 728 px beside the sidebar: a narrow panel still docks there.
    expect(panelMode(728, PANEL_MIN_WIDTH)).toBe('dock');
  });

  it('overlays when docking would leave the content under 400 px', () => {
    expect(panelMode(779, 380)).toBe('overlay');
    expect(panelMode(728, PANEL_DEFAULT_WIDTH)).toBe('overlay');
  });

  it('docks before the first measurement arrives', () => {
    expect(panelMode(null, 380)).toBe('dock');
  });
});

describe('dockMaxWidth', () => {
  it('stops the docked handle where the content would drop under its minimum', () => {
    expect(dockMaxWidth(900)).toBe(500);
    expect(dockMaxWidth(1200)).toBe(PANEL_MAX_WIDTH);
  });

  it('never goes under the panel minimum, and allows the maximum before a measurement', () => {
    expect(dockMaxWidth(600)).toBe(PANEL_MIN_WIDTH);
    expect(dockMaxWidth(null)).toBe(PANEL_MAX_WIDTH);
  });
});

describe('overlayMaxWidth', () => {
  it('lets the floating panel grow up to the shared width, within the panel limits', () => {
    expect(overlayMaxWidth(450)).toBe(450);
    expect(overlayMaxWidth(900)).toBe(PANEL_MAX_WIDTH);
    expect(overlayMaxWidth(280)).toBe(PANEL_MIN_WIDTH);
    expect(overlayMaxWidth(null)).toBe(PANEL_MAX_WIDTH);
  });
});

describe('stored preferences', () => {
  it('reads a width inside the limits and falls back to the default otherwise', () => {
    expect(parseStoredWidth('420')).toBe(420);
    expect(parseStoredWidth('100')).toBe(PANEL_MIN_WIDTH);
    expect(parseStoredWidth('9000')).toBe(PANEL_MAX_WIDTH);
    expect(parseStoredWidth(null)).toBe(PANEL_DEFAULT_WIDTH);
    expect(parseStoredWidth('wide')).toBe(PANEL_DEFAULT_WIDTH);
  });

  it('opens only on an explicit true', () => {
    expect(parseStoredOpen('true')).toBe(true);
    expect(parseStoredOpen('false')).toBe(false);
    expect(parseStoredOpen(null)).toBe(false);
  });
});

describe('isPanelToggle', () => {
  it('matches Ctrl+J and Ctrl+Shift+J', () => {
    expect(isPanelToggle(key({}))).toBe(true);
    expect(isPanelToggle(key({ key: 'J', shiftKey: true }))).toBe(true);
  });

  it('ignores other chords', () => {
    expect(isPanelToggle(key({ ctrlKey: false }))).toBe(false);
    expect(isPanelToggle(key({ altKey: true }))).toBe(false);
    expect(isPanelToggle(key({ key: 'k' }))).toBe(false);
  });
});
