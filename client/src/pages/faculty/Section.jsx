import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Send, Save, CheckCheck } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApi, useAction } from '../../lib/hooks.js';
import { fmtDate, meetingText, titleCase } from '../../lib/format.js';
import { PageHeader, Card, Spinner, Empty, Badge, Button, Tabs, DataTable, Input, Select, Field, Textarea, Modal, ConfirmDialog, Alert, ApiErrorDetails, ErrorState, cx } from '../../components/ui.jsx';

export default function FacultySection() {
  const { id } = useParams();
  const [tab, setTab] = useState('roster');
  const { data, isLoading, error } = useApi(`/faculty/sections/${id}`);
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <Spinner />;
  const { section, roster } = data.data;
  const active = roster.filter((r) => ['REGISTERED', 'COMPLETED'].includes(r.status));
  return (
    <>
      <PageHeader back={{ to: '/faculty', label: 'My sections' }} eyebrow={`${section.termCode} · ${section.course.code}-${section.sectionNumber}`} title={section.course.title}
        subtitle={`${meetingText(section.meetings)} · ${section.location ?? 'TBA'} · ${section.course.credits} credits`} />
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'roster', label: 'Roster', count: active.length },
        { value: 'attendance', label: 'Attendance' },
        { value: 'grades', label: 'Grades' },
        { value: 'announce', label: 'Announcements' },
      ]} />
      {tab === 'roster' && <Roster roster={roster} />}
      {tab === 'attendance' && <Attendance sectionId={id} section={section} />}
      {tab === 'grades' && <Gradebook sectionId={id} />}
      {tab === 'announce' && <Announce sectionId={id} />}
    </>
  );
}

function Roster({ roster }) {
  return (
    <Card padded={false}>
      <DataTable rows={roster} rowKey={(r) => r.registrationId} empty={<Empty title="No students registered" />} columns={[
        { key: 'name', header: 'Student', render: (r) => <div><div className="font-medium text-slate-900">{r.student.name}</div><div className="text-xs text-slate-500">{r.student.email}</div></div> },
        { key: 'id', header: 'Student ID', render: (r) => <span className="mono">{r.student.studentNumber}</span> },
        { key: 'program', header: 'Program', render: (r) => r.student.program ?? '—' },
        { key: 'level', header: 'Level', render: (r) => titleCase(r.student.classLevel) },
        { key: 'status', header: 'Status', render: (r) => <Badge status={r.status}>{r.status === 'WAITLISTED' ? `Waitlist #${r.waitlistPosition}` : undefined}</Badge> },
      ]} />
    </Card>
  );
}

const STATUSES = [['PRESENT', 'P', 'bg-emerald-600'], ['LATE', 'L', 'bg-amber-500'], ['ABSENT', 'A', 'bg-red-600'], ['EXCUSED', 'E', 'bg-slate-500']];

function lastMeetingDate(meetingDays) {
  const d = new Date();
  for (let i = 0; i < 8; i++) {
    const dow = ((d.getDay() + 6) % 7) + 1;
    if (!meetingDays.length || meetingDays.includes(dow)) break;
    d.setDate(d.getDate() - 1);
  }
  return d.toLocaleDateString('en-CA');
}

