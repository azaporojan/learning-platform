import React, { useEffect, useRef, useState } from 'react';
import { ThemeChoice, useTheme } from '../theme';

const OPTIONS: { value: ThemeChoice; label: string; icon: string }[] = [
  { value: 'light', label: 'Light', icon: 'light_mode' },
  { value: 'dark', label: 'Dark', icon: 'dark_mode' },
  { value: 'system', label: 'System', icon: 'brightness_auto' },
];

// Navbar button: the icon shows the current choice; the menu switches Light / Dark / System
export const ThemeSwitcher: React.FC = () => {
  const { choice, setChoice } = useTheme();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const current = OPTIONS.find((o) => o.value === choice) || OPTIONS[0];
  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Theme: ${current.label}`}
        title={`Theme: ${current.label}`}
        className="w-10 h-10 rounded-full flex items-center justify-center text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
      >
        <span aria-hidden="true" className="material-icons">{current.icon}</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-2 w-40 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-xl py-1 z-50">
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemradio"
              aria-checked={choice === o.value}
              onClick={() => { setChoice(o.value); setOpen(false); }}
              className={`w-full px-3 py-2 flex items-center gap-2 text-sm text-left hover:bg-gray-100 dark:hover:bg-gray-700 ${choice === o.value ? 'font-bold text-primary-dark dark:text-primary' : 'text-gray-700 dark:text-gray-200'}`}
            >
              <span aria-hidden="true" className="material-icons text-[18px]">{o.icon}</span>
              {o.label}
              {choice === o.value && <span aria-hidden="true" className="material-icons text-[16px] ml-auto">check</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
