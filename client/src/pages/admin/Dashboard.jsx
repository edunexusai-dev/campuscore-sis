import { Link } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { GraduationCap, ListChecks, Percent, KeyRound, ChevronRight } from 'lucide-react';
import { useApi } from '../../lib/hooks.js';
import { fmtRelative, titleCase } from '../../lib/format.js';
import { PageHeader, Card, Stat, Spinner, Badge, ErrorState, Empty } from '../../components/ui.jsx';

export default function AdminDashboard() {
  const { data, isLoading, error } = useApi('/admin/dashboard');
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <Spinner />;
  const d = data.data;
  return (
    <>
      <PageHeader eyebrow={d.term ? `${d.term.name} · ${titleCase(d.term.status)}` : undefined} title="Registrar operations" subtitle="Live figures from the system of record." />
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Stat label="Active students" value={d.kpis.activeStudents.toLocaleString()} hint={`${d.kpis.totalStudents} records total`} icon={GraduationCap} to="/admin/students?status=ACTIVE" />
        <Stat label="Term registrations" value={d.kpis.termRegistrations.toLocaleString()} hint={`${d.kpis.termWaitlisted} waitlisted`} icon={ListChecks} tone="green" to="/admin/registrations" />
        <Stat label="Seat fill rate" value={`${d.kpis.fillRate}%`} hint={`${d.kpis.sections} active sections`} icon={Percent} tone="brass" to="/admin/sections" />
        <Stat label="API calls (24h)" value={d.kpis.apiCalls24h.toLocaleString()} hint={`${d.kpis.integrations} active integrations`} icon={KeyRound} tone="slate" to="/admin/integrations" />
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card title="Needs attention" padded={false}>
          <ul className="divide-y divide-slate-100">
            {d.worklist.map((w) => (
              <li key={w.key}><Link to={w.link} className="flex items-center justify-between px-5 py-3 hover:bg-slate-50">
                <span className="text-sm text-slate-700">{w.label}</span>
                <span className="flex items-center gap-2">{w.count > 0 ? <Badge tone="amber">{w.count}</Badge> : <Badge tone="green">0</Badge>}<ChevronRight className="size-4 text-slate-300" /></span>
              </Link></li>
            ))}
            <li><Link to="/admin/students?hasHold=true" className="flex items-center justify-between px-5 py-3 hover:bg-slate-50"><span className="text-sm text-slate-700">Active holds</span><span className="flex items-center gap-2"><Badge tone="slate">{d.kpis.activeHolds}</Badge><ChevronRight className="size-4 text-slate-300" /></span></Link></li>
          </ul>
        </Card>
        <Card title="Enrollment by department" subtitle={`${d.term?.name ?? ''} · registered seats vs capacity`} className="xl:col-span-2">
          {!d.enrollmentByDepartment.length ? <Empty title="No sections this term" /> : (
            <div className="h-64">
              <ResponsiveContainer>
                <BarChart data={d.enrollmentByDepartment} margin={{ top: 5, right: 5, left: -15, bottom: 0 }}>
                  <CartesianGrid stroke="#eef0f4" vertical={false} />
                  <XAxis dataKey="department" tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <Tooltip cursor={{ fill: '#f1f5f9' }} labelFormatter={(l, p) => p?.[0]?.payload.name ?? l} />
                  <Bar dataKey="capacity" name="Capacity" fill="#e3e9f3" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="enrolled" name="Enrolled" fill="#14284b" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
        <Card title="Students by status" padded={false}>
          <ul className="divide-y divide-slate-100">
            {d.studentsByStatus.sort((a, b) => b.count - a.count).map((s) => (
              <li key={s.status}><Link to={`/admin/students?status=${s.status}`} className="flex items-center justify-between px-5 py-2.5 hover:bg-slate-50"><Badge status={s.status} /><span className="text-sm font-semibold tabular-nums text-slate-800">{s.count}</span></Link></li>
            ))}
          </ul>
        </Card>
        <Card title="Recent activity" className="xl:col-span-2" padded={false} actions={<Link to="/admin/audit" className="link text-sm">Audit log</Link>}>
          <ul className="divide-y divide-slate-100">
            {d.recentActivity.map((a) => (
              <li key={a.id} className="flex items-start justify-between gap-4 px-5 py-2.5">
                <div className="min-w-0"><div className="truncate text-sm text-slate-800">{a.summary}</div><div className="text-xs text-slate-500">{a.actor} · <span className="mono">{a.action}</span></div></div>
                <span className="shrink-0 text-xs text-slate-400">{fmtRelative(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
