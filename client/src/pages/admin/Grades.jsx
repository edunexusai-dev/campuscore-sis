import { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { api, qs } from '../../lib/api.js';
import { useApi, useAction } from '../../lib/hooks.js';
import { fmtDate, titleCase } from '../../lib/format.js';
import { PageHeader, Card, DataTable, Badge, Button, Tabs, Select, Modal, Field, Textarea, ApiErrorDetails, ConfirmDialog, Spinner, Empty, Alert, ErrorState } from '../../components/ui.jsx';

const STAGES = { AWAITING_APPROVAL: ['Awaiting approval', 'blue'], AWAITING_PUBLICATION: ['Ready to publish', 'violet'], PUBLISHED: ['Published', 'green'], RETURNED: ['Returned to faculty', 'amber'], IN_PROGRESS: ['Faculty entering', 'slate'] };

export default function AdminGrades() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'queue';
  return (
    <>
      <PageHeader title="Grades" subtitle="Approve and publish submitted grades, and review corrections to published grades. Only published grades are official." />
      <Tabs value={tab} onChange={(v) => setParams({ tab: v })} tabs={[{ value: 'queue', label: 'Grade submissions' }, { value: 'changes', label: 'Change requests' }]} />
      {tab === 'queue' ? <Queue /> : <Changes />}
    </>
  );
}

