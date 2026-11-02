import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, setCsrfToken } from './api.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ user: null, loading: true });
  const qc = useQueryClient();

  const refresh = useCallback(async () => {
    try {
      const res = await api.get('/auth/me');
      setCsrfToken(res.csrfToken);
      setState({ user: res.user, loading: false });
    } catch {
      setCsrfToken(null);
      setState({ user: null, loading: false });
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const onUnauth = () => { setCsrfToken(null); setState({ user: null, loading: false }); qc.clear(); };
    window.addEventListener('cc:unauthorized', onUnauth);
    return () => window.removeEventListener('cc:unauthorized', onUnauth);
  }, [qc]);

  const login = async (email, password) => {
    const res = await api.post('/auth/login', { email, password });
    setCsrfToken(res.csrfToken);
    qc.clear();
    setState({ user: res.user, loading: false });
    return res.user;
  };
  const logout = async () => {
    try { await api.post('/auth/logout'); } finally {
      setCsrfToken(null);
      qc.clear();
      setState({ user: null, loading: false });
    }
  };
  // University sign-in only: end this session and the university session (every app that uses it).
  const logoutEverywhere = async () => {
    let url = null;
    try { url = (await api.post('/auth/oidc/logout-everywhere'))?.url ?? null; } finally {
      setCsrfToken(null);
      qc.clear();
      setState({ user: null, loading: false });
    }
    if (url) window.location.assign(url);
  };
  const can = (perm) => !!state.user?.permissions.includes(perm);

  return <AuthCtx.Provider value={{ ...state, login, logout, logoutEverywhere, refresh, can }}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
// A person may hold several roles (a lecturer who also studies). Each persona has its own area; the server checks
// every request against all of the account's roles, so the persona only chooses what the app shows.
export const PERSONAS = {
  ADMIN: { area: 'admin', home: '/admin', label: 'Administration' },
  REGISTRAR: { area: 'admin', home: '/admin', label: 'Registrar' },
  FACULTY: { area: 'faculty', home: '/faculty', label: 'Teaching' },
  STUDENT: { area: 'student', home: '/student', label: 'Studying' },
};
const PERSONA_KEY = 'campuscore.persona';
export const rolesOf = (user) => user?.roles ?? (user?.role ? [user.role] : []);
export const hasRole = (user, ...roles) => roles.some((r) => rolesOf(user).includes(r));
/** The account's distinct areas, e.g. [{ role: 'FACULTY', ... }, { role: 'STUDENT', ... }]. */
export const personasOf = (user) => {
  const seen = new Set();
  return rolesOf(user).filter((r) => PERSONAS[r] && !seen.has(PERSONAS[r].area) && seen.add(PERSONAS[r].area)).map((r) => ({ role: r, ...PERSONAS[r] }));
};
export function rememberPersona(area) {
  try { localStorage.setItem(PERSONA_KEY, area); } catch { /* private mode: nothing to remember */ }
}
/** Where to go: the only area, the last area this person used, or the chooser. */
export function homeFor(user) {
  const personas = personasOf(user);
  if (!personas.length) return '/login';
  if (personas.length === 1) return personas[0].home;
  let last = null;
  try { last = localStorage.getItem(PERSONA_KEY); } catch { /* ignore */ }
  return personas.find((p) => p.area === last)?.home ?? '/choose';
}
