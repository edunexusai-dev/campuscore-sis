import { Pin } from 'lucide-react';
import { useApi } from '../../lib/hooks.js';
import { fmtDate } from '../../lib/format.js';
import { PageHeader, Card, Spinner, Empty, Badge, ErrorState } from '../../components/ui.jsx';

export default function Announcements() {
  const { data, isLoading, error } = useApi('/announcements');
  return (
    <>
      <PageHeader title="Announcements" subtitle="Institution-wide notices and messages from your classes." />
      {error ? <ErrorState error={error} /> : isLoading ? <Spinner /> : !data.data.length ? <Card><Empty title="No announcements" /></Card> : (
        <div className="space-y-3 max-w-3xl">
          {data.data.map((a) => (
            <article key={a.id} className="card p-5">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                {a.pinned && <span className="inline-flex items-center gap-1 font-semibold text-brass-600"><Pin className="size-3.5" />Pinned</span>}
                {a.section ? <Badge tone="ink">{a.section}</Badge> : <Badge tone="slate">{a.audience === 'ALL' ? 'Everyone' : a.audience.toLowerCase()}</Badge>}
                <span>{a.author} · {fmtDate(a.publishedAt)}</span>
              </div>
              <h2 className="mt-2 text-base font-semibold text-slate-900">{a.title}</h2>
              <p className="mt-1.5 whitespace-pre-line text-sm leading-relaxed text-slate-600">{a.body}</p>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
