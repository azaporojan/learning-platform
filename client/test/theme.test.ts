// Site theme choice (theme.ts): the default, saved values, private mode, and System
import test from 'node:test';
import assert from 'node:assert/strict';

const store = new Map<string, string>();
let osDark = false;
let failWrites = false;
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { if (failWrites) throw new Error('private mode'); store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as any).window = {
  matchMedia: () => ({ matches: osDark, addEventListener() {}, removeEventListener() {} }),
  dispatchEvent() { return true; },
};
(globalThis as any).CustomEvent = class { type: string; constructor(t: string) { this.type = t; } };
const classes = new Set<string>();
(globalThis as any).document = { documentElement: { classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) }, style: {} } };

const theme = await import('../theme.ts');

test('light is the default, and an unknown saved value reads as light', () => {
  store.clear();
  assert.equal(theme.readThemeChoice(), 'light');
  store.set('lp-theme', 'purple');
  assert.equal(theme.readThemeChoice(), 'light');
});

test('dark and system are saved; light removes the saved value', () => {
  theme.setThemeChoice('dark');
  assert.equal(store.get('lp-theme'), 'dark');
  assert.ok(classes.has('dark'));
  theme.setThemeChoice('light');
  assert.equal(store.has('lp-theme'), false);
  assert.ok(!classes.has('dark'));
});

test('system follows the OS', () => {
  osDark = true;
  assert.equal(theme.isDarkChoice('system'), true);
  osDark = false;
  assert.equal(theme.isDarkChoice('system'), false);
  assert.equal(theme.isDarkChoice('dark'), true);
});

test('a failed write (private mode) still keeps the choice for this page', () => {
  failWrites = true;
  theme.setThemeChoice('dark');
  assert.equal(theme.readThemeChoice(), 'dark');
  assert.ok(classes.has('dark'));
  failWrites = false;
});
