import { useEffect, useState } from 'react';

type Theme = 'system' | 'light' | 'dark';
const KEY = 'terraprev.theme';

function stored(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Sets data-theme on <html>; "system" removes it so prefers-color-scheme decides. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(stored);

  useEffect(() => {
    if (location.hash.startsWith('#print')) return; // headless export sets its own theme
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  return (
    <div className="themetoggle" role="group" aria-label="Color theme">
      {(['light', 'system', 'dark'] as const).map((t) => (
        <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)}>
          {t === 'light' ? <><span aria-hidden>☀ </span>Light</> : t === 'dark' ? <><span aria-hidden>☾ </span>Dark</> : 'Auto'}
        </button>
      ))}
    </div>
  );
}
