import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth, homeFor } from '../../lib/auth.jsx';
import { Button, Field, Input, Alert } from '../../components/ui.jsx';

// Demo account local parts; the domains come from the institution's configuration.
const demoAccounts = (b) => (b?.emailDomain ? [
  ['Administrator', `admin@${b.emailDomain}`],
  ['Registrar', `registrar@${b.emailDomain}`],
  ['Faculty', `e.vasquez@${b.emailDomain}`],
  ['Student', `maya.chen@${b.studentEmailDomain ?? b.emailDomain}`],
] : []);

// Reason codes from the university sign-in (no identity details are put in the address).
const SSO_ERRORS = {
  NO_INSTITUTIONAL_ID: 'Your university sign-in did not include a student or employee number, so it cannot be matched to a CampusCore account.',
  NO_MATCHING_RECORD: 'No CampusCore record matches your university ID. CampusCore access is for students, faculty and registrar staff with a CampusCore account.',
  NO_CAMPUSCORE_LOGIN: 'Your CampusCore record has no CampusCore login yet. Contact the registrar.',
  NO_CURRENT_RELATIONSHIP: 'Your CampusCore records are not active, so no CampusCore login is created. Contact the registrar.',
  EMAIL_IN_USE: 'Another CampusCore account already uses your university email address. Contact the registrar.',
  IDENTITY_EXCLUDED: 'Your CampusCore record is not set up for university sign-in. Contact the registrar.',
  AMBIGUOUS_RECORDS: 'Your university IDs match more than one CampusCore account. Contact the registrar.',
  EVIDENCE_MISMATCH: 'Your university sign-in does not match the CampusCore account for your ID. Contact the registrar.',
  EMAIL_NOT_VERIFIED: 'Your university email address is not verified, so your account cannot be linked.',
  ACCOUNT_DISABLED: 'This CampusCore account is not active.',
  STAFF_ACCOUNT_NEEDS_ADMIN_LINK: 'Staff accounts can use the university sign-in only after an administrator links it. Use your CampusCore password.',
  ACCOUNT_LINKED_TO_ANOTHER_IDENTITY: 'This CampusCore account is already linked to a different university sign-in.',
  CANCELLED: 'The university sign-in was cancelled.',
  EXPIRED: 'The sign-in took too long. Please try again.',
  INVALID_REQUEST: 'The sign-in could not be completed. Please try again.',
  PROVIDER_UNAVAILABLE: 'The university sign-in is unavailable right now. Use your CampusCore password or try again later.',
  VERIFICATION_FAILED: 'The response from the university sign-in could not be verified.',
  NOT_CONFIGURED: 'University sign-in is not set up for this institution.',
  SIGN_IN_FAILED: 'The university sign-in did not complete. Please try again.',
};

// Demo shortcuts are for the fictional sandbox only; build with VITE_SHOW_DEMO_ACCOUNTS=false for real deployments.
const SHOW_DEMO = import.meta.env.VITE_SHOW_DEMO_ACCOUNTS !== 'false';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [branding, setBranding] = useState(null);
  useEffect(() => { fetch('/api/app/auth/branding').then((r) => r.json()).then((j) => setBranding(j.data)).catch(() => {}); }, []);
  // University sign-in: offered when the server has it configured; failures come back as ?sso_error=CODE.
  const [sso, setSso] = useState(null);
  useEffect(() => { fetch('/api/app/auth/oidc/config').then((r) => r.json()).then((j) => setSso(j.data?.enabled ? j.data : null)).catch(() => {}); }, []);
  const ssoError = new URLSearchParams(window.location.search).get('sso_error');
  const DEMO = SHOW_DEMO ? demoAccounts(branding) : [];

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try { const user = await login(email, password); navigate(homeFor(user), { replace: true }); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <div className="relative hidden overflow-hidden bg-ink-950 lg:flex lg:flex-col lg:justify-between p-12 text-white">
        <div className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)', backgroundSize: '44px 44px' }} aria-hidden />
        <div className="relative flex items-center gap-3">
          <svg viewBox="0 0 32 32" className="size-10" aria-hidden><rect width="32" height="32" rx="7" fill="#f3c969" /><path d="M9 21.5V12l7-3.5 7 3.5v9.5" fill="none" stroke="#14284b" strokeWidth="2.2" strokeLinejoin="round" /><path d="M13 22.5v-6h6v6" fill="none" stroke="#14284b" strokeWidth="2.2" /></svg>
          <span className="font-serif text-2xl font-semibold">CampusCore SIS</span>
        </div>
        <div className="relative max-w-md">
          <p className="font-serif text-[34px] leading-[1.15] font-medium">The academic system of record for modern higher education.</p>
          <p className="mt-5 text-ink-200 text-[15px] leading-relaxed">Registration, records, grading and attendance in one auditable platform, with a secure, scoped API for the campus experience layer.</p>
        </div>
        <div className="relative grid grid-cols-3 gap-6 text-sm text-ink-200">
          <div><div className="text-2xl font-semibold text-white">3</div>role-based portals</div>
          <div><div className="text-2xl font-semibold text-white">OAuth 2.0</div>scoped integrations</div>
          <div><div className="text-2xl font-semibold text-white">100%</div>audited record changes</div>
        </div>
      </div>
      <div className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-sm">
          <h1 className="font-serif text-3xl font-semibold">Sign in</h1>
          {SHOW_DEMO && <p className="mt-1.5 text-sm text-slate-500">Feddrick University · fictional demo institution</p>}
          {ssoError && <div className="mt-6"><Alert tone="error">{SSO_ERRORS[ssoError] ?? SSO_ERRORS.SIGN_IN_FAILED}</Alert></div>}
          {sso && (
            <div className="mt-8">
              <a href="/api/app/auth/oidc/start" className="flex w-full items-center justify-center rounded-lg border border-ink-300 bg-white px-4 py-2.5 text-sm font-semibold text-ink-900 hover:border-ink-500 hover:bg-ink-50">Sign in with {sso.displayName}</a>
              <p className="mt-2 text-center text-xs text-slate-500">What you can do here is set by your CampusCore account, not by the university sign-in.</p>
              <div className="mt-6 flex items-center gap-3 text-xs text-slate-400"><span className="h-px flex-1 bg-slate-200" />or with your CampusCore password<span className="h-px flex-1 bg-slate-200" /></div>
            </div>
          )}
          <form onSubmit={submit} className={sso ? 'mt-4 space-y-4' : 'mt-8 space-y-4'}>
            {error && <Alert tone="error">{error}</Alert>}
            <Field label="Email">{(id) => <Input id={id} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />}</Field>
            <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}</Field>
            <Button type="submit" className="w-full" loading={busy}>Sign in</Button>
          </form>
          {SHOW_DEMO && DEMO.length > 0 && <div className="mt-8 rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Demo accounts</p>
            <p className="mt-1 text-xs text-slate-500">Password for all: <span className="mono font-semibold text-slate-800">Northbridge#2026</span></p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {DEMO.map(([label, addr]) => (
                <button key={addr} type="button" onClick={() => { setEmail(addr); setPassword('Northbridge#2026'); }} className="rounded-lg border border-slate-200 px-3 py-2 text-left text-[13px] hover:border-ink-300 hover:bg-ink-50">
                  <div className="font-medium text-slate-800">{label}</div><div className="truncate text-[11px] text-slate-500">{addr}</div>
                </button>
              ))}
            </div>
          </div>}
        </div>
      </div>
    </div>
  );
}
