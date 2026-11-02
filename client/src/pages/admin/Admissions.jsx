import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, qs } from '../../lib/api.js';
import { useApi, useAction, useListParams } from '../../lib/hooks.js';
import { fmtDate, titleCase } from '../../lib/format.js';
import { PageHeader, Card, DataTable, Pagination, Badge, Button, Select, SearchInput, Modal, Field, Input, Textarea, ApiErrorDetails, SecretBox, Alert, Tabs, Empty, ErrorState } from '../../components/ui.jsx';

const NEXT = { SUBMITTED: ['UNDER_REVIEW', 'WITHDRAWN'], UNDER_REVIEW: ['ADMITTED', 'WAITLISTED', 'REJECTED', 'WITHDRAWN'], WAITLISTED: ['ADMITTED', 'REJECTED', 'WITHDRAWN'], ADMITTED: ['WITHDRAWN'] };

export default function Admissions() {
  const { data: lookups } = useApi('/lookups');
  const [p, set] = useListParams({ page: '1', status: '' });
  const { data, isLoading, error } = useApi(`/admin/applications${qs({ status: p.status, search: p.search, termId: p.termId, page: p.page, pageSize: 25 })}`, { placeholderData: (x) => x });
  const [selected, setSelected] = useState(null);
  const [creating, setCreating] = useState(false);
  const counts = data?.counts ?? {};
  return (
    <>
      <PageHeader title="Admissions" subtitle="Review applications, record decisions and matriculate admitted applicants into student records." actions={<Button icon={Plus} onClick={() => setCreating(true)}>Record application</Button>} />
      <Tabs value={p.status} onChange={(v) => set({ status: v })} tabs={[{ value: '', label: 'All' }, ...['SUBMITTED', 'UNDER_REVIEW', 'ADMITTED', 'WAITLISTED', 'REJECTED', 'MATRICULATED'].map((s) => ({ value: s, label: titleCase(s), count: counts[s] ?? 0 }))]} />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <SearchInput value={p.search} onChange={(v) => set({ search: v })} placeholder="Name or application #" />
          <Select aria-label="Term" value={p.termId} onChange={(e) => set({ termId: e.target.value })} placeholder="All entry terms" options={(lookups?.data.terms ?? []).map((t) => ({ value: t.id, label: t.name }))} className="w-44" />
        </div>
        {error ? <ErrorState error={error} /> : <DataTable loading={isLoading} rows={data?.data} onRowClick={setSelected} empty={<Empty title="No applications" />} columns={[
          { key: 'applicationNumber', header: 'Application', render: (r) => <span className="mono">{r.applicationNumber}</span> },
          { key: 'name', header: 'Applicant', render: (r) => <div><div className="font-medium text-slate-900">{r.lastName}, {r.firstName}</div><div className="text-xs text-slate-500">{r.email}</div></div> },
          { key: 'program', header: 'Program', render: (r) => `${r.program.degreeType} ${r.program.name}` },
          { key: 'term', header: 'Entry term', render: (r) => r.term.name },
          { key: 'gpa', header: 'Prior GPA', align: 'right', render: (r) => r.priorGpa?.toFixed(2) ?? '—' },
          { key: 'submittedAt', header: 'Submitted', render: (r) => fmtDate(r.submittedAt) },
          { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
        ]} />}
        <Pagination pagination={data?.pagination} onPage={(n) => set({ page: String(n) })} />
      </Card>
      <Decision app={selected} onClose={() => setSelected(null)} />
      <CreateApplication open={creating} onClose={() => setCreating(false)} lookups={lookups?.data} />
    </>
  );
}

function Decision({ app, onClose }) {
  const [notes, setNotes] = useState('');
  const decide = useAction((status) => api.post(`/admin/applications/${app.id}/decision`, { status, notes: notes || undefined }), { invalidate: ['/admin/applications', '/admin/dashboard'], success: (_, s) => `Application moved to ${titleCase(s)}`, onSuccess: onClose, toastErrors: false });
  const matric = useAction(() => api.post(`/admin/applications/${app.id}/matriculate`), { invalidate: ['/admin/applications', '/admin/students', '/admin/dashboard'], toastErrors: false });
  const close = () => { matric.reset(); decide.reset(); setNotes(''); onClose(); };
  if (!app) return null;
  return (
    <Modal open onClose={close} title={`${app.firstName} ${app.lastName}`} description={`${app.applicationNumber} · ${app.program.degreeType} ${app.program.name} · ${app.term.name}`}
      footer={matric.data ? <Button onClick={close}>Done</Button> : <>
        <Button variant="secondary" onClick={close}>Close</Button>
        {(NEXT[app.status] ?? []).map((s) => <Button key={s} variant={s === 'REJECTED' || s === 'WITHDRAWN' ? 'subtleDanger' : s === 'ADMITTED' ? 'primary' : 'secondary'} loading={decide.isPending && decide.variables === s} onClick={() => decide.mutate(s)}>{s === 'UNDER_REVIEW' ? 'Start review' : titleCase(s)}</Button>)}
        {app.status === 'ADMITTED' && <Button variant="accent" onClick={() => matric.mutate()} loading={matric.isPending}>Matriculate</Button>}
      </>}>
      <div className="space-y-4">
        <ApiErrorDetails error={decide.error || matric.error} />
        {matric.data ? (
          <>
            <Alert tone="success">Student record created: <Link className="link" to={`/admin/students/${matric.data.data.studentId}`}>{matric.data.data.studentNumber}</Link> ({matric.data.data.email})</Alert>
            <SecretBox label="Temporary portal password (shown once)" value={matric.data.temporaryPassword} />
          </>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-3 text-sm"><div><dt className="text-slate-500">Status</dt><dd><Badge status={app.status} /></dd></div><div><dt className="text-slate-500">Prior GPA</dt><dd>{app.priorGpa?.toFixed(2) ?? '—'}</dd></div><div><dt className="text-slate-500">Email</dt><dd>{app.email}</dd></div><div><dt className="text-slate-500">Phone</dt><dd>{app.phone ?? '—'}</dd></div></dl>
            {app.notes && <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">{app.notes}</p>}
            {app.student && <Alert tone="info">Matriculated as <Link to={`/admin/students/${app.student.id}`} className="link">{app.student.studentNumber}</Link>.</Alert>}
            {NEXT[app.status] && <Field label="Decision notes (optional)"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>}
          </>
        )}
      </div>
    </Modal>
  );
}

function CreateApplication({ open, onClose, lookups }) {
  const empty = { firstName: '', lastName: '', email: '', phone: '', programId: '', termId: '', priorGpa: '' };
  const [f, setF] = useState(empty);
  const save = useAction(() => api.post('/admin/applications', { ...f, phone: f.phone || undefined, priorGpa: f.priorGpa ? Number(f.priorGpa) : undefined }), { invalidate: ['/admin/applications'], success: 'Application recorded', onSuccess: () => { setF(empty); onClose(); }, toastErrors: false });
  return (
    <Modal open={open} onClose={onClose} title="Record an application" description="Online application intake is outside the scope of this release; staff can record applications here." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending}>Save application</Button></>}>
      <ApiErrorDetails error={save.error} />
      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        <Field label="First name" required><Input value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} /></Field>
        <Field label="Last name" required><Input value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} /></Field>
        <Field label="Email" required><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Program" required><Select value={f.programId} onChange={(e) => setF({ ...f, programId: e.target.value })} placeholder="Select…" options={(lookups?.programs ?? []).map((x) => ({ value: x.id, label: `${x.degreeType} ${x.name}` }))} /></Field>
        <Field label="Entry term" required><Select value={f.termId} onChange={(e) => setF({ ...f, termId: e.target.value })} placeholder="Select…" options={(lookups?.terms ?? []).filter((t) => t.status !== 'COMPLETED').map((t) => ({ value: t.id, label: t.name }))} /></Field>
        <Field label="Prior GPA"><Input type="number" step="0.01" min="0" max="4" value={f.priorGpa} onChange={(e) => setF({ ...f, priorGpa: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
