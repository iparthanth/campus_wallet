import { createContext, useCallback, useContext, useEffect, useState } from 'react';

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

let seq = 0;

/**
 * Toasts instead of inline banners.
 *
 * An inline message rendered above the balance pushes the page down at the exact
 * moment the user is reading the number that just changed. A toast reports the
 * outcome without moving anything.
 */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const push = useCallback((message, kind = 'ok', ms = 5000) => {
    const id = ++seq;
    setToasts((t) => [...t, { id, message, kind, ms }]);
    return id;
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      {/* aria-live so a screen reader announces the outcome without moving focus */}
      <div className="toasts" role="status" aria-live="polite" data-testid="toasts">
        {toasts.map((t) => <Toast key={t.id} {...t} onDone={() => dismiss(t.id)} />)}
      </div>
    </ToastCtx.Provider>
  );
}

function Toast({ message, kind, ms, onDone }) {
  useEffect(() => {
    // Errors stay until dismissed: auto-hiding the reason something failed is how
    // users end up repeating the failure.
    if (kind === 'error') return undefined;
    const t = setTimeout(onDone, ms);
    return () => clearTimeout(t);
  }, [kind, ms, onDone]);

  const icon = kind === 'ok' ? '✓' : '!';
  return (
    <div className={`toast toast-${kind}`} data-testid={`toast-${kind}`}>
      <span aria-hidden="true" style={{ fontWeight: 700 }}>{icon}</span>
      <span>{message}</span>
      <button className="toast-close" onClick={onDone} aria-label="Dismiss">×</button>
    </div>
  );
}
