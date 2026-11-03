import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Pencil, ShieldAlert, ListPlus, ScrollText, ArrowRightLeft, KeyRound, Printer } from 'lucide-react';
import { api, qs } from '../../lib/api.js';
import { useApi, useAction } from '../../lib/hooks.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDate, fmtDateTime, gpa, meetingText, titleCase } from '../../lib/format.js';
import { PageHeader, Card, Spinner, Badge, Button, Tabs, KeyValue, DataTable, Modal, Field, Input, Select, Textarea, Checkbox, ConfirmDialog, ApiErrorDetails, Alert, Empty, SecretBox, SearchInput, ErrorState } from '../../components/ui.jsx';
import { DegreeAudit } from '../student/Progress.jsx';
import TranscriptView from '../../components/TranscriptView.jsx';
import WeeklySchedule from '../../components/WeeklySchedule.jsx';
import UniversityAccountCard from './UniversityAccount.jsx';

export default function StudentDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data, isLoading, error } = useApi(`/admin/students/${id}`);
  const [tab, setTab] = useState('overview');
  const [modal, setModal] = useState(null);
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <Spinner />;
  const s = data.data;
  const activeHolds = s.holds.filter((h) => !h.releasedAt);
  return (
    <>
      <PageHeader back={{ to: '/admin/students', label: 'Students' }} eyebrow={`Student ID ${s.studentNumber}`} title={`${s.firstName} ${s.lastName}${s.preferredName ? ` (${s.preferredName})` : ''}`}
        subtitle={<span className="flex flex-wrap items-center gap-2"><Badge status={s.status} /><Badge status={s.academicStanding} /><span>{s.program ? `${s.program.degreeType} ${s.program.name}` : 'Undeclared'} · {titleCase(s.classLevel)}</span>{activeHolds.length > 0 && <Badge tone="red">{activeHolds.length} active hold{activeHolds.length > 1 ? 's' : ''}</Badge>}</span>}
        actions={<>
          <Button variant="secondary" icon={ScrollText} onClick={() => setModal('transcript')}>Transcript</Button>
          <Button variant="secondary" icon={ShieldAlert} onClick={() => setModal('hold')}>Place hold</Button>
          <Button variant="secondary" icon={ArrowRightLeft} onClick={() => setModal('status')} disabled={!s.allowedTransitions.length}>Change status</Button>
          {can('registrations.manage') && <Button icon={ListPlus} onClick={() => setModal('register')}>Register</Button>}
        </>} />
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'overview', label: 'Overview' },
        { value: 'registrations', label: 'Registrations', count: s.registrations.filter((r) => ['REGISTERED', 'WAITLISTED'].includes(r.status)).length },
        { value: 'schedule', label: 'Schedule' },
        { value: 'record', label: 'Academic record' },
        { value: 'holds', label: 'Holds', count: activeHolds.length },
        { value: 'documents', label: 'Documents', count: s.documents.length },
      ]} />
      {tab === 'overview' && <Overview s={s} onEdit={() => setModal('edit')} onLogin={() => setModal('login')} canCreateLogin={can('users.manage')} />}
      {tab === 'registrations' && <Registrations s={s} />}
      {tab === 'schedule' && <Schedule s={s} />}
      {tab === 'record' && <Record s={s} />}
      {tab === 'holds' && <Holds s={s} />}
      {tab === 'documents' && <Card padded={false}><DataTable rows={s.documents} empty={<Empty title="No document requests" />} columns={[
        { key: 'type', header: 'Document', render: (r) => titleCase(r.type) }, { key: 'recipient', header: 'Recipient' }, { key: 'createdAt', header: 'Requested', render: (r) => fmtDate(r.createdAt) }, { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
      ]} /></Card>}
      <EditStudent open={modal === 'edit'} s={s} onClose={() => setModal(null)} />
      <PlaceHold open={modal === 'hold'} s={s} onClose={() => setModal(null)} />
      <ChangeStatus open={modal === 'status'} s={s} onClose={() => setModal(null)} />
      <RegisterStudent open={modal === 'register'} s={s} onClose={() => setModal(null)} />
      <CreateLogin open={modal === 'login'} s={s} onClose={() => setModal(null)} />
      <TranscriptModal open={modal === 'transcript'} id={s.id} onClose={() => setModal(null)} />
    </>
  );
}

