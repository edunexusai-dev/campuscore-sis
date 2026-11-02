import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, FlaskConical, BookOpen, ShieldCheck, AlertTriangle } from 'lucide-react';
import { api, qs } from '../../lib/api.js';
import { useApi, useAction } from '../../lib/hooks.js';
import { fmtDateTime, fmtRelative } from '../../lib/format.js';
import { PageHeader, Card, DataTable, Badge, Button, Tabs, Modal, Field, Input, Textarea, Select, Checkbox, ApiErrorDetails, SecretBox, Alert, Empty, Pagination, ErrorState } from '../../components/ui.jsx';

export default function Integrations() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('clients');
  const { data, isLoading, error } = useApi('/admin/integrations');
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Developer & integrations" subtitle="Register external applications such as EdunexusAI, issue OAuth 2.0 client credentials and control exactly what each one can read or change."
        actions={<><a href="/api/docs" target="_blank" rel="noreferrer"><Button variant="secondary" icon={BookOpen}>API reference</Button></a><Link to="/admin/integrations/playground"><Button variant="secondary" icon={FlaskConical}>API playground</Button></Link><Button icon={Plus} onClick={() => setCreating(true)}>Register application</Button></>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'clients', label: 'Integration clients', count: data?.data.length }, { value: 'activity', label: 'API activity' }, { value: 'guide', label: 'Connection guide' }]} />
      {tab === 'clients' && (
        <Card padded={false}>
          {error ? <ErrorState error={error} /> : <DataTable loading={isLoading} rows={data?.data} onRowClick={(r) => navigate(`/admin/integrations/${r.id}`)} empty={<Empty title="No integrations yet" description="Register an application to issue API credentials." action={<Button icon={Plus} onClick={() => setCreating(true)}>Register application</Button>} />} columns={[
            { key: 'name', header: 'Application', render: (r) => <div><div className="font-medium text-slate-900">{r.name}</div><div className="mono text-slate-500">{r.clientId}</div></div> },
            { key: 'scopes', header: 'Access', render: (r) => <div className="flex flex-wrap gap-1"><Badge tone="ink">{r.scopes.filter((s) => s.endsWith(':read')).length} read</Badge>{r.scopes.some((s) => s.endsWith(':write')) && <Badge tone="amber">{r.scopes.filter((s) => s.endsWith(':write')).length} write</Badge>}</div> },
            { key: 'tokens', header: 'Active tokens', align: 'right', render: (r) => r.stats.activeTokens },
            { key: 'req', header: 'Requests (24h)', align: 'right', render: (r) => <span>{r.stats.requests24h}{r.stats.errors24h > 0 && <span className="ml-1 text-xs text-red-600">({r.stats.errors24h} errors)</span>}</span> },
            { key: 'last', header: 'Last used', render: (r) => <span title={r.lastUsedIp ?? ''}>{fmtRelative(r.lastUsedAt)}</span> },
            { key: 'status', header: 'Status', render: (r) => <Badge status={r.revoked ? 'REVOKED' : r.enabled ? 'ACTIVE' : 'DISABLED'}>{r.revoked ? 'Revoked' : r.enabled ? 'Enabled' : 'Disabled'}</Badge> },
          ]} />}
        </Card>
      )}
      {tab === 'activity' && <Activity clients={data?.data ?? []} />}
      {tab === 'guide' && <Guide />}
      <CreateClient open={creating} onClose={() => setCreating(false)} onDone={(id) => navigate(`/admin/integrations/${id}`)} />
    </>
  );
}

export function ScopePicker({ value, onChange }) {
  const { data } = useApi('/admin/integrations/scopes');
  const scopes = data?.data ?? [];
  const toggle = (s, on) => onChange(on ? [...new Set([...value, s])] : value.filter((x) => x !== s));
  const reads = scopes.filter((s) => !s.write), writes = scopes.filter((s) => s.write);
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div>
        <div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Read access</span><button type="button" className="text-xs link" onClick={() => onChange([...new Set([...value, ...reads.map((s) => s.scope)])])}>Select all</button></div>
        <div className="space-y-2.5">{reads.map((s) => <Checkbox key={s.scope} label={<span className="mono">{s.scope}</span>} description={s.description} checked={value.includes(s.scope)} onChange={(v) => toggle(s.scope, v)} />)}</div>
      </div>
      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-700">Write access</div>
        <Alert tone="warn" className="mb-3">Write scopes are still bound by institutional policy switches and every business rule (eligibility, grade workflow, instructor assignment). Grant only what the application needs.</Alert>
        <div className="space-y-2.5">{writes.map((s) => <Checkbox key={s.scope} label={<span className="mono">{s.scope}</span>} description={s.description} checked={value.includes(s.scope)} onChange={(v) => toggle(s.scope, v)} />)}</div>
      </div>
    </div>
  );
}

