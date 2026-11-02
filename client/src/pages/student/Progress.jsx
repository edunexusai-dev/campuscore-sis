import { CheckCircle2, Circle, Clock, XCircle } from 'lucide-react';
import { useApi } from '../../lib/hooks.js';
import { gpa, titleCase } from '../../lib/format.js';
import { PageHeader, Card, Spinner, Empty, Badge, ErrorState } from '../../components/ui.jsx';

export default function StudentProgress() {
  const { data, isLoading, error } = useApi('/student/degree-audit');
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <Spinner />;
  const a = data.data;
  if (!a.program) return <Card><Empty title="No declared program" description="Contact your advisor to declare a program." /></Card>;
  return <DegreeAudit audit={a} />;
}

export function DegreeAudit({ audit: a, compact }) {
  const done = a.requirements.filter((r) => r.status === 'COMPLETE').length;
  return (
    <>
      {!compact && <PageHeader title="Degree progress" subtitle={`${a.program.degreeType} ${a.program.name} · ${a.program.requiredCredits} credits required`} />}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Overall progress">
          <div className="flex items-center gap-5">
            <div className="relative size-28 shrink-0">
              <svg viewBox="0 0 36 36" className="size-28 -rotate-90"><circle cx="18" cy="18" r="15.9" fill="none" stroke="#e8ebf1" strokeWidth="3.2" /><circle cx="18" cy="18" r="15.9" fill="none" stroke="#14284b" strokeWidth="3.2" strokeDasharray={`${a.percentComplete} 100`} strokeLinecap="round" /></svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center"><span className="text-2xl font-semibold text-slate-900">{a.percentComplete}%</span><span className="text-[11px] text-slate-500">of credits</span></div>
            </div>
            <dl className="space-y-1.5 text-sm">
              <div><dt className="inline text-slate-500">Earned </dt><dd className="inline font-semibold">{a.record.creditsEarned} / {a.program.requiredCredits}</dd></div>
              <div><dt className="inline text-slate-500">In progress </dt><dd className="inline font-semibold">{a.record.creditsInProgress}</dd></div>
              <div><dt className="inline text-slate-500">GPA </dt><dd className="inline font-semibold">{gpa(a.record.cumulativeGpa)}</dd></div>
              <div><dt className="inline text-slate-500">Required courses </dt><dd className="inline font-semibold">{done} / {a.requirements.length}</dd></div>
            </dl>
          </div>
        </Card>
        <Card title="Graduation checks" className="lg:col-span-2" actions={a.eligibleToGraduate ? <Badge tone="green">Eligible to graduate</Badge> : <Badge tone="slate">Requirements outstanding</Badge>}>
          <ul className="space-y-2.5">
            {a.checks.map((c) => (
              <li key={c.label} className="flex items-start gap-2.5 text-sm">
                {c.met ? <CheckCircle2 className="mt-0.5 size-4 text-emerald-600" /> : <XCircle className="mt-0.5 size-4 text-slate-400" />}
                <div><div className="font-medium text-slate-800">{c.label}</div><div className="text-[13px] text-slate-500">{c.detail}</div></div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <Card title="Program requirements" padded={false} className="mt-6">
        <table className="min-w-full">
          <thead><tr><th className="th w-10" /><th className="th">Course</th><th className="th">Category</th><th className="th text-right">Credits</th><th className="th">Status</th><th className="th">Term</th><th className="th text-right">Grade</th></tr></thead>
          <tbody>
            {a.requirements.map((r) => (
              <tr key={r.courseId}>
                <td className="td">{r.status === 'COMPLETE' ? <CheckCircle2 className="size-4 text-emerald-600" aria-label="Complete" /> : r.status === 'IN_PROGRESS' ? <Clock className="size-4 text-sky-600" aria-label="In progress" /> : <Circle className="size-4 text-slate-300" aria-label="Not started" />}</td>
                <td className="td"><span className="font-medium text-slate-900">{r.courseCode}</span> <span className="text-slate-500">{r.courseTitle}</span></td>
                <td className="td text-slate-500">{titleCase(r.category)}</td>
                <td className="td text-right tabular-nums">{r.credits}</td>
                <td className="td"><Badge status={r.status === 'COMPLETE' ? 'COMPLETED' : r.status === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'PLANNED'}>{titleCase(r.status)}</Badge></td>
                <td className="td text-slate-500">{r.term ?? '—'}</td>
                <td className="td text-right font-semibold">{r.grade ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
