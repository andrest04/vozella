// Loaded with `electron -r` when VOZELLA_E2E_BACKGROUND=1, so an e2e run can happen while someone
// is using the machine: every window stays off-screen, out of the taskbar and never takes focus.
// The app and the specs still read the place they asked for, so window logic stays testable. Specs
// that depend on real screen pixels or on window focus cannot run in this mode.
/* eslint-disable @typescript-eslint/no-require-imports -- Electron runs this file through -r, as CommonJS. */
const Module = require('node:module');
const electron = require('electron');
const { app, BrowserWindow } = electron;

const OFF_SCREEN = -20000;
const proto = BrowserWindow.prototype;
const showInactive = proto.showInactive;
const setBounds = proto.setBounds;
const setPosition = proto.setPosition;
const getBounds = proto.getBounds;
const getNormalBounds = proto.getNormalBounds;
const getContentBounds = proto.getContentBounds;
const setContentSize = proto.setContentSize;
const setContentBounds = proto.setContentBounds;

/** Where each window believes it is. The real position is always off-screen. */
const asked = new WeakMap();
const withAsked = (window, bounds) => ({ ...bounds, ...asked.get(window) });

function showParked() {
  this.setSkipTaskbar(true);
  setPosition.call(this, OFF_SCREEN, OFF_SCREEN);
  showInactive.call(this);
}

proto.show = showParked;
proto.showInactive = showParked;
// Sizes still apply, positions do not: nothing may bring a window back onto the screen.
proto.setBounds = function (bounds, animate) {
  const current = withAsked(this, getBounds.call(this));
  asked.set(this, { x: bounds.x ?? current.x, y: bounds.y ?? current.y });
  setBounds.call(this, { ...bounds, x: OFF_SCREEN, y: OFF_SCREEN }, animate);
};
proto.setPosition = function (x, y) {
  asked.set(this, { x, y });
};
proto.getBounds = function () {
  return withAsked(this, getBounds.call(this));
};
proto.getNormalBounds = function () {
  return withAsked(this, getNormalBounds.call(this));
};
proto.getContentBounds = function () {
  return withAsked(this, getContentBounds.call(this));
};
proto.getPosition = function () {
  const { x, y } = this.getBounds();
  return [x, y];
};
// Parked, the client area comes out 16 by 8 px larger than asked, so correct the window for it.
proto.setContentSize = function (width, height, animate) {
  setContentSize.call(this, width, height, animate);
  const [actualWidth, actualHeight] = this.getContentSize();
  const [outerWidth, outerHeight] = this.getSize();
  if (actualWidth === width && actualHeight === height) return;
  setBounds.call(this, {
    x: OFF_SCREEN,
    y: OFF_SCREEN,
    width: outerWidth - (actualWidth - width),
    height: outerHeight - (actualHeight - height),
  });
};
proto.setContentBounds = function (bounds, animate) {
  const current = withAsked(this, getBounds.call(this));
  asked.set(this, { x: bounds.x ?? current.x, y: bounds.y ?? current.y });
  setContentBounds.call(this, { ...bounds, x: OFF_SCREEN, y: OFF_SCREEN }, animate);
};
// Each of these would put a parked window back on a display, so each does nothing:
// - center moves the window to the middle of its display;
// - focus activates it, which takes the keyboard from whoever is using the machine;
// - moveTop raises it above the other windows and can activate it;
// - maximize and setFullScreen (and setKiosk, which is full screen) size it to a display.
for (const method of ['center', 'focus', 'moveTop', 'maximize', 'setFullScreen', 'setKiosk']) {
  proto[method] = () => undefined;
}
// A real minimize hands the activation to another window, and a real restore brings this one back
// with the focus, so both only keep the state the app and the specs read.
const minimized = new WeakSet();
proto.minimize = function () {
  minimized.add(this);
};
proto.restore = function () {
  minimized.delete(this);
};
proto.isMinimized = function () {
  return minimized.has(this);
};
// A window not yet shown keeps its real place until then, so park it from the start.
app.on('browser-window-created', (_event, window) => {
  const { x, y } = getBounds.call(window);
  asked.set(window, { x, y });
  window.setSkipTaskbar(true);
  setPosition.call(window, OFF_SCREEN, OFF_SCREEN);
  // A fallback for a window built with the original class (ParkedWindow below is the normal
  // path): Electron places and shows a `show: true` window after this event, so park it again.
  window.on('show', () => {
    setPosition.call(window, OFF_SCREEN, OFF_SCREEN);
  });
});

/**
 * `new BrowserWindow({ show: true })`, and `show` is true when left out, shows the window from
 * native code, at the x/y it was given, without calling `show()`. This subclass builds every
 * window hidden, keeps the place it would have had as the place it believes it is, and then
 * shows it parked. `instanceof` and the static methods still answer for every window.
 */
class ParkedWindow extends BrowserWindow {
  constructor(options = {}) {
    super({ ...options, show: false });
    // The window has its real, still hidden, place now: x/y, centered, or the default.
    const { x, y } = getBounds.call(this);
    asked.set(this, { x, y });
    if (options.show !== false) showParked.call(this);
  }

  static [Symbol.hasInstance](value) {
    return value instanceof BrowserWindow;
  }
}
// Electron lists a window in BrowserWindow.getAllWindows() only when its constructor is named
// BrowserWindow, so the subclass takes that name.
Object.defineProperty(ParkedWindow, 'name', { value: 'BrowserWindow' });
ParkedWindow.parked = true;

// Electron's exports are read-only, so `require('electron')` hands out a view of them with
// ParkedWindow in place of BrowserWindow. The app's main bundle and Playwright's `app.evaluate`
// (which reads `require('electron')` too, after this file has run) both come through here.
const parkedElectron = new Proxy(electron, {
  get(target, key) {
    return key === 'BrowserWindow' ? ParkedWindow : Reflect.get(target, key);
  },
});
const load = Module._load;
Module._load = function (request, ...rest) {
  const exported = load.call(this, request, ...rest);
  return request === 'electron' && exported === electron ? parkedElectron : exported;
};
app.focus = () => undefined;
// An off-screen window counts as occluded on Windows, and would stop painting.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
