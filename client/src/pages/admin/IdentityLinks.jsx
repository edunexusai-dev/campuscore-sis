import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Link2, Unlink, SearchCheck } from 'lucide-react';
import { api, qs } from '../../lib/api.js';
import { useApi, useAction, useListParams } from '../../lib/hooks.js';
import { fmtDateTime } from '../../lib/format.js';
import { PageHeader, Card, DataTable, Pagination, Badge, Button, Select, Input, Field, Modal, Textarea, ApiErrorDetails, Alert, Empty, ErrorState, SearchInput, Tabs } from '../../components/ui.jsx';

// Cross-system identity links: which external account (e.g. an EdunexusAI user) corresponds to which
// CampusCore student or faculty record. Links are never created automatically.
export default function IdentityLinks() {
  const [p, set] = useListParams({ page: '1', status: 'ACTIVE' });
  const { data, isLoading, error } = useApi(`/admin/identity-links${qs({ status: p.status, recordType: p.recordType, externalUserId: p.externalUserId, page: p.page, pageSize: 25 })}`, { placeholderData: (x) => x });
  const [linking, setLinking] = useState(false);
  const [revoking, setRevoking] = useState(null);
  const [tab, setTab] = useState('links');
  return (
    <>
      <PageHeader title="Identity links" subtitle="Explicit, audited links between external accounts (such as EdunexusAI users) and CampusCore records. Email and student numbers are only hints; names are never used to match."
        actions={<Button icon={Link2} onClick={() => setLinking(true)}>Link an account</Button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'links', label: 'Links' }, { value: 'reconcile', label: 'Check an account' }]} />
      {tab === 'reconcile' ? <Reconcile /> : (
        <Card padded={false}>
          <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
            <Select aria-label="Status" value={p.status} onChange={(e) => set({ status: e.target.value })} options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'REVOKED', label: 'Revoked' }, { value: '', label: 'All' }]} className="w-32" />
            <Select aria-label="Record type" value={p.recordType} onChange={(e) => set({ recordType: e.target.value })} placeholder="Students & faculty" options={[{ value: 'STUDENT', label: 'Students' }, { value: 'FACULTY', label: 'Faculty' }]} className="w-44" />
            <SearchInput value={p.externalUserId} onChange={(v) => set({ externalUserId: v })} placeholder="Exact external user ID" />
          </div>
          {error ? <ErrorState error={error} /> : <DataTable loading={isLoading} rows={data?.data} empty={<Empty title="No identity links" description="Link an EdunexusAI account to a student or faculty record to let EdunexusAI show that person's SIS data." />} columns={[
            { key: 'ext', header: 'External account', render: (r) => <div><div className="mono">{r.externalSystem} / {r.externalUserId}</div><div className="text-xs text-slate-500">{r.externalLabel ?? ''} {r.externalEmail ?? ''}</div></div> },
            { key: 'sis', header: 'CampusCore record', render: (r) => r.sisRecord.displayName ? <div><Link className="link" to={r.recordType === 'STUDENT' ? `/admin/students/${r.sisRecord.sisId}` : `/admin/faculty/${r.sisRecord.sisId}`}>{r.sisRecord.displayName}</Link><div className="text-xs text-slate-500">{r.recordType.toLowerCase()} · {r.sisRecord.institutionalId} · {r.sisRecord.email}</div></div> : <span className="mono">{r.sisRecord.sisId}</span> },
            { key: 'evidence', header: 'Evidence', render: (r) => <div className="text-xs">{r.evidence?.emailMatch === true ? <Badge tone="green">email matches</Badge> : r.evidence?.emailMatch === false ? <Badge tone="amber">email differs</Badge> : <Badge tone="slate">no email given</Badge>}{r.evidence?.mismatchReason && <div className="mt-1 text-slate-500">{r.evidence.mismatchReason}</div>}</div> },
            { key: 'by', header: 'Linked by', render: (r) => <div className="text-[13px]"><div>{r.createdBy}</div><div className="text-xs text-slate-500">{fmtDateTime(r.createdAt)} · {r.method === 'MANUAL_ADMIN' ? 'CampusCore admin' : 'via API'}</div></div> },
            { key: 'status', header: 'Status', render: (r) => <div><Badge status={r.status === 'ACTIVE' ? 'ACTIVE' : 'REVOKED'} />{r.revokedReason && <div className="mt-1 max-w-xs text-xs text-slate-500">{r.revokedReason}</div>}</div> },
            { key: 'act', header: '', align: 'right', render: (r) => r.status === 'ACTIVE' && <Button size="sm" variant="subtleDanger" icon={Unlink} onClick={() => setRevoking(r)}>Revoke</Button> },
          ]} />}
          <Pagination pagination={data?.pagination} onPage={(n) => set({ page: String(n) })} />
        </Card>
      )}
      <LinkModal open={linking} onClose={() => setLinking(false)} />
      <RevokeModal link={revoking} onClose={() => setRevoking(null)} />
    </>
  );
}