function Queue() {
  const { data: lookups } = useApi('/lookups');
  const [termId, setTermId] = useState('');
  const [stage, setStage] = useState('ACTION');
  const { data, isLoading, error } = useApi(`/admin/grades/queue${qs({ termId })}`);
  const [open, setOpen] = useState(null);
  const rows = (data?.data ?? []).filter((r) => stage === 'ALL' || (stage === 'ACTION' ? ['AWAITING_APPROVAL', 'AWAITING_PUBLICATION'].includes(r.stage) : r.stage === stage));
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        <Select aria-label="Term" value={termId} onChange={(e) => setTermId(e.target.value)} placeholder="All terms" options={(lookups?.data.terms ?? []).map((t) => ({ value: t.id, label: t.name }))} className="w-44" />
        <Select aria-label="Stage" value={stage} onChange={(e) => setStage(e.target.value)} options={[{ value: 'ACTION', label: 'Needs action' }, { value: 'ALL', label: 'All sections' }, ...Object.entries(STAGES).map(([k, [l]]) => ({ value: k, label: l }))]} className="w-48" />
      </div>
      <Card padded={false}>
        {error ? <ErrorState error={error} /> : <DataTable loading={isLoading} rows={rows} rowKey={(r) => r.sectionId} onRowClick={(r) => setOpen(r.sectionId)} empty={<Empty title="Nothing waiting" description="Sections appear here when faculty submit grades." />} columns={[
          { key: 'label', header: 'Section', render: (r) => <div><div className="font-medium text-slate-900">{r.label} <span className="text-slate-400 font-normal">· {r.term}</span></div><div className="text-xs text-slate-500">{r.title}</div></div> },
          { key: 'instructors', header: 'Instructor', render: (r) => r.instructors.join(', ') },
          { key: 'enrolled', header: 'Students', align: 'right', render: (r) => r.enrolled },
          { key: 'counts', header: 'Grades', render: (r) => <div className="flex flex-wrap gap-1">{Object.entries(r.counts).filter(([, v]) => v).map(([k, v]) => <Badge key={k} status={k}>{titleCase(k)} {v}</Badge>)}</div> },
          { key: 'due', header: 'Due', render: (r) => fmtDate(r.gradesDueDate) },
          { key: 'stage', header: 'Stage', render: (r) => <Badge tone={STAGES[r.stage][1]}>{STAGES[r.stage][0]}</Badge> },
        ]} />}
      </Card>
      {open && <Gradebook sectionId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function Gradebook({ sectionId, onClose }) {
  const { data, isLoading } = useApi(`/admin/sections/${sectionId}/gradebook`);
  const [confirm, setConfirm] = useState(null);
  const [reason, setReason] = useState('');
  const inv = ['/admin/grades', `/admin/sections/${sectionId}`, '/admin/dashboard'];
  const act = useAction((kind) => api.post(`/admin/sections/${sectionId}/grades/${kind}`, kind === 'return' ? { reason } : {}), {
    invalidate: inv, success: (_, k) => ({ approve: 'Grades approved', publish: 'Grades published — students notified and GPAs recalculated', return: 'Grades returned to faculty' }[k]), onSuccess: () => { setConfirm(null); setReason(''); }, toastErrors: false,
  });
  const c = data?.data.counts;
  return (
    <Modal open onClose={onClose} size="lg" title={data ? `${data.data.section.courseCode}-${data.data.section.sectionNumber} · ${data.data.section.courseTitle}` : 'Gradebook'} description={data?.data.section.term}
      footer={data && <>
        <Button variant="secondary" onClick={onClose}>Close</Button>
        {(c.SUBMITTED > 0 || c.APPROVED > 0) && <Button variant="subtleDanger" onClick={() => setConfirm('return')}>Return to faculty</Button>}
        {c.SUBMITTED > 0 && <Button onClick={() => setConfirm('approve')}>Approve {c.SUBMITTED}</Button>}
        {c.APPROVED > 0 && <Button variant="accent" onClick={() => setConfirm('publish')}>Publish {c.APPROVED}</Button>}
      </>}>
      {isLoading ? <Spinner /> : (
        <>
          <ApiErrorDetails error={act.error} />
          {c.MISSING > 0 && <Alert tone="warn" className="mb-3">{c.MISSING} student(s) have no grade yet.</Alert>}
          <table className="min-w-full">
            <thead><tr><th className="th">Student</th><th className="th">ID</th><th className="th">Grade</th><th className="th">Status</th></tr></thead>
            <tbody>{data.data.rows.map((r) => (
              <tr key={r.registrationId}>
                <td className="td">{r.student.name}</td><td className="td mono">{r.student.studentNumber}</td>
                <td className="td text-base font-semibold">{r.registrationStatus === 'WITHDRAWN' ? 'W' : r.grade?.letter ?? '—'}</td>
                <td className="td">{r.grade ? <Badge status={r.grade.status} /> : r.registrationStatus === 'WITHDRAWN' ? <Badge status="WITHDRAWN" /> : <Badge status="MISSING">Missing</Badge>}</td>
              </tr>
            ))}</tbody>
          </table>
        </>
      )}
      <ConfirmDialog open={!!confirm} onClose={() => setConfirm(null)} loading={act.isPending} tone={confirm === 'return' ? 'danger' : 'primary'}
        title={{ approve: 'Approve submitted grades?', publish: 'Publish grades to students?', return: 'Return grades to faculty?' }[confirm]}
        confirmLabel={{ approve: 'Approve', publish: 'Publish', return: 'Return grades' }[confirm]} onConfirm={() => act.mutate(confirm)}>
        {confirm === 'publish' && <p>Published grades become part of the official academic record, are visible to students and integrations, and update GPA, standing and class level. Later corrections require a grade change request.</p>}
        {confirm === 'approve' && <p>Approval confirms the grades are correct. Depending on policy, they may be published automatically.</p>}
        {confirm === 'return' && <Field label="Reason for the instructor" required><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
      </ConfirmDialog>
    </Modal>
  );
}

function Changes() {
  const [status, setStatus] = useState('PENDING');
  const { data, isLoading, error } = useApi(`/admin/grade-changes${qs({ status })}`);
  const [target, setTarget] = useState(null);
  const [note, setNote] = useState('');
  const review = useAction((approve) => api.post(`/admin/grade-changes/${target.id}/review`, { approve, note: note || undefined }), {
    invalidate: ['/admin/grade-changes', '/admin/dashboard'], success: (_, a) => (a ? 'Grade change approved and applied' : 'Grade change rejected'), onSuccess: () => { setTarget(null); setNote(''); }, toastErrors: false,
  });
  return (
    <>
      <div className="mb-4"><Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: 'PENDING', label: 'Pending' }, { value: 'APPROVED', label: 'Approved' }, { value: 'REJECTED', label: 'Rejected' }, { value: '', label: 'All' }]} className="w-40" /></div>
      <Card padded={false}>
        {error ? <ErrorState error={error} /> : <DataTable loading={isLoading} rows={data?.data} empty={<Empty title="No change requests" />} columns={[
          { key: 'createdAt', header: 'Requested', render: (r) => fmtDate(r.createdAt) },
          { key: 'student', header: 'Student', render: (r) => <Link className="link" to={`/admin/students/${r.student.id}`}>{r.student.name}</Link> },
          { key: 'course', header: 'Course', render: (r) => `${r.course} (${r.term})` },
          { key: 'change', header: 'Change', render: (r) => <span className="font-semibold">{r.fromLetter} → {r.toLetter}</span> },
          { key: 'by', header: 'Requested by', render: (r) => r.requestedBy },
          { key: 'reason', header: 'Reason', className: 'max-w-xs', render: (r) => <span className="line-clamp-2 text-slate-600">{r.reason}</span> },
          { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
          { key: 'act', header: '', align: 'right', render: (r) => r.status === 'PENDING' && <Button size="sm" variant="secondary" onClick={() => setTarget(r)}>Review</Button> },
        ]} />}
      </Card>
      <Modal open={!!target} onClose={() => setTarget(null)} title="Review grade change" description={target && `${target.student.name} · ${target.course}`}
        footer={<><Button variant="secondary" onClick={() => setTarget(null)}>Cancel</Button><Button variant="subtleDanger" onClick={() => review.mutate(false)} loading={review.isPending && review.variables === false}>Reject</Button><Button onClick={() => review.mutate(true)} loading={review.isPending && review.variables === true}>Approve change</Button></>}>
        {target && <div className="space-y-4">
          <ApiErrorDetails error={review.error} />
          <div className="flex items-center gap-4 rounded-lg bg-slate-50 p-4"><span className="text-3xl font-semibold text-slate-400">{target.fromLetter}</span><span className="text-slate-400">→</span><span className="text-3xl font-semibold text-ink-900">{target.toLetter}</span></div>
          <div><div className="label">Justification from {target.requestedBy}</div><p className="text-sm text-slate-700">{target.reason}</p></div>
          <Field label="Review note"><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <p className="text-xs text-slate-500">Approving updates the official grade, recalculates GPA and standing, notifies the student and records the change in grade history. A registrar cannot approve a request they created.</p>
        </div>}
      </Modal>
    </>
  );
}
