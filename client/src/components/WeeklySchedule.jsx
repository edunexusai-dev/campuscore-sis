import { meetingText } from '../lib/format.js';

const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI'];
const LABEL = { MON: 'Mon', TUE: 'Tue', WED: 'Wed', THU: 'Thu', FRI: 'Fri', SAT: 'Sat', SUN: 'Sun' };
const COLORS = ['bg-ink-100 border-ink-300 text-ink-900', 'bg-brass-100 border-brass-300 text-brass-700', 'bg-emerald-50 border-emerald-300 text-emerald-900', 'bg-sky-50 border-sky-300 text-sky-900', 'bg-violet-50 border-violet-300 text-violet-900', 'bg-rose-50 border-rose-300 text-rose-900'];
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

// Calendar-style week view. `classes` are section DTOs with meetings[]. Weekend columns appear
// only when a class meets then; classes without meeting times are listed, never dropped silently.
export default function WeeklySchedule({ classes }) {
  const meetings = classes.flatMap((c, ci) => (c.meetings ?? []).filter((m) => LABEL[m.day]).map((m) => ({ ...m, c, color: COLORS[ci % COLORS.length] })));
  const unscheduled = classes.filter((c) => !(c.meetings ?? []).length);
  const DAYS = [...WEEKDAYS, ...['SAT', 'SUN'].filter((d) => meetings.some((m) => m.day === d))];
  const missing = unscheduled.length > 0 && (
    <p className="mt-3 text-xs text-amber-700">
      No meeting times scheduled yet: {unscheduled.map((c) => `${c.course.code}-${c.sectionNumber}`).join(', ')}.
    </p>
  );
  if (!meetings.length) return missing || null;
  const start = Math.floor(Math.min(...meetings.map((m) => toMin(m.startTime))) / 60) * 60;
  const end = Math.ceil(Math.max(...meetings.map((m) => toMin(m.endTime))) / 60) * 60;
  const hours = [];
  for (let h = start; h < end; h += 60) hours.push(h);
  const PX = 0.9; // pixels per minute
  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[640px]" style={{ gridTemplateColumns: `56px repeat(${DAYS.length}, 1fr)` }}>
        <div />
        {DAYS.map((d) => <div key={d} className="border-b border-slate-200 pb-2 text-center text-xs font-semibold uppercase tracking-wide text-slate-500">{LABEL[d]}</div>)}
        <div className="relative" style={{ height: (end - start) * PX }}>
          {hours.map((h) => <div key={h} className="absolute right-2 -translate-y-1/2 text-[11px] text-slate-400 tabular-nums" style={{ top: (h - start) * PX }}>{((h / 60 + 11) % 12) + 1}{h < 720 ? 'am' : 'pm'}</div>)}
        </div>
        {DAYS.map((d) => (
          <div key={d} className="relative border-l border-slate-100" style={{ height: (end - start) * PX }}>
            {hours.map((h) => <div key={h} className="absolute inset-x-0 border-t border-slate-100" style={{ top: (h - start) * PX }} />)}
            {meetings.filter((m) => m.day === d).map((m, i) => (
              <div key={i} className={`absolute inset-x-1 overflow-hidden rounded-md border-l-[3px] px-2 py-1 text-[11.5px] leading-tight ${m.color}`} style={{ top: (toMin(m.startTime) - start) * PX + 1, height: (toMin(m.endTime) - toMin(m.startTime)) * PX - 2 }} title={`${m.c.course.code} ${meetingText([m])} ${m.room ?? ''}`}>
                <div className="font-semibold">{m.c.course.code}</div>
                <div className="truncate opacity-80">{m.room ?? m.c.location}</div>
              </div>
            ))}
          </div>
        ))}
      </div>
      {missing}
    </div>
  );
}