function RecordPicker({ recordType, value, onChange }) {
  const [search, setSearch] = useState('');
  const path = recordType === 'STUDENT' ? '/admin/students' : '/admin/faculty';
  const { data } = useApi(search.length >= 2 ? `${path}${qs({ search, pageSize: 8 })}` : null);
  return (
    <div className="space-y-2">
      <SearchInput value={search} onChange={setSearch} placeholder={`Search ${recordType === 'STUDENT' ? 'students' : 'faculty'} by name, email or ID`} className="max-w-none" />
      {data && <div className="max-h-48 overflow-y-auto rounded-lg border border-slate-200">
        {!data.data.length ? <div className="p-3 text-sm text-slate-500">No matches</div> : data.data.map((r) => (
          <button key={r.id} type="button" onClick={() => onChange(r)} className={`flex w-full justify-between border-b border-slate-100 px-3 py-2 text-left text-sm last:border-0 ${value?.id === r.id ? 'bg-ink-50' : 'hover:bg-slate-50'}`}>
            <span>{r.lastName}, {r.firstName} <span className="mono text-slate-500">{r.studentNumber ?? r.employeeNumber}</span></span><span className="text-xs text-slate-500">{r.email}</span>
          </button>
        ))}
      </div>}
    </div>
  );
}

function LinkModal({ open, onClose }) {
  const empty = { externalSystem: 'edunexusai', externalUserId: '', externalEmail: '', externalLabel: '', recordType: 'STUDENT', record: null, evidenceMismatchReason: '' };
  const [f, setF] = useState(empty);
  const save = useAction(() => api.post('/admin/identity-links', { externalSystem: f.externalSystem, externalUserId: f.externalUserId.trim(), externalEmail: f.externalEmail || undefined, externalLabel: f.externalLabel || undefined, recordType: f.recordType, sisRecordId: f.record.id, evidenceMismatchReason: f.evidenceMismatchReason || undefined }), {
    invalidate: ['/admin/identity-links'], success: 'Account linked. The change is in the audit log.', onSuccess: () => close(), toastErrors: false,
  });
  const close = () => { setF(empty); save.reset(); onClose(); };
  const mismatch = f.record && f.externalEmail && f.record.email.toLowerCase() !== f.externalEmail.trim().toLowerCase();
  return (
    <Modal open={open} onClose={close} size="lg" title="Link an external account" description="Confirm the person's identity before linking. One external account ↔ one SIS record."
      footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!f.externalUserId.trim() || !f.record || (mismatch && f.evidenceMismatchReason.trim().length < 10)}>Link account</Button></>}>
      <div className="space-y-4">
        <ApiErrorDetails error={save.error} />
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="External system" hint="e.g. edunexusai"><Input value={f.externalSystem} onChange={(e) => setF({ ...f, externalSystem: e.target.value.trim().toLowerCase() })} /></Field>
          <Field label="External user ID" required className="sm:col-span-2" hint="The stable internal ID of the user in that system"><Input className="mono" value={f.externalUserId} onChange={(e) => setF({ ...f, externalUserId: e.target.value })} /></Field>
          <Field label="External account email" className="sm:col-span-2"><Input type="email" value={f.externalEmail} onChange={(e) => setF({ ...f, externalEmail: e.target.value })} /></Field>
          <Field label="Record type"><Select value={f.recordType} onChange={(e) => setF({ ...f, recordType: e.target.value, record: null })} options={[{ value: 'STUDENT', label: 'Student' }, { value: 'FACULTY', label: 'Faculty' }]} /></Field>
        </div>
        <Field label="CampusCore record" required><RecordPicker recordType={f.recordType} value={f.record} onChange={(record) => setF({ ...f, record })} /></Field>
        {f.record && <Alert tone={mismatch ? 'warn' : 'info'} title={`${f.record.firstName} ${f.record.lastName} · ${f.record.studentNumber ?? f.record.employeeNumber}`}>
          {mismatch ? <>The external email does not match this record ({f.record.email}). Record how you verified the identity:</> : <>SIS email: {f.record.email}</>}
        </Alert>}
        {mismatch && <Field label="Verification note" required hint="At least 10 characters, e.g. 'Verified photo ID at the registrar desk'"><Textarea value={f.evidenceMismatchReason} onChange={(e) => setF({ ...f, evidenceMismatchReason: e.target.value })} /></Field>}
      </div>
    </Modal>
  );
}

