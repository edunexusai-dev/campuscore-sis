import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api.js';
import { useApi, useAction } from '../../lib/hooks.js';
import { fmtDateTime } from '../../lib/format.js';
import { PageHeader, Card, Spinner, Button, Toggle, Input, ApiErrorDetails, Badge, ErrorState, ConfirmDialog, Checkbox } from '../../components/ui.jsx';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (v) => (Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : String(v));

export default function Policies() {
  const { data, isLoading, error } = useApi('/admin/policies');
  const [draft, setDraft] = useState({});
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { if (data) setDraft(Object.fromEntries(data.data.map((p) => [p.key, p.value]))); }, [data]);
  const changes = useMemo(() => Object.fromEntries((data?.data ?? []).filter((p) => draft[p.key] !== undefined && !same(draft[p.key], p.value)).map((p) => [p.key, draft[p.key]])), [data, draft]);
  const save = useAction(() => api.put('/admin/policies', { changes }), { invalidate: ['/admin/policies'], success: 'Policies saved — enforced immediately and recorded in the audit log', onSuccess: () => setConfirm(false), toastErrors: false });
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <Spinner />;
  const groups = {};
  for (const p of data.data) (groups[p.category] ??= []).push(p);
  const n = Object.keys(changes).length;
  return (
    <>
      <PageHeader title="Institutional policies" subtitle="Rules the server enforces for every portal and integration. Changes take effect immediately and are audited."
        actions={<><Button variant="secondary" disabled={!n} onClick={() => setDraft(Object.fromEntries(data.data.map((p) => [p.key, p.value])))}>Discard</Button><Button disabled={!n} onClick={() => setConfirm(true)}>Save {n || ''} change{n === 1 ? '' : 's'}</Button></>} />
      <ApiErrorDetails error={save.error} />
      <div className="mt-2 grid gap-6 xl:grid-cols-2">
        {Object.entries(groups).map(([cat, items]) => (
          <Card key={cat} title={cat} padded={false}>
            <ul className="divide-y divide-slate-100">
              {items.map((p) => (
                <li key={p.key} className={p.type === 'fields' ? 'px-5 py-4' : 'flex items-start justify-between gap-4 px-5 py-4'}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><label htmlFor={p.key} className="text-sm font-medium text-slate-900">{p.label}</label>{!same(draft[p.key], p.value) && <Badge tone="amber">Unsaved</Badge>}{!same(p.value, p.default) && same(draft[p.key], p.value) && <Badge tone="slate">Customised</Badge>}</div>
                    <p className="mt-0.5 text-[13px] text-slate-500">{p.description}</p>
                    <p className="mt-1 text-[11px] text-slate-400"><span className="mono">{p.key}</span> · default {show(p.default)}{p.updatedAt && ` · changed ${fmtDateTime(p.updatedAt)}`}</p>
                  </div>
                  <div className={p.type === 'fields' ? 'hidden' : 'shrink-0 pt-0.5'}>
                    {p.type === 'fields' ? null : p.type === 'boolean'
                      ? <Toggle id={p.key} label={p.label} checked={!!draft[p.key]} onChange={(v) => setDraft({ ...draft, [p.key]: v })} />
                      : <Input id={p.key} type="number" step={String(p.default).includes('.') || p.key.startsWith('standing') ? '0.1' : '1'} className="w-24 text-right" value={draft[p.key] ?? ''} onChange={(e) => setDraft({ ...draft, [p.key]: e.target.value === '' ? '' : Number(e.target.value) })} />}
                  </div>
                  {p.type === 'fields' && (
                    <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2" role="group" aria-label={p.label}>
                      {p.options.map((o) => <Checkbox key={o} label={<span className="mono">{o}</span>} checked={(draft[p.key] ?? []).includes(o)} onChange={(v) => setDraft({ ...draft, [p.key]: v ? [...(draft[p.key] ?? []), o] : (draft[p.key] ?? []).filter((x) => x !== o) })} />)}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => save.mutate()} loading={save.isPending} tone="primary" title="Apply policy changes?" confirmLabel="Apply changes">
        <ul className="list-disc space-y-1 pl-5">{Object.entries(changes).map(([k, v]) => <li key={k}><strong>{data.data.find((p) => p.key === k).label}</strong>: {show(data.data.find((p) => p.key === k).value)} → {show(v)}</li>)}</ul>
        <p>These rules are enforced by the server for every channel, including integrations already holding tokens.</p>
      </ConfirmDialog>
    </>
  );
}
