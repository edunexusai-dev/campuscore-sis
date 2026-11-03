import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Pencil } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApi, useAction } from '../../lib/hooks.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDateTime, meetingText } from '../../lib/format.js';
import UniversityAccountCard from './UniversityAccount.jsx';
import { PageHeader, Card, Spinner, Badge, Button, KeyValue, DataTable, Modal, Field, Input, Select, ApiErrorDetails, Empty, ErrorState } from '../../components/ui.jsx';

export default function FacultyDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data, isLoading, error } = useApi(`/admin/faculty/${id}`);
  const { data: lookups } = useApi('/lookups');
  const [edit, setEdit] = useState(null);
  const save = useAction(() => api.patch(`/admin/faculty/${id}`, edit), { invalidate: ['/admin/faculty'], success: 'Faculty record updated', onSuccess: () => setEdit(null), toastErrors: false });
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <Spinner />;
  const f = data.data;
  return (
    <>
      <PageHeader back={{ to: '/admin/faculty', label: 'Faculty' }} eyebrow={f.department.name} title={`${f.firstName} ${f.lastName}`} subtitle={<span className="flex items-center gap-2"><Badge status={f.status} />{f.title}</span>}
        actions={can('faculty.manage') && <Button icon={Pencil} onClick={() => setEdit({ title: f.title, departmentId: f.department.id, phone: f.phone ?? '', officeLocation: f.officeLocation ?? '', officeHours: f.officeHours ?? '', status: f.status })}>Edit</Button>} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6">
          <Card title="Profile">
            <KeyValue cols={1} items={[['Employee #', <span className="mono">{f.employeeNumber}</span>], ['Email', f.email], ['Phone', f.phone], ['Office', f.officeLocation], ['Office hours', f.officeHours], ['Portal login', f.hasLogin ? `Yes · last sign-in ${fmtDateTime(f.lastLoginAt)}` : 'None']]} />
          </Card>
          <UniversityAccountCard personId={f.personId} />
        </div>
        <Card title="Teaching assignments" className="lg:col-span-2" padded={false}>
          <DataTable rows={f.sections} empty={<Empty title="No sections assigned" />} columns={[
            { key: 'term', header: 'Term', render: (r) => r.termCode },
            { key: 'sec', header: 'Section', render: (r) => <Link className="link" to={`/admin/sections/${r.id}`}>{r.course.code}-{r.sectionNumber}</Link> },
            { key: 'title', header: 'Title', render: (r) => r.course.title },
            { key: 'meets', header: 'Meets', render: (r) => <span className="text-[13px]">{meetingText(r.meetings)}</span> },
            { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
          ]} />
        </Card>
      </div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title="Edit faculty member" footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending}>Save</Button></>}>
        {edit && <><ApiErrorDetails error={save.error} />
          <div className="mt-2 grid gap-4 sm:grid-cols-2">
            <Field label="Title"><Input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
            <Field label="Department"><Select value={edit.departmentId} onChange={(e) => setEdit({ ...edit, departmentId: e.target.value })} options={(lookups?.data.departments ?? []).map((d) => ({ value: d.id, label: d.name }))} /></Field>
            <Field label="Phone"><Input value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
            <Field label="Office"><Input value={edit.officeLocation} onChange={(e) => setEdit({ ...edit, officeLocation: e.target.value })} /></Field>
            <Field label="Office hours"><Input value={edit.officeHours} onChange={(e) => setEdit({ ...edit, officeHours: e.target.value })} /></Field>
            <Field label="Status" hint="Disabling also disables the portal login and ends sessions"><Select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })} options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'DISABLED', label: 'Disabled' }]} /></Field>
          </div></>}
      </Modal>
    </>
  );
}
