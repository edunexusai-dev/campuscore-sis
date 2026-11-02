import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { qs } from '../../lib/api.js';
import { useApi, useListParams } from '../../lib/hooks.js';
import { meetingText } from '../../lib/format.js';
import { PageHeader, Card, DataTable, Pagination, Badge, Button, Select, SearchInput, Empty, ErrorState } from '../../components/ui.jsx';
import SectionForm from './SectionForm.jsx';

export default function Sections() {
  const navigate = useNavigate();
  const { data: lookups } = useApi('/lookups');
  const [p, set] = useListParams({ page: '1' });
  const termId = p.termId || lookups?.data.terms.find((t) => t.isCurrent)?.id;
  const { data, isLoading, error } = useApi(termId ? `/admin/sections${qs({ termId, departmentId: p.departmentId, search: p.search, status: p.status, scheduled: p.scheduled, page: p.page, pageSize: 30 })}` : null, { placeholderData: (x) => x });
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Course sections" subtitle="Scheduled offerings with capacity, meeting times and instructors." actions={<Button icon={Plus} onClick={() => setCreating(true)}>New section</Button>} />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <Select aria-label="Term" value={termId ?? ''} onChange={(e) => set({ termId: e.target.value })} options={(lookups?.data.terms ?? []).map((t) => ({ value: t.id, label: t.name }))} className="w-44" />
          <Select aria-label="Department" value={p.departmentId} onChange={(e) => set({ departmentId: e.target.value })} placeholder="All departments" options={(lookups?.data.departments ?? []).map((d) => ({ value: d.id, label: d.name }))} className="w-56" />
          <Select aria-label="Meeting times" value={p.scheduled} onChange={(e) => set({ scheduled: e.target.value })} placeholder="Any schedule" options={[{ value: 'false', label: 'No meeting times' }, { value: 'true', label: 'Has meeting times' }]} className="w-44" />
          <Select aria-label="Status" value={p.status} onChange={(e) => set({ status: e.target.value })} placeholder="Any status" options={['OPEN', 'CLOSED', 'CANCELLED'].map((v) => ({ value: v, label: v[0] + v.slice(1).toLowerCase() }))} className="w-36" />
          <SearchInput value={p.search} onChange={(v) => set({ search: v })} placeholder="Course code or title" />
        </div>
        {error ? <ErrorState error={error} /> : <DataTable loading={isLoading || !termId} rows={data?.data} onRowClick={(r) => navigate(`/admin/sections/${r.id}`)} empty={<Empty title="No sections" />} columns={[
          { key: 'course', header: 'Section', render: (r) => <div><div className="font-medium text-slate-900">{r.course.code}-{r.sectionNumber}</div><div className="text-xs text-slate-500">{r.course.title}</div></div> },
          { key: 'instructors', header: 'Instructor', render: (r) => r.instructors.map((i) => i.name).join(', ') || <span className="text-slate-400">Unassigned</span> },
          { key: 'meets', header: 'Meets', render: (r) => (r.meetings?.length ? <span className="text-[13px]">{meetingText(r.meetings)}</span> : <Badge tone="amber">No meeting times</Badge>) },
          { key: 'location', header: 'Location', render: (r) => r.location ?? 'TBA' },
          { key: 'seats', header: 'Enrolled', align: 'right', render: (r) => <span className={r.seatsAvailable === 0 ? 'font-semibold text-amber-700' : ''}>{r.enrolled}/{r.capacity}{r.waitlisted ? <span className="text-xs text-slate-500"> +{r.waitlisted}</span> : ''}</span> },
          { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
        ]} />}
        <Pagination pagination={data?.pagination} onPage={(n) => set({ page: String(n) })} />
      </Card>
      <SectionForm open={creating} onClose={() => setCreating(false)} onSaved={(r) => navigate(`/admin/sections/${r.data.id}`)} />
    </>
  );
}
