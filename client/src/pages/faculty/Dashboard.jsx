import { Link } from 'react-router-dom';
import { Users, BookOpen, ClipboardCheck, GitPullRequestArrow } from 'lucide-react';
import { useApi } from '../../lib/hooks.js';
import { fmtDate, fmtRelative, meetingText } from '../../lib/format.js';
import { PageHeader, Card, Stat, Spinner, Empty, Badge, ErrorState } from '../../components/ui.jsx';

export default function FacultyDashboard() {
  const { data, isLoading, error } = useApi('/faculty/dashboard');
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <Spinner />;
  const d = data.data;
  const pendingGrades = (d.stats.grades.DRAFT ?? 0) + (d.stats.grades.RETURNED ?? 0);
  return (
    <>
      <PageHeader eyebrow={d.term?.name} title={`Good to see you, ${d.profile.name.split(' ')[0]}`} subtitle={`${d.profile.title} · ${d.profile.office ?? ''}`} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Sections this term" value={d.stats.sections} icon={BookOpen} />
        <Stat label="Students" value={d.stats.students} icon={Users} tone="green" />
        <Stat label="Draft grades" value={pendingGrades} hint={`Due ${fmtDate(d.term?.gradesDueDate)}`} icon={ClipboardCheck} tone="brass" />
        <Stat label="Pending grade changes" value={d.stats.pendingChangeRequests} icon={GitPullRequestArrow} tone="slate" to="/faculty/grade-changes" />
      </div>
      <h2 className="mt-8 mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">My sections</h2>
      {!d.sections.length ? <Card><Empty title="No sections assigned this term" /></Card> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {d.sections.map((s) => {
            const stale = !s.lastAttendance || (Date.now() - new Date(s.lastAttendance)) / 86400000 > 5;
            return (
              <Link key={s.id} to={`/faculty/sections/${s.id}`} className="card group block p-5 transition hover:border-ink-300 hover:shadow-md">
                <div className="flex items-start justify-between gap-2">
                  <div><div className="text-xs font-semibold uppercase tracking-wide text-brass-600">{s.course.code}-{s.sectionNumber}</div><div className="mt-0.5 font-semibold text-slate-900 group-hover:text-ink-800">{s.course.title}</div></div>
                  <Badge status={s.status} />
                </div>
                <div className="mt-3 text-[13px] text-slate-600">{meetingText(s.meetings)} · {s.location}</div>
                <div className="mt-4 flex items-center justify-between text-[13px]">
                  <span className="text-slate-600"><strong className="text-slate-900 tabular-nums">{s.enrolled}</strong>/{s.capacity} enrolled{s.waitlisted ? ` · ${s.waitlisted} waitlisted` : ''}</span>
                  <span className={stale ? 'text-amber-700' : 'text-slate-500'}>Attendance {fmtRelative(s.lastAttendance)}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
