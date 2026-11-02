import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, Plus } from 'lucide-react';
import { api, qs } from '../../lib/api.js';
import { useApi, useAction, useListParams } from '../../lib/hooks.js';
import { download, titleCase } from '../../lib/format.js';
import { useAuth } from '../../lib/auth.jsx';
import { PageHeader, Card, DataTable, Pagination, Badge, Button, Select, SearchInput, Modal, Field, Input, ApiErrorDetails, SecretBox, Alert, Empty, ErrorState, Checkbox, useToast } from '../../components/ui.jsx';

const STATUS = ['APPLICANT', 'ADMITTED', 'ACTIVE', 'LEAVE_OF_ABSENCE', 'SUSPENDED', 'WITHDRAWN', 'GRADUATED'];
const LEVELS = ['FRESHMAN', 'SOPHOMORE', 'JUNIOR', 'SENIOR', 'GRADUATE'];
const STANDING = ['GOOD', 'DEANS_LIST', 'PROBATION', 'SUSPENSION'];
const opts = (arr) => arr.map((v) => ({ value: v, label: titleCase(v) }));

export default function Students() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const { data: lookups } = useApi('/lookups');
  const [p, set] = useListParams({ page: '1', pageSize: '25', sort: 'lastName' });
  const filters = { search: p.search, status: p.status, programId: p.programId, classLevel: p.classLevel, standing: p.standing, hasHold: p.hasHold, sort: p.sort };
  const { data, isLoading, error } = useApi(`/admin/students${qs({ ...filters, page: p.page, pageSize: p.pageSize })}`, { placeholderData: (prev) => prev });
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    try { await download(`/api/app/admin/students/export${qs(filters)}`, `students-${new Date().toISOString().slice(0, 10)}.csv`); toast('Export downloaded — this action was recorded in the audit log'); }
    catch (e) { toast(e.message, 'error'); } finally { setExporting(false); }
  };
  return (
    <>
      <PageHeader title="Students" subtitle={data ? `${data.pagination.total.toLocaleString()} matching records` : ' '}
        actions={<>{can('students.export') && <Button variant="secondary" icon={Download} onClick={exportCsv} loading={exporting}>Export CSV</Button>}<Button icon={Plus} onClick={() => setCreating(true)}>New student</Button></>} />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
          <SearchInput value={p.search} onChange={(v) => set({ search: v })} placeholder="Name, email or student ID" />
          <Select aria-label="Status" value={p.status} onChange={(e) => set({ status: e.target.value })} placeholder="All statuses" options={opts(STATUS)} className="w-40" />
          <Select aria-label="Program" value={p.programId} onChange={(e) => set({ programId: e.target.value })} placeholder="All programs" options={(lookups?.data.programs ?? []).map((x) => ({ value: x.id, label: `${x.degreeType} ${x.name}` }))} className="w-52" />
          <Select aria-label="Class level" value={p.classLevel} onChange={(e) => set({ classLevel: e.target.value })} placeholder="All levels" options={opts(LEVELS)} className="w-36" />
          <Select aria-label="Standing" value={p.standing} onChange={(e) => set({ standing: e.target.value })} placeholder="Any standing" options={opts(STANDING)} className="w-36" />
          <label className="flex items-center gap-1.5 text-[13px] text-slate-600"><input type="checkbox" className="accent-ink-800" checked={p.hasHold === 'true'} onChange={(e) => set({ hasHold: e.target.checked ? 'true' : '' })} />Has active hold</label>
        </div>
        {error ? <ErrorState error={error} /> : (
          <DataTable loading={isLoading} rows={data?.data} sort={p.sort} onSort={(s) => set({ sort: s })} onRowClick={(r) => navigate(`/admin/students/${r.id}`)}
            empty={<Empty title="No students match these filters" />}
            columns={[
              { key: 'lastName', header: 'Name', sortable: true, render: (r) => <div><div className="font-medium text-slate-900">{r.lastName}, {r.preferredName || r.firstName}</div><div className="text-xs text-slate-500">{r.email}</div></div> },
              { key: 'studentNumber', header: 'Student ID', sortable: true, render: (r) => <span className="mono">{r.studentNumber}</span> },
              { key: 'program', header: 'Program', render: (r) => r.program?.name ?? <span className="text-slate-400">Undeclared</span> },
              { key: 'classLevel', header: 'Level', render: (r) => titleCase(r.classLevel) },
              { key: 'standing', header: 'Standing', render: (r) => <Badge status={r.academicStanding} /> },
              { key: 'status', header: 'Status', sortable: true, render: (r) => <div className="flex items-center gap-1.5"><Badge status={r.status} />{r.activeHolds > 0 && <Badge tone="red">{r.activeHolds} hold{r.activeHolds > 1 ? 's' : ''}</Badge>}</div> },
            ]} />
        )}
        <Pagination pagination={data?.pagination} onPage={(n) => set({ page: String(n) })} />
      </Card>
      <CreateStudent open={creating} onClose={() => setCreating(false)} lookups={lookups?.data} onCreated={(id) => navigate(`/admin/students/${id}`)} />
    </>
  );
}

