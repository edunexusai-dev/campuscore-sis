// Copies a reviewed subset of one CampusCore database into another: the academic structure and course catalog, and
// named people with their student/faculty records, KEEPING their person, student and employee numbers (so accounts
// already issued for them elsewhere, e.g. in the university sign-in, still identify them).
//
//   export (source database):  node scripts/import-subset.js export --slug feddrick --people P0000024,P0000002 --out subset.json
//   import (target database):  node scripts/import-subset.js import --slug feddrick --file subset.json            (dry run)
//                              node scripts/import-subset.js import --slug feddrick --file subset.json --apply    (writes)
//
// Never copied: logins (User rows) and passwords, sessions, sections, registrations, grades, holds, applications,
// documents, identity links, integration clients, policies, the institution's address/contact profile, and personal
// details of people (date of birth, home address, phone, personal email, emergency contact, financial references).
// Logins are created at the person's first university sign-in (OIDC_JIT_ACCOUNTS).
//
// Import rules: everything is matched on its natural key (codes, names, numbers). An existing identical row is left
// alone; an existing DIFFERENT row is a conflict and is never overwritten. Any conflict refuses the whole apply. The
// apply is one transaction; the database triggers queue the imported people for university-account provisioning.
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { PrismaClient } from '@prisma/client';

const FORMAT = 'campuscore-subset/1';
const { positionals: [mode], values: a } = parseArgs({ allowPositionals: true, options: { slug: { type: 'string' }, people: { type: 'string', default: '' }, out: { type: 'string' }, file: { type: 'string' }, apply: { type: 'boolean', default: false } } });
const fail = (msg) => { console.error(msg); process.exit(1); };
if (!['export', 'import'].includes(mode) || !a.slug) fail('Usage: import-subset.js export|import --slug <institution> (see the header of this file).');

const prisma = new PrismaClient();
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const iso = (d) => (d ? new Date(d).toISOString() : null);

