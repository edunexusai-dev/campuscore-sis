import { useState } from 'react';
import { useApi } from '../../lib/hooks.js';
import { meetingText } from '../../lib/format.js';
import { PageHeader, Card, Spinner, Empty, Badge, Select, DataTable, ErrorState } from '../../components/ui.jsx';
import WeeklySchedule from '../../components/WeeklySchedule.jsx';

export default function StudentSchedule() {
  const [termId, setTermId] = useState('');
  const { data: terms } = useApi('/terms');
  const { data, isLoading, error } = useApi(`/student/schedule${termId ? `?termId=${termId}` : ''}`);
  const classes = data?.data.classes ?? [];
  const registered = classes.filter((c) => c.registrationStatus !== 'WAITLISTED');
  return (
    <>
      <PageHeader title="Class schedule" subtitle={data?.data.term?.name} actions={<Select aria-label="Term" value={termId || data?.data.term?.id || ''} onChange={(e) => setTermId(e.target.value)} options={(terms?.data ?? []).map((t) => ({ value: t.id, label: t.name }))} className="w-48" />} />
      {error ? <ErrorState error={error} /> : isLoading ? <Spinner /> : !classes.length ? <Card><Empty title="No classes for this term" /></Card> : (
        <div className="space-y-6">
          <Card title="Week at a glance"><WeeklySchedule classes={registered} /></Card>
          <Card padded={false} title="Classes">
            <DataTable rows={classes} rowKey={(r) => r.registrationId} columns={[
              { key: 'course', header: 'Course', render: (r) => <div><div className="font-medium text-slate-900">{r.course.code}-{r.sectionNumber}</div><div className="text-xs text-slate-500">{r.course.title}</div></div> },
              { key: 'instructor', header: 'Instructor', render: (r) => r.instructors.map((i) => i.name).join(', ') || 'TBA' },
              { key: 'meets', header: 'Meets', render: (r) => meetingText(r.meetings) },
              { key: 'location', header: 'Location', render: (r) => r.location ?? 'TBA' },
              { key: 'credits', header: 'Credits', align: 'right', render: (r) => r.course.credits },
              { key: 'status', header: 'Status', render: (r) => <Badge status={r.registrationStatus}>{r.registrationStatus === 'WAITLISTED' ? `Waitlist #${r.waitlistPosition}` : undefined}</Badge> },
            ]} />
          </Card>
        </div>
      )}
    </>
  );
}
