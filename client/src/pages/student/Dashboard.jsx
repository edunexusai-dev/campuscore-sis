import { Link } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Award, BookOpenCheck, CalendarClock, GraduationCap } from 'lucide-react';
import { useApi } from '../../lib/hooks.js';
import { fmtDate, gpa, meetingText, titleCase } from '../../lib/format.js';
import { PageHeader, Card, Stat, Spinner, Empty, Badge, Alert, Button, ErrorState } from '../../components/ui.jsx';

export default function StudentDashboard() {
  const { data, isLoading, error } = useApi('/student/dashboard');
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <Spinner />;
  const d = data.data;
  const p = d.profile;
  const blocking = p.holds.filter((h) => h.blocksRegistration);
  const credits = d.currentClasses.reduce((s, c) => s + c.course.credits, 0);
  return (
    <>
      <PageHeader eyebrow={d.term?.name} title={`Welcome back, ${p.preferredName || p.firstName}`} subtitle={`${p.program ? `${p.program.degreeType} ${p.program.name}` : 'Undeclared'} · ${titleCase(p.classLevel)} · Student ID ${p.studentNumber}`} />
      {blocking.length > 0 && <Alert tone="warn" title="You have a registration hold" className="mb-5">{blocking.map((h) => h.reason).join(' · ')} <Link to="/student/profile" className="link ml-1">View holds</Link></Alert>}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Cumulative GPA" value={gpa(d.record.cumulativeGpa)} icon={Award} tone="brass" to="/student/grades" />
        <Stat label="Credits earned" value={d.record.creditsEarned} hint={`${d.record.creditsInProgress} in progress`} icon={GraduationCap} to="/student/progress" />
        <Stat label="This term" value={`${credits} cr`} hint={`${d.currentClasses.length} classes`} icon={BookOpenCheck} tone="green" to="/student/schedule" />
        <Stat label="Academic standing" value={titleCase(p.academicStanding)} icon={CalendarClock} tone={p.academicStanding === 'PROBATION' ? 'red' : 'slate'} />
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card title="Current classes" subtitle={d.term?.name} className="xl:col-span-2" padded={false} actions={<Link to="/student/schedule" className="link text-sm">Week view</Link>}>
          {!d.currentClasses.length ? <Empty title="No classes this term" action={d.selfServiceRegistration && <Link to="/student/registration"><Button size="sm">Find classes</Button></Link>} /> : (
            <ul className="divide-y divide-slate-100">
              {d.currentClasses.map((c) => (
                <li key={c.id} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0"><div className="font-medium text-slate-900">{c.course.code} · {c.course.title}</div><div className="text-[13px] text-slate-500">{c.instructors.map((i) => i.name).join(', ')} · {c.course.credits} credits</div></div>
                  <div className="text-[13px] text-slate-600 sm:text-right"><div>{meetingText(c.meetings)}</div><div className="text-slate-400">{c.location}</div></div>
                </li>
              ))}
              {d.waitlisted.map((c) => (
                <li key={c.id} className="flex items-center justify-between px-5 py-3 bg-amber-50/40">
                  <div><div className="font-medium text-slate-900">{c.course.code} · {c.course.title}</div><div className="text-[13px] text-slate-500">Waitlist position #{c.waitlistPosition}</div></div>
                  <Badge status="WAITLISTED" />
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Upcoming dates" padded={false} actions={<Link to="/calendar" className="link text-sm">Calendar</Link>}>
          {!d.upcoming.length ? <Empty title="Nothing upcoming" /> : (
            <ul className="divide-y divide-slate-100">
              {d.upcoming.map((e) => (
                <li key={e.id} className="flex items-center gap-3 px-5 py-2.5">
                  <div className="w-11 shrink-0 rounded-md bg-ink-50 py-1 text-center"><div className="text-[10px] font-semibold uppercase text-ink-600">{fmtDate(e.startDate, { month: 'short' })}</div><div className="text-base font-semibold text-ink-900 tabular-nums leading-none">{Number(String(e.startDate).slice(8, 10))}</div></div>
                  <div className="text-sm text-slate-800">{e.title}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="GPA by term" className="xl:col-span-2">
          {d.record.gpaTrend.length < 1 ? <Empty title="No graded terms yet" description="Your GPA appears after final grades are published." /> : (
            <div className="h-56">
              <ResponsiveContainer>
                <LineChart data={d.record.gpaTrend} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid stroke="#eef0f4" vertical={false} />
                  <XAxis dataKey="term" tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis domain={[0, 4]} ticks={[0, 1, 2, 3, 4]} tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <Tooltip formatter={(v) => Number(v).toFixed(2)} />
                  <Line type="monotone" dataKey="termGpa" name="Term GPA" stroke="#c58f22" strokeWidth={2} dot={{ r: 3 }} />
                  <Line type="monotone" dataKey="cumulativeGpa" name="Cumulative" stroke="#14284b" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
        <Card title="Registration">
          {d.term && <dl className="space-y-2 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">Add/drop deadline</dt><dd className="font-medium">{fmtDate(d.term.addDropDeadline)}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Withdrawal deadline</dt><dd className="font-medium">{fmtDate(d.term.withdrawDeadline)}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Registration status</dt><dd>{blocking.length ? <Badge tone="red">On hold</Badge> : <Badge tone="green">Eligible</Badge>}</dd></div>
          </dl>}
          <div className="mt-4">{d.selfServiceRegistration ? <Link to="/student/registration"><Button variant="secondary" className="w-full">Plan next term</Button></Link> : <p className="text-sm text-slate-500">Online registration is currently closed by the registrar.</p>}</div>
        </Card>
      </div>
    </>
  );
}