// ── Export ──
async function exportSubset() {
  if (!a.out) fail('Missing --out');
  const inst = await prisma.institution.findUnique({ where: { slug: a.slug } });
  if (!inst) fail(`No institution "${a.slug}".`);
  const w = { institutionId: inst.id };
  const numbers = a.people.split(',').map((s) => s.trim()).filter(Boolean);
  const people = [];
  for (const personNumber of numbers) {
    const p = await prisma.person.findFirst({ where: { ...w, personNumber }, include: { student: { include: { program: true, admitTerm: true } }, faculty: { include: { department: true } } } });
    if (!p) fail(`No person ${personNumber} in ${a.slug}.`);
    if (p.mergedIntoId) fail(`${personNumber} was merged into another person; export the surviving person instead.`);
    if (!p.student && !p.faculty) fail(`${personNumber} has no student or faculty record.`);
    const s = p.student;
    const f = p.faculty;
    people.push({
      personNumber,
      identityExcluded: p.identityExcluded,
      student: s && { studentNumber: s.studentNumber, firstName: s.firstName, lastName: s.lastName, preferredName: s.preferredName, email: s.email, status: s.status, classLevel: s.classLevel, academicStanding: s.academicStanding, expectedGraduation: s.expectedGraduation, programCode: s.program?.code ?? null, admitTermCode: s.admitTerm?.code ?? null },
      faculty: f && { employeeNumber: f.employeeNumber, firstName: f.firstName, lastName: f.lastName, email: f.email, title: f.title, status: f.status, officeLocation: f.officeLocation, officeHours: f.officeHours, departmentCode: f.department.code },
    });
  }
  const [colleges, departments, programs, years, terms, courses, prereqs, reqs] = await Promise.all([
    prisma.college.findMany({ where: w, orderBy: { code: 'asc' } }),
    prisma.department.findMany({ where: w, include: { college: true }, orderBy: { code: 'asc' } }),
    prisma.program.findMany({ where: w, include: { department: true }, orderBy: { code: 'asc' } }),
    prisma.academicYear.findMany({ where: w, orderBy: { startDate: 'asc' } }),
    prisma.term.findMany({ where: w, include: { academicYear: true }, orderBy: { startDate: 'asc' } }),
    prisma.course.findMany({ where: w, include: { department: true }, orderBy: { code: 'asc' } }),
    prisma.coursePrerequisite.findMany({ where: { course: w }, include: { course: true, prerequisite: true } }),
    prisma.programRequirement.findMany({ where: { program: w }, include: { program: true, course: true } }),
  ]);
  const subset = {
    format: FORMAT,
    source: { slug: a.slug, exportedAt: new Date().toISOString() },
    institution: { emailDomain: inst.emailDomain, studentEmailDomain: inst.studentEmailDomain },
    colleges: colleges.map((c) => ({ code: c.code, name: c.name })),
    departments: departments.map((d) => ({ code: d.code, name: d.name, collegeCode: d.college.code, officeLocation: d.officeLocation, email: d.email })),
    programs: programs.map((p) => ({ code: p.code, name: p.name, degreeType: p.degreeType, level: p.level, requiredCredits: p.requiredCredits, minGpa: p.minGpa.toString(), description: p.description, active: p.active, departmentCode: p.department.code })),
    academicYears: years.map((y) => ({ name: y.name, startDate: day(y.startDate), endDate: day(y.endDate) })),
    terms: terms.map((t) => ({ code: t.code, name: t.name, academicYearName: t.academicYear.name, startDate: day(t.startDate), endDate: day(t.endDate), registrationOpens: iso(t.registrationOpens), registrationCloses: iso(t.registrationCloses), addDropDeadline: iso(t.addDropDeadline), withdrawDeadline: iso(t.withdrawDeadline), gradesDueDate: iso(t.gradesDueDate), status: t.status, isCurrent: t.isCurrent })),
    courses: courses.map((c) => ({ code: c.code, title: c.title, description: c.description, credits: c.credits, level: c.level, active: c.active, departmentCode: c.department.code })),
    coursePrerequisites: prereqs.map((p) => ({ courseCode: p.course.code, prerequisiteCode: p.prerequisite.code, minGrade: p.minGrade })).sort((x, y) => `${x.courseCode}${x.prerequisiteCode}`.localeCompare(`${y.courseCode}${y.prerequisiteCode}`)),
    programRequirements: reqs.map((r) => ({ programCode: r.program.code, courseCode: r.course.code, category: r.category })).sort((x, y) => `${x.programCode}${x.courseCode}`.localeCompare(`${y.programCode}${y.courseCode}`)),
    people,
  };
  fs.writeFileSync(a.out, `${JSON.stringify(subset, null, 2)}\n`);
  console.log(`Exported to ${a.out}: ${['colleges', 'departments', 'programs', 'academicYears', 'terms', 'courses', 'coursePrerequisites', 'programRequirements', 'people'].map((k) => `${subset[k].length} ${k}`).join(', ')}.`);
}

// ── Import ──
const same = (row, want, keys) => keys.filter((k) => {
  const have = row[k] instanceof Date ? (want[k]?.length === 10 ? day(row[k]) : iso(row[k])) : row[k] != null && typeof row[k] === 'object' ? row[k].toString() : row[k];
  return String(have ?? '') !== String(want[k] ?? '');
});

