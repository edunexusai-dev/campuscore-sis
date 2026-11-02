import { useApi } from '../../lib/hooks.js';
import { gpa } from '../../lib/format.js';
import { PageHeader, Card, Spinner, Empty, Badge, Stat, ErrorState } from '../../components/ui.jsx';

export default function StudentGrades() {
  const { data, isLoading, error } = useApi('/student/grades');
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <Spinner />;
  const r = data.data;
  return (
    <>
      <PageHeader title="Grades & GPA" subtitle="Only final grades published by the Registrar appear here. GPA is credit-weighted on a 4.0 scale." />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Cumulative GPA" value={gpa(r.cumulativeGpa)} tone="brass" />
        <Stat label="Credits earned" value={r.creditsEarned} />
        <Stat label="Credits attempted" value={r.creditsAttempted} tone="slate" />
        <Stat label="Quality points" value={r.qualityPoints.toFixed(1)} tone="slate" />
      </div>
      {!r.terms.length ? <Card><Empty title="No grades yet" /></Card> : (
        <div className="space-y-5">
          {[...r.terms].reverse().map((t) => (
            <Card key={t.term.id} title={t.term.name} padded={false} actions={<div className="text-right text-[13px] text-slate-500">Term GPA <span className="font-semibold text-slate-900">{gpa(t.termGpa)}</span> · Cumulative <span className="font-semibold text-slate-900">{gpa(t.cumulativeGpa)}</span></div>}>
              <table className="min-w-full">
                <thead><tr><th className="th">Course</th><th className="th">Title</th><th className="th text-right">Credits</th><th className="th text-right">Grade</th><th className="th text-right">Points</th></tr></thead>
                <tbody>
                  {t.courses.map((c) => (
                    <tr key={c.registrationId}>
                      <td className="td font-medium text-slate-900 whitespace-nowrap">{c.courseCode}</td>
                      <td className="td">{c.courseTitle}</td>
                      <td className="td text-right tabular-nums">{c.credits}</td>
                      <td className="td text-right">{c.state === 'IN_PROGRESS' ? <Badge tone="blue">In progress</Badge> : <span className="font-semibold text-slate-900">{c.grade}</span>}</td>
                      <td className="td text-right tabular-nums text-slate-500">{c.gradePoints != null ? (c.gradePoints * c.credits).toFixed(1) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
