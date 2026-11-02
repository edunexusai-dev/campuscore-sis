import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api, qs } from '../../lib/api.js';
import { useApi, useAction } from '../../lib/hooks.js';
import { DAY_NAMES } from '../../lib/format.js';
import { Modal, Button, Field, Input, Select, ApiErrorDetails } from '../../components/ui.jsx';

// Create (no `section`) or edit a section, including meeting times and instructors.
export default function SectionForm({ open, onClose, section, onSaved }) {
  const { data: lookups } = useApi(open ? '/lookups' : null);
  const { data: courses } = useApi(open && !section ? '/admin/courses?pageSize=100' : null);
  const { data: faculty } = useApi(open ? '/admin/faculty?pageSize=100' : null);
  const init = () => section ? {
    capacity: section.capacity, waitlistCapacity: section.waitlistCapacity, location: section.location ?? '', deliveryMode: section.deliveryMode, status: section.status,
    meetings: section.meetings.map((m) => ({ dayOfWeek: m.dayOfWeek, startTime: m.startTime, endTime: m.endTime, room: m.room ?? '' })), instructorIds: section.instructors.map((i) => i.facultyId),
  } : { termId: '', courseId: '', sectionNumber: '01', capacity: 30, waitlistCapacity: 5, location: '', deliveryMode: 'IN_PERSON', meetings: [], instructorIds: [] };
  const [f, setF] = useState(init);
  useEffect(() => { if (open) setF(init()); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useAction(() => {
    const body = { ...f, capacity: Number(f.capacity), waitlistCapacity: Number(f.waitlistCapacity), location: f.location || null, meetings: f.meetings.map((m) => ({ ...m, dayOfWeek: Number(m.dayOfWeek), room: m.room || null })), instructorIds: f.instructorIds.filter(Boolean) };
    return section ? api.patch(`/admin/sections/${section.id}`, body) : api.post('/admin/sections', body);
  }, { invalidate: ['/admin/sections', '/admin/courses'], success: section ? 'Section updated' : 'Section created', onSuccess: (r) => { onSaved?.(r); onClose(); }, toastErrors: false });
  const setMeeting = (i, patch) => setF({ ...f, meetings: f.meetings.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  return (
    <Modal open={open} onClose={onClose} size="lg" title={section ? 'Edit section' : 'New section'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending}>{section ? 'Save changes' : 'Create section'}</Button></>}>
      <div className="space-y-4">
        <ApiErrorDetails error={save.error} />
        {!section && <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Term" required><Select value={f.termId} onChange={(e) => setF({ ...f, termId: e.target.value })} placeholder="Select…" options={(lookups?.data.terms ?? []).filter((t) => t.status !== 'COMPLETED').map((t) => ({ value: t.id, label: t.name }))} /></Field>
          <Field label="Course" required className="sm:col-span-2"><Select value={f.courseId} onChange={(e) => setF({ ...f, courseId: e.target.value })} placeholder="Select…" options={(courses?.data ?? []).map((c) => ({ value: c.id, label: `${c.code} — ${c.title}` }))} /></Field>
          <Field label="Section number" required><Input value={f.sectionNumber} onChange={(e) => setF({ ...f, sectionNumber: e.target.value })} maxLength={5} /></Field>
        </div>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Capacity" required hint={section ? 'Increasing capacity promotes waitlisted students' : undefined}><Input type="number" min={1} value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} /></Field>
          <Field label="Waitlist capacity"><Input type="number" min={0} value={f.waitlistCapacity} onChange={(e) => setF({ ...f, waitlistCapacity: e.target.value })} /></Field>
          <Field label="Delivery"><Select value={f.deliveryMode} onChange={(e) => setF({ ...f, deliveryMode: e.target.value })} options={[{ value: 'IN_PERSON', label: 'In person' }, { value: 'HYBRID', label: 'Hybrid' }, { value: 'ONLINE', label: 'Online' }]} /></Field>
          <Field label="Location" className="sm:col-span-2"><Input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="Building and room" /></Field>
          {section && <Field label="Status"><Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} options={[{ value: 'OPEN', label: 'Open' }, { value: 'CLOSED', label: 'Closed' }, { value: 'CANCELLED', label: 'Cancelled' }]} /></Field>}
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between"><span className="label mb-0">Meeting times</span><Button size="sm" variant="ghost" icon={Plus} onClick={() => setF({ ...f, meetings: [...f.meetings, { dayOfWeek: 1, startTime: '09:00', endTime: '09:50', room: f.location }] })}>Add meeting</Button></div>
          {!f.meetings.length && <p className="text-sm text-slate-500">No meeting times (TBA / asynchronous).</p>}
          <div className="space-y-2">{f.meetings.map((m, i) => (
            <div key={i} className="grid grid-cols-[1fr_auto_auto_1fr_auto] items-center gap-2">
              <Select aria-label="Day" value={m.dayOfWeek} onChange={(e) => setMeeting(i, { dayOfWeek: e.target.value })} options={[1, 2, 3, 4, 5, 6, 7].map((d) => ({ value: d, label: DAY_NAMES[d] }))} />
              <Input aria-label="Start" type="time" value={m.startTime} onChange={(e) => setMeeting(i, { startTime: e.target.value })} className="w-28" />
              <Input aria-label="End" type="time" value={m.endTime} onChange={(e) => setMeeting(i, { endTime: e.target.value })} className="w-28" />
              <Input aria-label="Room" value={m.room} onChange={(e) => setMeeting(i, { room: e.target.value })} placeholder="Room" />
              <Button size="sm" variant="ghost" icon={Trash2} aria-label="Remove meeting" onClick={() => setF({ ...f, meetings: f.meetings.filter((_, j) => j !== i) })} />
            </div>
          ))}</div>
        </div>
        <Field label="Instructors" hint="The first instructor is primary. Instructors can only manage sections they are assigned to.">
          <div className="space-y-2">
            {[...f.instructorIds, ''].map((fid, i) => (
              <Select key={i} aria-label={`Instructor ${i + 1}`} value={fid} onChange={(e) => { const ids = [...f.instructorIds]; if (e.target.value) ids[i] = e.target.value; else ids.splice(i, 1); setF({ ...f, instructorIds: ids }); }} placeholder={i === f.instructorIds.length ? '+ Add instructor' : 'Remove'}
                options={(faculty?.data ?? []).map((x) => ({ value: x.id, label: `${x.lastName}, ${x.firstName} — ${x.department.code}` }))} />
            ))}
          </div>
        </Field>
      </div>
    </Modal>
  );
}
