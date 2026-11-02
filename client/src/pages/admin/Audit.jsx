import { useState } from 'react';
import { qs } from '../../lib/api.js';
import { useApi, useListParams } from '../../lib/hooks.js';
import { fmtDateTime } from '../../lib/format.js';
import { PageHeader, Card, DataTable, Pagination, Badge, Select, SearchInput, Modal, Input, Empty, ErrorState } from '../../components/ui.jsx';

export default function Audit() {
  const [p, set] = useListParams({ page: '1' });
  const { data, isLoading, error } = useApi(`/admin/audit${qs({ search: p.search, actorType: p.actorType, entityType: p.entityType, action: p.action, page: p.page, pageSize: 40 })}`, { placeholderData: (x) => x });
  const [open, setOpen] = useState(null);
  return (
    <>
      <PageHeader title="Audit log" subtitle="Append-only record of sensitive reads and every change to academic records, policies, users and integrations." />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <SearchInput value={p.search} onChange={(v) => set({ search: v })} placeholder="Search summary or actor" />
          <Select aria-label="Actor type" value={p.actorType} onChange={(e) => set({ actorType: e.target.value })} placeholder="All actors" options={[{ value: 'USER', label: 'Users' }, { value: 'INTEGRATION', label: 'Integrations' }, { value: 'SYSTEM', label: 'System' }]} className="w-36" />
          <Select aria-label="Entity" value={p.entityType} onChange={(e) => set({ entityType: e.target.value })} placeholder="All entities" options={(data?.entityTypes ?? []).map((t) => ({ value: t, label: t }))} className="w-48" />
          <Input aria-label="Action prefix" value={p.action} onChange={(e) => set({ action: e.target.value })} placeholder="action prefix, e.g. grade." className="mono w-56" />
        </div>
        {error ? <ErrorState error={error} /> : <DataTable dense loading={isLoading} rows={data?.data} onRowClick={setOpen} empty={<Empty title="No matching events" />} columns={[
          { key: 'createdAt', header: 'Time', render: (r) => <span className="whitespace-nowrap text-[13px]">{fmtDateTime(r.createdAt)}</span> },
          { key: 'actor', header: 'Actor', render: (r) => <div className="flex items-center gap-1.5"><Badge tone={r.actorType === 'INTEGRATION' ? 'violet' : r.actorType === 'SYSTEM' ? 'slate' : 'ink'}>{r.actorType.toLowerCase()}</Badge><span className="text-[13px]">{r.actorLabel}</span></div> },
          { key: 'action', header: 'Action', render: (r) => <span className="mono">{r.action}</span> },
          { key: 'summary', header: 'Summary', render: (r) => <span className="text-[13px]">{r.summary}</span> },
        ]} />}
        <Pagination pagination={data?.pagination} onPage={(n) => set({ page: String(n) })} />
      </Card>
      <Modal open={!!open} onClose={() => setOpen(null)} size="lg" title={open?.action} description={open && fmtDateTime(open.createdAt)}>
        {open && <dl className="space-y-3 text-sm">
          <div><dt className="label">Summary</dt><dd>{open.summary}</dd></div>
          <div className="grid grid-cols-2 gap-3"><div><dt className="label">Actor</dt><dd>{open.actorLabel}</dd></div><div><dt className="label">IP address</dt><dd className="mono">{open.ip ?? '—'}</dd></div><div><dt className="label">Entity</dt><dd>{open.entityType}</dd></div><div><dt className="label">Entity ID</dt><dd className="mono break-all">{open.entityId ?? '—'}</dd></div></div>
          {(open.before || open.after) && <div className="grid gap-3 sm:grid-cols-2">{[['Before', open.before], ['After', open.after]].map(([l, v]) => <div key={l}><dt className="label">{l}</dt><dd><pre className="max-h-64 overflow-auto rounded-lg bg-slate-50 p-2 text-[12px]">{v ? JSON.stringify(v, null, 2) : '—'}</pre></dd></div>)}</div>}
        </dl>}
      </Modal>
    </>
  );
}
