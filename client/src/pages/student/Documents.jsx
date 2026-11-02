import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useApi, useAction } from '../../lib/hooks.js';
import { fmtDate, titleCase } from '../../lib/format.js';
import { PageHeader, Card, Spinner, Empty, Badge, Button, Modal, Field, Input, Select, Textarea, ApiErrorDetails, DataTable, ErrorState } from '../../components/ui.jsx';

export default function StudentDocuments() {
  const { data, isLoading, error } = useApi('/student/document-requests');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ type: 'OFFICIAL_TRANSCRIPT', recipient: '', deliveryMethod: 'ELECTRONIC', copies: 1, notes: '' });
  const create = useAction(() => api.post('/student/document-requests', { ...form, copies: Number(form.copies), notes: form.notes || undefined }), { invalidate: ['/student/document-requests'], success: 'Request submitted to the Registrar', onSuccess: () => setOpen(false), toastErrors: false });
  return (
    <>
      <PageHeader title="Document requests" subtitle="Request official transcripts and enrollment or degree verifications." actions={<Button onClick={() => { create.reset(); setOpen(true); }}>New request</Button>} />
      <Card padded={false}>
        {error ? <ErrorState error={error} /> : <DataTable loading={isLoading} rows={data?.data} empty={<Empty title="No requests yet" />} columns={[
          { key: 'type', header: 'Document', render: (r) => <span className="font-medium text-slate-900">{titleCase(r.type)}</span> },
          { key: 'recipient', header: 'Recipient' },
          { key: 'deliveryMethod', header: 'Delivery', render: (r) => titleCase(r.deliveryMethod) },
          { key: 'createdAt', header: 'Requested', render: (r) => fmtDate(r.createdAt) },
          { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
          { key: 'notes', header: 'Notes', render: (r) => <span className="text-slate-500">{r.notes ?? ''}</span> },
        ]} />}
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} title="Request a document" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={create.isPending} onClick={() => create.mutate()} disabled={form.recipient.trim().length < 2}>Submit request</Button></>}>
        <div className="space-y-4">
          <ApiErrorDetails error={create.error} />
          <Field label="Document type"><Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} options={[{ value: 'OFFICIAL_TRANSCRIPT', label: 'Official transcript' }, { value: 'ENROLLMENT_VERIFICATION', label: 'Enrollment verification' }, { value: 'DEGREE_VERIFICATION', label: 'Degree verification' }]} /></Field>
          <Field label="Recipient" required hint="Organisation or person receiving the document"><Input value={form.recipient} onChange={(e) => setForm({ ...form, recipient: e.target.value })} maxLength={200} /></Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Delivery"><Select value={form.deliveryMethod} onChange={(e) => setForm({ ...form, deliveryMethod: e.target.value })} options={[{ value: 'ELECTRONIC', label: 'Electronic' }, { value: 'MAIL', label: 'Mail' }, { value: 'PICKUP', label: 'Pick up' }]} /></Field>
            <Field label="Copies"><Input type="number" min={1} max={5} value={form.copies} onChange={(e) => setForm({ ...form, copies: e.target.value })} /></Field>
          </div>
          <Field label="Notes"><Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={500} /></Field>
          <p className="text-xs text-slate-500">Official transcripts cannot be released while a financial hold is active. Fees and electronic delivery to third-party networks are not part of this sandbox.</p>
        </div>
      </Modal>
    </>
  );
}
