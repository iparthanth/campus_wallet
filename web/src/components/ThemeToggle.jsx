import { useEffect, useState } from 'react';

const KEY = 'cw_theme';   // 'light' | 'dark' | 'system'

function apply(mode) {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
}

/**
 * Three-way theme control.
 *
 * "System" is the default and a real option, not a fallback: most people want the
 * app to follow the phone, and forcing an explicit choice on first run is a decision
 * the user has not asked to make. The CSS is written so an explicit stamp beats the
 * OS setting in both directions.
 */
export default function ThemeToggle() {
  const [mode, setMode] = useState(() => localStorage.getItem(KEY) ?? 'system');

  useEffect(() => {
    apply(mode);
    localStorage.setItem(KEY, mode);
  }, [mode]);

  return (
    <div className="theme-toggle" role="group" aria-label="Colour theme">
      {[['light', 'Light'], ['system', 'Auto'], ['dark', 'Dark']].map(([v, label]) => (
        <button key={v} type="button" aria-pressed={mode === v}
                onClick={() => setMode(v)} data-testid={`theme-${v}`}>
          {label}
        </button>
      ))}
    </div>
  );
}
