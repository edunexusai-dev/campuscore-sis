import { fmtDate, gpa, titleCase } from '../lib/format.js';

export default function TranscriptView({ t }) {
  return (
    <div className="card mx-auto max-w-4xl p-8 print:p-0">
      <div className="flex flex-col gap-4 border-b-2 border-ink-900 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="font-serif text-2xl font-semibold text-ink-900">{t.institution.name}</div>
          <div className="text-[13px] text-slate-500">{[t.institution.addressLine, t.institution.city, t.institution.region, t.institution.postalCode].filter(Boolean).join(', ')}</div>
        </div>
        <div className="text-right"><div className="text-sm font-semibold uppercase tracking-[0.2em] text-red-700">Unofficial transcript</div><div className="text-xs text-slate-500">Generated {fmtDate(t.generatedAt)}</div></div>
      </div>
      <div className="grid gap-x-8 gap-y-1 py-4 text-sm sm:grid-cols-2">
        <div><span className="text-slate-500">Name:</span> <strong>{t.student.name}</strong></div>
        <div><span className="text-slate-500">Student ID:</span> <span className="mono">{t.student.studentNumber}</span></div>
        <div><span className="text-slate-500">Program:</span> {t.student.program ?? 'Undeclared'}</div>
        <div><span className="text-slate-500">Status / standing:</span> {titleCase(t.student.status)} · {titleCase(t.student.academicStanding)}</div>
      </div>
      {t.terms.map((term) => (
        <div key={term.term.id} className="mt-4 break-inside-avoid">
          <div className="flex items-baseline justify-between border-b border-slate-300 pb-1"><h3 className="text-sm font-semibold uppercase tracking-wide text-ink-900">{term.term.name}</h3><span className="text-xs text-slate-500">Term GPA {gpa(term.termGpa)} · Cumulative {gpa(term.cumulativeGpa)}</span></div>
          <table className="mt-1 w-full text-sm">
            <tbody>
              {term.courses.map((c) => (
                <tr key={c.registrationId}>
                  <td className="w-28 py-1 font-medium">{c.courseCode}</td>
                  <td className="py-1">{c.courseTitle}</td>
                  <td className="w-16 py-1 text-right tabular-nums">{c.credits.toFixed(1)}</td>
                  <td className="w-20 py-1 text-right font-semibold">{c.state === 'IN_PROGRESS' ? <span className="font-normal text-slate-400">IP</span> : c.grade}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <div className="mt-6 grid grid-cols-2 gap-3 border-t-2 border-ink-900 pt-4 text-sm sm:grid-cols-4">
        <div><div className="text-xs text-slate-500">Cumulative GPA</div><div className="text-lg font-semibold">{gpa(t.totals.cumulativeGpa)}</div></div>
        <div><div className="text-xs text-slate-500">Credits attempted</div><div className="text-lg font-semibold">{t.totals.creditsAttempted}</div></div>
        <div><div className="text-xs text-slate-500">Credits earned</div><div className="text-lg font-semibold">{t.totals.creditsEarned}</div></div>
        <div><div className="text-xs text-slate-500">In progress</div><div className="text-lg font-semibold">{t.totals.creditsInProgress}</div></div>
      </div>
      <p className="mt-6 text-[11px] text-slate-400">IP = in progress · W = withdrawn. This unofficial transcript is not valid for external submission and does not bear the Registrar's seal. Fictional data for demonstration.</p>
    </div>
  );
}
