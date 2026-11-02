import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../../lib/api.js';
import { useApi, useAction } from '../../lib/hooks.js';
import { fmtDate, titleCase } from '../../lib/format.js';
import { PageHeader, Card, DataTable, Badge, Button, Tabs, Modal, Field, Textarea, ApiErrorDetails, Empty, ErrorState } from '../../components/ui.jsx';

const NEXT = { PENDING: ['PROCESSING', 'REJECTED'], PROCESSING: ['COMPLETED', 'REJECTED'] };

export default function AdminDocuments() {
  const [status, setStatus] = useState('PENDING');
  const { data, isLoading, error } = useApi(`/admin/document-requests${qs({ status })}`);
  const [target, setTarget] = useState(null);
  const [notes, setNotes] = useState('');
  const update = useAction(({ id, status: s }) => api.post(`/admin/document-requests/${id}/status`, { status: s, notes: notes || undefined }), { invalidate: ['/admin/document-requests', '/admin/dashboard'], success: 'Request updated; student notified', onSuccess: () => { setTarget(null); setNotes(''); }, toastErrors: false });
  return (
    <>
      <PageHeader title="Document requests" subtitle="Official transcripts and verifications requested by students. Fulfilment (printing, e-delivery networks, fees) happens outside this sandbox." />
      <Tabs value={status} onChange={setStatus} tabs={['PENDING', 'PROCESSING', 'COMPLETED', 'REJECTED', ''].map((s) => ({ value: s, label: s ? titleCase(s) : 'All' }))} />
      <Card padded={false}>
        {error ? <ErrorState error={error} /> : <DataTable loading={isLoading} rows={data?.data} empty={<Empty title="No requests in this state" />} columns={[
          { key: 'student', header: 'Student', render: (r) => <Link className="link" to={`/admin/students/${r.student.id}`}>{r.student.lastName}, {r.student.firstName}</Link> },
          { key: 'type', header: 'Document', render: (r) => titleCase(r.type) },
          { key: 'recipient', header: 'Recipient' },
          { key: 'delivery', header: 'Delivery', render: (r) => `${titleCase(r.deliveryMethod)} × ${r.copies}` },
          { key: 'createdAt', header: 'Requested', render: (r) => fmtDate(r.createdAt) },
          { key: 'status', header: 'Status', render: (r) => <Badge status={r.status} /> },
          { key: 'act', header: '', align: 'right', render: (r) => NEXT[r.status] && <Button size="sm" variant="secondary" onClick={() => setTarget(r)}>Update</Button> },
        ]} />}
      </Card>
      <Modal open={!!target} onClose={() => setTarget(null)} title="Update request" description={target && `${titleCase(target.type)} for ${target.recipient}`}
        footer={<><Button variant="secondary" onClick={() => setTarget(null)}>Cancel</Button>{(NEXT[target?.status] ?? []).map((s) => <Button key={s} variant={s === 'REJECTED' ? 'subtleDanger' : 'primary'} loading={update.isPending && update.variables?.status === s} onClick={() => update.mutate({ id: target.id, status: s })}>{s === 'PROCESSING' ? 'Start processing' : titleCase(s)}</Button>)}</>}>
        <ApiErrorDetails error={update.error} />
        <Field label="Note to student (optional)"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} /></Field>
      </Modal>
    </>
  );
}
