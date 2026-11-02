import { Navigate, useNavigate } from 'react-router-dom';
import { ArrowRight, GraduationCap, Presentation, ShieldCheck } from 'lucide-react';
import { useAuth, personasOf, rememberPersona } from '../../lib/auth.jsx';

const ICONS = { admin: ShieldCheck, faculty: Presentation, student: GraduationCap };
const DESCRIPTIONS = {
  admin: 'Records, academics and administration.',
  faculty: 'Your sections, rosters, attendance and grading.',
  student: 'Your registration, schedule, grades and documents.',
};

// Shown after sign-in to a person who holds more than one role (e.g. a lecturer who is also a student). Both areas
// belong to the same account; the choice is remembered on this device and can be changed from the sidebar.
export default function ChoosePersona() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const personas = personasOf(user);
  if (personas.length < 2) return <Navigate to={personas[0]?.home ?? '/login'} replace />;
  const choose = (p) => { rememberPersona(p.area); navigate(p.home, { replace: true }); };
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-md">
        <h1 className="font-serif text-3xl font-semibold text-slate-900">Welcome, {user.firstName}</h1>
        <p className="mt-1.5 text-sm text-slate-500">Your CampusCore account has more than one role. Where would you like to start?</p>
        <ul className="mt-6 space-y-3">
          {personas.map((p) => {
            const Icon = ICONS[p.area];
            return (
              <li key={p.area}>
                <button type="button" onClick={() => choose(p)} className="group flex w-full items-center gap-4 rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-ink-300 hover:bg-ink-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink-500">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-ink-950 text-brass-300"><Icon className="size-5" aria-hidden /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-slate-900">{p.label}</span>
                    <span className="block text-[13px] text-slate-500">{DESCRIPTIONS[p.area]}</span>
                  </span>
                  <ArrowRight className="size-4 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-ink-700" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
        <p className="mt-4 text-xs text-slate-500">You can switch at any time from the menu.</p>
      </div>
    </main>
  );
}
