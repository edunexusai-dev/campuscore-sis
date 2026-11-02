export const fmtDate = (d, opts = { month: 'short', day: 'numeric', year: 'numeric' }) => (d ? new Date(d).toLocaleDateString(undefined, { timeZone: typeof d === 'string' && d.length === 10 ? 'UTC' : undefined, ...opts }) : '—');
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
export const fmtRelative = (d) => {
  if (!d) return 'never';
  const diff = (Date.now() - new Date(d).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} d ago`;
  return fmtDate(d);
};
export const gpa = (v) => (v == null ? '—' : Number(v).toFixed(2));
export const titleCase = (s) => (s ? s.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '');
const to12 = (t) => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'a' : 'p'}`; };
export const meetingText = (meetings = []) => {
  if (!meetings.length) return 'TBA';
  const groups = {};
  for (const m of meetings) { const k = `${m.startTime}-${m.endTime}`; (groups[k] ??= []).push(m.day ?? ['', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'][m.dayOfWeek]); }
  const abbrev = { MON: 'M', TUE: 'Tu', WED: 'W', THU: 'Th', FRI: 'F', SAT: 'Sa', SUN: 'Su' };
  return Object.entries(groups).map(([k, days]) => { const [s, e] = k.split('-'); return `${days.map((d) => abbrev[d]).join('')} ${to12(s)}–${to12(e)}`; }).join(', ');
};
export const DAY_NAMES = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const download = async (url, filename) => {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error('Download failed');
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
};