async function planImport(tx, inst, s) {
  const w = { institutionId: inst.id };
  const plan = { create: {}, same: {}, conflicts: [], warnings: [], institution: null };
  const tally = (kind, entity, label) => { (plan[kind][entity] ??= []).push(label); };
  const conflict = (entity, key, msg) => plan.conflicts.push(`${entity} ${key}: ${msg}`);
  const byKey = async (model, where) => tx[model].findFirst({ where: { ...w, ...where } });

  const fill = Object.entries(s.institution ?? {}).filter(([, v]) => v);
  const changes = {};
  for (const [k, v] of fill) {
    if (!inst[k]) changes[k] = v;
    else if (inst[k] !== v) conflict('institution', k, `is "${inst[k]}" here, "${v}" in the subset`);
  }
  plan.institution = changes;

  const check = async (entity, model, where, want, keys, refs = {}) => {
    const row = await byKey(model, where);
    const key = Object.values(where).join('/');
    if (!row) return tally('create', entity, key);
    const diff = same(row, want, keys);
    for (const [field, expectedId] of Object.entries(refs)) if (expectedId !== undefined && row[field] !== expectedId) diff.push(field);
    if (diff.length) conflict(entity, key, `exists with different ${diff.join(', ')}`);
    else tally('same', entity, key);
  };
  const idOf = async (model, where) => (await byKey(model, where))?.id;
  for (const c of s.colleges) await check('college', 'college', { code: c.code }, c, ['name']);
  for (const d of s.departments) await check('department', 'department', { code: d.code }, d, ['name', 'officeLocation', 'email'], { collegeId: await idOf('college', { code: d.collegeCode }) });
  for (const p of s.programs) await check('program', 'program', { code: p.code }, p, ['name', 'degreeType', 'level', 'requiredCredits', 'minGpa', 'description', 'active'], { departmentId: await idOf('department', { code: p.departmentCode }) });
  for (const y of s.academicYears) await check('academicYear', 'academicYear', { name: y.name }, y, ['startDate', 'endDate']);
  for (const t of s.terms) await check('term', 'term', { code: t.code }, t, ['name', 'startDate', 'endDate', 'registrationOpens', 'registrationCloses', 'addDropDeadline', 'withdrawDeadline', 'gradesDueDate', 'status', 'isCurrent'], { academicYearId: await idOf('academicYear', { name: t.academicYearName }) });
  for (const c of s.courses) await check('course', 'course', { code: c.code }, c, ['title', 'description', 'credits', 'level', 'active'], { departmentId: await idOf('department', { code: c.departmentCode }) });
  const current = s.terms.filter((t) => t.isCurrent);
  if (current.length > 1) conflict('term', 'isCurrent', 'the subset marks several terms current');
  const otherCurrent = await tx.term.findFirst({ where: { ...w, isCurrent: true, code: { notIn: current.map((t) => t.code) } } });
  if (current.length && otherCurrent) conflict('term', otherCurrent.code, `is already the current term here; the subset makes ${current[0].code} current`);

  for (const r of s.coursePrerequisites) {
    const [course, pre] = [await idOf('course', { code: r.courseCode }), await idOf('course', { code: r.prerequisiteCode })];
    const row = course && pre ? await tx.coursePrerequisite.findUnique({ where: { courseId_prerequisiteId: { courseId: course, prerequisiteId: pre } } }) : null;
    const key = `${r.courseCode}→${r.prerequisiteCode}`;
    if (!row) tally('create', 'coursePrerequisite', key);
    else if (row.minGrade !== r.minGrade) conflict('coursePrerequisite', key, 'exists with a different minimum grade');
    else tally('same', 'coursePrerequisite', key);
  }
  for (const r of s.programRequirements) {
    const [program, course] = [await idOf('program', { code: r.programCode }), await idOf('course', { code: r.courseCode })];
    const row = program && course ? await tx.programRequirement.findUnique({ where: { programId_courseId: { programId: program, courseId: course } } }) : null;
    const key = `${r.programCode}:${r.courseCode}`;
    if (!row) tally('create', 'programRequirement', key);
    else if (row.category !== r.category) conflict('programRequirement', key, 'exists with a different category');
    else tally('same', 'programRequirement', key);
  }

  const codes = (list) => new Set(list.map((x) => x.code));
  const [deptCodes, programCodes, termCodes] = [codes(s.departments), codes(s.programs), codes(s.terms)];
  for (const p of s.people) {
    const existing = await tx.person.findFirst({ where: { ...w, personNumber: p.personNumber }, include: { student: true, faculty: true } });
    if (existing) {
      const ok = (!p.student || existing.student?.studentNumber === p.student.studentNumber) && (!p.faculty || existing.faculty?.employeeNumber === p.faculty.employeeNumber);
      if (ok) tally('same', 'person', p.personNumber);
      else conflict('person', p.personNumber, 'this person number already belongs to someone else here');
      continue;
    }
    if (p.student) {
      const taken = await tx.student.findFirst({ where: { ...w, studentNumber: p.student.studentNumber } });
      if (taken) conflict('person', p.personNumber, `student number ${p.student.studentNumber} is already used here`);
      if (p.student.programCode && !programCodes.has(p.student.programCode) && !(await idOf('program', { code: p.student.programCode }))) conflict('person', p.personNumber, `program ${p.student.programCode} is neither here nor in the subset`);
      if (p.student.admitTermCode && !termCodes.has(p.student.admitTermCode) && !(await idOf('term', { code: p.student.admitTermCode }))) conflict('person', p.personNumber, `admit term ${p.student.admitTermCode} is neither here nor in the subset`);
    }
    if (p.faculty) {
      const taken = await tx.faculty.findFirst({ where: { ...w, employeeNumber: p.faculty.employeeNumber } });
      if (taken) conflict('person', p.personNumber, `employee number ${p.faculty.employeeNumber} is already used here`);
      if (!deptCodes.has(p.faculty.departmentCode) && !(await idOf('department', { code: p.faculty.departmentCode }))) conflict('person', p.personNumber, `department ${p.faculty.departmentCode} is neither here nor in the subset`);
    }
    for (const email of [p.student?.email, p.faculty?.email].filter(Boolean)) {
      const login = await tx.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { role: true } });
      if (login) plan.warnings.push(`${p.personNumber}: a ${login.role} login already uses ${email}; their first university sign-in would be refused (EMAIL_IN_USE) until resolved`);
    }
    tally('create', 'person', `${p.personNumber} (${[p.student && `student ${p.student.studentNumber}`, p.faculty && `faculty ${p.faculty.employeeNumber}`].filter(Boolean).join(' + ')})`);
  }
  return plan;
}

