import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../../lib/api.js';
import { useApi, useAction } from '../../lib/hooks.js';
import { fmtDate, fmtDateTime, titleCase } from '../../lib/format.js';
import { PageHeader, Card, DataTable, Badge, Button, Tabs, Modal, Field, Input, Select, Checkbox, KeyValue, Empty, ErrorState, ApiErrorDetails, SearchInput, Alert, ConfirmDialog, Textarea } from '../../components/ui.jsx';

// Student accounts (bursar). Every figure is computed by the server from the append-only ledger; a correction is a
// reversal or an adjustment, never an edit. Requires finance.manage.

const usd = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(v) || 0);
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const CATEGORIES = ['TUITION', 'TECHNOLOGY', 'STUDENT_SERVICES', 'REGISTRATION', 'LABORATORY', 'COURSE', 'OTHER'];
const STANDING_TONE = { SETTLED: 'green', CREDIT_BALANCE: 'green', BALANCE_DUE: 'amber', PAST_DUE: 'red' };
const TYPE_TONE = { CHARGE: 'slate', PAYMENT: 'green', CREDIT: 'blue', REFUND: 'violet', ADJUSTMENT: 'amber', REVERSAL: 'red' };

export default function AdminFinance() {
  const [tab, setTab] = useState('accounts');
  return (
    <>
      <PageHeader title="Student accounts" subtitle="Fees, charges, payments, credits and statements. Balances are computed from each account's ledger; posted entries are never edited." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'accounts', label: 'Student accounts' }, { value: 'fees', label: 'Fee catalogue' }]} />
      {tab === 'accounts' ? <Accounts /> : <Fees />}
    </>
  );
}

/* ───────────────────────────── accounts ───────────────────────────── */

function Accounts() {
  const [search, setSearch] = useState('');
  const [studentId, setStudentId] = useState(null);
  const list = useApi(`/admin/finance/students${qs({ search: search || undefined })}`);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
      <Card title="Students" subtitle={list.data?.term ? `Balances for ${list.data.term.name}` : undefined} padded={false} actions={<SearchInput value={search} onChange={setSearch} placeholder="Name, number or email" />}>
        {list.error ? <ErrorState error={list.error} retry={list.refetch} /> : (
          <DataTable dense loading={list.isLoading} rows={list.data?.data} onRowClick={(r) => setStudentId(r.id)} empty={<Empty title="No students match" />} columns={[
            { key: 'name', header: 'Student', render: (r) => <span className={r.id === studentId ? 'font-semibold' : ''}>{r.name}<span className="block text-xs text-slate-500">{r.studentNumber} · {r.program ?? '—'}</span></span> },
            { key: 'account', header: 'Balance', align: 'right', render: (r) => (r.account ? <span>{usd(r.account.balance)}{r.account.isDemo && <Badge tone="slate" className="ml-1">Demo</Badge>}</span> : <span className="text-xs text-slate-400">No account</span>) },
          ]} />
        )}
      </Card>
      {studentId ? <StudentAccounts studentId={studentId} /> : <Card><Empty title="Select a student" description="Choose a student to see or open their term accounts." /></Card>}
    </div>
  );
}

