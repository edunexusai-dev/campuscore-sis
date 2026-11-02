import { Database, Server, KeyRound, Users, AlertTriangle, Cpu } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApi, useAction } from '../../lib/hooks.js';
import { fmtDateTime } from '../../lib/format.js';
import { PageHeader, Card, Stat, Spinner, Button, KeyValue, Badge, ErrorState } from '../../components/ui.jsx';

export default function System() {
  const { data, isLoading, error, refetch, isFetching } = useApi('/admin/system/health');
  const cleanup = useAction(() => api.post('/admin/system/cleanup'), { invalidate: ['/admin/system'], success: (r) => `Removed ${r.data.sessions} expired session(s) and ${r.data.tokens} old token record(s)` });
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <Spinner />;
  const h = data.data;
  const up = h.uptimeSeconds;
  return (
    <>
      <PageHeader title="System health" subtitle="Live status of this CampusCore instance." actions={<><Button variant="secondary" onClick={() => refetch()} loading={isFetching}>Refresh</Button><Button variant="secondary" onClick={() => cleanup.mutate()} loading={cleanup.isPending}>Purge expired sessions & tokens</Button></>} />
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Stat label="API status" value={<Badge tone="green" className="text-sm">Operational</Badge>} hint={`Up ${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`} icon={Server} tone="green" />
        <Stat label="Database latency" value={`${h.database.latencyMs} ms`} hint={h.database.version} icon={Database} />
        <Stat label="Active sessions / tokens" value={`${h.activeSessions} / ${h.activeApiTokens}`} icon={Users} tone="slate" />
        <Stat label="Server errors (24h)" value={h.serverErrors24h} icon={AlertTriangle} tone={h.serverErrors24h ? 'red' : 'slate'} />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Runtime"><KeyValue items={[['Environment', h.environment], ['Node.js', h.node], ['Started', fmtDateTime(h.startedAt)], ['Memory (RSS)', `${h.memoryMb} MB`]]} /></Card>
        <Card title="Database migrations" padded={false}>
          <ul className="divide-y divide-slate-100">{h.database.recentMigrations.map((m) => <li key={m.migration_name} className="flex justify-between px-5 py-2.5 text-sm"><span className="mono">{m.migration_name}</span><span className="text-slate-500">{fmtDateTime(m.finished_at)}</span></li>)}</ul>
        </Card>
        <Card title="Backups" className="lg:col-span-2">
          <p className="text-sm text-slate-600">Backups are an infrastructure responsibility and are not run by the application. See <span className="mono">docs/DEPLOYMENT.md</span> for the recommended <span className="mono">pg_dump</span> schedule, point-in-time recovery and restore drills.</p>
        </Card>
      </div>
    </>
  );
}