function CreateClient({ open, onClose, onDone }) {
  const empty = { name: '', description: '', scopes: [], tokenTtlSeconds: 900 };
  const [f, setF] = useState(empty);
  const create = useAction(() => api.post('/admin/integrations', { ...f, description: f.description || undefined, tokenTtlSeconds: Number(f.tokenTtlSeconds) }), { invalidate: ['/admin/integrations'], toastErrors: false });
  const [ack, setAck] = useState(false);
  const close = () => { setF(empty); setAck(false); create.reset(); onClose(); };
  const result = create.data;
  return (
    <Modal open={open} onClose={result ? () => {} : close} size="lg" title={result ? 'Save these credentials now' : 'Register an application'}
      description={result ? 'The client secret is displayed only once. CampusCore stores only a one-way hash.' : 'Creates an OAuth 2.0 client-credentials integration.'}
      footer={result ? <Button disabled={!ack} onClick={() => { const id = result.client.id; close(); onDone(id); }}>I have stored the secret</Button>
        : <><Button variant="secondary" onClick={close}>Cancel</Button><Button onClick={() => create.mutate()} loading={create.isPending} disabled={f.name.trim().length < 3 || !f.scopes.length}>Create client</Button></>}>
      {result ? (
        <div className="space-y-4">
          <Alert tone="warn" title="Store the secret in the application's server-side secret store">Never place it in browser code, mobile apps, source control or chat. If it is lost or exposed, rotate it from the client page.</Alert>
          <SecretBox label="Client ID" value={result.client.clientId} />
          <SecretBox label="Client secret" value={result.clientSecret} />
          <div>
            <div className="label">Request a token</div>
            <pre className="overflow-x-auto rounded-lg bg-ink-950 p-3 text-[12px] leading-relaxed text-ink-100">{`curl -X POST ${window.location.origin}/api/v1/oauth/token \\
  -u "${result.client.clientId}:<CLIENT_SECRET>" \\
  -d grant_type=client_credentials`}</pre>
          </div>
          <Checkbox label="I have copied the client secret to a secure location" checked={ack} onChange={setAck} />
        </div>
      ) : (
        <div className="space-y-4">
          <ApiErrorDetails error={create.error} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Application name" required className="sm:col-span-2"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="EdunexusAI Campus Portal" /></Field>
            <Field label="Token lifetime" hint="Short-lived tokens limit exposure"><Select value={f.tokenTtlSeconds} onChange={(e) => setF({ ...f, tokenTtlSeconds: e.target.value })} options={[[300, '5 minutes'], [900, '15 minutes'], [1800, '30 minutes'], [3600, '60 minutes']].map(([v, l]) => ({ value: v, label: l }))} /></Field>
          </div>
          <Field label="Description"><Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="What the application does and who owns it" /></Field>
          <div><div className="label">Scopes</div><ScopePicker value={f.scopes} onChange={(scopes) => setF({ ...f, scopes })} /></div>
        </div>
      )}
    </Modal>
  );
}