function StudentAccounts({ studentId }) {
  const { data, isLoading, error, refetch } = useApi(`/admin/finance/students/${studentId}/accounts`);
  const terms = useApi('/terms');
  const [accountId, setAccountId] = useState(null);
  const [opening, setOpening] = useState(false);
  const [form, setForm] = useState({ termId: '', dueDate: '', isDemo: false });
  const open = useAction((body) => api.post(`/admin/finance/students/${studentId}/accounts`, body), { invalidate: ['/admin/finance'], success: 'Account ready', onSuccess: (res) => { setOpening(false); setAccountId(res.data.id); }, toastErrors: false });
  if (error) return <Card><ErrorState error={error} retry={refetch} /></Card>;
  const accounts = data?.data ?? [];
  const selected = accounts.find((a) => a.id === accountId) ?? accounts[0];
  return (
    <div className="space-y-4">
      <Card title={data?.student ? `${data.student.firstName} ${data.student.lastName}` : 'Student'} subtitle={data?.student ? `${data.student.studentNumber} · person ${data.student.personId}${data.student.financialAccountRef ? ` · bursar ref ${data.student.financialAccountRef}` : ''}` : undefined}
        actions={<><Link className="link text-sm" to={`/admin/students/${studentId}`}>Student record</Link><Button size="sm" onClick={() => { setForm({ termId: terms.data?.data?.find((t) => t.isCurrent)?.id ?? '', dueDate: '', isDemo: false }); setOpening(true); }}>Open term account</Button></>}>
        {isLoading ? <p className="text-sm text-slate-500">Loading…</p> : accounts.length === 0 ? <Empty title="No accounts yet" description="Open an account for a term, then assess the applicable fees." /> : (
          <div className="flex flex-wrap gap-2">
            {accounts.map((a) => <Button key={a.id} size="sm" variant={a.id === selected?.id ? 'primary' : 'secondary'} onClick={() => setAccountId(a.id)}>{a.term.code} · {usd(a.totals.balance)}</Button>)}
          </div>
        )}
      </Card>
      {selected && <AccountDetail account={selected} />}
      <Modal open={opening} onClose={() => setOpening(false)} title="Open a term account" description="One account per student and term. Opening an existing one returns it."
        footer={<><Button variant="secondary" onClick={() => setOpening(false)}>Cancel</Button><Button loading={open.isPending} disabled={!form.termId} onClick={() => open.mutate({ termId: form.termId, dueDate: form.dueDate || undefined, isDemo: form.isDemo })}>Open account</Button></>}>
        <ApiErrorDetails error={open.error} />
        <Field label="Term" required><Select value={form.termId} onChange={(e) => setForm({ ...form, termId: e.target.value })} placeholder="Choose a term" options={(terms.data?.data ?? []).map((t) => ({ value: t.id, label: `${t.name} (${t.code})` }))} /></Field>
        <Field label="Payment due date"><Input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></Field>
        <Checkbox label="Illustrative (demo) account" description="Its entries are simulated and labelled as such everywhere they appear." checked={form.isDemo} onChange={(v) => setForm({ ...form, isDemo: v })} />
      </Modal>
    </div>
  );
}