async function applyImport(tx, inst, s) {
  const w = { institutionId: inst.id };
  const ids = { college: {}, department: {}, program: {}, academicYear: {}, term: {}, course: {} };
  const ensure = async (model, key, where, data) => {
    const row = (await tx[model].findFirst({ where: { ...w, ...where } })) ?? (await tx[model].create({ data: { ...w, ...data } }));
    ids[model][key] = row.id;
  };
  if (Object.keys(s.__plan.institution).length) await tx.institution.update({ where: { id: inst.id }, data: s.__plan.institution });
  for (const c of s.colleges) await ensure('college', c.code, { code: c.code }, { code: c.code, name: c.name });
  for (const { collegeCode, ...d } of s.departments) await ensure('department', d.code, { code: d.code }, { ...d, collegeId: ids.college[collegeCode] });
  for (const { departmentCode, ...p } of s.programs) await ensure('program', p.code, { code: p.code }, { ...p, departmentId: ids.department[departmentCode] });
  for (const y of s.academicYears) await ensure('academicYear', y.name, { name: y.name }, { name: y.name, startDate: new Date(y.startDate), endDate: new Date(y.endDate) });
  for (const { academicYearName, ...t } of s.terms) {
    await ensure('term', t.code, { code: t.code }, { ...t, academicYearId: ids.academicYear[academicYearName], startDate: new Date(t.startDate), endDate: new Date(t.endDate) });
  }
  for (const { departmentCode, ...c } of s.courses) await ensure('course', c.code, { code: c.code }, { ...c, departmentId: ids.department[departmentCode] });
  for (const r of s.coursePrerequisites) {
    const data = { courseId: ids.course[r.courseCode], prerequisiteId: ids.course[r.prerequisiteCode], minGrade: r.minGrade };
    await tx.coursePrerequisite.upsert({ where: { courseId_prerequisiteId: { courseId: data.courseId, prerequisiteId: data.prerequisiteId } }, create: data, update: {} });
  }
  for (const r of s.programRequirements) {
    const data = { programId: ids.program[r.programCode], courseId: ids.course[r.courseCode], category: r.category };
    await tx.programRequirement.upsert({ where: { programId_courseId: { programId: data.programId, courseId: data.courseId } }, create: data, update: {} });
  }
  const actor = { institutionId: inst.id, actorType: 'SYSTEM', actorLabel: 'System (subset import)' };
  const created = [];
  for (const p of s.people) {
    if (await tx.person.findFirst({ where: { ...w, personNumber: p.personNumber } })) continue;
    const person = await tx.person.create({ data: { ...w, personNumber: p.personNumber, identityExcluded: Boolean(p.identityExcluded) } });
    if (p.student) {
      const { programCode, admitTermCode, ...st } = p.student;
      await tx.student.create({ data: { ...w, ...st, personId: person.id, programId: programCode ? ids.program[programCode] ?? (await tx.program.findFirst({ where: { ...w, code: programCode } })).id : null, admitTermId: admitTermCode ? ids.term[admitTermCode] ?? (await tx.term.findFirst({ where: { ...w, code: admitTermCode } })).id : null } });
    }
    if (p.faculty) {
      const { departmentCode, ...fa } = p.faculty;
      await tx.faculty.create({ data: { ...w, ...fa, personId: person.id, departmentId: ids.department[departmentCode] ?? (await tx.department.findFirst({ where: { ...w, code: departmentCode } })).id } });
    }
    await tx.auditEvent.create({ data: { ...actor, action: 'person.imported', entityType: 'Person', entityId: person.id, summary: `Imported ${p.personNumber} (${[p.student && `student ${p.student.studentNumber}`, p.faculty && `faculty ${p.faculty.employeeNumber}`].filter(Boolean).join(' + ')}) from ${s.source.slug} export ${s.source.exportedAt}; numbers kept, no login created` } });
    created.push(p.personNumber);
  }
  await tx.auditEvent.create({ data: { ...actor, action: 'catalog.imported', entityType: 'Institution', entityId: inst.id, summary: `Imported academic structure and catalog from ${s.source.slug} export ${s.source.exportedAt}: ${s.colleges.length} colleges, ${s.departments.length} departments, ${s.programs.length} programs, ${s.academicYears.length} academic years, ${s.terms.length} terms, ${s.courses.length} courses (existing identical rows kept)` } });
  return created;
}

