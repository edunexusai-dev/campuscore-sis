import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useApi, useAction } from '../../lib/hooks.js';
import { fmtDate, titleCase } from '../../lib/format.js';
import { PageHeader, Card, Spinner, KeyValue, Badge, Button, Field, Input, ApiErrorDetails, Empty, ErrorState } from '../../components/ui.jsx';

const EDITABLE = [
  ['preferredName', 'Preferred name'], ['phone', 'Phone'], ['personalEmail', 'Personal email'],
  ['addressLine', 'Street address'], ['city', 'City'], ['region', 'State / region'], ['postalCode', 'Postal code'], ['country', 'Country'],
  ['emergencyContactName', 'Emergency contact name'], ['emergencyContactPhone', 'Emergency contact phone'], ['emergencyContactRelation', 'Relationship'],
];

export default function StudentProfile() {
  const { data, isLoading, error } = useApi('/student/profile');
  const [form, setForm] = useState(null);
  const p = data?.data;
  useEffect(() => { if (p) setForm(Object.fromEntries(EDITABLE.map(([k]) => [k, p[k] ?? '']))); }, [p]);
  const save = useAction(() => {
    const changes = Object.fromEntries(EDITABLE.map(([k]) => [k, form[k].trim() === '' ? null : form[k].trim()]).filter(([k, v]) => v !== (p[k] ?? null)));
    return api.patch('/student/profile', changes);
  }, { invalidate: ['/student'], success: 'Contact details updated', toastErrors: false });
  if (error) return <ErrorState error={error} />;
  if (isLoading || !form) return <Spinner />;
  const dirty = EDITABLE.some(([k]) => (form[k].trim() || null) !== (p[k] ?? null));
  return (
    <>
      <PageHeader title="Profile & holds" subtitle="Your academic record is maintained by the Registrar. You can update your contact details here." />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-1">
          <Card title="Academic record" subtitle="Read-only">
            <KeyValue cols={1} items={[
              ['Name', `${p.firstName} ${p.lastName}`], ['Student ID', <span className="mono">{p.studentNumber}</span>], ['Institution email', p.email],
              ['Program', p.program ? `${p.program.degreeType} ${p.program.name}` : 'Undeclared'], ['Department', p.program?.department],
              ['Status', <Badge status={p.status} />], ['Class level', titleCase(p.classLevel)], ['Academic standing', <Badge status={p.academicStanding} />],
              ['Admit term', p.admitTerm], ['Expected graduation', p.expectedGraduation], ['Date of birth', fmtDate(p.dateOfBirth)],
            ]} />
          </Card>
          <Card title="Financial references" subtitle="Managed by Student Financial Services">
            <KeyValue cols={1} items={[['Bursar account', p.financialAccountRef], ['Financial aid status', p.financialAidStatus]]} />
            <p className="mt-3 text-xs text-slate-500">Billing and aid are handled in separate systems; CampusCore stores reference identifiers only.</p>
          </Card>
        </div>
        <div className="space-y-6 lg:col-span-2">
          <Card title="Holds" padded={false}>
            {!p.holds.length ? <Empty title="No active holds" description="You're clear to register." /> : (
              <ul className="divide-y divide-slate-100">
                {p.holds.map((h) => (
                  <li key={h.id} className="flex items-start justify-between gap-3 px-5 py-3">
                    <div><div className="text-sm font-medium text-slate-900">{titleCase(h.type)} hold</div><div className="text-[13px] text-slate-600">{h.reason}</div><div className="text-xs text-slate-400">Placed {fmtDate(h.placedAt)}</div></div>
                    {h.blocksRegistration ? <Badge tone="red">Blocks registration</Badge> : <Badge tone="slate">Informational</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Contact details" footer={<div className="flex justify-end"><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>Save changes</Button></div>}>
            <ApiErrorDetails error={save.error} />
            <div className="mt-1 grid gap-4 sm:grid-cols-2">
              {EDITABLE.map(([k, label]) => <Field key={k} label={label}>{(id) => <Input id={id} value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />}</Field>)}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
