import { useState } from 'react';
import { Plus, Pencil, Trash2, Pin } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApi, useAction } from '../../lib/hooks.js';
import { fmtDate, titleCase } from '../../lib/format.js';
import { PageHeader, Card, DataTable, Badge, Button, Tabs, Modal, Field, Input, Select, Textarea, Checkbox, ConfirmDialog, ApiErrorDetails, Empty, ErrorState } from '../../components/ui.jsx';

export default function Communications() {
  const [tab, setTab] = useState('announcements');
  return (
    <>
      <PageHeader title="Announcements & calendar" subtitle="Institution-wide communication and the academic calendar shown to every portal and the integration API." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'announcements', label: 'Announcements' }, { value: 'calendar', label: 'Academic calendar' }]} />
      {tab === 'announcements' ? <Announcements /> : <CalendarAdmin />}
    </>
  );
}

function Announcements() {
  const { data, isLoading, error } = useApi('/admin/announcements');
  const [edit, setEdit] = useState(null);
  const [del, setDel] = useState(null);
  const remove = useAction(() => api.del(`/admin/announcements/${del.id}`), { invalidate: ['/admin/announcements', '/announcements'], success: 'Announcement deleted', onSuccess: () => setDel(null) });
  return (
    <>
      <div className="mb-4 flex justify-end"><Button icon={Plus} onClick={() => setEdit({})}>New announcement</Button></div>
      <Card padded={false}>
        {error ? <ErrorState error={error} /> : <DataTable loading={isLoading} rows={data?.data} empty={<Empty title="No announcements" />} columns={[
          { key: 'title', header: 'Title', render: (r) => <div className="flex items-center gap-1.5">{r.pinned && <Pin className="size-3.5 text-brass-500" />}<span className="font-medium text-slate-900">{r.title}</span></div> },
          { key: 'audience', header: 'Audience', render: (r) => r.section ? <Badge tone="ink">{r.section}</Badge> : <Badge tone="slate">{titleCase(r.audience)}</Badge> },
          { key: 'author', header: 'Author' },
          { key: 'publishedAt', header: 'Published', render: (r) => fmtDate(r.publishedAt) },
          { key: 'expiresAt', header: 'Expires', render: (r) => fmtDate(r.expiresAt) },
          { key: 'act', header: '', align: 'right', render: (r) => !r.section && <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" icon={Pencil} aria-label="Edit" onClick={() => setEdit(r)} /><Button size="sm" variant="ghost" icon={Trash2} aria-label="Delete" onClick={() => setDel(r)} /></div> },
        ]} />}
      </Card>
      {edit && <AnnouncementForm item={edit.id ? edit : null} onClose={() => setEdit(null)} />}
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} onConfirm={() => remove.mutate()} loading={remove.isPending} title="Delete announcement?" confirmLabel="Delete"><p>“{del?.title}” will be removed from every portal.</p></ConfirmDialog>
    </>
  );
}

function AnnouncementForm({ item, onClose }) {
  const [f, setF] = useState(item ? { title: item.title, body: item.body, audience: item.audience, pinned: item.pinned, expiresAt: item.expiresAt ? item.expiresAt.slice(0, 10) : '' } : { title: '', body: '', audience: 'ALL', pinned: false, expiresAt: '' });
  const save = useAction(() => { const b = { ...f, expiresAt: f.expiresAt || null }; return item ? api.patch(`/admin/announcements/${item.id}`, b) : api.post('/admin/announcements', b); }, { invalidate: ['/admin/announcements', '/announcements'], success: item ? 'Announcement updated' : 'Announcement published', onSuccess: onClose, toastErrors: false });
  return (
    <Modal open onClose={onClose} title={item ? 'Edit announcement' : 'New announcement'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending}>{item ? 'Save' : 'Publish'}</Button></>}>
      <div className="space-y-4">
        <ApiErrorDetails error={save.error} />
        <Field label="Title" required><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={150} /></Field>
        <Field label="Message" required><Textarea rows={6} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Audience"><Select value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })} options={[{ value: 'ALL', label: 'Everyone' }, { value: 'STUDENTS', label: 'Students' }, { value: 'FACULTY', label: 'Faculty' }, { value: 'STAFF', label: 'Staff' }]} /></Field>
          <Field label="Expires"><Input type="date" value={f.expiresAt} onChange={(e) => setF({ ...f, expiresAt: e.target.value })} /></Field>
        </div>
        <Checkbox label="Pin to top" checked={f.pinned} onChange={(v) => setF({ ...f, pinned: v })} />
      </div>
    </Modal>
  );
}

