// Site theme: light (the default), dark, or follow the operating system. The choice is kept in this browser
// (localStorage) and applied as the "dark" class on <html>, which Tailwind's dark: variants use.
// index.html applies it before the first paint, so pages never flash the wrong theme.
import { useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';
const KEY = 'lp-theme';
const EVENT = 'lp-theme-change';
const media = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null);

export function readThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'system' ? v : 'light';
  } catch {
    return 'light';
  }
}

export const isDarkChoice = (choice: ThemeChoice) => choice === 'dark' || (choice === 'system' && Boolean(media()?.matches));

export function applyTheme(choice: ThemeChoice = readThemeChoice()) {
  const dark = isDarkChoice(choice);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

export function setThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === 'light') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch { /* private mode: the choice lasts for this page only */ }
  applyTheme(choice);
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** The current choice and whether the page is dark now; follows the OS while the choice is "system". */
export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(readThemeChoice);
  const [dark, setDark] = useState(() => isDarkChoice(readThemeChoice()));
  useEffect(() => {
    const sync = () => { const c = readThemeChoice(); setChoice(c); setDark(isDarkChoice(c)); };
    const m = media();
    const onOs = () => { if (readThemeChoice() === 'system') { applyTheme('system'); sync(); } };
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', (e) => { if (e.key === KEY) { applyTheme(); sync(); } });
    m?.addEventListener?.('change', onOs);
    return () => { window.removeEventListener(EVENT, sync); m?.removeEventListener?.('change', onOs); };
  }, []);
  return { choice, dark, setChoice: setThemeChoice };
}
