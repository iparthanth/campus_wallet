import { useMemo, useState } from 'react';
import { formatPaisa } from '../api.js';

/* Shared chart chrome. Grid and axes are deliberately recessive: the data is the
   subject, the scaffolding is not. */
const PAD = { t: 12, r: 14, b: 26, l: 52 };

const taka = (paisa) => `৳${Math.round(paisa / 100).toLocaleString('en-IN')}`;
const shortDay = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** Toggle between the plot and its table. The table is not decoration — it is the
 *  documented relief for a fill that sits below 3:1 against the surface, and it is
 *  also the accessible read of any chart. */
function ViewToggle({ mode, setMode, id }) {
  return (
    <div className="seg" style={{ width: 168, marginBottom: 0 }} role="tablist" aria-label="Chart view">
      {['chart', 'table'].map((m) => (
        <button
          key={m}
          role="tab"
          aria-selected={mode === m}
          aria-controls={`${id}-${m}`}
          onClick={() => setMode(m)}
          data-testid={`view-${m}`}
        >
          {m === 'chart' ? 'Chart' : 'Table'}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Daily volume + 7-day moving average                                 */
/* Trend over time. Two marks of the SAME measure, so this is one hue   */
/* in two shades rather than two categorical colours — the average is   */
/* not a different thing, it is the same thing smoothed.                */
/* ------------------------------------------------------------------ */
export function VolumeChart({ data }) {
  const [mode, setMode] = useState('chart');
  const [hover, setHover] = useState(null);
  const W = 660, H = 240;

  // API returns newest first; a time axis reads left-to-right oldest-first.
  const rows = useMemo(() => [...data].reverse(), [data]);

  const geom = useMemo(() => {
    if (!rows.length) return null;
    const max = Math.max(...rows.map((r) => Number(r.total_paisa)), 1);
    const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
    const x = (i) => PAD.l + (rows.length === 1 ? iw / 2 : (i / (rows.length - 1)) * iw);
    const y = (v) => PAD.t + ih - (Number(v) / max) * ih;
    return { max, x, y, ih, iw };
  }, [rows]);

  if (!rows.length) {
    return <p className="empty-text" data-testid="volume-empty">No transfers yet — the chart appears once money moves.</p>;
  }

  const { max, x, y } = geom;
  const areaPath =
    `M ${x(0)} ${y(rows[0].total_paisa)} ` +
    rows.map((r, i) => `L ${x(i)} ${y(r.total_paisa)}`).join(' ') +
    ` L ${x(rows.length - 1)} ${PAD.t + geom.ih} L ${x(0)} ${PAD.t + geom.ih} Z`;
  const linePath = rows
    .map((r, i) => `${i ? 'L' : 'M'} ${x(i)} ${y(r.moving_avg_7d ?? r.total_paisa)}`)
    .join(' ');

  const ticks = [0, 0.5, 1].map((f) => ({ v: max * f, yy: y(max * f) }));

  return (
    <div>
      <div className="card-head" style={{ marginBottom: 12 }}>
        <div className="legend">
          <span className="legend-item">
            <span className="legend-swatch" style={{ background: 'var(--series-fill)' }} />Daily volume
          </span>
          <span className="legend-item">
            <span className="legend-swatch" style={{ background: 'var(--series-line)', height: 3, borderRadius: 2 }} />7-day average
          </span>
        </div>
        <ViewToggle mode={mode} setMode={setMode} id="volume" />
      </div>

      {mode === 'chart' ? (
        <div style={{ position: 'relative', overflowX: 'auto' }} id="volume-chart">
          <svg
            viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet"
            style={{ display: 'block', minWidth: 460, maxHeight: 260 }}
            role="img"
            aria-label={`Daily transfer volume over the last ${rows.length} days, with a seven-day moving average. Peak ${taka(max)}.`}
            onMouseLeave={() => setHover(null)}
            onMouseMove={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              const px = ((e.clientX - box.left) / box.width) * W;
              const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (rows.length - 1));
              setHover(i >= 0 && i < rows.length ? i : null);
            }}
          >
            {ticks.map((t, i) => (
              <g key={i}>
                <line x1={PAD.l} x2={W - PAD.r} y1={t.yy} y2={t.yy} stroke="var(--grid)" strokeWidth="1" />
                <text x={PAD.l - 8} y={t.yy + 4} textAnchor="end" fontSize="11" fill="var(--ink-muted)">{taka(t.v)}</text>
              </g>
            ))}

            <path d={areaPath} fill="var(--series-fill)" opacity=".28" />
            <path d={linePath} fill="none" stroke="var(--series-line)" strokeWidth="2"
                  strokeLinejoin="round" strokeLinecap="round" />

            {/* Data-end marker, ≥8px, ringed against the surface so it reads over the fill */}
            <circle cx={x(rows.length - 1)} cy={y(rows.at(-1).moving_avg_7d ?? rows.at(-1).total_paisa)}
                    r="4.5" fill="var(--series-line)" stroke="var(--surface)" strokeWidth="2" />

            {hover !== null && (
              <g pointerEvents="none">
                <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + geom.ih} stroke="var(--axis)" strokeWidth="1" strokeDasharray="3 3" />
                <circle cx={x(hover)} cy={y(rows[hover].total_paisa)} r="4.5"
                        fill="var(--series-fill)" stroke="var(--surface)" strokeWidth="2" />
              </g>
            )}

            <text x={PAD.l} y={H - 7} fontSize="11" fill="var(--ink-muted)">{shortDay(rows[0].day)}</text>
            <text x={W - PAD.r} y={H - 7} fontSize="11" fill="var(--ink-muted)" textAnchor="end">{shortDay(rows.at(-1).day)}</text>
          </svg>

          {hover !== null && (
            <div
              role="status"
              style={{
                position: 'absolute', top: 4,
                left: `clamp(0px, ${(x(hover) / W) * 100}% - 70px, calc(100% - 150px))`,
                background: 'var(--surface)', border: '1px solid var(--hairline)',
                borderRadius: 8, padding: '7px 10px', fontSize: 12,
                boxShadow: 'var(--shadow)', pointerEvents: 'none', minWidth: 132,
              }}
            >
              <div style={{ color: 'var(--ink-muted)', marginBottom: 3 }}>{shortDay(rows[hover].day)}</div>
              <div style={{ fontWeight: 650 }}>{formatPaisa(Number(rows[hover].total_paisa))}</div>
              <div style={{ color: 'var(--ink-2)' }}>avg {formatPaisa(Number(rows[hover].moving_avg_7d ?? 0))}</div>
            </div>
          )}
        </div>
      ) : (
        <div style={{ maxHeight: 260, overflowY: 'auto' }} id="volume-table">
          <table className="tbl">
            <thead><tr><th>Day</th><th className="num">Volume</th><th className="num">7-day avg</th></tr></thead>
            <tbody>
              {[...rows].reverse().map((r) => (
                <tr key={r.day}>
                  <td>{shortDay(r.day)}</td>
                  <td className="num">{formatPaisa(Number(r.total_paisa))}</td>
                  <td className="num">{formatPaisa(Number(r.moving_avg_7d ?? 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Top senders — compare magnitude, so: horizontal bars, one hue.       */
/* Horizontal because the labels are email addresses, which never fit   */
/* under vertical columns.                                              */
/* ------------------------------------------------------------------ */
export function TopSendersChart({ data }) {
  const [hover, setHover] = useState(null);
  const rows = data.slice(0, 5);

  if (!rows.length) {
    return <p className="empty-text" data-testid="senders-empty">No sender activity in this period.</p>;
  }

  const max = Math.max(...rows.map((r) => Number(r.sent_paisa)), 1);

  return (
    <div className="rows" data-testid="top-senders">
      {rows.map((r, i) => {
        const pct = (Number(r.sent_paisa) / max) * 100;
        return (
          <div
            key={`${r.email}-${i}`}
            style={{ padding: '9px 0', borderBottom: i < rows.length - 1 ? '1px solid var(--hairline-2)' : 0 }}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
              <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.email}
              </span>
              {/* Direct label — every bar is labelled, which is also the relief for the fill's contrast */}
              <span style={{ fontSize: 13, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>
                {formatPaisa(Number(r.sent_paisa))}
              </span>
            </div>
            <div style={{ height: 8, background: 'var(--surface-sunk)', borderRadius: 4, overflow: 'hidden' }}>
              <div
                style={{
                  width: `${pct}%`, height: '100%',
                  background: hover === i ? 'var(--series-line)' : 'var(--series-fill)',
                  borderRadius: 4, transition: 'background .12s',
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
