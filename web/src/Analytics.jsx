import { useEffect, useState } from 'react';
import { api, formatPaisa } from './api.js';
import { StatTile, EmptyState, SkeletonRows, Message } from './components/ui.jsx';
import { VolumeChart, TopSendersChart } from './components/Charts.jsx';

/** Admin dashboard. Leads with the headline numbers, then the trend, then the
 *  people — magnitude first, detail on demand. */
export default function Analytics() {
  const [data, setData] = useState(null);
  const [flags, setFlags] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [a, f] = await Promise.all([api.analytics(), api.flags()]);
        setData(a);
        setFlags(f.flags);
      } catch (err) {
        setError(err.status === 403 ? 'This dashboard is for administrators.' : err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <>
        <div className="grid grid-3">
          {[0, 1, 2].map((i) => (
            <div className="tile" key={i}>
              <div className="skel" style={{ width: '52%', height: 11 }} />
              <div className="skel" style={{ width: '68%', height: 26, marginTop: 10 }} />
            </div>
          ))}
        </div>
        <div className="card"><SkeletonRows count={4} /></div>
      </>
    );
  }

  if (error) return <Message kind="error" testid="analytics-error">{error}</Message>;

  const volume = data?.daily_volume ?? [];
  const totalPaisa = volume.reduce((s, r) => s + Number(r.total_paisa), 0);
  const busiest = volume.reduce((b, r) => (Number(r.total_paisa) > Number(b?.total_paisa ?? 0) ? r : b), null);

  return (
    <>
      <div className="grid grid-3" data-testid="kpi-row">
        <StatTile
          label="Volume moved"
          value={formatPaisa(totalPaisa)}
          foot={`across ${volume.length} active ${volume.length === 1 ? 'day' : 'days'}`}
          testid="kpi-volume"
        />
        <StatTile
          label="Flagged for review"
          value={flags.length}
          foot={flags.length ? 'awaiting an admin decision' : 'nothing outstanding'}
          testid="kpi-flags"
        />
        <StatTile
          label="Busiest day"
          value={busiest ? formatPaisa(Number(busiest.total_paisa)) : '—'}
          foot={busiest ? new Date(busiest.day).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : 'no activity yet'}
          testid="kpi-busiest"
        />
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Transfer volume</h2>
            <p className="card-note">Daily totals, smoothed by a 7-day average</p>
          </div>
        </div>
        <VolumeChart data={volume} />
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Most active senders</h2>
            <p className="card-note">By value sent, current week</p>
          </div>
        </div>
        <TopSendersChart data={data?.top_senders ?? []} />
      </div>

      <div className="card">
        <div className="card-head">
          <div>
            <h2 className="card-title">Fraud flags</h2>
            <p className="card-note">Transfers the rules held for review — they still completed</p>
          </div>
        </div>
        {flags.length === 0 ? (
          <EmptyState mark="✓" title="No flags" text="Nothing has tripped the velocity or threshold rules." testid="flags-empty" />
        ) : (
          <div className="rows" data-testid="flag-list">
            {flags.map((f) => (
              <div className="row" key={f.id} data-testid="flag-row">
                <div className="row-main">
                  <div className="row-title">
                    <span className="chip">{f.rule_name}</span>{' '}
                    {f.sender_email} → {f.recipient_email}
                  </div>
                  <div className="row-meta">{f.detail}</div>
                </div>
                <div className="row-amount">{formatPaisa(f.amount_paisa)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