function Overview({ s, onEdit, onLogin, canCreateLogin }) {
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card title="Personal & contact" className="lg:col-span-2" actions={<Button size="sm" variant="secondary" icon={Pencil} onClick={onEdit}>Edit</Button>}>
        <KeyValue items={[
          ['Legal name', `${s.firstName} ${s.lastName}`], ['Preferred name', s.preferredName], ['Institution email', s.email], ['Personal email', s.personalEmail], ['Phone', s.phone], ['Date of birth', fmtDate(s.dateOfBirth)],
          ['Address', [s.addressLine, s.city, s.region, s.postalCode, s.country].filter(Boolean).join(', ') || null],
          ['Emergency contact', s.emergencyContactName ? `${s.emergencyContactName} (${s.emergencyContactRelation ?? '—'}) · ${s.emergencyContactPhone ?? ''}` : null],
        ]} />
      </Card>
      <div className="space-y-6">
        <Card title="Academic">
          <KeyValue cols={1} items={[
            ['Program', s.program ? `${s.program.degreeType} ${s.program.name} — ${s.program.department.name}` : 'Undeclared'], ['Admit term', s.admitTerm?.name], ['Expected graduation', s.expectedGraduation],
            ['Cumulative GPA', gpa(s.record.cumulativeGpa)], ['Credits earned / in progress', `${s.record.creditsEarned} / ${s.record.creditsInProgress}`],
            s.application && ['Application', `${s.application.applicationNumber} · submitted ${fmtDate(s.application.submittedAt)}`],
          ]} />
        </Card>
        <Card title="Portal account & references">
          <KeyValue cols={1} items={[
            ['Login', s.login ? <span>{s.login.email} <Badge status={s.login.status} /></span> : 'No portal login'], s.login && ['Last sign-in', fmtDateTime(s.login.lastLoginAt)],
            ['Bursar account', s.financialAccountRef], ['Financial aid', s.financialAidStatus],
          ]} />
          {!s.login && canCreateLogin && <Button size="sm" variant="secondary" icon={KeyRound} className="mt-4" onClick={onLogin}>Create portal login</Button>}
        </Card>
        <UniversityAccountCard personId={s.personId} />
      </div>
    </div>
  );
}

// Weekly timetable of the student's registered sections in one term, from the same registration
// records as the Registrations tab (sections carry their meeting times, rooms and instructors).
function Schedule({ s }) {
  const { data: termList } = useApi('/terms');
  const active = s.registrations.filter((r) => ['REGISTERED', 'WAITLISTED', 'COMPLETED'].includes(r.status));
  const terms = [...new Map(active.map((r) => [r.term.id, r.term])).values()];
  const current = termList?.data?.find((t) => t.isCurrent);
  const fallback = terms.some((t) => t.id === current?.id) ? current.id : terms[0]?.id ?? '';
  const [termId, setTermId] = useState('');
  const selected = termId || fallback;
  const inTerm = active.filter((r) => r.term.id === selected);
  const classes = inTerm.filter((r) => r.status !== 'WAITLISTED').map((r) => r.section);
  if (!terms.length) return <Card><Empty title="No registered classes" description="Use Register (top right) to register the student in sections; their timetable appears here." /></Card>;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Select aria-label="Term" value={selected} onChange={(e) => setTermId(e.target.value)} options={terms.map((t) => ({ value: t.id, label: `${t.name}${t.id === current?.id ? ' (current)' : ''}` }))} className="w-56" />
        {selected !== current?.id && current && <span className="text-xs text-slate-500">Not the current term ({current.name}).</span>}
      </div>
      <Card title="Week at a glance">{classes.length ? <WeeklySchedule classes={classes} /> : <Empty title="No registered classes this term" />}</Card>
      <Card padded={false} title="Classes">
        <DataTable rows={inTerm} rowKey={(r) => r.id} columns={[
          { key: 'course', header: 'Section', render: (r) => <div><div className="font-medium text-slate-900">{r.section.course.code}-{r.section.sectionNumber}</div><div className="text-xs text-slate-500">{r.section.course.title}</div></div> },
          { key: 'instructor', header: 'Instructor', render: (r) => r.section.instructors?.map((i) => i.name).join(', ') || 'TBA' },
          { key: 'meets', header: 'Meets', render: (r) => (r.section.meetings?.length ? <span className="text-[13px]">{meetingText(r.section.meetings)}</span> : <Badge tone="amber">No meeting times</Badge>) },
          { key: 'room', header: 'Room', render: (r) => [...new Set((r.section.meetings ?? []).map((m) => m.room).filter(Boolean))].join(', ') || r.section.location || 'TBA' },
          { key: 'status', header: 'Status', render: (r) => <Badge status={r.status}>{r.status === 'WAITLISTED' ? `Waitlist #${r.waitlistPosition}` : undefined}</Badge> },
        ]} />
      </Card>
    </div>
  );
}

