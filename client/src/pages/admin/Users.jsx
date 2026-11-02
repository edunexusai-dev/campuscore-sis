import { useState } from 'react';
import { Plus, Check } from 'lucide-react';
import { api, qs } from '../../lib/api.js';
import { useApi, useAction, useListParams } from '../../lib/hooks.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtRelative, titleCase } from '../../lib/format.js';
import { PageHeader, Card, DataTable, Pagination, Badge, Button, Select, SearchInput, Tabs, Modal, Field, Input, ConfirmDialog, ApiErrorDetails, SecretBox, Empty, ErrorState } from '../../components/ui.jsx';

export default function Users() {
  const [tab, setTab] = useState('users');
  return (
    <>
      <PageHeader title="Users & roles" subtitle="Portal accounts and the role-based permission matrix enforced by the server." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'users', label: 'Accounts' }, { value: 'roles', label: 'Roles & permissions' }]} />
      {tab === 'users' ? <Accounts /> : <Roles />}
    </>
  );
}

function Accounts() {
  const { user } = useAuth();
  const [p, set] = useListParams({ page: '1' });
  const { data, isLoading, error } = useApi(`/admin/users${qs({ search: p.search, role: p.role, page: p.page, pageSize: 30 })}`, { placeholderData: (x) => x });
  const [creating, setCreating] = useState(false);
  const [action, setAction] = useState(null);
  const run = useAction(({ kind, u }) => (kind === 'reset' ? api.post(`/admin/users/${u.id}/reset-password`) : api.patch(`/admin/users/${u.id}`, kind === 'unlock' ? { unlock: true } : { status: u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' })), {
    invalidate: ['/admin/users'], toastErrors: false, success: (_, { kind }) => ({ reset: 'Password reset; all sessions signed out', unlock: 'Account unlocked', toggle: 'Account status updated' }[kind]), onSuccess: (r, v) => { if (v.kind !== 'reset') setAction(null); },
  });
  return (
    <>
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
          <SearchInput value={p.search} onChange={(v) => set({ search: v })} placeholder="Name or email" />
          <Select aria-label="Role" value={p.role} onChange={(e) => set({ role: e.target.value })} placeholder="All roles" options={['ADMIN', 'REGISTRAR', 'FACULTY', 'STUDENT'].map((r) => ({ value: r, label: titleCase(r) }))} className="w-40" />
          <div className="ml-auto"><Button icon={Plus} onClick={() => setCreating(true)}>New staff account</Button></div>
        </div>
        {error ? <ErrorState error={error} /> : <DataTable loading={isLoading} rows={data?.data} empty={<Empty title="No accounts" />} columns={[
          { key: 'name', header: 'Name', render: (r) => <div><div className="font-medium text-slate-900">{r.lastName}, {r.firstName}</div><div className="text-xs text-slate-500">{r.email}</div></div> },
          { key: 'role', header: 'Roles', render: (r) => <div className="flex flex-wrap gap-1">{(r.roles?.length ? r.roles : [r.role]).map((role) => <Badge key={role} tone={role === 'ADMIN' ? 'violet' : role === 'REGISTRAR' ? 'ink' : 'slate'}>{titleCase(role)}</Badge>)}{r.hasPassword === false && <Badge tone="slate">University sign-in only</Badge>}</div> },
          { key: 'last', header: 'Last sign-in', render: (r) => fmtRelative(r.lastLoginAt) },
          { key: 'status', header: 'Status', render: (r) => <div className="flex gap-1"><Badge status={r.status} />{r.lockedUntil && new Date(r.lockedUntil) > new Date() && <Badge tone="red">Locked</Badge>}</div> },
          { key: 'act', header: '', align: 'right', render: (r) => r.id !== user.id && <div className="flex justify-end gap-1">
            {r.lockedUntil && new Date(r.lockedUntil) > new Date() && <Button size="sm" variant="ghost" onClick={() => run.mutate({ kind: 'unlock', u: r })}>Unlock</Button>}
            <Button size="sm" variant="ghost" onClick={() => setAction({ kind: 'reset', u: r })}>Reset password</Button>
            <Button size="sm" variant={r.status === 'ACTIVE' ? 'subtleDanger' : 'secondary'} onClick={() => setAction({ kind: 'toggle', u: r })}>{r.status === 'ACTIVE' ? 'Disable' : 'Enable'}</Button>
          </div> },
        ]} />}
        <Pagination pagination={data?.pagination} onPage={(n) => set({ page: String(n) })} />
      </Card>
      <ConfirmDialog open={!!action && !run.data?.temporaryPassword} onClose={() => { setAction(null); run.reset(); }} onConfirm={() => run.mutate(action)} loading={run.isPending}
        title={action?.kind === 'reset' ? 'Reset password?' : action?.u.status === 'ACTIVE' ? 'Disable account?' : 'Enable account?'} confirmLabel={action?.kind === 'reset' ? 'Reset password' : 'Confirm'}>
        <ApiErrorDetails error={run.error} />
        <p>{action?.u.email}</p>
        <p>{action?.kind === 'reset' ? 'A new temporary password will be generated and every active session for this account will be signed out.' : action?.u.status === 'ACTIVE' ? 'The user will be signed out and unable to sign in.' : 'The user will be able to sign in again.'}</p>
      </ConfirmDialog>
      <Modal open={!!run.data?.temporaryPassword} onClose={() => { setAction(null); run.reset(); }} title="Temporary password" footer={<Button onClick={() => { setAction(null); run.reset(); }}>Done</Button>}>
        <SecretBox label={`For ${action?.u.email} (shown once)`} value={run.data?.temporaryPassword ?? ''} />
      </Modal>
      <CreateStaff open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function CreateStaff({ open, onClose }) {
  const [f, setF] = useState({ email: '', firstName: '', lastName: '', role: 'REGISTRAR' });
  const save = useAction(() => api.post('/admin/users', f), { invalidate: ['/admin/users'], toastErrors: false });
  const close = () => { save.reset(); setF({ email: '', firstName: '', lastName: '', role: 'REGISTRAR' }); onClose(); };
  return (
    <Modal open={open} onClose={close} title="New staff account" description="Student and faculty logins are created from their records." footer={save.data ? <Button onClick={close}>Done</Button> : <><Button variant="secondary" onClick={close}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending}>Create account</Button></>}>
      {save.data ? <SecretBox label="Temporary password (shown once)" value={save.data.temporaryPassword} /> : <div className="space-y-4">
        <ApiErrorDetails error={save.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="First name"><Input value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} /></Field>
          <Field label="Last name"><Input value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} /></Field>
        </div>
        <Field label="Email"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Role"><Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} options={[{ value: 'REGISTRAR', label: 'Registrar' }, { value: 'ADMIN', label: 'Administrator' }]} /></Field>
      </div>}
    </Modal>
  );
}

function Roles() {
  const { data, isLoading } = useApi('/admin/roles');
  if (isLoading) return null;
  const roles = data.data.roles;
  return (
    <Card padded={false} title="Permission matrix" subtitle="Built-in roles. Custom roles are planned for a later release; resource-level rules (e.g. faculty see only their own sections) apply on top of these permissions.">
      <div className="overflow-x-auto">
        <table className="min-w-full">
          <thead><tr><th className="th">Permission</th>{roles.map((r) => <th key={r.role} className="th text-center">{titleCase(r.role)}<div className="font-normal normal-case tracking-normal text-slate-400">{r.users} users</div></th>)}</tr></thead>
          <tbody>{data.data.permissions.map((p) => (
            <tr key={p.key}><td className="td"><div className="font-medium text-slate-800">{p.label}</div><div className="mono text-slate-400">{p.key}</div></td>
              {roles.map((r) => <td key={r.role} className="td text-center">{p.roles.includes(r.role) ? <Check className="mx-auto size-4 text-emerald-600" aria-label="Granted" /> : <span className="text-slate-300" aria-label="Not granted">—</span>}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
    </Card>
  );
}
