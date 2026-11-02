import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { useApi, useAction } from '../../lib/hooks.js';
import { fmtRelative } from '../../lib/format.js';
import { PageHeader, Card, Spinner, Empty, Button, cx, ErrorState } from '../../components/ui.jsx';

export default function Notifications() {
  const { data, isLoading, error } = useApi('/notifications');
  const readAll = useAction(() => api.post('/notifications/read-all'), { invalidate: ['/notifications'], success: 'All notifications marked as read' });
  const read = useAction((id) => api.post(`/notifications/${id}/read`), { invalidate: ['/notifications'] });
  return (
    <>
      <PageHeader title="Notifications" actions={data?.unread > 0 && <Button variant="secondary" onClick={() => readAll.mutate()} loading={readAll.isPending}>Mark all as read</Button>} />
      <Card padded={false} className="max-w-3xl">
        {error ? <ErrorState error={error} /> : isLoading ? <Spinner /> : !data.data.length ? <Empty title="You're all caught up" /> : (
          <ul className="divide-y divide-slate-100">
            {data.data.map((n) => (
              <li key={n.id} className={cx('flex items-start gap-3 px-5 py-3.5', !n.readAt && 'bg-brass-50/40')}>
                <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-brass-400')} aria-label={n.readAt ? undefined : 'Unread'} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-900">{n.link ? <Link to={n.link} onClick={() => !n.readAt && read.mutate(n.id)} className="hover:underline">{n.title}</Link> : n.title}</div>
                  <div className="text-[13px] text-slate-600">{n.body}</div>
                  <div className="mt-0.5 text-xs text-slate-400">{fmtRelative(n.createdAt)}</div>
                </div>
                {!n.readAt && <Button size="sm" variant="ghost" onClick={() => read.mutate(n.id)}>Mark read</Button>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
