import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAction } from '../lib/hooks.js';
import { NavLink, Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import {
  KeySquare, LayoutDashboard, Users, GraduationCap, BookOpen, CalendarRange, ClipboardCheck, FileText, Wallet, Megaphone, ShieldCheck, Settings2, KeyRound,
  ScrollText, BarChart3, Activity, Building2, UserPlus, ListChecks, Bell, LogOut, Menu, X, CalendarDays, Contact, School, Library, ClipboardList, UserCog, Network, Link2,
} from 'lucide-react';
import { useAuth, personasOf, rememberPersona, homeFor } from '../lib/auth.jsx';
import { useApi } from '../lib/hooks.js';
import { cx, Modal, Button, Field, Input, ApiErrorDetails } from './ui.jsx';

const NAV = {
  admin: [
    { section: 'Overview', items: [{ to: '/admin', label: 'Dashboard', icon: LayoutDashboard, end: true }, { to: '/admin/reports', label: 'Reports', icon: BarChart3, perm: 'reports.view' }] },
    { section: 'Records', items: [
      { to: '/admin/students', label: 'Students', icon: GraduationCap, perm: 'students.manage' },
      { to: '/admin/admissions', label: 'Admissions', icon: UserPlus, perm: 'admissions.manage' },
      { to: '/admin/registrations', label: 'Registrations', icon: ListChecks, perm: 'registrations.manage' },
      { to: '/admin/grades', label: 'Grades', icon: ClipboardCheck, perm: 'grades.approve' },
      { to: '/admin/documents', label: 'Document requests', icon: FileText, perm: 'documents.manage' },
      { to: '/admin/finance', label: 'Student accounts', icon: Wallet, perm: 'finance.manage' },
      { to: '/admin/identity', label: 'Identity links', icon: Link2, perm: 'identity.manage' },
    ] },
    { section: 'Academics', items: [
      { to: '/admin/sections', label: 'Sections', icon: CalendarRange, perm: 'academics.manage' },
      { to: '/admin/courses', label: 'Course catalog', icon: BookOpen, perm: 'academics.manage' },
      { to: '/admin/structure', label: 'Programs & departments', icon: Building2, perm: 'academics.manage' },
      { to: '/admin/terms', label: 'Terms', icon: CalendarDays, perm: 'academics.manage' },
      { to: '/admin/faculty', label: 'Faculty', icon: Users, perm: 'academics.manage' },
      { to: '/admin/communications', label: 'Announcements & calendar', icon: Megaphone, perm: 'communications.manage' },
    ] },
    { section: 'Administration', items: [
      { to: '/admin/policies', label: 'Policies', icon: ShieldCheck, perm: 'policies.manage' },
      { to: '/admin/users', label: 'Users & roles', icon: UserCog, perm: 'users.manage' },
      { to: '/admin/institution', label: 'Institution', icon: Settings2, perm: 'institution.manage' },
      { to: '/admin/integrations', label: 'Developer & integrations', icon: KeyRound, perm: 'integrations.manage' },
      { to: '/admin/audit', label: 'Audit log', icon: ScrollText, perm: 'audit.view' },
      { to: '/admin/system', label: 'System health', icon: Activity, perm: 'audit.view' },
    ] },
  ],
  faculty: [
    { section: 'Teaching', items: [
      { to: '/faculty', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/faculty/schedule', label: 'Teaching schedule', icon: CalendarRange },
      { to: '/faculty/grade-changes', label: 'Grade changes', icon: ClipboardList },
    ] },
  ],
  student: [
    { section: 'My academics', items: [
      { to: '/student', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/student/schedule', label: 'Class schedule', icon: CalendarRange },
      { to: '/student/registration', label: 'Registration', icon: ListChecks },
      { to: '/student/grades', label: 'Grades & GPA', icon: ClipboardCheck },
      { to: '/student/progress', label: 'Degree progress', icon: School },
      { to: '/student/attendance', label: 'Attendance', icon: ClipboardList },
    ] },
    { section: 'Services', items: [
      { to: '/student/transcript', label: 'Unofficial transcript', icon: ScrollText },
      { to: '/student/documents', label: 'Document requests', icon: FileText },
      { to: '/student/profile', label: 'Profile & holds', icon: Contact },
    ] },
  ],
};
const SHARED = { section: 'Campus', items: [{ to: '/announcements', label: 'Announcements', icon: Megaphone }, { to: '/calendar', label: 'Academic calendar', icon: CalendarDays }, { to: '/directory', label: 'Directory', icon: Library }] };

export default function Layout() {
  const { user, logout, logoutEverywhere, can } = useAuth();
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  // The area follows the page (a person with several roles moves between them); shared pages keep the last one.
  const personas = personasOf(user);
  const fromPath = personas.find((p) => location.pathname === p.home || location.pathname.startsWith(`${p.home}/`));
  const persona = fromPath ?? personas.find((p) => p.home === homeFor(user)) ?? personas[0] ?? { area: 'student', label: '' };
  const area = persona.area;
  useEffect(() => { if (fromPath) rememberPersona(fromPath.area); }, [fromPath]);
  const switchTo = (p) => { rememberPersona(p.area); setOpen(false); navigate(p.home); };
  const { data: notes } = useApi('/notifications', { refetchInterval: 60_000 });
  const { data: terms } = useApi('/terms', { staleTime: 300_000 });
  const current = terms?.data.find((t) => t.isCurrent);
  const groups = [...NAV[area].map((g) => ({ ...g, items: g.items.filter((i) => !i.perm || can(i.perm)) })).filter((g) => g.items.length), SHARED];

  const sidebar = (
    <nav className="flex h-full flex-col" aria-label="Main">
      <Link to="/" className="flex items-center gap-2.5 px-5 py-5">
        <svg viewBox="0 0 32 32" className="size-8 shrink-0" aria-hidden><rect width="32" height="32" rx="7" fill="#f3c969" /><path d="M9 21.5V12l7-3.5 7 3.5v9.5" fill="none" stroke="#14284b" strokeWidth="2.2" strokeLinejoin="round" /><path d="M13 22.5v-6h6v6" fill="none" stroke="#14284b" strokeWidth="2.2" /></svg>
        <div className="leading-tight"><div className="font-serif text-[17px] font-semibold text-white">CampusCore</div><div className="text-[10.5px] font-medium uppercase tracking-[0.18em] text-ink-300">Student Information</div></div>
      </Link>
      <div className="flex-1 overflow-y-auto px-3 pb-4">
        {groups.map((g) => (
          <div key={g.section} className="mt-4">
            <div className="px-3 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-400">{g.section}</div>
            {g.items.map((i) => (
              <NavLink key={i.to} to={i.to} end={i.end} onClick={() => setOpen(false)}
                className={({ isActive }) => cx('group flex items-center gap-2.5 rounded-lg px-3 py-[7px] text-[13.5px] font-medium transition-colors', isActive ? 'bg-white/10 text-white' : 'text-ink-200 hover:bg-white/5 hover:text-white')}>
                {({ isActive }) => <><i.icon className={cx('size-[17px]', isActive ? 'text-brass-300' : 'text-ink-400 group-hover:text-ink-200')} aria-hidden />{i.label}</>}
              </NavLink>
            ))}
          </div>
        ))}
      </div>
      <div className="border-t border-white/10 p-3">
        {personas.length > 1 && (
          <div className="mb-2 px-2" role="group" aria-label="Switch role">
            <div className="pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-400">Viewing as</div>
            <div className="grid gap-1 rounded-lg bg-white/5 p-1" style={{ gridTemplateColumns: `repeat(${personas.length}, minmax(0, 1fr))` }}>
              {personas.map((p) => (
                <button key={p.area} type="button" onClick={() => switchTo(p)} aria-pressed={p.area === area}
                  className={cx('rounded-md px-2 py-1.5 text-[12.5px] font-medium transition-colors', p.area === area ? 'bg-white text-ink-950' : 'text-ink-200 hover:bg-white/10 hover:text-white')}>{p.label}</button>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-center gap-3 rounded-lg px-2 py-2">
          <div className="flex size-9 items-center justify-center rounded-full bg-ink-700 text-sm font-semibold text-white">{user.firstName[0]}{user.lastName[0]}</div>
          <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-white">{user.firstName} {user.lastName}</div><div className="truncate text-xs text-ink-300">{personas.length > 1 ? persona.label : user.role.charAt(0) + user.role.slice(1).toLowerCase()} · {user.institution.shortName}</div></div>
          {user.hasPassword !== false && <button onClick={() => setPwOpen(true)} className="rounded-md p-1.5 text-ink-300 hover:bg-white/10 hover:text-white" aria-label="Change password" title="Change password"><KeySquare className="size-4" /></button>}
          <button onClick={() => (user.signInMethod === 'SSO' ? setSignOutOpen((v) => !v) : logout())} className="rounded-md p-1.5 text-ink-300 hover:bg-white/10 hover:text-white" aria-label="Sign out" aria-expanded={user.signInMethod === 'SSO' ? signOutOpen : undefined} title="Sign out"><LogOut className="size-4" /></button>
        </div>
        {signOutOpen && user.signInMethod === 'SSO' && (
          <div className="mt-1 space-y-1 rounded-lg bg-white/5 p-2" role="group" aria-label="Sign-out options">
            <button onClick={logout} className="block w-full rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink-100 hover:bg-white/10">Sign out of CampusCore<span className="block text-[11px] text-ink-300">Other university apps stay signed in.</span></button>
            <button onClick={logoutEverywhere} className="block w-full rounded-md px-2.5 py-1.5 text-left text-[13px] text-ink-100 hover:bg-white/10">Sign out of all university apps<span className="block text-[11px] text-ink-300">Ends your university sign-in, including EdunexusAI.</span></button>
          </div>
        )}
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen lg:pl-64">
      <aside className="no-print fixed inset-y-0 left-0 z-30 hidden w-64 bg-ink-950 lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <aside className="relative h-full w-72 max-w-[85vw] bg-ink-950">{sidebar}<button className="absolute right-3 top-5 text-white/70" onClick={() => setOpen(false)} aria-label="Close menu"><X className="size-5" /></button></aside>
        </div>
      )}
      <header className="no-print sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-slate-200/80 bg-canvas/90 px-4 backdrop-blur sm:px-6">
        <button className="rounded-md p-1.5 text-slate-600 hover:bg-slate-200/60 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu className="size-5" /></button>
        <div className="min-w-0 flex-1 truncate text-sm text-slate-500"><span className="font-medium text-slate-800">{user.institution.name}</span>{current && <span className="hidden sm:inline"> · {current.name} <span className="text-slate-400">({current.status.replace('_', ' ').toLowerCase()})</span></span>}</div>
        <a href="/api/docs" target="_blank" rel="noreferrer" className={cx('hidden text-[13px] font-medium text-slate-500 hover:text-slate-900 sm:inline', area !== 'admin' && 'sm:hidden')}><Network className="mr-1 inline size-4" />API docs</a>
        <Link to="/notifications" className="relative rounded-md p-2 text-slate-600 hover:bg-slate-200/60" aria-label={`Notifications${notes?.unread ? ` (${notes.unread} unread)` : ''}`}>
          <Bell className="size-5" />
          {notes?.unread > 0 && <span className="absolute right-1 top-1 flex min-w-4 h-4 items-center justify-center rounded-full bg-brass-400 px-1 text-[10px] font-bold text-ink-950">{notes.unread}</span>}
        </Link>
      </header>
      <ChangePassword open={pwOpen} onClose={() => setPwOpen(false)} />
      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8" key={location.pathname.split('/').slice(0, 3).join('/')}>
        <Outlet />
      </main>
    </div>
  );
}

function ChangePassword({ open, onClose }) {
  const [f, setF] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const save = useAction(() => api.post('/auth/change-password', { currentPassword: f.currentPassword, newPassword: f.newPassword }), { success: 'Password changed. Your other sessions were signed out.', onSuccess: () => close(), toastErrors: false });
  const close = () => { setF({ currentPassword: '', newPassword: '', confirm: '' }); save.reset(); onClose(); };
  const mismatch = f.confirm && f.confirm !== f.newPassword;
  return (
    <Modal open={open} onClose={close} size="sm" title="Change password" footer={<><Button variant="secondary" onClick={close}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!f.currentPassword || f.newPassword.length < 10 || f.newPassword !== f.confirm}>Change password</Button></>}>
      <div className="space-y-4">
        <ApiErrorDetails error={save.error} />
        <Field label="Current password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} />}</Field>
        <Field label="New password" hint="At least 10 characters">{(id) => <Input id={id} type="password" autoComplete="new-password" value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} />}</Field>
        <Field label="Confirm new password" error={mismatch ? 'Passwords do not match' : undefined}>{(id) => <Input id={id} type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} />}</Field>
      </div>
    </Modal>
  );
}
