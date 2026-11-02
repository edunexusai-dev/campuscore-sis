import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, qs } from '../../lib/api.js';
import { useApi, useAction, useListParams } from '../../lib/hooks.js';
import { PageHeader, Card, DataTable, Pagination, Badge, Button, Select, SearchInput, Modal, Field, Input, Textarea, ApiErrorDetails, Empty, ErrorState } from '../../components/ui.jsx';

export default function Courses() {
  const navigate = useNavigate();
  const { data: lookups } = useApi('/lookups');
  const [p, set] = useListParams({ page: '1', sort: 'code' });
  const { data, isLoading, error } = useApi(`/admin/courses${qs({ search: p.search, departmentId: p.departmentId, sort: p.sort, page: p.page, pageSize: 30 })}`, { placeholderData: (x) => x });
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Course catalog" subtitle="Catalog courses, credits and prerequisites." actions={<Button icon={Plus} onClick={() => setCreating(true)}>New course</Button>} />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <SearchInput value={p.search} onChange={(v) => set({ search: v })} placeholder="Code or title" />
          <Select aria-label="Department" value={p.departmentId} onChange={(e) => set({ departmentId: e.target.value })} placeholder="All departments" options={(lookups?.data.departments ?? []).map((d) => ({ value: d.id, label: d.name }))} className="w-56" />
        </div>
        {error ? <ErrorState error={error} /> : <DataTable loading={isLoading} rows={data?.data} sort={p.sort} onSort={(s) => set({ sort: s })} onRowClick={(r) => navigate(`/admin/courses/${r.id}`)} empty={<Empty title="No courses" />} columns={[
          { key: 'code', header: 'Code', sortable: true, render: (r) => <span className="font-medium text-slate-900">{r.code}</span> },
          { key: 'title', header: 'Title', sortable: true },
          { key: 'department', header: 'Department', render: (r) => r.department.name },
          { key: 'credits', header: 'Credits', sortable: true, align: 'right' },
          { key: 'prereqs', header: 'Prerequisites', render: (r) => r.prerequisites.length ? r.prerequisites.map((x) => x.code).join(', ') : <span className="text-slate-400">None</span> },
          { key: 'active', header: 'Status', render: (r) => <Badge tone={r.active ? 'green' : 'slate'}>{r.active ? 'Active' : 'Inactive'}</Badge> },
        ]} />}
        <Pagination pagination={data?.pagination} onPage={(n) => set({ page: String(n) })} />
      </Card>
      <CourseForm open={creating} onClose={() => setCreating(false)} departments={lookups?.data.departments ?? []} onSaved={(r) => navigate(`/admin/courses/${r.data.id}`)} />
    </>
  );
}

export function CourseForm({ open, onClose, departments, course, onSaved }) {
  const init = () => course ? { departmentId: course.department.id, code: course.code, title: course.title, description: course.description ?? '', credits: course.credits, level: course.level, active: course.active } : { departmentId: '', code: '', title: '', description: '', credits: 3, level: 100, active: true };
  const [f, setF] = useState(init);
  const save = useAction(() => {
    const body = { ...f, credits: Number(f.credits), level: Number(f.level), description: f.description || null };
    return course ? api.patch(`/admin/courses/${course.id}`, body) : api.post('/admin/courses', body);
  }, { invalidate: ['/admin/courses'], success: course ? 'Course updated' : 'Course created', onSuccess: (r) => { onSaved?.(r); onClose(); }, toastErrors: false });
  return (
    <Modal open={open} onClose={onClose} title={course ? 'Edit course' : 'New course'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending}>Save</Button></>}>
      <ApiErrorDetails error={save.error} />
      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        <Field label="Department" required className="sm:col-span-2"><Select value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })} placeholder="Select…" options={departments.map((d) => ({ value: d.id, label: d.name }))} /></Field>
        <Field label="Code" required hint='e.g. "CS 205"'><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="Title" required><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Credits" required hint={course ? 'Existing registrations keep the credits they were taken for' : undefined}><Input type="number" min={0} max={12} value={f.credits} onChange={(e) => setF({ ...f, credits: e.target.value })} /></Field>
        <Field label="Level"><Select value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })} options={[100, 200, 300, 400, 500, 600, 700].map((l) => ({ value: l, label: String(l) }))} /></Field>
        <Field label="Description" className="sm:col-span-2"><Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        {course && <Field label="Status"><Select value={String(f.active)} onChange={(e) => setF({ ...f, active: e.target.value === 'true' })} options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }]} /></Field>}
      </div>
    </Modal>
  );
}
