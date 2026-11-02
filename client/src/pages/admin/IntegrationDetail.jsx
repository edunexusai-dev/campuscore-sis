import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { RotateCw, Ban, Trash2, FlaskConical } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApi, useAction } from '../../lib/hooks.js';
import { fmtDateTime, fmtRelative } from '../../lib/format.js';
import { PageHeader, Card, Spinner, Badge, Button, Tabs, KeyValue, DataTable, Toggle, Field, Input, Select, Modal, ConfirmDialog, SecretBox, Alert, ApiErrorDetails, Empty, ErrorState, Checkbox } from '../../components/ui.jsx';
import { ScopePicker, Activity } from './Integrations.jsx';

export default function IntegrationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = useApi(`/admin/integrations/${id}`, { refetchInterval: 15_000 });
  const [tab, setTab] = useState('capabilities');
  const [confirm, setConfirm] = useState(null);
  const [secret, setSecret] = useState(null);
  const [ack, setAck] = useState(false);
  const inv = ['/admin/integrations'];
  const rotate = useAction(() => api.post(`/admin/integrations/${id}/rotate`), { invalidate: inv, onSuccess: (r) => { setConfirm(null); setSecret(r.clientSecret); }, toastErrors: false });
  const revokeTokens = useAction(() => api.post(`/admin/integrations/${id}/revoke-tokens`), { invalidate: inv, success: (r) => `${r.data.revoked} active token(s) revoked`, onSuccess: () => setConfirm(null) });
  const revoke = useAction(() => api.post(`/admin/integrations/${id}/revoke`), { invalidate: inv, success: 'Client permanently revoked', onSuccess: () => { setConfirm(null); navigate('/admin/integrations'); } });
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <Spinner />;
  const c = data.data;
  return (
    <>
      <PageHeader back={{ to: '/admin/integrations', label: 'Integrations' }} title={c.name} subtitle={c.description}
        eyebrow={c.revoked ? 'Revoked' : c.enabled ? 'Enabled' : 'Disabled'}
        actions={!c.revoked && <>
          <Link to={`/admin/integrations/playground?client=${c.clientId}`}><Button variant="secondary" icon={FlaskConical}>Test in playground</Button></Link>
          <Button variant="secondary" icon={RotateCw} onClick={() => setConfirm('rotate')}>Rotate secret</Button>
          <Button variant="secondary" icon={Ban} onClick={() => setConfirm('tokens')}>Revoke tokens</Button>
          <Button variant="subtleDanger" icon={Trash2} onClick={() => setConfirm('revoke')}>Revoke client</Button>
        </>} />
      {c.revoked && <Alert tone="error" className="mb-5" title="This client was permanently revoked">Revoked {fmtDateTime(c.revokedAt)}. It can no longer obtain tokens. Register a new client to restore access.</Alert>}
      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card title="Credentials">
          <KeyValue cols={1} items={[
            ['Client ID', <span className="mono break-all">{c.clientId}</span>], ['Client secret', <span className="mono">{c.secretHint}</span>], ['Secret last rotated', fmtDateTime(c.secretRotatedAt)],
            ['Token lifetime', `${c.tokenTtlSeconds / 60} minutes`], ['Last used', c.lastUsedAt ? `${fmtRelative(c.lastUsedAt)} from ${c.lastUsedIp}` : 'Never'], ['Created', fmtDateTime(c.createdAt)],
          ]} />
        </Card>
        <Card title="Access tokens" className="lg:col-span-2" padded={false} subtitle="Most recent 50. Tokens are revocable server-side; expired ones cannot be used.">
          <div className="max-h-72 overflow-y-auto">
            <DataTable dense rows={c.tokens} rowKey={(r) => r.jti} empty={<Empty title="No tokens issued yet" />} columns={[
              { key: 'jti', header: 'Token ID', render: (r) => <span className="mono">{r.jti.slice(0, 8)}…</span> },
              { key: 'issued', header: 'Issued', render: (r) => <span className="text-[13px]">{fmtDateTime(r.issuedAt)}</span> },
              { key: 'exp', header: 'Expires', render: (r) => <span className="text-[13px]">{fmtDateTime(r.expiresAt)}</span> },
              { key: 'scopes', header: 'Scopes', render: (r) => <span className="text-xs text-slate-500">{r.scopes.length}</span> },
              { key: 'ip', header: 'IP', render: (r) => <span className="mono text-slate-500">{r.ip}</span> },
              { key: 'state', header: 'State', render: (r) => <Badge status={r.state} /> },
            ]} />
          </div>
        </Card>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'capabilities', label: 'Write capabilities' }, { value: 'settings', label: 'Access & settings' }, { value: 'activity', label: 'API activity' }, { value: 'audit', label: 'Audit trail', count: c.auditEvents.length }]} />
      {tab === 'capabilities' && <Capabilities c={c} />}
      {tab === 'settings' && <Settings c={c} />}
      {tab === 'activity' && <Activity clientId={c.id} clients={[]} />}
      {tab === 'audit' && (
        <Card padded={false}><DataTable rows={c.auditEvents} empty={<Empty title="No audit events" />} columns={[
          { key: 'createdAt', header: 'Time', render: (r) => <span className="whitespace-nowrap text-[13px]">{fmtDateTime(r.createdAt)}</span> },
          { key: 'actor', header: 'Actor', render: (r) => r.actorLabel },
          { key: 'action', header: 'Action', render: (r) => <span className="mono">{r.action}</span> },
          { key: 'summary', header: 'Summary' },
        ]} /></Card>
      )}
      <ConfirmDialog open={confirm === 'rotate'} onClose={() => setConfirm(null)} onConfirm={() => rotate.mutate()} loading={rotate.isPending} title="Rotate client secret?" confirmLabel="Rotate secret">
        <ApiErrorDetails error={rotate.error} />
        <p>A new secret will be generated and shown once. The current secret stops working immediately and <strong>every outstanding access token is revoked</strong>. Update the secret in {c.name}'s server configuration right away.</p>
      </ConfirmDialog>
      <ConfirmDialog open={confirm === 'tokens'} onClose={() => setConfirm(null)} onConfirm={() => revokeTokens.mutate()} loading={revokeTokens.isPending} title="Revoke all active tokens?" confirmLabel="Revoke tokens">
        <p>Requests using existing tokens will fail with <span className="mono">401 invalid_token</span>. The client can immediately request new tokens with its current secret.</p>
      </ConfirmDialog>
      <ConfirmDialog open={confirm === 'revoke'} onClose={() => setConfirm(null)} onConfirm={() => revoke.mutate()} loading={revoke.isPending} title="Permanently revoke this client?" confirmLabel="Revoke permanently" requireText={c.name}>
        <p>The client and all of its tokens stop working immediately. This cannot be undone; its audit history is kept.</p>
      </ConfirmDialog>
      <Modal open={!!secret} onClose={() => {}} title="New client secret" description="Shown only once." footer={<Button disabled={!ack} onClick={() => { setSecret(null); setAck(false); }}>I have stored the secret</Button>}>
        <div className="space-y-4">
          <SecretBox label="Client secret" value={secret ?? ''} />
          <Checkbox label="I have updated the application's server-side configuration" checked={ack} onChange={setAck} />
        </div>
      </Modal>
    </>
  );
}

