import { useApi } from '../../lib/hooks.js';
import { fmtDate } from '../../lib/format.js';
import { PageHeader, Card, DataTable, Badge, Empty, ErrorState } from '../../components/ui.jsx';

export default function FacultyGradeChanges() {
  const { data, isLoading, error } = useApi('/faculty/grade-changes');
  return (
    <>
      <PageHeader title="Grade change requests" subtitle="Corrections to published grades require Registrar approval. Start a request from a section's Grades tab." />
      <Card padded={false}>
        {error ? <ErrorState error={error} /> : <DataTable loading={isLoading} rows={data?.data} empty={<Empty title="No grade change requests" />} columns={[
          { key: 'createdAt', header: 'Requested', render: (r) => fmtDate(r.createdAt) },
          { key: 'course', header: 'Course', render: (r) => <span className="font-medium">{r.course} <span className="text-slate-400">({r.term})</span></span> },
          { key: 'student', header: 'Student' },
          { key: 'change', header: 'Change', render: (r) => <span className="font-semibold">{r.fromLetter} → {r.toLetter}</span> },
          { key: 'reason', header: 'Reason', className: 'max-w-sm', render: (r) => <span className="text-slate-600">{r.reason}</span> },
          { key: 'status', header: 'Status', render: (r) => <div><Badge status={r.status} />{r.reviewNote && <div className="mt-1 text-xs text-slate-500">{r.reviewNote}</div>}</div> },
        ]} />}
      </Card>
    </>
  );
}
