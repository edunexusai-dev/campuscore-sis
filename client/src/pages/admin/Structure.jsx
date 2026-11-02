import { useEffect, useState } from 'react';
import { Plus, Trash2, ChevronRight } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApi, useAction } from '../../lib/hooks.js';
import { titleCase } from '../../lib/format.js';
import { PageHeader, Card, Spinner, Badge, Button, Modal, Field, Input, Select, Textarea, ApiErrorDetails, ErrorState } from '../../components/ui.jsx';

export default function Structure() {
  const { data, isLoading, error } = useApi('/admin/structure');
  const [modal, setModal] = useState(null);
  const [program, setProgram] = useState(null);
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <Spinner />;
  const departments = data.data.flatMap((c) => c.departments);
  return (
    <>
      <PageHeader title="Programs & departments" subtitle="Academic organisation: colleges, departments and the degree programs they offer."
        actions={<><Button variant="secondary" icon={Plus} onClick={() => setModal('college')}>College</Button><Button variant="secondary" icon={Plus} onClick={() => setModal('department')}>Department</Button><Button icon={Plus} onClick={() => setModal('program')}>Program</Button></>} />
      <div className="space-y-6">
        {data.data.map((c) => (
          <Card key={c.id} title={c.name} subtitle={`${c.code} · ${c.departments.length} departments`} padded={false}>
            <div className="divide-y divide-slate-100">
              {c.departments.map((d) => (
                <div key={d.id} className="px-5 py-4">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div><span className="font-semibold text-slate-900">{d.name}</span> <span className="text-sm text-slate-400">{d.code}</span></div>
                    <div className="text-xs text-slate-500">{d._count.courses} courses · {d._count.faculty} faculty · {d.officeLocation}</div>
                  </div>
                  {d.programs.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {d.programs.map((p) => (
                        <button key={p.id} onClick={() => setProgram(p.id)} className="group flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-left text-[13px] hover:border-ink-300 hover:bg-ink-50">
                          <span className="font-medium text-slate-800">{p.degreeType} {p.name}</span>
                          <span className="text-xs text-slate-500">{p._count.students} students · {p.requiredCredits} cr</span>
                          {!p.active && <Badge tone="slate">Inactive</Badge>}
                          <ChevronRight className="size-3.5 text-slate-300 group-hover:text-slate-500" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
      <CreateModal kind={modal} onClose={() => setModal(null)} colleges={data.data} departments={departments} />
      {program && <ProgramModal id={program} onClose={() => setProgram(null)} departments={departments} />}
    </>
  );
}

function CreateModal({ kind, onClose, colleges, departments }) {
  const [f, setF] = useState({});
  useEffect(() => { setF(kind === 'program' ? { level: 'UNDERGRADUATE', requiredCredits: 120, minGpa: 2, degreeType: 'BS' } : {}); }, [kind]);
  const save = useAction(() => {
    if (kind === 'college') return api.post('/admin/colleges', { code: f.code, name: f.name });
    if (kind === 'department') return api.post('/admin/departments', { collegeId: f.collegeId, code: f.code, name: f.name, officeLocation: f.officeLocation || null, email: f.email || null });
    return api.post('/admin/programs', { departmentId: f.departmentId, code: f.code, name: f.name, degreeType: f.degreeType, level: f.level, requiredCredits: Number(f.requiredCredits), minGpa: Number(f.minGpa), description: f.description || null });
  }, { invalidate: ['/admin/structure', '/lookups'], success: `${titleCase(kind ?? '')} created`, onSuccess: onClose, toastErrors: false });
  const input = (k, label, props) => <Field label={label}><Input value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props} /></Field>;
  return (
    <Modal open={!!kind} onClose={onClose} title={`New ${kind}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending}>Create</Button></>}>
      <ApiErrorDetails error={save.error} />
      <div className="mt-2 grid gap-4 sm:grid-cols-2">
        {kind === 'department' && <Field label="College" className="sm:col-span-2"><Select value={f.collegeId ?? ''} onChange={(e) => setF({ ...f, collegeId: e.target.value })} placeholder="Select…" options={colleges.map((c) => ({ value: c.id, label: c.name }))} /></Field>}
        {kind === 'program' && <Field label="Department" className="sm:col-span-2"><Select value={f.departmentId ?? ''} onChange={(e) => setF({ ...f, departmentId: e.target.value })} placeholder="Select…" options={departments.map((d) => ({ value: d.id, label: d.name }))} /></Field>}
        {input('code', 'Code')}{input('name', 'Name')}
        {kind === 'department' && <>{input('officeLocation', 'Office')}{input('email', 'Email', { type: 'email' })}</>}
        {kind === 'program' && <>
          {input('degreeType', 'Degree type (BS, BA, MS…)')}
          <Field label="Level"><Select value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })} options={[{ value: 'UNDERGRADUATE', label: 'Undergraduate' }, { value: 'GRADUATE', label: 'Graduate' }]} /></Field>
          {input('requiredCredits', 'Required credits', { type: 'number' })}{input('minGpa', 'Minimum GPA', { type: 'number', step: '0.1' })}
          <Field label="Description" className="sm:col-span-2"><Textarea value={f.description ?? ''} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        </>}
      </div>
    </Modal>
  );
}

function ProgramModal({ id, onClose }) {
  const { data } = useApi(`/admin/programs/${id}`);
  const { data: courses } = useApi('/admin/courses?pageSize=100');
  const [reqs, setReqs] = useState(null);
  const [meta, setMeta] = useState(null);
  useEffect(() => { if (data) { setReqs(data.data.requirements.map((r) => ({ courseId: r.course.id, category: r.category }))); setMeta({ requiredCredits: data.data.requiredCredits, minGpa: data.data.minGpa, active: data.data.active }); } }, [data]);
  const save = useAction(async () => {
    await api.patch(`/admin/programs/${id}`, { requiredCredits: Number(meta.requiredCredits), minGpa: Number(meta.minGpa), active: meta.active });
    return api.put(`/admin/programs/${id}/requirements`, { requirements: reqs });
  }, { invalidate: ['/admin/programs', '/admin/structure'], success: 'Program saved — degree audits use the new requirements immediately', onSuccess: onClose, toastErrors: false });
  const p = data?.data;
  return (
    <Modal open onClose={onClose} size="lg" title={p ? `${p.degreeType} ${p.name}` : 'Program'} description={p && `${p.code} · ${p.department} · ${p.studentCount} students`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!reqs}>Save program</Button></>}>
      {!reqs || !meta ? <Spinner /> : (
        <div className="space-y-4">
          <ApiErrorDetails error={save.error} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Required credits"><Input type="number" value={meta.requiredCredits} onChange={(e) => setMeta({ ...meta, requiredCredits: e.target.value })} /></Field>
            <Field label="Minimum GPA"><Input type="number" step="0.1" value={meta.minGpa} onChange={(e) => setMeta({ ...meta, minGpa: e.target.value })} /></Field>
            <Field label="Status"><Select value={String(meta.active)} onChange={(e) => setMeta({ ...meta, active: e.target.value === 'true' })} options={[{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }]} /></Field>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between"><span className="label mb-0">Required courses ({reqs.length})</span><Button size="sm" variant="ghost" icon={Plus} onClick={() => setReqs([...reqs, { courseId: courses?.data[0]?.id, category: 'MAJOR' }])}>Add course</Button></div>
            <div className="max-h-80 space-y-2 overflow-y-auto">
              {reqs.map((r, i) => (
                <div key={i} className="flex gap-2">
                  <Select aria-label="Course" value={r.courseId} onChange={(e) => setReqs(reqs.map((x, j) => (j === i ? { ...x, courseId: e.target.value } : x)))} options={(courses?.data ?? []).map((c) => ({ value: c.id, label: `${c.code} — ${c.title}` }))} />
                  <Select aria-label="Category" value={r.category} onChange={(e) => setReqs(reqs.map((x, j) => (j === i ? { ...x, category: e.target.value } : x)))} options={['CORE', 'MAJOR', 'ELECTIVE', 'GENERAL_EDUCATION'].map((v) => ({ value: v, label: titleCase(v) }))} className="w-44" />
                  <Button size="sm" variant="ghost" icon={Trash2} aria-label="Remove" onClick={() => setReqs(reqs.filter((_, j) => j !== i))} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