function RevokeModal({ link, onClose }) {
  const [reason, setReason] = useState('');
  const rev = useAction(() => api.post(`/admin/identity-links/${link.id}/revoke`, { reason }), { invalidate: ['/admin/identity-links'], success: 'Link revoked', onSuccess: () => { setReason(''); onClose(); }, toastErrors: false });
  return (
    <Modal open={!!link} onClose={onClose} title="Revoke identity link" description={link && `${link.externalSystem}/${link.externalUserId} ↔ ${link.sisRecord.displayName ?? link.sisRecord.sisId}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" onClick={() => rev.mutate()} loading={rev.isPending} disabled={reason.trim().length < 5}>Revoke link</Button></>}>
      <div className="space-y-3">
        <ApiErrorDetails error={rev.error} />
        <p className="text-sm text-slate-600">The external system will immediately see this account as unmapped and stop showing SIS data for it. To correct a mapping, revoke it and create a new link; both steps are audited.</p>
        <Field label="Reason" required><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function Reconcile() {
  const [f, setF] = useState({ externalSystem: 'edunexusai', externalUserId: '', recordType: 'STUDENT', email: '', institutionalId: '', firstName: '', lastName: '' });
  const check = useAction(() => api.post('/admin/identity-links/reconcile', { externalSystem: f.externalSystem, candidates: [Object.fromEntries(Object.entries({ externalUserId: f.externalUserId, recordType: f.recordType, email: f.email, institutionalId: f.institutionalId, firstName: f.firstName, lastName: f.lastName }).filter(([, v]) => v))] }), { toastErrors: false });
  const r = check.data?.data[0];
  const tone = { LINKED: 'green', CANDIDATE: 'blue', AMBIGUOUS: 'amber', UNMATCHED: 'slate' };
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Check how an external account would match" subtitle="Read-only. Nothing is linked from here." footer={<div className="flex justify-end"><Button icon={SearchCheck} onClick={() => check.mutate()} loading={check.isPending} disabled={!f.externalUserId}>Check</Button></div>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="External user ID" required><Input className="mono" value={f.externalUserId} onChange={(e) => setF({ ...f, externalUserId: e.target.value })} /></Field>
          <Field label="Record type"><Select value={f.recordType} onChange={(e) => setF({ ...f, recordType: e.target.value })} options={[{ value: 'STUDENT', label: 'Student' }, { value: 'FACULTY', label: 'Faculty' }]} /></Field>
          <Field label="Email"><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Student / employee number"><Input value={f.institutionalId} onChange={(e) => setF({ ...f, institutionalId: e.target.value })} /></Field>
          <Field label="First name" hint="Shown for review only"><Input value={f.firstName} onChange={(e) => setF({ ...f, firstName: e.target.value })} /></Field>
          <Field label="Last name"><Input value={f.lastName} onChange={(e) => setF({ ...f, lastName: e.target.value })} /></Field>
        </div>
      </Card>
      <Card title="Result">
        <ApiErrorDetails error={check.error} />
        {!r ? <Empty title="No check run yet" /> : (
          <div className="space-y-3">
            <div className="flex items-center gap-2"><Badge tone={tone[r.status]}>{r.status}</Badge><span className="text-sm text-slate-600">{r.reason ?? (r.status === 'LINKED' ? 'This account is already linked.' : '')}</span></div>
            {r.warnings?.map((w) => <Alert key={w} tone="warn">{w}</Alert>)}
            {(r.candidates ?? (r.sisRecord ? [r.sisRecord] : [])).map((c) => (
              <div key={c.sisId} className="rounded-lg border border-slate-200 p-3 text-sm">
                <div className="font-medium">{c.displayName} <span className="mono text-slate-500">{c.institutionalId}</span></div>
                <div className="text-slate-500">{c.email} · {c.status?.toLowerCase()} {c.program ?? c.department ?? ''}</div>
                {c.evidence && <div className="mt-1 flex gap-1">{Object.entries(c.evidence).map(([k, v]) => <Badge key={k} tone={v ? 'green' : 'slate'}>{k.replace('Match', '')}: {v ? 'match' : 'no'}</Badge>)}</div>}
                {c.linkedToExternalUserId && <div className="mt-1 text-xs text-amber-700">Already linked to {c.linkedToExternalUserId}</div>}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