function Registrations({ s }) {
  const [target, setTarget] = useState(null);
  const [reason, setReason] = useState('');
  const [history, setHistory] = useState(null);
  const drop = useAction(() => api.post(`/admin/registrations/${target.id}/drop`, { reason }), { invalidate: [`/admin/students/${s.id}`, '/admin/registrations'], success: (r) => `Registration ${r.data.status.toLowerCase()}`, onSuccess: () => { setTarget(null); setReason(''); }, toastErrors: false });
  const { data: hist } = useApi(history ? `/admin/registrations/${history.id}/history` : null);
  return (
    <Card padded={false}>
      <DataTable rows={s.registrations} empty={<Empty title="No registrations" />} columns={[
        { key: 'term', header: 'Term', render: (r) => r.term.code },
        { key: 'course', header: 'Section', render: (r) => <div><div className="font-medium text-slate-900">{r.section.course.code}-{r.section.sectionNumber}</div><div className="text-xs text-slate-500">{r.section.course.title}</div></div> },
        { key: 'meets', header: 'Meets', render: (r) => <span className="text-[13px]">{meetingText(r.section.meetings)}</span> },
        { key: 'credits', header: 'Cr', align: 'right', render: (r) => r.credits },
        { key: 'grade', header: 'Grade', render: (r) => r.grade ? <span className="flex items-center gap-1.5"><span className="font-semibold">{r.grade.letter}</span><Badge status={r.grade.status} /></span> : '—' },
        { key: 'source', header: 'Source', render: (r) => <span className="text-xs text-slate-500">{titleCase(r.source)}</span> },
        { key: 'status', header: 'Status', render: (r) => <Badge status={r.status}>{r.status === 'WAITLISTED' ? `Waitlist #${r.waitlistPosition}` : undefined}</Badge> },
        { key: 'act', header: '', align: 'right', render: (r) => <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" onClick={() => setHistory(r)}>History</Button>{['REGISTERED', 'WAITLISTED'].includes(r.status) && (!r.grade || r.grade.status === 'DRAFT') && <Button size="sm" variant="subtleDanger" onClick={() => setTarget(r)}>Drop</Button>}</div> },
      ]} />
      <ConfirmDialog open={!!target} onClose={() => setTarget(null)} onConfirm={() => drop.mutate()} loading={drop.isPending} title="Drop or withdraw registration" confirmLabel="Confirm">
        <p>{target?.section.course.code}-{target?.section.sectionNumber}. Before the add/drop deadline the registration is dropped; afterwards it becomes a withdrawal (W). Registrar staff may withdraw after the deadline.</p>
        <ApiErrorDetails error={drop.error} />
        <Field label="Reason" required><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </ConfirmDialog>
      <Modal open={!!history} onClose={() => setHistory(null)} title="Registration history" description={history && `${history.section.course.code}-${history.section.sectionNumber} · ${history.term.name}`}>
        {!hist ? <Spinner /> : <ol className="space-y-3">{hist.data.map((e) => <li key={e.id} className="flex gap-3 text-sm"><span className="w-36 shrink-0 text-xs text-slate-500">{fmtDateTime(e.createdAt)}</span><div><span className="font-medium">{titleCase(e.action)}</span> → <Badge status={e.toStatus} /> <span className="text-xs text-slate-500">by {e.actorType.toLowerCase()}</span>{e.reason && <div className="text-[13px] text-slate-600">{e.reason}</div>}</div></li>)}</ol>}
      </Modal>
    </Card>
  );
}

function Record({ s }) {
  const { data } = useApi(`/admin/students/${s.id}/degree-audit`);
  return (
    <div className="space-y-6">
      <Card title="Term history" padded={false}>
        <DataTable rows={s.record.terms} rowKey={(r) => r.term.id} empty={<Empty title="No graded terms" />} columns={[
          { key: 'term', header: 'Term', render: (r) => r.term.name }, { key: 'earned', header: 'Credits earned', align: 'right', render: (r) => r.creditsEarned },
          { key: 'tgpa', header: 'Term GPA', align: 'right', render: (r) => gpa(r.termGpa) }, { key: 'cgpa', header: 'Cumulative GPA', align: 'right', render: (r) => <strong>{gpa(r.cumulativeGpa)}</strong> },
        ]} />
      </Card>
      {!data ? <Spinner /> : data.data.program ? <DegreeAudit audit={data.data} compact /> : <Card><Empty title="No program declared" /></Card>}
    </div>
  );
}

function Holds({ s }) {
  const [release, setRelease] = useState(null);
  const rel = useAction(() => api.post(`/admin/holds/${release.id}/release`), { invalidate: [`/admin/students/${s.id}`, '/admin/students', '/admin/dashboard'], success: 'Hold released', onSuccess: () => setRelease(null) });
  return (
    <Card padded={false}>
      <DataTable rows={s.holds} empty={<Empty title="No holds on record" />} columns={[
        { key: 'type', header: 'Type', render: (r) => <span className="font-medium">{titleCase(r.type)}</span> },
        { key: 'reason', header: 'Reason' },
        { key: 'blocks', header: 'Effect', render: (r) => r.blocksRegistration ? <Badge tone="red">Blocks registration</Badge> : <Badge tone="slate">Informational</Badge> },
        { key: 'placed', header: 'Placed', render: (r) => fmtDate(r.placedAt) },
        { key: 'status', header: 'Status', render: (r) => r.releasedAt ? <span className="text-[13px] text-slate-500">Released {fmtDate(r.releasedAt)}</span> : <Badge tone="amber">Active</Badge> },
        { key: 'act', header: '', align: 'right', render: (r) => !r.releasedAt && <Button size="sm" variant="secondary" onClick={() => setRelease(r)}>Release</Button> },
      ]} />
      <ConfirmDialog open={!!release} onClose={() => setRelease(null)} onConfirm={() => rel.mutate()} loading={rel.isPending} tone="primary" title="Release hold?" confirmLabel="Release hold">
        <p>{release && `${titleCase(release.type)} hold: ${release.reason}`}</p><p>The student will be notified.</p>
      </ConfirmDialog>
    </Card>
  );
}

const CONTACT = ['firstName', 'lastName', 'preferredName', 'email', 'personalEmail', 'phone', 'dateOfBirth', 'addressLine', 'city', 'region', 'postalCode', 'country', 'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation', 'programId', 'classLevel', 'expectedGraduation', 'financialAccountRef', 'financialAidStatus', 'academicStanding'];
const LABELS = { firstName: 'First name', lastName: 'Last name', preferredName: 'Preferred name', email: 'Institution email', personalEmail: 'Personal email', phone: 'Phone', dateOfBirth: 'Date of birth', addressLine: 'Street address', city: 'City', region: 'State / region', postalCode: 'Postal code', country: 'Country', emergencyContactName: 'Emergency contact', emergencyContactPhone: 'Emergency phone', emergencyContactRelation: 'Relationship', programId: 'Program', classLevel: 'Class level', expectedGraduation: 'Expected graduation', financialAccountRef: 'Bursar account ref', financialAidStatus: 'Financial aid status', academicStanding: 'Academic standing' };

function EditStudent({ open, s, onClose }) {
  const { data: lookups } = useApi('/lookups');
  const init = () => Object.fromEntries(CONTACT.map((k) => [k, k === 'dateOfBirth' ? (s.dateOfBirth ? s.dateOfBirth.slice(0, 10) : '') : s[k] ?? '']));
  const [f, setF] = useState(init);
  useEffect(() => { if (open) setF(init()); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useAction(() => {
    const changes = {};
    for (const k of CONTACT) {
      const before = k === 'dateOfBirth' ? (s.dateOfBirth ? s.dateOfBirth.slice(0, 10) : '') : s[k] ?? '';
      if (f[k] !== before) changes[k] = f[k] === '' ? null : f[k];
    }
    for (const k of ['firstName', 'lastName', 'email', 'classLevel', 'academicStanding']) if (changes[k] === null) delete changes[k];
    return api.patch(`/admin/students/${s.id}`, changes);
  }, { invalidate: [`/admin/students/${s.id}`, '/admin/students'], success: 'Student record updated', onSuccess: onClose, toastErrors: false });
  const input = (k, props = {}) => <Field key={k} label={LABELS[k]}><Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props} /></Field>;
  return (
    <Modal open={open} onClose={onClose} size="lg" title="Edit student record" description="Changes are recorded in the audit log with before/after values." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending}>Save changes</Button></>}>
      <ApiErrorDetails error={save.error} />
      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        {['firstName', 'lastName', 'preferredName', 'email', 'personalEmail', 'phone'].map((k) => input(k))}
        {input('dateOfBirth', { type: 'date' })}
        {['addressLine', 'city', 'region', 'postalCode', 'country', 'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation'].map((k) => input(k))}
        <Field label="Program"><Select value={f.programId} onChange={(e) => setF({ ...f, programId: e.target.value })} placeholder="Undeclared" options={(lookups?.data.programs ?? []).map((x) => ({ value: x.id, label: `${x.degreeType} ${x.name}` }))} /></Field>
        <Field label="Class level"><Select value={f.classLevel} onChange={(e) => setF({ ...f, classLevel: e.target.value })} options={['FRESHMAN', 'SOPHOMORE', 'JUNIOR', 'SENIOR', 'GRADUATE'].map((v) => ({ value: v, label: titleCase(v) }))} /></Field>
        <Field label="Academic standing" hint="Normally computed from GPA; set Suspension manually"><Select value={f.academicStanding} onChange={(e) => setF({ ...f, academicStanding: e.target.value })} options={['GOOD', 'DEANS_LIST', 'PROBATION', 'SUSPENSION'].map((v) => ({ value: v, label: titleCase(v) }))} /></Field>
        {['expectedGraduation', 'financialAccountRef', 'financialAidStatus'].map((k) => input(k))}
      </div>
    </Modal>
  );
}