function AccountDetail({ account }) {
  const [entryOpen, setEntryOpen] = useState(false);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const [statementOpen, setStatementOpen] = useState(false);
  const [reversing, setReversing] = useState(null);
  const [reason, setReason] = useState('');
  const t = account.totals;
  const assess = useAction(() => api.post(`/admin/finance/accounts/${account.id}/assess`, {}), { invalidate: ['/admin/finance'], success: (res) => (res.data.posted.length ? `Assessed ${res.data.posted.length} fee(s) on ${res.data.credits} credits` : 'Nothing new to assess') });
  const reverse = useAction(() => api.post(`/admin/finance/entries/${reversing.id}/reverse`, { reason }), { invalidate: ['/admin/finance'], success: 'Entry reversed', onSuccess: () => { setReversing(null); setReason(''); }, toastErrors: false });
  const entries = useMemo(() => [...account.entries].reverse(), [account.entries]);
  return (
    <>
      <Card title={`${account.term.name} · ${account.accountNumber}`} subtitle={account.isDemo ? 'Illustrative (demo) account: simulated entries, no real money.' : undefined}
        actions={<><Button size="sm" variant="secondary" loading={assess.isPending} onClick={() => assess.mutate()}>Assess fees</Button><Button size="sm" variant="secondary" onClick={() => setEntryOpen(true)}>Record entry</Button><Button size="sm" variant="secondary" onClick={() => setInvoiceOpen(true)}>Issue invoice</Button><Button size="sm" onClick={() => setStatementOpen(true)}>Statement</Button></>}>
        <KeyValue cols={3} items={[
          { label: 'Balance', value: <span className="text-lg font-semibold">{usd(t.balance)}</span> },
          { label: 'Standing', value: <Badge tone={STANDING_TONE[account.standing]}>{titleCase(account.standing)}</Badge> },
          { label: 'Next deadline', value: account.deadlines.next ? `${fmtDate(account.deadlines.next.dueDate)} · ${usd(account.deadlines.next.amount)}` : '—' },
          { label: 'Assessed charges', value: usd(t.charges) },
          { label: 'Payments', value: usd(t.payments) },
          { label: 'Scholarships & credits', value: usd(t.credits) },
          { label: 'Refunds', value: usd(t.refunds) },
          { label: 'Adjustments', value: usd(t.adjustments) },
          { label: 'Account status', value: <Badge status={account.status} /> },
        ]} />
        {account.deadlines.overdue.length > 0 && <Alert tone="warning" className="mt-3" title="Past due">{account.deadlines.overdue.map((d) => `${d.label} (${fmtDate(d.dueDate)})`).join(', ')}</Alert>}
      </Card>
      <Card title="Ledger" subtitle="Newest first. Reversed entries stay on the ledger; their reversal cancels them." padded={false}>
        <DataTable dense rows={entries} empty={<Empty title="No entries" description="Assess fees to post the term's charges." />} columns={[
          { key: 'effectiveDate', header: 'Date', render: (e) => fmtDate(e.effectiveDate) },
          { key: 'reference', header: 'Reference', render: (e) => <span className="font-mono text-xs">{e.reference}</span> },
          { key: 'type', header: 'Type', render: (e) => <Badge tone={TYPE_TONE[e.type]}>{titleCase(e.type)}</Badge> },
          { key: 'description', header: 'Description', render: (e) => <span>{e.description}{e.method ? <span className="text-slate-500"> · {e.method}</span> : null}{e.isDemo && <Badge tone="slate" className="ml-1">Demo</Badge>}{e.status === 'REVERSED' && <Badge tone="red" className="ml-1">Reversed by {e.reversedBy}</Badge>}</span> },
          { key: 'amount', header: 'Amount', align: 'right', render: (e) => <span className={Number(e.signedAmount) < 0 ? 'text-emerald-700' : ''}>{Number(e.signedAmount) < 0 ? '−' : ''}{usd(e.amount)}</span> },
          { key: 'act', header: '', align: 'right', render: (e) => e.type !== 'REVERSAL' && e.status !== 'REVERSED' && <Button size="sm" variant="ghost" onClick={() => setReversing(e)}>Reverse</Button> },
        ]} />
      </Card>
      {account.invoices.length > 0 && (
        <Card title="Invoices" padded={false}>
          <DataTable dense rows={account.invoices} columns={[
            { key: 'number', header: 'Invoice', render: (i) => <span className="font-mono text-xs">{i.number}</span> },
            { key: 'issuedAt', header: 'Issued', render: (i) => fmtDate(i.issuedAt) },
            { key: 'dueDate', header: 'Due', render: (i) => fmtDate(i.dueDate) },
            { key: 'lines', header: 'Lines', render: (i) => i.lines.length },
            { key: 'total', header: 'Total', align: 'right', render: (i) => usd(i.total) },
          ]} />
        </Card>
      )}
      <EntryModal open={entryOpen} onClose={() => setEntryOpen(false)} account={account} />
      <InvoiceModal open={invoiceOpen} onClose={() => setInvoiceOpen(false)} account={account} />
      <StatementModal open={statementOpen} onClose={() => setStatementOpen(false)} accountId={account.id} />
      <ConfirmDialog open={!!reversing} onClose={() => setReversing(null)} onConfirm={() => reverse.mutate()} loading={reverse.isPending} title="Reverse this entry?" confirmLabel="Post reversal" tone="danger">
        <p className="text-sm text-slate-600">{reversing && `${titleCase(reversing.type)} ${reversing.reference} of ${usd(reversing.amount)} will be cancelled by an equal and opposite reversal. The original stays on the ledger.`}</p>
        <ApiErrorDetails error={reverse.error} />
        <Field label="Reason" required><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} /></Field>
      </ConfirmDialog>
    </>
  );
}

