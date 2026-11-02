import { useState } from 'react';
import { Plus, Pencil, Star } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApi, useAction } from '../../lib/hooks.js';
import { fmtDate, titleCase } from '../../lib/format.js';
import { PageHeader, Card, DataTable, Badge, Button, Modal, Field, Input, Select, ApiErrorDetails, ConfirmDialog, ErrorState } from '../../components/ui.jsx';

const toLocal = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

export default function Terms() {
  const { data, isLoading, error } = useApi('/admin/terms');
  const [edit, setEdit] = useState(null);
  const [current, setCurrent] = useState(null);
  const setCur = useAction(() => api.post(`/admin/terms/${current.id}/set-current`), { invalidate: ['/admin', '/terms', '/lookups'], success: 'Current term updated', onSuccess: () => setCurrent(null) });
  return (
    <>
      <PageHeader title="Academic terms" subtitle="Term dates and registration windows drive registration rules, deadlines and grading." actions={<Button icon={Plus} onClick={() => setEdit({})}>New term</Button>} />
      <Card padded={false}>
        {error ? <ErrorState error={error} /> : <DataTable loading={isLoading} rows={data?.data} columns={[
          { key: 'name', header: 'Term', render: (r) => <div className="flex items-center gap-2"><span className="font-medium text-slate-900">{r.name}</span>{r.isCurrent && <Badge tone="ink">Current</Badge>}</div> },
          { key: 'code', header: 'Code', render: (r) => <span className="mono">{r.code}</span> },
          { key: 'dates', header: 'Classes', render: (r) => `${fmtDate(r.startDate)} – ${fmtDate(r.endDate)}` },
          { key: 'reg', header: 'Registration window', render: (r) => `${fmtDate(r.registration.opens)} – ${fmtDate(r.registration.closes)}` },
          { key: 'dl', header: 'Add/drop · withdraw', render: (r) => <span className="text-[13px]">{fmtDate(r.registration.addDropDeadline, { month: 'short', day: 'numeric' })} · {fmtDate(r.registration.withdrawDeadline, { month: 'short', day: 'numeric' })}</span> },
          { key: 'sections', header: 'Sections', align: 'right', render: (r) => r.sectionCount },
          { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
          { key: 'act', header: '', align: 'right', render: (r) => <div className="flex justify-end gap-1">{!r.isCurrent && <Button size="sm" variant="ghost" icon={Star} onClick={() => setCurrent(r)}>Make current</Button>}<Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEdit(r)} aria-label="Edit" /></div> },
        ]} />}
      </Card>
      {edit && <TermForm term={edit.id ? edit : null} years={data?.academicYears ?? []} onClose={() => setEdit(null)} />}
      <ConfirmDialog open={!!current} onClose={() => setCurrent(null)} onConfirm={() => setCur.mutate()} loading={setCur.isPending} tone="primary" title="Change the current term?" confirmLabel="Make current">
        <p>{current?.name} will become the default term for dashboards, schedules and the integration API (<span className="mono">?current=true</span>).</p>
      </ConfirmDialog>
    </>
  );
}

function TermForm({ term, years, onClose }) {
  const [f, setF] = useState(term ? {
    academicYearId: term.academicYearId, code: term.code, name: term.name, startDate: term.startDate, endDate: term.endDate, status: term.status,
    registrationOpens: toLocal(term.registration.opens), registrationCloses: toLocal(term.registration.closes), addDropDeadline: toLocal(term.registration.addDropDeadline), withdrawDeadline: toLocal(term.registration.withdrawDeadline), gradesDueDate: toLocal(term.gradesDueDate),
  } : { academicYearId: years[0]?.id ?? '', code: '', name: '', startDate: '', endDate: '', registrationOpens: '', registrationCloses: '', addDropDeadline: '', withdrawDeadline: '', gradesDueDate: '', status: 'PLANNED' });
  const save = useAction(() => (term ? api.patch(`/admin/terms/${term.id}`, f) : api.post('/admin/terms', f)), { invalidate: ['/admin/terms', '/terms', '/lookups'], success: term ? 'Term updated' : 'Term created', onSuccess: onClose, toastErrors: false });
  const d = (k, label) => <Field label={label}><Input type="date" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>;
  return (
    <Modal open onClose={onClose} size="lg" title={term ? `Edit ${term.name}` : 'New term'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending}>Save term</Button></>}>
      <ApiErrorDetails error={save.error} />
      <div className="mt-2 grid gap-4 sm:grid-cols-3">
        <Field label="Academic year"><Select value={f.academicYearId} onChange={(e) => setF({ ...f, academicYearId: e.target.value })} options={years.map((y) => ({ value: y.id, label: y.name }))} /></Field>
        <Field label="Code"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="2027FA" /></Field>
        <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Fall 2027" /></Field>
        {d('startDate', 'Classes begin')}{d('endDate', 'Classes end')}
        <Field label="Status"><Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={['PLANNED', 'REGISTRATION_OPEN', 'IN_PROGRESS', 'COMPLETED'].map((v) => ({ value: v, label: titleCase(v) }))} /></Field>
        {d('registrationOpens', 'Registration opens')}{d('registrationCloses', 'Registration closes')}{d('addDropDeadline', 'Add/drop deadline')}{d('withdrawDeadline', 'Withdrawal deadline')}{d('gradesDueDate', 'Grades due')}
      </div>
    </Modal>
  );
}
