import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api, qs } from '../../lib/api.js';
import { useApi, useAction, useListParams } from '../../lib/hooks.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtRelative } from '../../lib/format.js';
import { PageHeader, Card, DataTable, Pagination, Badge, Button, Select, SearchInput, Modal, Field, Input, Checkbox, ApiErrorDetails, SecretBox, Empty, ErrorState } from '../../components/ui.jsx';

export default function Faculty() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const { data: lookups } = useApi('/lookups');
  const [p, set] = useListParams({ page: '1', sort: 'lastName' });
  const { data, isLoading, error } = useApi(`/admin/faculty${qs({ search: p.search, departmentId: p.departmentId, sort: p.sort, page: p.page, pageSize: 30 })}`, { placeholderData: (x) => x });
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Faculty" subtitle="Instructors, departmental assignments and teaching loads." actions={can('faculty.manage') && <Button icon={Plus} onClick={() => setCreating(true)}>New faculty member</Button>} />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <SearchInput value={p.search} onChange={(v) => set({ search: v })} placeholder="Name, email or employee #" />
          <Select aria-label="Department" value={p.departmentId} onChange={(e) => set({ departmentId: e.target.value })} placeholder="All departments" options={(lookups?.data.departments ?? []).map((d) => ({ value: d.id, label: d.name }))} className="w-56" />
        </div>
        {error ? <ErrorState error={error} /> : <DataTable loading={isLoading} rows={data?.data} sort={p.sort} onSort={(s) => set({ sort: s })} onRowClick={(r) => navigate(`/admin/faculty/${r.id}`)} empty={<Empty title="No faculty found" />} columns={[
          { key: 'lastName', header: 'Name', sortable: true, render: (r) => <div><div className="font-medium text-slate-900">{r.lastName}, {r.firstName}</div><div className="text-xs text-slate-500">{r.email}</div></div> },
          { key: 'employeeNumber', header: 'Employee #', sortable: true, render: (r) => <span className="mono">{r.employeeNumber}</span> },
          { key: 'title', header: 'Title', className: 'max-w-xs' },
          { key: 'dept', header: 'Department', render: (r) => r.department.name },
          { key: 'login', header: 'Last sign-in', render: (r) => (r.hasLogin ? fmtRelative(r.lastLoginAt) : <span className="text-slate-400">No login</span>) },
          { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
        ]} />}
        <Pagination pagination={data?.pagination} onPage={(n) => set({ page: String(n) })} />
      </Card>
      <CreateFaculty open={creating} onClose={() => setCreating(false)} departments={lookups?.data.departments ?? []} />
    </>
  );
}

function CreateFaculty({ open, onClose, departments }) {
  const empty = { firstName: '', lastName: '', email: '', title: '', departmentId: '', phone: '', officeLocation: '', officeHours: '', createLogin: true };
  const [f, setF] = useState(empty);
  const save = useAction(() => api.post('/admin/faculty', { ...f, phone: f.phone || null, officeLocation: f.officeLocation || null, officeHours: f.officeHours || null }), { invalidate: ['/admin/faculty'], toastErrors: false });
  const close = () => { setF(empty); save.reset(); onClose(); };
  const input = (k, label) => <Field label={label}><Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>;
  return (
    <Modal open={open} onClose={close} size="lg" title={save.data ? 'Faculty member created' : 'New faculty member'} footer={save.data ? <Button onClick={close}>Done</Button> : <><Button variant="secondary" onClick={close}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending}>Create</Button></>}>
      {save.data ? (save.data.temporaryPassword ? <SecretBox label="Temporary portal password (shown once)" value={save.data.temporaryPassword} /> : <p className="text-sm">Created without a portal login.</p>) : (
        <>
          <ApiErrorDetails error={save.error} />
          <div className="mt-2 grid gap-4 sm:grid-cols-2">
            {input('firstName', 'First name')}{input('lastName', 'Last name')}{input('email', 'Email')}{input('title', 'Title')}
            <Field label="Department"><Select value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })} placeholder="Select…" options={departments.map((d) => ({ value: d.id, label: d.name }))} /></Field>
            {input('phone', 'Phone')}{input('officeLocation', 'Office')}{input('officeHours', 'Office hours')}
          </div>
          <div className="mt-4"><Checkbox label="Create a faculty portal login" checked={f.createLogin} onChange={(v) => setF({ ...f, createLogin: v })} /></div>
        </>
      )}
    </Modal>
  );
}
