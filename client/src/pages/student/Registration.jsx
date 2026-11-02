import { useState } from 'react';
import { CheckCircle2, XCircle, Clock } from 'lucide-react';
import { api, qs } from '../../lib/api.js';
import { useApi, useAction } from '../../lib/hooks.js';
import { fmtDate, meetingText } from '../../lib/format.js';
import { PageHeader, Card, Spinner, Empty, Badge, Button, Select, SearchInput, Tabs, ConfirmDialog, Alert, Field, Input, ErrorState, cx } from '../../components/ui.jsx';

export default function StudentRegistration() {
  const [tab, setTab] = useState('search');
  return (
    <>
      <PageHeader title="Registration" subtitle="Search for classes, check eligibility, and manage your registrations." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'search', label: 'Class search' }, { value: 'mine', label: 'My registrations' }]} />
      {tab === 'search' ? <ClassSearch /> : <MyRegistrations />}
    </>
  );
}

function ClassSearch() {
  const { data: lookups } = useApi('/lookups');
  const [termId, setTermId] = useState('');
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const { data, isLoading, error } = useApi(`/student/class-search${qs({ termId, search, departmentId })}`);
  const add = useAction((sectionId) => api.post('/student/registrations', { sectionId }), {
    invalidate: ['/student'],
    success: (r) => (r.data.status === 'WAITLISTED' ? `Added to the waitlist (position #${r.data.waitlistPosition})` : 'Registered successfully'),
  });
  const term = data?.data.term;
  const now = new Date();
  const windowOpen = term && new Date(term.registrationOpens) <= now && now <= new Date(term.registrationCloses);
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select aria-label="Term" value={termId || term?.id || ''} onChange={(e) => setTermId(e.target.value)} options={(lookups?.data.terms ?? []).filter((t) => t.status !== 'COMPLETED').map((t) => ({ value: t.id, label: t.name }))} className="w-48" />
        <Select aria-label="Department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} placeholder="All departments" options={(lookups?.data.departments ?? []).map((d) => ({ value: d.id, label: d.name }))} className="w-56" />
        <SearchInput value={search} onChange={setSearch} placeholder="Course code or title" />
      </div>
      {term && <Alert tone={windowOpen ? 'info' : 'warn'} className="mb-4">Registration for <strong>{term.name}</strong> {windowOpen ? 'is open until' : 'is closed. Window:'} {windowOpen ? fmtDate(term.registrationCloses) : `${fmtDate(term.registrationOpens)} – ${fmtDate(term.registrationCloses)}`}.</Alert>}
      {error ? <ErrorState error={error} /> : isLoading ? <Spinner label="Checking eligibility…" /> : !data.data.sections.length ? <Card><Empty title="No sections match" description="Try a different search or department." /></Card> : (
        <div className="grid gap-3 lg:grid-cols-2">
          {data.data.sections.map((s) => {
            const v = s.eligibility.violations;
            const enrolled = v.some((x) => x.code === 'already_registered' || x.code === 'already_waitlisted');
            return (
              <div key={s.id} className={cx('card flex flex-col p-4', enrolled && 'ring-1 ring-emerald-300')}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900">{s.course.code}-{s.sectionNumber} <span className="font-normal text-slate-500">· {s.course.credits} cr</span></div>
                    <div className="text-[15px] font-medium text-slate-800">{s.course.title}</div>
                  </div>
                  <div className="text-right text-xs tabular-nums text-slate-500 shrink-0"><div className={s.seatsAvailable ? 'text-emerald-700 font-semibold' : 'text-amber-700 font-semibold'}>{s.seatsAvailable} seats left</div><div>{s.enrolled}/{s.capacity}{s.waitlisted ? ` · ${s.waitlisted} waitlisted` : ''}</div></div>
                </div>
                <div className="mt-2 text-[13px] text-slate-600">{meetingText(s.meetings)} · {s.location ?? 'TBA'} · {s.instructors.map((i) => i.name).join(', ') || 'Staff'}</div>
                {s.description && <p className="mt-2 line-clamp-2 text-[13px] text-slate-500">{s.description}</p>}
                <div className="mt-3 flex-1">
                  {enrolled ? <p className="flex items-center gap-1.5 text-[13px] font-medium text-emerald-700"><CheckCircle2 className="size-4" />{v.find((x) => x.code.startsWith('already')).message}</p>
                    : v.length ? <ul className="space-y-1">{v.map((x) => <li key={x.code + x.message} className="flex items-start gap-1.5 text-[13px] text-red-700"><XCircle className="mt-0.5 size-3.5 shrink-0" />{x.message}</li>)}</ul>
                    : s.eligibility.outcome === 'WAITLISTED' ? <p className="flex items-center gap-1.5 text-[13px] text-amber-700"><Clock className="size-4" />Section full — you can join the waitlist.</p>
                    : <p className="flex items-center gap-1.5 text-[13px] text-emerald-700"><CheckCircle2 className="size-4" />You are eligible to register.</p>}
                </div>
                {!enrolled && (
                  <div className="mt-3 flex justify-end">
                    <Button size="sm" variant={s.eligibility.outcome === 'WAITLISTED' ? 'secondary' : 'primary'} disabled={v.length > 0} loading={add.isPending && add.variables === s.id} onClick={() => add.mutate(s.id)}>
                      {s.eligibility.outcome === 'WAITLISTED' ? 'Join waitlist' : 'Register'}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function MyRegistrations() {
  const { data, isLoading, error } = useApi('/student/registrations');
  const [target, setTarget] = useState(null);
  const [reason, setReason] = useState('');
  const drop = useAction(({ id, reason: r }) => api.post(`/student/registrations/${id}/drop`, { reason: r || undefined }), {
    invalidate: ['/student'], success: (r) => (r.data.status === 'WITHDRAWN' ? 'Withdrawn — a W will appear on your transcript' : 'Class dropped'), onSuccess: () => { setTarget(null); setReason(''); },
  });
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <Spinner />;
  const byTerm = {};
  for (const r of data.data) (byTerm[r.term.name] ??= []).push(r);
  if (!data.data.length) return <Card><Empty title="No registrations yet" /></Card>;
  return (
    <div className="space-y-5">
      {Object.entries(byTerm).map(([termName, regs]) => (
        <Card key={termName} title={termName} padded={false} subtitle={`${regs.filter((r) => r.status === 'REGISTERED' || r.status === 'COMPLETED').reduce((s, r) => s + r.credits, 0)} credits`}>
          <ul className="divide-y divide-slate-100">
            {regs.map((r) => (
              <li key={r.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="font-medium text-slate-900">{r.section.course.code}-{r.section.sectionNumber} · {r.section.course.title}</div>
                  <div className="text-[13px] text-slate-500">{meetingText(r.section.meetings)} · {r.credits} cr · added {fmtDate(r.registeredAt)} via {r.source.replace('_', ' ').toLowerCase()}</div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge status={r.status}>{r.status === 'WAITLISTED' ? `Waitlist #${r.waitlistPosition}` : undefined}</Badge>
                  {r.canDrop && <Button size="sm" variant="subtleDanger" onClick={() => setTarget(r)}>{r.dropWillWithdraw ? 'Withdraw' : 'Drop'}</Button>}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ))}
      <ConfirmDialog open={!!target} onClose={() => setTarget(null)} loading={drop.isPending} title={target?.dropWillWithdraw ? 'Withdraw from class?' : 'Drop class?'} confirmLabel={target?.dropWillWithdraw ? 'Withdraw' : 'Drop class'}
        onConfirm={() => drop.mutate({ id: target.id, reason })}>
        <p><strong>{target?.section.course.code} · {target?.section.course.title}</strong></p>
        {target?.dropWillWithdraw ? <Alert tone="warn">The add/drop deadline has passed. Withdrawing records a <strong>W</strong> on your transcript. It does not affect your GPA.</Alert> : <p>The class will be removed from your schedule. If you were registered, your seat may be offered to a waitlisted student.</p>}
        <Field label="Reason (optional)"><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
      </ConfirmDialog>
    </div>
  );
}
