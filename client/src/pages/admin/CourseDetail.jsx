import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Pencil, Trash2, Plus } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApi, useAction } from '../../lib/hooks.js';
import { meetingText } from '../../lib/format.js';
import { PageHeader, Card, Spinner, Badge, Button, KeyValue, DataTable, Select, Empty, ApiErrorDetails, ErrorState } from '../../components/ui.jsx';
import { CourseForm } from './Courses.jsx';

const GRADES = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D'];

export default function CourseDetail() {
  const { id } = useParams();
  const { data, isLoading, error } = useApi(`/admin/courses/${id}`);
  const { data: lookups } = useApi('/lookups');
  const { data: all } = useApi('/admin/courses?pageSize=100');
  const [editing, setEditing] = useState(false);
  const [prereqs, setPrereqs] = useState(null);
  useEffect(() => { if (data) setPrereqs(data.data.prerequisites.map((p) => ({ courseId: p.courseId, minGrade: p.minGrade }))); }, [data]);
  const save = useAction(() => api.put(`/admin/courses/${id}/prerequisites`, { prerequisites: prereqs }), { invalidate: ['/admin/courses'], success: 'Prerequisites saved', toastErrors: false });
  if (error) return <ErrorState error={error} />;
  if (isLoading || !prereqs) return <Spinner />;
  const c = data.data;
  const dirty = JSON.stringify(prereqs) !== JSON.stringify(c.prerequisites.map((p) => ({ courseId: p.courseId, minGrade: p.minGrade })));
  return (
    <>
      <PageHeader back={{ to: '/admin/courses', label: 'Course catalog' }} eyebrow={c.department.name} title={`${c.code} · ${c.title}`} subtitle={<Badge tone={c.active ? 'green' : 'slate'}>{c.active ? 'Active' : 'Inactive'}</Badge>} actions={<Button icon={Pencil} onClick={() => setEditing(true)}>Edit course</Button>} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Catalog entry" className="lg:col-span-2">
          <KeyValue items={[['Credits', c.credits], ['Level', c.level], ['Department', c.department.name], ['Required by', c.requiredBy.length ? c.requiredBy.map((r) => <Link key={r.id} className="link mr-2" to={`/admin/courses/${r.id}`}>{r.code}</Link>) : 'No other courses']]} />
          <p className="mt-4 text-sm leading-relaxed text-slate-600">{c.description}</p>
        </Card>
        <Card title="Prerequisites" footer={<div className="flex justify-end"><Button size="sm" onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>Save prerequisites</Button></div>}>
          <ApiErrorDetails error={save.error} />
          <div className="space-y-2">
            {prereqs.map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                <Select aria-label="Prerequisite course" value={p.courseId} onChange={(e) => setPrereqs(prereqs.map((x, j) => (j === i ? { ...x, courseId: e.target.value } : x)))} options={(all?.data ?? []).filter((x) => x.id !== c.id).map((x) => ({ value: x.id, label: x.code }))} />
                <Select aria-label="Minimum grade" value={p.minGrade} onChange={(e) => setPrereqs(prereqs.map((x, j) => (j === i ? { ...x, minGrade: e.target.value } : x)))} options={GRADES} className="w-20" />
                <Button size="sm" variant="ghost" icon={Trash2} aria-label="Remove" onClick={() => setPrereqs(prereqs.filter((_, j) => j !== i))} />
              </div>
            ))}
            {!prereqs.length && <p className="text-sm text-slate-500">No prerequisites.</p>}
            <Button size="sm" variant="ghost" icon={Plus} onClick={() => setPrereqs([...prereqs, { courseId: all?.data.find((x) => x.id !== c.id)?.id, minGrade: 'D' }])}>Add prerequisite</Button>
          </div>
        </Card>
      </div>
      <Card title="Sections" padded={false} className="mt-6">
        <DataTable rows={c.sections} empty={<Empty title="Never offered" />} columns={[
          { key: 'term', header: 'Term', render: (r) => r.termCode },
          { key: 'sec', header: 'Section', render: (r) => <Link className="link" to={`/admin/sections/${r.id}`}>{c.code}-{r.sectionNumber}</Link> },
          { key: 'instr', header: 'Instructor', render: (r) => r.instructors.map((i) => i.name).join(', ') },
          { key: 'meets', header: 'Meets', render: (r) => meetingText(r.meetings) },
          { key: 'seats', header: 'Enrolled', align: 'right', render: (r) => `${r.enrolled}/${r.capacity}` },
          { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
        ]} />
      </Card>
      {editing && <CourseForm open onClose={() => setEditing(false)} course={c} departments={lookups?.data.departments ?? []} />}
    </>
  );
}