function CreateStudent({ open, onClose, lookups, onCreated }) {
  const { user } = useAuth();
  const empty = { firstName: '', lastName: '', email: '', phone: '', dateOfBirth: '', programId: '', classLevel: 'FRESHMAN', admitTermId: '', status: 'ACTIVE', createLogin: true };
  const [f, setF] = useState(empty);
  const [result, setResult] = useState(null);
  const create = useAction(() => api.post('/admin/students', { ...f, phone: f.phone || null, dateOfBirth: f.dateOfBirth || null, programId: f.programId || null, admitTermId: f.admitTermId || null }), {
    invalidate: ['/admin/students', '/admin/dashboard'], toastErrors: false, onSuccess: (r) => setResult(r),
  });
  const close = () => { setF(empty); setResult(null); create.reset(); onClose(); };
  return (
    <Modal open={open} onClose={close} title={result ? 'Student created' : 'New student record'} size="lg"
      footer={result ? <><Button variant="secondary" onClick={close}>Close</Button><Button onClick={() => { const id = result.data.id; close(); onCreated(id); }}>Open record</Button></>
        : <><Button variant="secondary" onClick={close}>Cancel</Button><Button onClick={() => create.mutate()} loading={create.isPending}>Create student</Button></>}>
      {result ? (
        <div className="space-y-4">
          <Alert tone="success">Student ID <strong className="mono">{result.data.studentNumber}</strong> was assigned.</Alert>
          {result.temporaryPassword && <><SecretBox label="Temporary portal password (shown once)" value={result.temporaryPassword} /><p className="text-xs text-slate-500">Share it with the student through a secure channel. It is not stored in readable form.</p></>}
        </div>
      ) : (
        <div className="space-y-4">
          <ApiErrorDetails error={create.error} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="First name" required><Input value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} /></Field>
            <Field label="Last name" required><Input value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} /></Field>
            <Field label="Institution email" required><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder={`first.last@${user?.institution.studentEmailDomain ?? "students.example.edu"}`} /></Field>
            <Field label="Phone"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
            <Field label="Date of birth"><Input type="date" value={f.dateOfBirth} onChange={(e) => setF({ ...f, dateOfBirth: e.target.value })} /></Field>
            <Field label="Program"><Select value={f.programId} onChange={(e) => setF({ ...f, programId: e.target.value })} placeholder="Undeclared" options={(lookups?.programs ?? []).map((x) => ({ value: x.id, label: `${x.degreeType} ${x.name}` }))} /></Field>
            <Field label="Admit term"><Select value={f.admitTermId} onChange={(e) => setF({ ...f, admitTermId: e.target.value })} placeholder="—" options={(lookups?.terms ?? []).map((t) => ({ value: t.id, label: t.name }))} /></Field>
            <Field label="Class level"><Select value={f.classLevel} onChange={(e) => setF({ ...f, classLevel: e.target.value })} options={opts(LEVELS)} /></Field>
            <Field label="Initial status"><Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={opts(['ADMITTED', 'ACTIVE'])} /></Field>
          </div>
          <Checkbox label="Create a student portal login" description="Generates a one-time temporary password." checked={f.createLogin} onChange={(v) => setF({ ...f, createLogin: v })} />
          <p className="text-xs text-slate-500">The program sets degree requirements; it does not register the student in any classes. After creating the record, register them in this term's sections from their record (Register), or the student registers through Class Search.</p>
        </div>
      )}
    </Modal>
  );
}