function EntryModal({ open, onClose, account }) {
  const blank = () => ({ type: 'PAYMENT', direction: 'CREDIT', amount: '', description: '', method: '', externalRef: '', effectiveDate: '', isDemo: account.isDemo, idempotencyKey: newKey() });
  const [f, setF] = useState(blank);
  const post = useAction((body) => api.post(`/admin/finance/accounts/${account.id}/entries`, body), { invalidate: ['/admin/finance'], success: (res) => (res.data.replayed ? 'Already recorded' : `Recorded ${res.data.entry.reference}`), onSuccess: () => { setF(blank()); onClose(); }, toastErrors: false });
  const body = { type: f.type, amount: f.amount, description: f.description, ...(f.type === 'ADJUSTMENT' ? { direction: f.direction } : {}), ...(f.method ? { method: f.method } : {}), ...(f.externalRef ? { externalRef: f.externalRef } : {}), ...(f.effectiveDate ? { effectiveDate: f.effectiveDate } : {}), isDemo: f.isDemo, idempotencyKey: f.idempotencyKey };
  return (
    <Modal open={open} onClose={onClose} title="Record an entry" description="Payments received, scholarships and other credits, refunds, or adjustments. Charges come from assessing fees."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={post.isPending} disabled={!f.amount || f.description.trim().length < 3} onClick={() => post.mutate(body)}>Record</Button></>}>
      <ApiErrorDetails error={post.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type" required><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} options={[{ value: 'PAYMENT', label: 'Payment received' }, { value: 'CREDIT', label: 'Scholarship / credit' }, { value: 'REFUND', label: 'Refund paid out' }, { value: 'ADJUSTMENT', label: 'Adjustment' }]} /></Field>
        {f.type === 'ADJUSTMENT' && <Field label="Direction" required><Select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })} options={[{ value: 'DEBIT', label: 'Increase the balance (debit)' }, { value: 'CREDIT', label: 'Decrease the balance (credit)' }]} /></Field>}
        <Field label="Amount (USD)" required><Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="1250.00" /></Field>
        <Field label="Effective date"><Input type="date" value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} /></Field>
        <Field label="Description" required className="sm:col-span-2"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={200} /></Field>
        {['PAYMENT', 'REFUND'].includes(f.type) && <Field label="Method"><Input value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} placeholder="Bank transfer, cheque…" maxLength={60} /></Field>}
        <Field label="External reference"><Input value={f.externalRef} onChange={(e) => setF({ ...f, externalRef: e.target.value })} maxLength={100} /></Field>
      </div>
      <Checkbox label="Illustrative (demo) entry" description="Simulated; never real money." checked={f.isDemo} onChange={(v) => setF({ ...f, isDemo: v })} />
    </Modal>
  );
}

function InvoiceModal({ open, onClose, account }) {
  const [due, setDue] = useState(account.dueDate ?? '');
  const issue = useAction(() => api.post(`/admin/finance/accounts/${account.id}/invoices`, due ? { dueDate: due } : {}), { invalidate: ['/admin/finance'], success: (res) => `Issued ${res.data.invoice.number}`, onSuccess: onClose, toastErrors: false });
  return (
    <Modal open={open} onClose={onClose} title="Issue an invoice" description="Bundles every charge not yet on an invoice."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={issue.isPending} onClick={() => issue.mutate()}>Issue invoice</Button></>}>
      <ApiErrorDetails error={issue.error} />
      <Field label="Due date" required><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
    </Modal>
  );
}

function StatementModal({ open, onClose, accountId }) {
  const { data, isLoading, error } = useApi(open ? `/admin/finance/accounts/${accountId}/statement` : null);
  const st = data?.data;
  return (
    <Modal open={open} onClose={onClose} size="lg" title="Statement of account" description={st ? `${st.account.student.name} · ${st.account.student.studentNumber} · ${st.account.term.name} · generated ${fmtDateTime(st.generatedAt)}` : undefined}
      footer={<><Button variant="secondary" onClick={() => window.print()}>Print</Button><Button onClick={onClose}>Close</Button></>}>
      {error ? <ErrorState error={error} /> : isLoading || !st ? <p className="text-sm text-slate-500">Loading…</p> : (
        <>
          {st.account.isDemo && <Alert tone="info" title="Illustrative account">Simulated entries for demonstration; no money has been charged or received.</Alert>}
          <DataTable dense rows={st.lines} columns={[
            { key: 'effectiveDate', header: 'Date', render: (e) => fmtDate(e.effectiveDate) },
            { key: 'reference', header: 'Reference', render: (e) => <span className="font-mono text-xs">{e.reference}</span> },
            { key: 'description', header: 'Description' },
            { key: 'amount', header: 'Amount', align: 'right', render: (e) => `${Number(e.signedAmount) < 0 ? '−' : ''}${usd(e.amount)}` },
            { key: 'runningBalance', header: 'Balance', align: 'right', render: (e) => usd(e.runningBalance) },
          ]} />
          <p className="mt-3 text-right text-sm font-semibold">Balance due: {usd(st.account.totals.balance)}{st.account.deadlines.next ? ` by ${fmtDate(st.account.deadlines.next.dueDate)}` : ''}</p>
        </>
      )}
    </Modal>
  );
}

