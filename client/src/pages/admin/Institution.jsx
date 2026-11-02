import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useApi, useAction } from '../../lib/hooks.js';
import { PageHeader, Card, Spinner, Button, Field, Input, ApiErrorDetails, Toggle, ErrorState, Alert } from '../../components/ui.jsx';

const FIELDS = [['name', 'Institution name'], ['shortName', 'Short name'], ['timezone', 'Time zone'], ['website', 'Website'], ['email', 'Email'], ['phone', 'Phone'], ['addressLine', 'Address'], ['city', 'City'], ['region', 'State / region'], ['postalCode', 'Postal code'], ['emailDomain', 'Staff & faculty email domain'], ['studentEmailDomain', 'Student email domain']];

export default function Institution() {
  const { data, isLoading, error } = useApi('/admin/institution');
  const [f, setF] = useState(null);
  useEffect(() => { if (data) { const d = data.data; setF({ name: d.name, shortName: d.shortName, timezone: d.timezone, website: d.website ?? '', email: d.email ?? '', phone: d.phone ?? '', addressLine: d.address.line1 ?? '', city: d.address.city ?? '', region: d.address.region ?? '', postalCode: d.address.postalCode ?? '', emailDomain: d.emailDomain ?? '', studentEmailDomain: d.studentEmailDomain ?? '' }); } }, [data]);
  const save = useAction(() => api.patch('/admin/institution', Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v === '' && !['name', 'shortName', 'timezone'].includes(k) ? null : v]))), { invalidate: ['/admin/institution'], success: 'Institution profile saved', toastErrors: false });
  if (error) return <ErrorState error={error} />;
  if (isLoading || !f) return <Spinner />;
  return (
    <>
      <PageHeader title="Institution" subtitle="Profile and grading configuration for this tenant." />
      <div className="grid gap-6 xl:grid-cols-5">
        <Card title="Profile" className="xl:col-span-2" footer={<div className="flex justify-end"><Button onClick={() => save.mutate()} loading={save.isPending}>Save profile</Button></div>}>
          <ApiErrorDetails error={save.error} />
          <div className="mt-1 grid gap-4 sm:grid-cols-2">{FIELDS.map(([k, l]) => <Field key={k} label={l}><Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>)}</div>
        </Card>
        <GradeScale scale={data.data.gradeScale} />
      </div>
    </>
  );
}

function GradeScale({ scale }) {
  const [rows, setRows] = useState(scale.entries);
  useEffect(() => setRows(scale.entries), [scale]);
  const save = useAction((e) => api.patch(`/admin/grade-scale/${e.id}`, { points: Number(e.points), minPercent: e.minPercent === '' || e.minPercent == null ? null : Number(e.minPercent), countsInGpa: e.countsInGpa, earnsCredit: e.earnsCredit, description: e.description || null }), { invalidate: ['/admin/institution'], success: (_, e) => `Grade ${e.letter} updated`, toastErrors: true });
  const upd = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Card title={`Grade scale · ${scale.name}`} className="xl:col-span-3" padded={false}>
      <div className="px-5 pt-4"><Alert tone="warn">Changes apply to GPA calculations immediately, including historical grades. Adding or removing letters is planned for a later release.</Alert></div>
      <div className="overflow-x-auto">
        <table className="mt-3 min-w-full">
          <thead><tr><th className="th">Letter</th><th className="th">Points</th><th className="th">Min %</th><th className="th">In GPA</th><th className="th">Earns credit</th><th className="th">Description</th><th className="th" /></tr></thead>
          <tbody>{rows.map((r, i) => {
            const dirty = JSON.stringify(r) !== JSON.stringify(scale.entries[i]);
            return (
              <tr key={r.id}>
                <td className="td text-base font-semibold">{r.letter}</td>
                <td className="td"><Input type="number" step="0.1" className="w-20" value={r.points} onChange={(e) => upd(i, { points: e.target.value })} aria-label={`${r.letter} points`} /></td>
                <td className="td"><Input type="number" className="w-20" value={r.minPercent ?? ''} onChange={(e) => upd(i, { minPercent: e.target.value })} aria-label={`${r.letter} minimum percent`} /></td>
                <td className="td"><Toggle checked={r.countsInGpa} onChange={(v) => upd(i, { countsInGpa: v })} label={`${r.letter} counts in GPA`} /></td>
                <td className="td"><Toggle checked={r.earnsCredit} onChange={(v) => upd(i, { earnsCredit: v })} label={`${r.letter} earns credit`} /></td>
                <td className="td"><Input value={r.description ?? ''} onChange={(e) => upd(i, { description: e.target.value })} aria-label={`${r.letter} description`} /></td>
                <td className="td text-right">{dirty && <Button size="sm" onClick={() => save.mutate(r)} loading={save.isPending && save.variables?.id === r.id}>Save</Button>}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
    </Card>
  );
}
