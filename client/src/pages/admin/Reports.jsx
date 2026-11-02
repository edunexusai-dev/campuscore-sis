import { useState } from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, PieChart, Pie, Cell, Legend } from 'recharts';
import { useApi } from '../../lib/hooks.js';
import { titleCase } from '../../lib/format.js';
import { PageHeader, Card, Spinner, Select, ErrorState, Empty } from '../../components/ui.jsx';

const PALETTE = ['#14284b', '#c58f22', '#456196', '#0f766e', '#98abcd', '#a3711a', '#64748b', '#be123c'];
const axis = { tick: { fontSize: 12, fill: '#64748b' }, axisLine: false, tickLine: false };

export default function Reports() {
  const { data: lookups } = useApi('/lookups');
  const [termId, setTermId] = useState('');
  const { data, isLoading, error } = useApi(`/admin/reports${termId ? `?termId=${termId}` : ''}`);
  if (error) return <ErrorState error={error} />;
  const r = data?.data;
  return (
    <>
      <PageHeader title="Reports & analytics" subtitle={r ? `Computed live · ${r.term.name}` : ''} actions={<Select aria-label="Term" value={termId || r?.term.id || ''} onChange={(e) => setTermId(e.target.value)} options={(lookups?.data.terms ?? []).map((t) => ({ value: t.id, label: t.name }))} className="w-48" />} />
      {isLoading ? <Spinner /> : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Enrollment trend" subtitle="Registered + completed seats per term">
            <div className="h-64"><ResponsiveContainer><LineChart data={r.enrollmentTrend} margin={{ left: -10, right: 10 }}><CartesianGrid stroke="#eef0f4" vertical={false} /><XAxis dataKey="term" {...axis} /><YAxis {...axis} /><Tooltip /><Line dataKey="enrollments" name="Enrollments" stroke="#14284b" strokeWidth={2} dot={{ r: 3 }} /></LineChart></ResponsiveContainer></div>
          </Card>
          <Card title="Grade distribution" subtitle={`Published grades · ${r.term.name}`}>
            {!r.gradeDistribution.some((g) => g.count) ? <Empty title="No published grades for this term" /> : (
              <div className="h-64"><ResponsiveContainer><BarChart data={r.gradeDistribution} margin={{ left: -15 }}><CartesianGrid stroke="#eef0f4" vertical={false} /><XAxis dataKey="letter" {...axis} /><YAxis {...axis} allowDecimals={false} /><Tooltip cursor={{ fill: '#f1f5f9' }} /><Bar dataKey="count" name="Grades" fill="#c58f22" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div>
            )}
          </Card>
          <Card title="Active students by program">
            <div className="h-72"><ResponsiveContainer><BarChart data={r.programs} layout="vertical" margin={{ left: 40 }}><CartesianGrid stroke="#eef0f4" horizontal={false} /><XAxis type="number" {...axis} /><YAxis type="category" dataKey="program" width={150} {...axis} /><Tooltip cursor={{ fill: '#f1f5f9' }} /><Bar dataKey="count" name="Students" fill="#456196" radius={[0, 4, 4, 0]} /></BarChart></ResponsiveContainer></div>
          </Card>
          <div className="grid gap-6 sm:grid-cols-2">
            {[['Academic standing', r.standing.map((s) => ({ name: titleCase(s.standing), value: s.count }))], ['Class level', r.classLevels.map((s) => ({ name: titleCase(s.level), value: s.count }))]].map(([title, rows]) => (
              <Card key={title} title={title}>
                <div className="h-60"><ResponsiveContainer><PieChart><Pie data={rows} dataKey="value" nameKey="name" innerRadius={45} outerRadius={75} paddingAngle={2}>{rows.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}</Pie><Tooltip /><Legend iconSize={8} wrapperStyle={{ fontSize: 12 }} /></PieChart></ResponsiveContainer></div>
              </Card>
            ))}
          </div>
          <Card title="Section fill rates" subtitle={r.term.name} padded={false} className="lg:col-span-2">
            <div className="max-h-96 overflow-y-auto">
              <table className="min-w-full"><thead className="sticky top-0"><tr><th className="th">Section</th><th className="th text-right">Enrolled</th><th className="th text-right">Capacity</th><th className="th w-1/2">Fill</th></tr></thead>
                <tbody>{r.sectionFill.map((s) => (
                  <tr key={s.label}><td className="td font-medium">{s.label}</td><td className="td text-right tabular-nums">{s.enrolled}</td><td className="td text-right tabular-nums">{s.capacity}</td>
                    <td className="td"><div className="flex items-center gap-2"><div className="h-2 flex-1 rounded-full bg-slate-100"><div className="h-2 rounded-full" style={{ width: `${Math.min(100, s.fill)}%`, background: s.fill >= 100 ? '#be123c' : s.fill >= 80 ? '#c58f22' : '#14284b' }} /></div><span className="w-10 text-right text-xs tabular-nums text-slate-500">{s.fill}%</span></div></td></tr>
                ))}</tbody>
              </table>
            </div>
          </Card>
          <Card title="Registration channels" subtitle="Where this term's registrations came from">
            <ul className="space-y-2">{r.registrationSources.map((s) => <li key={s.source} className="flex justify-between text-sm"><span className="text-slate-600">{titleCase(s.source)}</span><span className="font-semibold tabular-nums">{s.count}</span></li>)}</ul>
          </Card>
        </div>
      )}
    </>
  );
}