function Attendance({ sectionId }) {
  const [date, setDate] = useState(null);
  const { data: base } = useApi(`/faculty/sections/${sectionId}/attendance`);
  useEffect(() => { if (base && !date) setDate(lastMeetingDate(base.data.section.meetingDays)); }, [base, date]);
  const { data, isLoading, error } = useApi(date ? `/faculty/sections/${sectionId}/attendance?date=${date}` : null);
  const [marks, setMarks] = useState({});
  useEffect(() => { if (data) setMarks(Object.fromEntries(data.data.rows.map((r) => [r.student.id, r.status ?? '']))); }, [data]);
  const save = useAction(() => api.put(`/faculty/sections/${sectionId}/attendance`, { date, records: Object.entries(marks).filter(([, s]) => s).map(([studentId, status]) => ({ studentId, status })) }), {
    invalidate: [`/faculty/sections/${sectionId}/attendance`, '/faculty/dashboard'], success: (r) => `Attendance saved for ${r.data.recorded} students`, toastErrors: false,
  });
  if (error) return <ErrorState error={error} />;
  if (!data || isLoading) return <Spinner />;
  const recorded = data.data.recordedDates.includes(date);
  const unmarked = data.data.rows.filter((r) => !marks[r.student.id]).length;
  const today = new Date().toLocaleDateString('en-CA');
  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card className="xl:col-span-2" title="Take attendance" padded={false}
        actions={<div className="flex items-center gap-2"><Input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} className="w-40" aria-label="Class date" />{recorded ? <Badge tone="green">Recorded</Badge> : <Badge tone="amber">Not recorded</Badge>}</div>}
        footer={<div className="flex flex-wrap items-center justify-between gap-2"><Button variant="ghost" icon={CheckCheck} onClick={() => setMarks(Object.fromEntries(data.data.rows.map((r) => [r.student.id, marks[r.student.id] || 'PRESENT'])))}>Mark remaining present</Button><div className="flex items-center gap-3"><span className="text-[13px] text-slate-500">{unmarked} unmarked</span><Button icon={Save} loading={save.isPending} disabled={unmarked === data.data.rows.length} onClick={() => save.mutate()}>Save attendance</Button></div></div>}>
        {save.error && <div className="p-4 pb-0"><ApiErrorDetails error={save.error} /></div>}
        {!data.data.rows.length ? <Empty title="No students on the roster" /> : (
          <ul className="divide-y divide-slate-100">
            {data.data.rows.map((r) => (
              <li key={r.student.id} className="flex items-center justify-between gap-3 px-5 py-2.5">
                <div className="min-w-0"><div className="truncate text-sm font-medium text-slate-900">{r.student.name}</div><div className="text-xs text-slate-500">{r.summary.rate != null ? `${r.summary.rate}% attendance (${r.summary.attended}/${r.summary.total})` : 'No records yet'}</div></div>
                <div className="flex gap-1" role="radiogroup" aria-label={`Attendance for ${r.student.name}`}>
                  {STATUSES.map(([s, short, color]) => (
                    <button key={s} role="radio" aria-checked={marks[r.student.id] === s} title={titleCase(s)} onClick={() => setMarks({ ...marks, [r.student.id]: s })}
                      className={cx('size-8 rounded-md text-xs font-semibold transition', marks[r.student.id] === s ? `${color} text-white shadow-sm` : 'bg-slate-100 text-slate-500 hover:bg-slate-200')}>{short}</button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Recorded class dates" subtitle={`${data.data.recordedDates.length} sessions`}>
        {!data.data.recordedDates.length ? <Empty title="No sessions recorded" /> : (
          <div className="flex flex-wrap gap-1.5">
            {[...data.data.recordedDates].reverse().map((d) => <button key={d} onClick={() => setDate(d)} className={cx('rounded-md px-2 py-1 text-xs tabular-nums', d === date ? 'bg-ink-900 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200')}>{fmtDate(d, { month: 'short', day: 'numeric' })}</button>)}
          </div>
        )}
        <p className="mt-4 text-xs text-slate-500">Attendance can be recorded or corrected within the edit window set by institutional policy. Older corrections must be made by the Registrar.</p>
      </Card>
    </div>
  );
}

function Gradebook({ sectionId }) {
  const { data, isLoading, error } = useApi(`/faculty/sections/${sectionId}/grades`);
  const [edits, setEdits] = useState({});
  const [confirm, setConfirm] = useState(false);
  const [change, setChange] = useState(null);
  const inv = [`/faculty/sections/${sectionId}/grades`, '/faculty/dashboard', '/faculty/grade-changes'];
  const save = useAction(() => api.put(`/faculty/sections/${sectionId}/grades`, { grades: Object.entries(edits).map(([registrationId, letter]) => ({ registrationId, letter })) }), { invalidate: inv, success: 'Draft grades saved', onSuccess: () => setEdits({}), toastErrors: false });
  const submit = useAction(() => api.post(`/faculty/sections/${sectionId}/grades/submit`), { invalidate: inv, success: 'Grades submitted to the Registrar', onSuccess: () => setConfirm(false), toastErrors: false });
  const rows = useMemo(() => data?.data.rows ?? [], [data]);
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <Spinner />;
  const gb = data.data;
  const editable = (r) => r.registrationStatus === 'REGISTERED' && (!r.grade || ['DRAFT', 'RETURNED'].includes(r.grade.status));
  const dirty = Object.keys(edits).length > 0;
  const canSubmit = rows.some((r) => r.grade && ['DRAFT', 'RETURNED'].includes(r.grade.status));
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-[13px]">
        {Object.entries(gb.counts).filter(([, v]) => v > 0).map(([k, v]) => <Badge key={k} status={k}>{titleCase(k)}: {v}</Badge>)}
        <span className="text-slate-500">· Grades due {fmtDate(gb.section.gradesDueDate)}</span>
      </div>
      {rows.some((r) => r.grade?.status === 'RETURNED') && <Alert tone="warn" className="mb-4" title="Grades returned by the Registrar">Review the returned grades, correct them and resubmit.</Alert>}
      <Card padded={false} footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {dirty && <span className="mr-auto text-[13px] text-amber-700">{Object.keys(edits).length} unsaved change(s)</span>}
          <Button variant="secondary" icon={Save} disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>Save drafts</Button>
          <Button icon={Send} disabled={dirty || !canSubmit} onClick={() => setConfirm(true)}>Submit for approval</Button>
        </div>}>
        {(save.error || submit.error) && <div className="p-4 pb-0"><ApiErrorDetails error={save.error || submit.error} /></div>}
        <DataTable rows={rows} rowKey={(r) => r.registrationId} empty={<Empty title="No students to grade" />} columns={[
          { key: 'student', header: 'Student', render: (r) => <div><div className="font-medium text-slate-900">{r.student.name}</div><div className="mono text-slate-500">{r.student.studentNumber}</div></div> },
          { key: 'grade', header: 'Final grade', render: (r) => r.registrationStatus === 'WITHDRAWN' ? <span className="text-slate-400">W (withdrawn)</span> : editable(r) ? (
            <Select aria-label={`Grade for ${r.student.name}`} className={cx('w-28', edits[r.registrationId] && 'border-amber-400 bg-amber-50')} value={edits[r.registrationId] ?? r.grade?.letter ?? ''} placeholder="—"
              onChange={(e) => { const v = e.target.value; setEdits((x) => { const n = { ...x }; if (!v || v === r.grade?.letter) delete n[r.registrationId]; else n[r.registrationId] = v; return n; }); }}
              options={gb.letters.filter((l) => l.letter !== 'W').map((l) => ({ value: l.letter, label: l.letter }))} />
          ) : <span className="text-base font-semibold text-slate-900">{r.grade?.letter}</span> },
          { key: 'status', header: 'Status', render: (r) => r.grade ? <Badge status={r.grade.status} /> : r.registrationStatus === 'WITHDRAWN' ? <Badge status="WITHDRAWN" /> : <Badge tone="slate">Not entered</Badge> },
          { key: 'actions', header: '', align: 'right', render: (r) => r.grade?.status === 'PUBLISHED' && (r.grade.pendingChange ? <Badge tone="amber">Change pending</Badge> : <Button size="sm" variant="ghost" onClick={() => setChange(r)}>Request change</Button>) },
        ]} />
      </Card>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => submit.mutate()} loading={submit.isPending} tone="primary" confirmLabel="Submit grades" title="Submit grades for approval?">
        <p>Every student on the active roster must have a grade. After submission you can no longer edit these grades unless the Registrar returns them.</p>
      </ConfirmDialog>
      <ChangeRequest row={change} letters={gb.letters} onClose={() => setChange(null)} invalidate={inv} />
    </>
  );
}

function ChangeRequest({ row, letters, onClose, invalidate }) {
  const [toLetter, setToLetter] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => { setToLetter(''); setReason(''); }, [row]);
  const req = useAction(() => api.post('/faculty/grade-changes', { gradeId: row.grade.id, toLetter, reason }), { invalidate, success: 'Grade change request sent to the Registrar', onSuccess: onClose, toastErrors: false });
  return (
    <Modal open={!!row} onClose={onClose} title="Request a grade change" description={row && `${row.student.name} · current grade ${row.grade.letter}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => req.mutate()} loading={req.isPending} disabled={!toLetter || reason.trim().length < 10}>Submit request</Button></>}>
      <div className="space-y-4">
        <ApiErrorDetails error={req.error} />
        <Field label="New grade" required><Select value={toLetter} onChange={(e) => setToLetter(e.target.value)} placeholder="Select…" options={letters.filter((l) => l.letter !== row?.grade.letter).map((l) => ({ value: l.letter, label: l.letter }))} /></Field>
        <Field label="Reason" required hint="At least 10 characters. This becomes part of the permanent record."><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} /></Field>
      </div>
    </Modal>
  );
}

function Announce({ sectionId }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const { data } = useApi('/announcements');
  const post = useAction(() => api.post(`/faculty/sections/${sectionId}/announcements`, { title, body }), { invalidate: ['/announcements'], success: 'Announcement posted to your class', onSuccess: () => { setTitle(''); setBody(''); }, toastErrors: false });
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Post to this class" footer={<div className="flex justify-end"><Button icon={Send} onClick={() => post.mutate()} loading={post.isPending} disabled={title.trim().length < 3 || body.trim().length < 3}>Post announcement</Button></div>}>
        <div className="space-y-4">
          <ApiErrorDetails error={post.error} />
          <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={150} /></Field>
          <Field label="Message"><Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} maxLength={5000} /></Field>
        </div>
      </Card>
      <Card title="Recent announcements" padded={false}>
        {!data?.data.length ? <Empty title="No announcements" /> : (
          <ul className="divide-y divide-slate-100">{data.data.slice(0, 8).map((a) => <li key={a.id} className="px-5 py-3"><div className="text-sm font-medium text-slate-900">{a.title} {a.section && <Badge tone="ink" className="ml-1">{a.section}</Badge>}</div><div className="text-xs text-slate-500">{a.author} · {fmtDate(a.publishedAt)}</div></li>)}</ul>
        )}
      </Card>
    </div>
  );
}