async function importSubset() {
  if (!a.file) fail('Missing --file');
  const s = JSON.parse(fs.readFileSync(a.file, 'utf8'));
  if (s.format !== FORMAT) fail(`Not a ${FORMAT} file.`);
  const inst = await prisma.institution.findUnique({ where: { slug: a.slug } });
  if (!inst) fail(`No institution "${a.slug}" here (create it with scripts/bootstrap.js first).`);
  const plan = await planImport(prisma, inst, s);
  console.log(`${a.apply ? 'APPLY' : 'DRY RUN (nothing written; add --apply)'} · ${s.source.slug} export ${s.source.exportedAt} → ${inst.slug}`);
  console.log(`  institution: ${Object.keys(plan.institution).length ? `set ${Object.entries(plan.institution).map(([k, v]) => `${k}=${v}`).join(', ')}` : 'no change'}`);
  for (const entity of [...new Set([...Object.keys(plan.create), ...Object.keys(plan.same)])]) console.log(`  ${entity.padEnd(19)} create ${String(plan.create[entity]?.length ?? 0).padStart(3)} · already present ${plan.same[entity]?.length ?? 0}`);
  for (const p of plan.create.person ?? []) console.log(`    + person ${p}`);
  for (const x of plan.warnings) console.log(`  warning: ${x}`);
  for (const x of plan.conflicts) console.log(`  CONFLICT ${x}`);
  if (plan.conflicts.length) { console.log(`${plan.conflicts.length} conflict(s): nothing ${a.apply ? 'was ' : 'would be '}written.`); process.exitCode = 2; return; }
  if (!a.apply) return;
  const created = await prisma.$transaction(async (tx) => {
    const again = await planImport(tx, inst, s); // re-checked inside the transaction
    if (again.conflicts.length) throw new Error(`conflict appeared during apply: ${again.conflicts[0]}`);
    return applyImport(tx, inst, { ...s, __plan: again });
  }, { timeout: 120_000 });
  console.log(`Applied. People imported: ${created.join(', ') || 'none'} (queued for university-account provisioning).`);
}

try {
  await (mode === 'export' ? exportSubset() : importSubset());
} finally {
  await prisma.$disconnect();
}
