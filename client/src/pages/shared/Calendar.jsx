import { useMemo, useState } from 'react';
import { useApi } from '../../lib/hooks.js';
import { fmtDate } from '../../lib/format.js';
import { PageHeader, Card, Spinner, Empty, Badge, Select, ErrorState } from '../../components/ui.jsx';

const TONE = { DEADLINE: 'amber', HOLIDAY: 'green', EXAM: 'red', ACADEMIC: 'ink', EVENT: 'violet' };

export default function Calendar() {
  const { data: terms } = useApi('/terms');
  const [termId, setTermId] = useState('');
  const { data, isLoading, error } = useApi(`/calendar${termId ? `?termId=${termId}` : ''}`);
  const today = new Date().toISOString().slice(0, 10);
  const byMonth = useMemo(() => {
    const m = new Map();
    for (const e of data?.data ?? []) {
      const k = e.startDate.slice(0, 7);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(e);
    }
    return [...m.entries()];
  }, [data]);
  return (
    <>
      <PageHeader title="Academic calendar" subtitle="Term dates, deadlines, holidays and examinations."
        actions={<Select value={termId} onChange={(e) => setTermId(e.target.value)} placeholder="All terms" options={(terms?.data ?? []).map((t) => ({ value: t.id, label: t.name }))} className="w-48" aria-label="Filter by term" />} />
      {error ? <ErrorState error={error} /> : isLoading ? <Spinner /> : !byMonth.length ? <Card><Empty title="No calendar events" /></Card> : (
        <div className="grid gap-5 lg:grid-cols-2">
          {byMonth.map(([month, events]) => (
            <Card key={month} title={new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })} padded={false}>
              <ul className="divide-y divide-slate-100">
                {events.map((e) => (
                  <li key={e.id} className={`flex gap-4 px-5 py-3 ${e.startDate < today ? 'opacity-60' : ''}`}>
                    <div className="w-12 shrink-0 text-center"><div className="text-[11px] font-semibold uppercase text-slate-500">{fmtDate(e.startDate, { weekday: 'short' })}</div><div className="text-xl font-semibold tabular-nums text-slate-900">{Number(e.startDate.slice(8, 10))}</div></div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium text-slate-900">{e.title}</span><Badge tone={TONE[e.category]}>{e.category.toLowerCase()}</Badge></div>
                      {e.endDate && <div className="text-xs text-slate-500">through {fmtDate(e.endDate)}</div>}
                      {e.description && <div className="mt-0.5 text-[13px] text-slate-500">{e.description}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
