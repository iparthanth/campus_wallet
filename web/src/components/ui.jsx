/** Small shared primitives. Kept in one file deliberately — a component-per-file
 *  tree for eight tiny pieces is folder theatre, not architecture. */

export function StatTile({ label, value, foot, testid }) {
  return (
    <div className="tile" data-testid={testid}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {foot && <div className="tile-foot">{foot}</div>}
    </div>
  );
}

export function EmptyState({ mark = '—', title, text, testid }) {
  return (
    <div className="empty" data-testid={testid}>
      <div className="empty-mark" aria-hidden="true">{mark}</div>
      <div className="empty-title">{title}</div>
      {text && <div className="empty-text">{text}</div>}
    </div>
  );
}

/** Skeletons mirror the shape of the content they replace, so the layout does not
 *  jump when real data lands. */
export function SkeletonRows({ count = 3 }) {
  return (
    <div className="rows" data-testid="skeleton">
      {Array.from({ length: count }).map((_, i) => (
        <div className="row" key={i}>
          <div className="skel" style={{ width: 34, height: 34, borderRadius: '50%' }} />
          <div className="row-main">
            <div className="skel" style={{ width: '58%', height: 13 }} />
            <div className="skel" style={{ width: '32%', height: 11, marginTop: 6 }} />
          </div>
          <div className="skel" style={{ width: 62, height: 14 }} />
        </div>
      ))}
    </div>
  );
}

export function Field({ id, label, hint, prefix, ...input }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className={prefix ? 'field-prefix' : undefined}>
        {prefix && <span className="sym" aria-hidden="true">{prefix}</span>}
        <input id={id} {...input} />
      </div>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

export function Message({ kind = 'error', children, testid }) {
  // 'info' must not read as success — a neutral explanation gets a neutral mark.
  const icon = kind === 'error' || kind === 'warn' ? '!' : kind === 'info' ? 'i' : '✓';
  return (
    <div className={`msg msg-${kind}`} role={kind === 'error' ? 'alert' : 'status'} data-testid={testid}>
      {/* Icon + text, never colour alone — a status must survive being read in greyscale */}
      <span aria-hidden="true" style={{ fontWeight: 700 }}>{icon}</span>
      <span>{children}</span>
    </div>
  );
}

/** Initials avatar. Deterministic, no images to load, no layout shift. */
export function Avatar({ email }) {
  const initials = (email ?? '?').slice(0, 2).toUpperCase();
  return <div className="row-avatar" aria-hidden="true">{initials}</div>;
}