function PlaceHold({ open, s, onClose }) {
  const [f, setF] = useState({ type: 'ADVISING', reason: '', blocksRegistration: true });
  const save = useAction(() => api.post(`/admin/students/${s.id}/holds`, f), { invalidate: [`/admin/students/${s.id}`, '/admin/students', '/admin/dashboard'], success: 'Hold placed; student notified', onSuccess: () => { setF({ type: 'ADVISING', reason: '', blocksRegistration: true }); onClose(); }, toastErrors: false });
  return (
    <Modal open={open} onClose={onClose} title="Place a hold" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={f.reason.trim().length < 3}>Place hold</Button></>}>
      <div className="space-y-4">
        <ApiErrorDetails error={save.error} />
        <Field label="Type"><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} options={['FINANCIAL', 'ACADEMIC', 'ADVISING', 'ADMINISTRATIVE', 'IMMUNIZATION'].map((v) => ({ value: v, label: titleCase(v) }))} /></Field>
        <Field label="Reason (visible to the student)" required><Textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} maxLength={300} /></Field>
        <Checkbox label="Blocks registration" checked={f.blocksRegistration} onChange={(v) => setF({ ...f, blocksRegistration: v })} />
      </div>
    </Modal>
  );
}

function ChangeStatus({ open, s, onClose }) {
  const [status, setStatus] = useState('');
  const [reason, setReason] = useState('');
  const save = useAction(() => api.post(`/admin/students/${s.id}/status`, { status, reason }), { invalidate: [`/admin/students/${s.id}`, '/admin/students', '/admin/dashboard'], success: 'Status updated', onSuccess: () => { setStatus(''); setReason(''); onClose(); }, toastErrors: false });
  return (
    <Modal open={open} onClose={onClose} title="Change student status" description={`Current status: ${titleCase(s.status)}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!status || reason.trim().length < 3}>Update status</Button></>}>
      <div className="space-y-4">
        <ApiErrorDetails error={save.error} />
        <Field label="New status" hint="Only valid lifecycle transitions are offered. Graduation requires all degree requirements."><Select value={status} onChange={(e) => setStatus(e.target.value)} placeholder="Select…" options={s.allowedTransitions.map((v) => ({ value: v, label: titleCase(v) }))} /></Field>
        <Field label="Reason" required><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}

function RegisterStudent({ open, s, onClose }) {
  const { data: lookups } = useApi('/lookups');
  const [termId, setTermId] = useState('');
  const [search, setSearch] = useState('');
  const [section, setSection] = useState(null);
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState('');
  const defaultTerm = lookups?.data.terms.find((t) => t.status === 'REGISTRATION_OPEN') ?? lookups?.data.terms.find((t) => t.isCurrent);
  const tId = termId || defaultTerm?.id;
  const { data: sections } = useApi(open && tId ? `/admin/sections${qs({ termId: tId, search, pageSize: 20 })}` : null);
  const { data: check } = useApi(section ? `/admin/registrations/check?studentId=${s.id}&sectionId=${section.id}` : null);
  const reg = useAction(() => api.post('/admin/registrations', { studentId: s.id, sectionId: section.id, override, reason: reason || undefined }), {
    invalidate: [`/admin/students/${s.id}`, '/admin/registrations', '/admin/sections'], success: (r) => `Student ${r.data.status.toLowerCase()}`, onSuccess: () => { setSection(null); setOverride(false); setReason(''); onClose(); }, toastErrors: false,
  });
  const v = check?.data.violations ?? [];
  const hardBlock = v.some((x) => !x.overridable);
  return (
    <Modal open={open} onClose={onClose} size="lg" title={`Register ${s.firstName} ${s.lastName}`} description="Registration rules are evaluated before you submit. Overrides require a reason and are audited."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => reg.mutate()} loading={reg.isPending} disabled={!section || hardBlock || (v.length > 0 && (!override || reason.trim().length < 5))}>{override ? 'Register with override' : check?.data.outcome === 'WAITLISTED' ? 'Add to waitlist' : 'Register'}</Button></>}>
      <div className="space-y-4">
        <ApiErrorDetails error={reg.error} />
        <div className="flex flex-wrap gap-2">
          <Select aria-label="Term" value={tId ?? ''} onChange={(e) => { setTermId(e.target.value); setSection(null); }} options={(lookups?.data.terms ?? []).filter((t) => t.status !== 'COMPLETED').map((t) => ({ value: t.id, label: t.name }))} className="w-44" />
          <SearchInput value={search} onChange={setSearch} placeholder="Course code or title" />
        </div>
        <div className="max-h-56 overflow-y-auto rounded-lg border border-slate-200">
          {!sections ? <Spinner /> : !sections.data.length ? <Empty title="No sections" /> : sections.data.map((x) => (
            <button key={x.id} onClick={() => setSection(x)} className={`flex w-full items-center justify-between border-b border-slate-100 px-3 py-2 text-left text-sm last:border-0 ${section?.id === x.id ? 'bg-ink-50' : 'hover:bg-slate-50'}`}>
              <span><span className="font-medium">{x.course.code}-{x.sectionNumber}</span> <span className="text-slate-500">{x.course.title}</span></span>
              <span className="text-xs tabular-nums text-slate-500">{x.enrolled}/{x.capacity}{x.waitlisted ? ` +${x.waitlisted} wl` : ''} · {meetingText(x.meetings)}</span>
            </button>
          ))}
        </div>
        {section && check && (v.length === 0
          ? <Alert tone="success">Eligible — the student will be <strong>{check.data.outcome.toLowerCase()}</strong>.</Alert>
          : <Alert tone={hardBlock ? 'error' : 'warn'} title={hardBlock ? 'Cannot register' : 'Rule exceptions'}><ul className="list-disc pl-4">{v.map((x) => <li key={x.code + x.message}>{x.message}{!x.overridable && <strong> (not overridable)</strong>}</li>)}</ul></Alert>)}
        {section && v.length > 0 && !hardBlock && <>
          <Checkbox label="Override registration rules" description="Bypasses the listed exceptions, including capacity. Holds and student status can never be overridden." checked={override} onChange={setOverride} />
          {override && <Field label="Override reason" required><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Instructor permission; prerequisite completed elsewhere" /></Field>}
        </>}
      </div>
    </Modal>
  );
}

function CreateLogin({ open, s, onClose }) {
  const create = useAction(() => api.post(`/admin/students/${s.id}/login`), { invalidate: [`/admin/students/${s.id}`], toastErrors: false });
  const close = () => { create.reset(); onClose(); };
  return (
    <Modal open={open} onClose={close} title="Create portal login" footer={create.data ? <Button onClick={close}>Done</Button> : <><Button variant="secondary" onClick={close}>Cancel</Button><Button onClick={() => create.mutate()} loading={create.isPending}>Create login</Button></>}>
      <ApiErrorDetails error={create.error} />
      {create.data ? <SecretBox label="Temporary password (shown once)" value={create.data.temporaryPassword} /> : <p className="text-sm text-slate-600">Creates a student portal account for <strong>{s.email}</strong> with a one-time temporary password.</p>}
    </Modal>
  );
}

function TranscriptModal({ open, id, onClose }) {
  const { data } = useApi(open ? `/admin/students/${id}/transcript` : null);
  return (
    <Modal open={open} onClose={onClose} size="xl" title="Unofficial transcript" description="Viewing is recorded in the audit log." footer={<Button variant="secondary" icon={Printer} onClick={() => window.print()}>Print</Button>}>
      {!data ? <Spinner /> : <TranscriptView t={data.data} />}
    </Modal>
  );
}
