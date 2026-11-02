import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { KeyRound, Send, Ban, Copy, Eye, EyeOff, ShieldAlert } from 'lucide-react';
import { useApi } from '../../lib/hooks.js';
import { PageHeader, Card, Button, Field, Input, Select, Textarea, Badge, Alert, Spinner, cx } from '../../components/ui.jsx';

// The client secret entered here lives only in React state for this page. It is sent once, to the real
// token endpoint, and never written to storage or the URL. The resulting access token is also memory-only.
const decode = (jwt) => { try { return JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); } catch { return null; } };

export default function Playground() {
  const [params] = useSearchParams();
  const { data: spec } = useApi('/api/openapi.json', { staleTime: Infinity });
  const [clientId, setClientId] = useState(params.get('client') ?? '');
  const [secret, setSecret] = useState('');
  const [show, setShow] = useState(false);
  const [scope, setScope] = useState('');
  const [token, setToken] = useState(null);
  const [tokenRes, setTokenRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  const getToken = async () => {
    setBusy(true);
    const body = new URLSearchParams({ grant_type: 'client_credentials', ...(scope ? { scope } : {}) });
    const res = await fetch('/api/v1/oauth/token', { method: 'POST', headers: { Authorization: `Basic ${btoa(`${clientId}:${secret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const json = await res.json().catch(() => null);
    setTokenRes({ status: res.status, body: json });
    setToken(res.ok ? { value: json.access_token, claims: decode(json.access_token), issuedAt: Date.now(), expiresIn: json.expires_in } : null);
    setBusy(false);
  };
  const revoke = async () => {
    const res = await fetch('/api/v1/oauth/revoke', { method: 'POST', headers: { Authorization: `Basic ${btoa(`${clientId}:${secret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: token.value }) });
    setTokenRes({ status: res.status, body: { ...(await res.json()), note: 'Token revoked server-side. Send a request below to see it rejected.' } });
  };
  const remaining = token ? Math.max(0, Math.round(token.claims.exp - now / 1000)) : 0;

  return (
    <>
      <PageHeader back={{ to: '/admin/integrations', label: 'Integrations' }} title="API playground" subtitle="Exercise the real integration API exactly as an external application would: client credentials → bearer token → scoped requests." />
      <Alert tone="info" className="mb-5" title="Nothing here is stored">The client secret and access token exist only in this browser tab's memory and are discarded when you leave the page. Requests are logged in the client's API activity like any other integration traffic.</Alert>
      <div className="grid gap-6 xl:grid-cols-5">
        <div className="space-y-6 xl:col-span-2">
          <Card title="1 · Obtain an access token" subtitle="POST /api/v1/oauth/token (client_credentials)">
            <div className="space-y-3">
              <Field label="Client ID"><Input value={clientId} onChange={(e) => setClientId(e.target.value.trim())} className="mono" autoComplete="off" /></Field>
              <Field label="Client secret" hint="Paste from your secure store. Not saved anywhere.">
                <div className="flex gap-2"><Input type={show ? 'text' : 'password'} value={secret} onChange={(e) => setSecret(e.target.value.trim())} className="mono" autoComplete="off" spellCheck={false} /><Button variant="secondary" icon={show ? EyeOff : Eye} onClick={() => setShow(!show)} aria-label={show ? 'Hide secret' : 'Show secret'} /></div>
              </Field>
              <Field label="Scopes (optional)" hint="Space-separated subset; empty requests every granted scope"><Input value={scope} onChange={(e) => setScope(e.target.value)} className="mono" placeholder="students:read courses:read" /></Field>
              <div className="flex gap-2"><Button icon={KeyRound} onClick={getToken} loading={busy} disabled={!clientId || !secret}>Request token</Button>{token && <Button variant="subtleDanger" icon={Ban} onClick={revoke}>Revoke token</Button>}</div>
            </div>
            {tokenRes && <ResponseView status={tokenRes.status} body={tokenRes.body} className="mt-4" />}
            {token && (
              <div className="mt-4 rounded-lg border border-slate-200 p-3 text-[13px]">
                <div className="flex items-center justify-between"><span className="font-medium">Bearer token</span>{remaining > 0 ? <Badge tone={remaining < 60 ? 'amber' : 'green'}>expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</Badge> : <Badge tone="red">expired</Badge>}</div>
                <div className="mt-2 grid grid-cols-[90px_1fr] gap-y-1 text-slate-600"><span>Client</span><span className="mono">{token.claims.sub}</span><span>Token ID</span><span className="mono">{token.claims.jti}</span><span>Scopes</span><span className="mono break-words">{token.claims.scope}</span></div>
              </div>
            )}
          </Card>
          <Card title="Equivalent curl">
            <pre className="overflow-x-auto rounded-lg bg-ink-950 p-3 text-[12px] leading-relaxed text-ink-100">{`curl -X POST ${window.location.origin}/api/v1/oauth/token \\
  -u "${clientId || '<CLIENT_ID>'}:$CAMPUSCORE_CLIENT_SECRET" \\
  -d grant_type=client_credentials${scope ? ` \\\n  -d scope="${scope}"` : ''}`}</pre>
          </Card>
        </div>
        <div className="xl:col-span-3">{spec ? <RequestRunner spec={spec} token={token?.value} /> : <Spinner />}</div>
      </div>
    </>
  );
}

function RequestRunner({ spec, token }) {
  const ops = useMemo(() => Object.entries(spec.paths).flatMap(([path, methods]) => Object.entries(methods).map(([m, op]) => ({ key: `${m.toUpperCase()} ${path}`, method: m.toUpperCase(), path, op }))).filter((o) => !o.path.includes('/oauth/')), [spec]);
  const [sel, setSel] = useState('GET /api/v1/students');
  const op = ops.find((o) => o.key === sel) ?? ops[0];
  const [pathParams, setPathParams] = useState({});
  const [query, setQuery] = useState('');
  const [body, setBody] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sendWithout, setSendWithout] = useState(false);
  const pathNames = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
  const scopes = op.op.security?.[0]?.oauth2 ?? [];
  useEffect(() => {
    setRes(null);
    setQuery(op.method === 'GET' && op.op.parameters?.some((p) => p.name === 'pageSize') ? 'pageSize=5' : '');
    const schema = op.op.requestBody?.content?.['application/json']?.schema;
    setBody(schema ? JSON.stringify(Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([k]) => schema.required?.includes(k) || op.method === 'PATCH').slice(0, 4).map(([k, v]) => [k, v.type === 'array' ? [] : ''])), null, 2) : '');
  }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps

  const url = op.path.replace(/\{(\w+)\}/g, (_, n) => encodeURIComponent(pathParams[n] || `{${n}}`)) + (query ? `?${query}` : '');
  const send = async () => {
    setBusy(true);
    const started = performance.now();
    const headers = { Accept: 'application/json' };
    if (token && !sendWithout) headers.Authorization = `Bearer ${token}`;
    if (body && op.method !== 'GET') headers['Content-Type'] = 'application/json';
    try {
      const r = await fetch(url, { method: op.method, headers, body: op.method !== 'GET' && body ? body : undefined, credentials: 'omit' });
      const json = await r.json().catch(() => null);
      setRes({ status: r.status, body: json, ms: Math.round(performance.now() - started), requestId: r.headers.get('x-request-id'), rate: r.headers.get('ratelimit') });
    } catch (e) { setRes({ status: 0, body: { error: e.message } }); }
    setBusy(false);
  };
  const curl = `curl -X ${op.method} "${window.location.origin}${url}" \\\n  -H "Authorization: Bearer $TOKEN"${body && op.method !== 'GET' ? ` \\\n  -H "Content-Type: application/json" \\\n  -d '${body.replace(/\s+/g, ' ')}'` : ''}`;
  return (
    <Card title="2 · Call an endpoint" subtitle="Requests go to the live /api/v1 with your bearer token. Human session cookies are never sent.">
      <div className="space-y-4">
        <Field label="Endpoint">
          <Select value={sel} onChange={(e) => setSel(e.target.value)} options={ops.map((o) => ({ value: o.key, label: `${o.method.padEnd(6, ' ')} ${o.path.replace('/api/v1', '')} — ${o.op.summary}` }))} className="mono" />
        </Field>
        <div className="flex flex-wrap items-center gap-2 text-[13px]">{scopes.length ? scopes.map((s) => <Badge key={s} tone={s.endsWith(':write') ? 'amber' : 'ink'}>{s}</Badge>) : <Badge tone="slate">no scope required</Badge>}{op.op.description?.includes('policy') && <span className="flex items-center gap-1 text-amber-700"><ShieldAlert className="size-3.5" />policy-controlled</span>}</div>
        {pathNames.length > 0 && <div className="grid gap-3 sm:grid-cols-2">{pathNames.map((n) => <Field key={n} label={`Path · ${n}`}><Input className="mono" value={pathParams[n] ?? ''} onChange={(e) => setPathParams({ ...pathParams, [n]: e.target.value.trim() })} placeholder="Paste an ID from a list response" /></Field>)}</div>}
        <Field label="Query string" hint={op.op.parameters?.filter((p) => p.in === 'query').map((p) => p.name).join(', ') || 'No query parameters'}><Input className="mono" value={query} onChange={(e) => setQuery(e.target.value)} /></Field>
        {op.method !== 'GET' && <Field label="JSON body"><Textarea className="mono min-h-[140px]" value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} /></Field>}
        <div className="flex flex-wrap items-center gap-3">
          <Button icon={Send} onClick={send} loading={busy}>Send {op.method}</Button>
          <label className="flex items-center gap-1.5 text-[13px] text-slate-600"><input type="checkbox" className="accent-ink-800" checked={sendWithout} onChange={(e) => setSendWithout(e.target.checked)} />Send without token</label>
          {!token && !sendWithout && <span className="text-[13px] text-amber-700">No token yet — the request will be rejected with 401.</span>}
        </div>
        <div className="mono truncate rounded-md bg-slate-50 px-3 py-2 text-slate-600"><span className="font-semibold">{op.method}</span> {url}</div>
        {res && <ResponseView {...res} />}
        <details className="text-[13px]"><summary className="cursor-pointer font-medium text-slate-700">curl</summary>
          <div className="relative mt-2"><pre className="overflow-x-auto rounded-lg bg-ink-950 p-3 text-[12px] text-ink-100">{curl}</pre><button className="absolute right-2 top-2 rounded p-1 text-ink-300 hover:text-white" onClick={() => navigator.clipboard.writeText(curl)} aria-label="Copy curl"><Copy className="size-4" /></button></div>
        </details>
      </div>
    </Card>
  );
}

function ResponseView({ status, body, ms, requestId, className }) {
  return (
    <div className={cx('rounded-lg border border-slate-200', className)}>
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-3 py-2 text-[13px]">
        <Badge tone={status >= 200 && status < 300 ? 'green' : status >= 500 || status === 0 ? 'red' : 'amber'}>{status || 'network error'}</Badge>
        {ms != null && <span className="text-slate-500">{ms} ms</span>}
        {requestId && <span className="mono text-slate-400">request {requestId.slice(0, 8)}</span>}
        {body?.error && <span className="mono text-red-700">{typeof body.error === 'string' ? body.error : body.error.code}</span>}
      </div>
      <pre className="max-h-[460px] overflow-auto p-3 text-[12px] leading-relaxed text-slate-800">{JSON.stringify(body, (k, v) => (k === 'access_token' && typeof v === 'string' ? `${v.slice(0, 24)}… (held in memory)` : v), 2)}</pre>
    </div>
  );
}