/* ───────────────────────────── fee catalogue ───────────────────────────── */

function Fees() {
  const { data, isLoading, error, refetch } = useApi('/admin/finance/fees');
  const terms = useApi('/terms');
  const [adding, setAdding] = useState(false);
  const blank = { code: '', name: '', category: 'TUITION', basis: 'FLAT', amount: '', termId: '', description: '' };
  const [f, setF] = useState(blank);
  const create = useAction((body) => api.post('/admin/finance/fees', body), { invalidate: ['/admin/finance'], success: 'Fee added', onSuccess: () => { setAdding(false); setF(blank); }, toastErrors: false });
  const toggle = useAction((fee) => api.patch(`/admin/finance/fees/${fee.id}`, { active: !fee.active }), { invalidate: ['/admin/finance'], success: 'Fee updated' });
  return (
    <Card title="Fee catalogue" subtitle="Changing a fee affects future assessments only; posted charges never change." padded={false} actions={<Button size="sm" onClick={() => setAdding(true)}>Add fee</Button>}>
      {error ? <ErrorState error={error} retry={refetch} /> : (
        <DataTable loading={isLoading} rows={data?.data} empty={<Empty title="No fees configured" description="Add the institution's tuition and fees to assess them to student accounts." />} columns={[
          { key: 'code', header: 'Code', render: (x) => <span className="font-mono text-xs">{x.code}</span> },
          { key: 'name', header: 'Name', render: (x) => <span>{x.name}{x.isDemo && <Badge tone="slate" className="ml-1">Demo</Badge>}</span> },
          { key: 'category', header: 'Category', render: (x) => titleCase(x.category) },
          { key: 'amount', header: 'Amount', align: 'right', render: (x) => `${usd(x.amount)}${x.basis === 'PER_CREDIT' ? ' / credit' : ''}` },
          { key: 'term', header: 'Term', render: (x) => x.term?.code ?? 'Every term' },
          { key: 'active', header: 'Status', render: (x) => <Badge tone={x.active ? 'green' : 'slate'}>{x.active ? 'Active' : 'Inactive'}</Badge> },
          { key: 'act', header: '', align: 'right', render: (x) => <Button size="sm" variant="ghost" onClick={() => toggle.mutate(x)}>{x.active ? 'Deactivate' : 'Activate'}</Button> },
        ]} />
      )}
      <Modal open={adding} onClose={() => setAdding(false)} title="Add a fee"
        footer={<><Button variant="secondary" onClick={() => setAdding(false)}>Cancel</Button><Button loading={create.isPending} disabled={!f.code || !f.name || !f.amount} onClick={() => create.mutate({ ...f, termId: f.termId || null, description: f.description || undefined })}>Add fee</Button></>}>
        <ApiErrorDetails error={create.error} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Code" required hint="Capitals, digits, - or _"><Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} maxLength={30} /></Field>
          <Field label="Name" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} /></Field>
          <Field label="Category" required><Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} options={CATEGORIES.map((c) => ({ value: c, label: titleCase(c) }))} /></Field>
          <Field label="Basis" required><Select value={f.basis} onChange={(e) => setF({ ...f, basis: e.target.value })} options={[{ value: 'FLAT', label: 'Flat, per term' }, { value: 'PER_CREDIT', label: 'Per registered credit' }]} /></Field>
          <Field label="Amount (USD)" required><Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="350.00" /></Field>
          <Field label="Term"><Select value={f.termId} onChange={(e) => setF({ ...f, termId: e.target.value })} placeholder="Every term" options={(terms.data?.data ?? []).map((t) => ({ value: t.id, label: `${t.name} (${t.code})` }))} /></Field>
          <Field label="Description" className="sm:col-span-2"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={500} /></Field>
        </div>
      </Modal>
    </Card>
  );
}