function Settings({ c }) {
  const [f, setF] = useState(null);
  useEffect(() => setF({ name: c.name, description: c.description ?? '', scopes: c.scopes, enabled: c.enabled, tokenTtlSeconds: c.tokenTtlSeconds }), [c]);
  const save = useAction(() => api.patch(`/admin/integrations/${c.id}`, { ...f, description: f.description || null, tokenTtlSeconds: Number(f.tokenTtlSeconds) }), { invalidate: ['/admin/integrations'], success: 'Integration updated', toastErrors: false });
  if (!f) return null;
  const narrowed = c.scopes.some((s) => !f.scopes.includes(s));
  const dirty = JSON.stringify(f) !== JSON.stringify({ name: c.name, description: c.description ?? '', scopes: c.scopes, enabled: c.enabled, tokenTtlSeconds: c.tokenTtlSeconds });
  return (
    <Card footer={!c.revoked && <div className="flex items-center justify-end gap-3">{dirty && (narrowed || !f.enabled) && <span className="text-[13px] text-amber-700">Saving will revoke the client's active tokens.</span>}<Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty || !f.scopes.length}>Save changes</Button></div>}>
      <ApiErrorDetails error={save.error} />
      <fieldset disabled={c.revoked} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Name" className="sm:col-span-2"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Token lifetime"><Select value={f.tokenTtlSeconds} onChange={(e) => setF({ ...f, tokenTtlSeconds: e.target.value })} options={[[300, '5 minutes'], [900, '15 minutes'], [1800, '30 minutes'], [3600, '60 minutes']].map(([v, l]) => ({ value: v, label: l }))} /></Field>
          <Field label="Description" className="sm:col-span-3"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        </div>
        <div className="flex items-center gap-3 rounded-lg border border-slate-200 p-3"><Toggle checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label="Enabled" /><div><div className="text-sm font-medium">{f.enabled ? 'Enabled' : 'Disabled'}</div><div className="text-xs text-slate-500">Disabled clients cannot obtain tokens and existing tokens are rejected.</div></div></div>
        <div><div className="label">Scopes</div><ScopePicker value={f.scopes} onChange={(scopes) => setF({ ...f, scopes })} /></div>
      </fieldset>
    </Card>
  );
}

// Effective write capability = scope granted × institutional policy × this client's write preferences.
function Capabilities({ c }) {
  const prefs = c.writePreferences ?? { disabledOperations: [] };
  const [disabled, setDisabled] = useState(prefs.disabledOperations ?? []);
  useEffect(() => setDisabled(c.writePreferences?.disabledOperations ?? []), [c]);
  const save = useAction(() => api.patch(`/admin/integrations/${c.id}`, { writePreferences: { ...(c.writePreferences ?? {}), disabledOperations: disabled } }), { invalidate: ['/admin/integrations'], success: 'Write preferences saved', toastErrors: false });
  const dirty = JSON.stringify([...disabled].sort()) !== JSON.stringify([...(prefs.disabledOperations ?? [])].sort());
  const Yes = ({ ok, children }) => <Badge tone={ok ? 'green' : 'slate'}>{children ?? (ok ? 'Yes' : 'No')}</Badge>;
  return (
    <Card padded={false} title="What this client can change" subtitle="An operation is allowed only when the scope is granted, the institutional policy is on (Admin → Policies), and this client's preferences don't switch it off. Preferences can only narrow access."
      footer={!c.revoked && <div className="flex justify-end"><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty}>Save preferences</Button></div>}>
      {save.error && <div className="p-4 pb-0"><ApiErrorDetails error={save.error} /></div>}
      <DataTable rows={c.capabilities} rowKey={(r) => r.operation} columns={[
        { key: 'op', header: 'Operation', render: (r) => <div><div className="font-medium text-slate-900">{r.label}</div><div className="mono text-slate-400">{r.operation}</div></div> },
        { key: 'scope', header: 'Scope granted', render: (r) => <div><Yes ok={r.scopeGranted} /><div className="mono mt-0.5 text-xs text-slate-400">{r.scope}</div></div> },
        { key: 'policy', header: 'Institution policy', render: (r) => <div><Yes ok={r.policyEnabled}>{r.policyEnabled ? 'On' : 'Off'}</Yes><div className="mono mt-0.5 text-xs text-slate-400">{r.policy}</div></div> },
        { key: 'pref', header: 'Client preference', render: (r) => <Toggle checked={!disabled.includes(r.operation)} onChange={(v) => setDisabled(v ? disabled.filter((x) => x !== r.operation) : [...disabled, r.operation])} label={`Allow ${r.label}`} disabled={c.revoked} /> },
        { key: 'fields', header: 'Fields', render: (r) => r.allowedFields ? <span className="text-xs text-slate-600">{r.allowedFields.join(', ') || 'none'}</span> : '—' },
        { key: 'eff', header: 'Effective', render: (r) => <div><Yes ok={r.effective}>{r.effective ? 'Allowed' : 'Blocked'}</Yes>{r.reason && <div className="mt-0.5 max-w-xs text-xs text-slate-500">{r.reason}</div>}</div> },
      ]} />
    </Card>
  );
}