function CalendarAdmin() {
  const { data: lookups } = useApi('/lookups');
  const { data, isLoading, error } = useApi('/calendar');
  const [edit, setEdit] = useState(null);
  const [del, setDel] = useState(null);
  const remove = useAction(() => api.del(`/admin/calendar/${del.id}`), { invalidate: ['/calendar'], success: 'Event deleted', onSuccess: () => setDel(null) });
  const termName = (id) => lookups?.data.terms.find((t) => t.id === id)?.name ?? '—';
  return (
    <>
      <div className="mb-4 flex justify-end"><Button icon={Plus} onClick={() => setEdit({})}>New event</Button></div>
      <Card padded={false}>
        {error ? <ErrorState error={error} /> : <DataTable loading={isLoading} rows={data?.data ? [...data.data].reverse() : undefined} empty={<Empty title="No events" />} columns={[
          { key: 'startDate', header: 'Date', render: (r) => `${fmtDate(r.startDate)}${r.endDate ? ` – ${fmtDate(r.endDate)}` : ''}` },
          { key: 'title', header: 'Event', render: (r) => <span className="font-medium text-slate-900">{r.title}</span> },
          { key: 'category', header: 'Category', render: (r) => titleCase(r.category) },
          { key: 'term', header: 'Term', render: (r) => termName(r.termId) },
          { key: 'act', header: '', align: 'right', render: (r) => <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" icon={Pencil} aria-label="Edit" onClick={() => setEdit(r)} /><Button size="sm" variant="ghost" icon={Trash2} aria-label="Delete" onClick={() => setDel(r)} /></div> },
        ]} />}
      </Card>
      {edit && <EventForm item={edit.id ? edit : null} terms={lookups?.data.terms ?? []} onClose={() => setEdit(null)} />}
      <ConfirmDialog open={!!del} onClose={() => setDel(null)} onConfirm={() => remove.mutate()} loading={remove.isPending} title="Delete event?" confirmLabel="Delete"><p>“{del?.title}” will be removed from the academic calendar.</p></ConfirmDialog>
    </>
  );
}

function EventForm({ item, terms, onClose }) {
  const [f, setF] = useState(item ? { title: item.title, description: item.description ?? '', category: item.category, startDate: item.startDate, endDate: item.endDate ?? '', termId: item.termId ?? '' } : { title: '', description: '', category: 'ACADEMIC', startDate: '', endDate: '', termId: '' });
  const save = useAction(() => { const b = { ...f, description: f.description || null, endDate: f.endDate || null, termId: f.termId || null }; return item ? api.patch(`/admin/calendar/${item.id}`, b) : api.post('/admin/calendar', b); }, { invalidate: ['/calendar'], success: 'Calendar updated', onSuccess: onClose, toastErrors: false });
  return (
    <Modal open onClose={onClose} title={item ? 'Edit event' : 'New calendar event'} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending}>Save</Button></>}>
      <div className="space-y-4">
        <ApiErrorDetails error={save.error} />
        <Field label="Title" required><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Category"><Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} options={['ACADEMIC', 'DEADLINE', 'HOLIDAY', 'EXAM', 'EVENT'].map((v) => ({ value: v, label: titleCase(v) }))} /></Field>
          <Field label="Term"><Select value={f.termId} onChange={(e) => setF({ ...f, termId: e.target.value })} placeholder="None" options={terms.map((t) => ({ value: t.id, label: t.name }))} /></Field>
          <Field label="Start date" required><Input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field>
          <Field label="End date"><Input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></Field>
        </div>
        <Field label="Description"><Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
