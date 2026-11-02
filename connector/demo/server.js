// Minimal stand-in for the EdunexusAI experience layer. It never touches CampusCore's database: every
// value on these pages comes through the SIS adapter (OAuth client credentials → /api/v1 → canonical model).
import express from 'express';
import { createSisAdapter, SisError } from '../src/index.js';

const sis = createSisAdapter();
const app = express();
app.use(express.urlencoded({ extended: false }));

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · EdunexusAI demo</title>
<style>
:root{--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--accent:#4f46e5;--bg:#f8fafc}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--ink);background:var(--bg)}
header{background:#111827;color:#fff;padding:14px 24px;display:flex;gap:16px;align-items:center}header a{color:#c7d2fe;text-decoration:none}header b{font-size:16px}
main{max-width:1100px;margin:0 auto;padding:24px}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:0 0 10px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);font-size:13px}th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase}
.muted{color:var(--muted)}.pill{display:inline-block;padding:1px 8px;border-radius:999px;background:#eef2ff;color:#3730a3;font-size:12px}.err{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:10px 12px;border-radius:8px}
.ok{background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;padding:10px 12px;border-radius:8px}input,select,button{font:inherit;padding:7px 10px;border:1px solid #cbd5e1;border-radius:8px}button{background:var(--accent);color:#fff;border:0;cursor:pointer}a{color:var(--accent)}
.kpi{font-size:26px;font-weight:600}.src{font-family:ui-monospace,monospace;font-size:11px;color:var(--muted)}
</style></head><body><header><b>EdunexusAI</b><span class="muted" style="color:#94a3b8">Campus experience · integration demo</span><span style="flex:1"></span><a href="/">Students</a><a href="/announcements">Announcements</a><a href="/status">Connection</a></header><main>${body}</main></body></html>`;

const errorBox = (e) => `<div class="err"><b>CampusCore said:</b> ${esc(e.message)}${e.code ? ` <span class="src">(${esc(e.code)}${e.status ? `, HTTP ${e.status}` : ''})</span>` : ''}${e.retryable ? '<br>This is a temporary problem; EdunexusAI will retry automatically.' : ''}</div>`;
const handle = (fn) => async (req, res) => {
  try { res.send(await fn(req, res)); }
  catch (e) { res.status(e instanceof SisError && e.status ? (e.status >= 500 ? 502 : e.status) : 502).send(page('Error', `<h1>Couldn't load data from the SIS</h1>${errorBox(e)}<p><a href="/status">Check the connection</a></p>`)); }
};

app.get('/', handle(async (req) => {
  const q = req.query.q ?? '';
  const [term, result] = await Promise.all([sis.getCurrentTerm(), sis.searchStudents({ search: q || undefined, status: 'ACTIVE', pageSize: 20 })]);
  return page('Students', `<h1>Students</h1><p class="muted">Live from CampusCore SIS · ${esc(term?.name)} · ${result.total} active students</p>
  <form><input name="q" value="${esc(q)}" placeholder="Search name or ID"> <button>Search</button></form><br>
  <div class="card"><table><tr><th>Name</th><th>ID</th><th>Program</th><th>Level</th><th>Standing</th></tr>
  ${result.items.map((s) => `<tr><td><a href="/students/${esc(s.source.id)}">${esc(s.displayName)}</a></td><td>${esc(s.institutionalId)}</td><td>${esc(s.program ? `${s.program.credential} ${s.program.name}` : '—')}</td><td>${esc(s.level)}</td><td>${esc(s.standing.replace('_', ' '))}${s.hasRegistrationHold ? ' <span class="pill">hold</span>' : ''}</td></tr>`).join('')}</table></div>`);
}));

app.get('/students/:id', handle(async (req) => {
  const id = req.params.id;
  const [s, summary, schedule, grades, terms] = await Promise.all([sis.getStudent(id), sis.getAcademicSummary(id), sis.getStudentSchedule(id), sis.getGradeHistory(id), sis.listTerms()]);
  const canEnroll = sis.capabilities().writes.includes('registrations:write');
  const next = terms.find((t) => t.registrationOpen);
  const flash = req.query.ok ? `<div class="ok">${esc(req.query.ok)}</div><br>` : req.query.err ? `<div class="err">${esc(req.query.err)}</div><br>` : '';
  return page(s.displayName, `${flash}<h1>${esc(s.displayName)}</h1><p class="muted">${esc(s.institutionalId)} · ${esc(s.program?.name ?? 'Undeclared')} · ${esc(s.level)} · <span class="src">source: ${esc(s.source.system)}/${esc(s.source.id)}</span></p>
  <div class="grid">
    <div class="card"><h2>Academic summary</h2><div class="kpi">${summary.gpa?.toFixed(2) ?? '—'}</div><div class="muted">cumulative GPA · ${summary.creditsEarned} credits earned · ${summary.creditsInProgress} in progress · ${esc(summary.standing.replace('_', ' '))}</div></div>
    <div class="card"><h2>${esc(schedule.term.name)} schedule</h2><table>${schedule.items.map((c) => `<tr><td><b>${esc(c.courseCode)}</b>-${esc(c.sectionCode)}<br><span class="muted">${esc(c.courseTitle)}</span></td><td>${c.meetings.map((m) => `${esc(m.day)} ${esc(m.start)}–${esc(m.end)}`).join('<br>')}</td><td>${esc(c.enrollment.status)}</td></tr>`).join('') || '<tr><td class="muted">No classes</td></tr>'}</table></div>
  </div><br>
  ${canEnroll && next ? `<div class="card"><h2>Add a class for ${esc(next.name)}</h2><p class="muted">Submitted to CampusCore, which applies every registration rule (holds, prerequisites, credit limit, capacity) and audits the change.</p>
    <form method="post" action="/students/${esc(id)}/enroll"><input name="sectionId" placeholder="CampusCore section ID" size="40" required> <button>Request registration</button></form></div><br>` : ''}
  <div class="card"><h2>Grade history (published grades only)</h2><table><tr><th>Term</th><th>Course</th><th>Credits</th><th>Grade</th></tr>
  ${grades.flatMap((t) => t.courses.map((c) => `<tr><td>${esc(t.termCode)}</td><td>${esc(c.courseCode)} ${esc(c.courseTitle)}</td><td>${c.credits}</td><td>${c.inProgress ? '<span class="muted">in progress</span>' : esc(c.grade)}</td></tr>`)).reverse().join('')}</table></div>`);
}));

app.post('/students/:id/enroll', async (req, res) => {
  try {
    const e = await sis.enroll(req.params.id, String(req.body.sectionId ?? '').trim());
    res.redirect(`/students/${encodeURIComponent(req.params.id)}?ok=${encodeURIComponent(`CampusCore accepted the request: ${e.status}${e.waitlistPosition ? ` (waitlist #${e.waitlistPosition})` : ''}.`)}`);
  } catch (e) {
    res.redirect(`/students/${encodeURIComponent(req.params.id)}?err=${encodeURIComponent(`${e.message} (${e.code})`)}`);
  }
});

app.get('/announcements', handle(async () => {
  const items = await sis.listAnnouncements();
  return page('Announcements', `<h1>Announcements</h1><div class="grid">${items.map((a) => `<div class="card"><h2>${esc(a.title)}</h2><p>${esc(a.body)}</p><span class="pill">${esc(a.audience)}</span></div>`).join('')}</div>`);
}));

app.get('/status', handle(async () => {
  const inst = await sis.getInstitution();
  const c = sis.client;
  return page('Connection', `<h1>SIS connection</h1><div class="grid">
    <div class="card"><h2>${esc(inst.name)}</h2><p class="muted">Provider: CampusCore SIS at ${esc(c.baseUrl)}</p><p>Token valid until ${new Date(c.token.expiresAt).toLocaleTimeString()}</p></div>
    <div class="card"><h2>Granted scopes</h2>${c.grantedScopes.map((s) => `<span class="pill">${esc(s)}</span>`).join(' ')}</div>
    <div class="card"><h2>Client statistics</h2><p>${c.stats.requests} requests · ${c.stats.tokenRequests} token requests · ${c.stats.retries} retries</p>${c.stats.lastError ? errorBox(c.stats.lastError) : '<p class="muted">No errors.</p>'}</div></div>`);
}));

const port = Number(process.env.PORT ?? 4100);
app.listen(port, () => console.log(`EdunexusAI integration demo on http://localhost:${port} (reading from ${process.env.CAMPUSCORE_BASE_URL})`));
