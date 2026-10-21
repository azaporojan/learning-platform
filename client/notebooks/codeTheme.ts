// Notebook code theme, per browser: "default" follows the site theme (light code on a light site,
// Darcula colours on a dark one); "darcula" gives code cells, inputs, outputs and code blocks
// IntelliJ's Darcula look on either site theme.
import { useEffect, useState } from 'react';

export type CodeTheme = 'default' | 'darcula';
const KEY = 'lp-code-theme';
const EVENT = 'lp-code-theme-change';

export function readCodeTheme(): CodeTheme {
  try { return localStorage.getItem(KEY) === 'darcula' ? 'darcula' : 'default'; } catch { return 'default'; }
}

export function setCodeTheme(theme: CodeTheme) {
  try {
    if (theme === 'default') localStorage.removeItem(KEY); else localStorage.setItem(KEY, theme);
  } catch { /* private mode: lasts for this page */ }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: theme }));
}

export function useCodeTheme(): [CodeTheme, (t: CodeTheme) => void] {
  const [theme, setTheme] = useState<CodeTheme>(readCodeTheme);
  useEffect(() => {
    const sync = (e: Event) => setTheme((e as CustomEvent).detail || readCodeTheme());
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  return [theme, setCodeTheme];
}

/**
 * Classes for a code surface (editor, input, output). Darcula also adds "dark", so the Tailwind
 * dark: styles inside the box apply even on a light site.
 */
export const darculaClass = (theme: CodeTheme) => (theme === 'darcula' ? 'dark lp-darcula' : '');
