import { Link } from 'react-router-dom';
import { qs } from '../../lib/api.js';
import { useApi, useListParams } from '../../lib/hooks.js';
import { fmtDateTime, titleCase } from '../../lib/format.js';
import { PageHeader, Card, DataTable, Pagination, Badge, Select, SearchInput, Empty, ErrorState } from '../../components/ui.jsx';

export default function Registrations() {
  const { data: lookups } = useApi('/lookups');
  const [p, set] = useListParams({ page: '1' });
  const { data, isLoading, error } = useApi(`/admin/registrations${qs({ termId: p.termId, status: p.status, source: p.source, search: p.search, page: p.page, pageSize: 30 })}`, { placeholderData: (x) => x });
  return (
    <>
      <PageHeader title="Registrations" subtitle="Every add, drop, withdrawal and waitlist change across all channels. Register individual students from their record." />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <SearchInput value={p.search} onChange={(v) => set({ search: v })} placeholder="Student or course" />
          <Select aria-label="Term" value={p.termId} onChange={(e) => set({ termId: e.target.value })} placeholder="All terms" options={(lookups?.data.terms ?? []).map((t) => ({ value: t.id, label: t.name }))} className="w-44" />
          <Select aria-label="Status" value={p.status} onChange={(e) => set({ status: e.target.value })} placeholder="All statuses" options={['REGISTERED', 'WAITLISTED', 'DROPPED', 'WITHDRAWN', 'COMPLETED'].map((v) => ({ value: v, label: titleCase(v) }))} className="w-40" />
          <Select aria-label="Source" value={p.source} onChange={(e) => set({ source: e.target.value })} placeholder="All channels" options={['STUDENT_PORTAL', 'ADMIN', 'API', 'SYSTEM'].map((v) => ({ value: v, label: titleCase(v) }))} className="w-40" />
        </div>
        {error ? <ErrorState error={error} /> : <DataTable loading={isLoading} rows={data?.data} empty={<Empty title="No registrations match" />} columns={[
          { key: 'student', header: 'Student', render: (r) => <Link className="link" to={`/admin/students/${r.student.id}`}>{r.student.name}</Link> },
          { key: 'sid', header: 'ID', render: (r) => <span className="mono">{r.student.studentNumber}</span> },
          { key: 'section', header: 'Section', render: (r) => <Link className="hover:underline" to={`/admin/sections/${r.section.id}`}><span className="font-medium">{r.section.label}</span> <span className="text-slate-500">{r.section.title}</span></Link> },
          { key: 'term', header: 'Term', render: (r) => r.section.term },
          { key: 'source', header: 'Channel', render: (r) => <Badge tone={r.source === 'API' ? 'violet' : 'slate'}>{titleCase(r.source)}</Badge> },
          { key: 'changed', header: 'Last change', render: (r) => <span className="text-[13px] text-slate-500">{fmtDateTime(r.statusChangedAt)}</span> },
          { key: 'status', header: 'Status', render: (r) => <Badge status={r.status}>{r.status === 'WAITLISTED' ? `Waitlist #${r.waitlistPosition}` : undefined}</Badge> },
        ]} />}
        <Pagination pagination={data?.pagination} onPage={(n) => set({ page: String(n) })} />
      </Card>
    </>
  );
}