export function Activity({ clients, clientId: fixed }) {
  const [clientId, setClientId] = useState(fixed ?? '');
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useApi(`/admin/integrations/activity${qs({ clientId: fixed ?? clientId, page, pageSize: 25 })}`, { refetchInterval: 10_000, placeholderData: (x) => x });
  return (
    <Card padded={false} title={fixed ? 'API activity' : undefined} subtitle={fixed ? 'Every request made with this client, refreshed every 10 seconds' : undefined}>
      {!fixed && <div className="border-b border-slate-100 p-3"><Select aria-label="Client" value={clientId} onChange={(e) => { setClientId(e.target.value); setPage(1); }} placeholder="All clients" options={clients.map((c) => ({ value: c.id, label: c.name }))} className="w-64" /></div>}
      {error ? <ErrorState error={error} /> : <DataTable dense loading={isLoading} rows={data?.data} empty={<Empty title="No API requests yet" />} columns={[
        { key: 'createdAt', header: 'Time', render: (r) => <span className="whitespace-nowrap text-[13px]">{fmtDateTime(r.createdAt)}</span> },
        !fixed && { key: 'client', header: 'Client', render: (r) => r.client ?? '—' },
        { key: 'req', header: 'Request', render: (r) => <span className="mono"><span className="font-semibold">{r.method}</span> {r.path}</span> },
        { key: 'status', header: 'Status', render: (r) => <Badge tone={r.status < 300 ? 'green' : r.status < 500 ? 'amber' : 'red'}>{r.status}</Badge> },
        { key: 'err', header: 'Error', render: (r) => r.errorCode ? <span className="mono text-red-700">{r.errorCode}</span> : '' },
        { key: 'ms', header: 'Time', align: 'right', render: (r) => `${r.durationMs} ms` },
        { key: 'ip', header: 'IP', render: (r) => <span className="mono text-slate-500">{r.ip}</span> },
      ].filter(Boolean)} />}
      <Pagination pagination={data?.pagination} onPage={setPage} />
    </Card>
  );
}

function Guide() {
  const base = window.location.origin;
  const steps = [
    ['Register EdunexusAI', 'Use “Register application”, choose the read scopes the portal needs (and only the write scopes you intend to allow), and copy the client secret when it is shown.'],
    ['Configure EdunexusAI server-side', <>Set <span className="mono">CAMPUSCORE_BASE_URL</span>, <span className="mono">CAMPUSCORE_CLIENT_ID</span> and <span className="mono">CAMPUSCORE_CLIENT_SECRET</span> in EdunexusAI's backend environment or encrypted settings store — never in its frontend.</>],
    ['Request a token', <>EdunexusAI calls <span className="mono">POST {base}/api/v1/oauth/token</span> with the client-credentials grant, caches the bearer token until shortly before <span className="mono">expires_in</span>, and requests a new one on <span className="mono">401 invalid_token</span>.</>],
    ['Read and map records', <>Call <span className="mono">/api/v1/students</span>, <span className="mono">/students/:id/schedule</span>, <span className="mono">/academic-record</span>, etc., and map the DTOs into EdunexusAI's canonical model. The reference connector in <span className="mono">connector/</span> shows the adapter pattern, retries and token caching.</>],
    ['Write only where permitted', <>Writes (registrations, attendance, contact details, draft grades) require the matching <span className="mono">:write</span> scope <em>and</em> the policy switch under Policies → Integration API. CampusCore validates, enforces business rules, persists and audits every change.</>],
    ['Monitor and rotate', 'Watch API activity and errors here. Rotate the secret periodically or immediately if exposed — rotation revokes every outstanding token.'],
  ];
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card title="Connecting EdunexusAI (or any campus application)" className="lg:col-span-2">
        <ol className="space-y-4">{steps.map(([t, d], i) => (
          <li key={t} className="flex gap-3"><span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink-900 text-[13px] font-semibold text-white">{i + 1}</span><div><div className="font-medium text-slate-900">{t}</div><div className="text-sm text-slate-600">{d}</div></div></li>
        ))}</ol>
      </Card>
      <div className="space-y-6">
        <Card title="Data ownership">
          <ul className="space-y-2 text-sm text-slate-600">
            <li><strong className="text-slate-800">CampusCore is authoritative</strong> for student identity, program, status, registrations, official grades, attendance and the academic calendar.</li>
            <li><strong className="text-slate-800">External systems</strong> (LMS assignments, billing ledgers, aid packaging) remain authoritative for their own data; CampusCore stores references only and never overwrites them.</li>
          </ul>
        </Card>
        <Card title="Security model">
          <ul className="space-y-2 text-sm text-slate-600">
            <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />Secrets hashed at rest, shown once</li>
            <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />Short-lived signed tokens with server-side revocation</li>
            <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />Per-scope, per-policy and per-record authorization</li>
            <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />Tenant-isolated: a client sees only its institution</li>
            <li className="flex gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />No IP allow-listing or mTLS yet (planned)</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
