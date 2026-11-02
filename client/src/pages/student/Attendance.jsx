import { useApi } from '../../lib/hooks.js';
import { fmtDate } from '../../lib/format.js';
import { PageHeader, Card, Spinner, Empty, Badge, ErrorState, cx } from '../../components/ui.jsx';

const DOT = { PRESENT: 'bg-emerald-500', LATE: 'bg-amber-400', ABSENT: 'bg-red-500', EXCUSED: 'bg-slate-400' };

export default function StudentAttendance() {
  const { data, isLoading, error } = useApi('/student/attendance');
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <Spinner />;
  if (data.hidden) return <Card><Empty title="Attendance is not shared" description="Your institution does not display attendance records in the student portal." /></Card>;
  return (
    <>
      <PageHeader title="Attendance" subtitle="Current term attendance as recorded by your instructors." />
      {!data.data.length ? <Card><Empty title="No attendance recorded" /></Card> : (
        <div className="grid gap-5 lg:grid-cols-2">
          {data.data.map((s) => (
            <Card key={s.sectionId} title={`${s.courseCode}-${s.sectionNumber}`} subtitle={s.courseTitle}
              actions={s.summary.rate != null && <Badge tone={s.summary.rate >= 90 ? 'green' : s.summary.rate >= 75 ? 'amber' : 'red'}>{s.summary.rate}% attended</Badge>}>
              <div className="grid grid-cols-4 gap-2 text-center">
                {[['Present', s.summary.attended - s.summary.late], ['Late', s.summary.late], ['Absent', s.summary.absent], ['Excused', s.summary.excused]].map(([l, v]) => (
                  <div key={l} className="rounded-lg bg-slate-50 py-2"><div className="text-lg font-semibold tabular-nums">{v}</div><div className="text-[11px] text-slate-500">{l}</div></div>
                ))}
              </div>
              {s.records.length > 0 && (
                <div className="mt-4 flex flex-wrap gap-1.5" aria-label="Attendance by class date">
                  {s.records.map((r) => <span key={r.date} title={`${fmtDate(r.date)}: ${r.status.toLowerCase()}`} className={cx('size-3.5 rounded-sm', DOT[r.status])} />)}
                </div>
              )}
              <div className="mt-3 flex gap-3 text-[11px] text-slate-500">{Object.entries(DOT).map(([k, c]) => <span key={k} className="flex items-center gap-1"><span className={cx('size-2.5 rounded-sm', c)} />{k.toLowerCase()}</span>)}</div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
