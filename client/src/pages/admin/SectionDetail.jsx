import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Pencil, ClipboardCheck } from 'lucide-react';
import { useApi } from '../../lib/hooks.js';
import { fmtDate, meetingText, titleCase } from '../../lib/format.js';
import { PageHeader, Card, Spinner, Badge, Button, KeyValue, DataTable, Empty, ErrorState } from '../../components/ui.jsx';
import SectionForm from './SectionForm.jsx';

export default function SectionDetail() {
  const { id } = useParams();
  const { data, isLoading, error } = useApi(`/admin/sections/${id}`);
  const [editing, setEditing] = useState(false);
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <Spinner />;
  const s = data.data;
  return (
    <>
      <PageHeader back={{ to: '/admin/sections', label: 'Sections' }} eyebrow={s.term.name} title={`${s.course.code}-${s.sectionNumber} · ${s.course.title}`} subtitle={<span className="flex items-center gap-2"><Badge status={s.status} />{s.enrolled}/{s.capacity} enrolled · {s.waitlisted} waitlisted</span>}
        actions={<><Link to="/admin/grades"><Button variant="secondary" icon={ClipboardCheck}>Grades</Button></Link><Button icon={Pencil} onClick={() => setEditing(true)}>Edit section</Button></>} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Details">
          <KeyValue cols={1} items={[
            ['Course', <Link className="link" to={`/admin/courses/${s.course.id}`}>{s.course.code} · {s.course.credits} credits</Link>], ['Meets', meetingText(s.meetings)], ['Location', s.location], ['Delivery', titleCase(s.deliveryMode)],
            ['Instructors', s.instructors.map((i) => <div key={i.facultyId}>{i.name}{i.isPrimary && <span className="text-xs text-slate-500"> (primary)</span>}</div>)],
            ['Capacity / waitlist', `${s.capacity} / ${s.waitlistCapacity}`], ['Prerequisites', s.course.prerequisites.length ? s.course.prerequisites.map((p) => `${p.code} (min ${p.minGrade})`).join(', ') : 'None'],
            ['Add/drop deadline', fmtDate(s.term.registration.addDropDeadline)],
          ]} />
        </Card>
        <Card title="Registrations" className="lg:col-span-2" padded={false}>
          <DataTable rows={s.registrations} empty={<Empty title="No registrations" />} columns={[
            { key: 'student', header: 'Student', render: (r) => <Link className="link" to={`/admin/students/${r.student.id}`}>{r.student.name}</Link> },
            { key: 'id', header: 'ID', render: (r) => <span className="mono">{r.student.studentNumber}</span> },
            { key: 'source', header: 'Channel', render: (r) => <span className="text-xs text-slate-500">{titleCase(r.source)}</span> },
            { key: 'reg', header: 'Registered', render: (r) => fmtDate(r.registeredAt) },
            { key: 'grade', header: 'Grade', render: (r) => r.grade ? `${r.grade.letter} (${r.grade.status.toLowerCase()})` : '—' },
            { key: 'status', header: 'Status', render: (r) => <Badge status={r.status}>{r.status === 'WAITLISTED' ? `Waitlist #${r.waitlistPosition}` : undefined}</Badge> },
          ]} />
        </Card>
      </div>
      <SectionForm open={editing} onClose={() => setEditing(false)} section={s} />
    </>
  );
}
