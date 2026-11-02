// The person registry. A Person is one human being; their student and faculty relationships (records) and
// their CampusCore login point to it. Everything a consumer needs to know about the person (name, primary
// email, which relationships are current) is DERIVED from the records here, so it can never drift from them.
//
// Rules other systems rely on (identity sync to the university's identity provider, portal JIT accounts):
//   - a relationship is CURRENT while the record is in an active state (CURRENT_STATUS below);
//   - the primary email is the current faculty email, else the current student email, else (no current
//     relationship) the faculty email, else the student email. A staff mailbox outlives a degree, and a
//     person who both teaches and studies is addressed by the institution as staff;
//   - the person's status is ACTIVE (any current relationship), ALUMNI (a graduated student and nothing
//     current) or INACTIVE.
import { prisma } from '../lib/prisma.js';
import { notFound, conflict, ruleViolation as ruleViolationErr } from '../lib/errors.js';

export const CURRENT_STATUS = { STUDENT: ['ACTIVE', 'ADMITTED', 'LEAVE_OF_ABSENCE'], FACULTY: ['ACTIVE'] };

export const personInclude = {
  student: { include: { program: true } },
  faculty: { include: { department: true } },
  user: { select: { id: true, email: true, status: true } },
};

export async function nextPersonNumber(institutionId, tx = prisma) {
  const last = await tx.person.findFirst({ where: { institutionId, personNumber: { startsWith: 'P' } }, orderBy: { personNumber: 'desc' }, select: { personNumber: true } });
  const seq = last ? Number(last.personNumber.slice(1)) + 1 : 1;
  return `P${String(seq).padStart(7, '0')}`;
}

/** A new person, inside the caller's transaction. Every new student or faculty record starts here (or joins an existing person). */
export async function createPerson(tx, institutionId) {
  return tx.person.create({ data: { institutionId, personNumber: await nextPersonNumber(institutionId, tx) } });
}

const norm = (s) => (s ?? '').trim().toLowerCase();

export function relationshipsOf(person) {
  const out = [];
  if (person.faculty) {
    const f = person.faculty;
    out.push({ type: 'FACULTY', sisId: f.id, number: f.employeeNumber, email: f.email, status: f.status, current: CURRENT_STATUS.FACULTY.includes(f.status), title: f.title, department: f.department?.name ?? null });
  }
  if (person.student) {
    const s = person.student;
    out.push({ type: 'STUDENT', sisId: s.id, number: s.studentNumber, email: s.email, status: s.status, current: CURRENT_STATUS.STUDENT.includes(s.status), program: s.program?.name ?? null, classLevel: s.classLevel });
  }
  return out;
}

export function primaryEmailOf(person) {
  const rels = relationshipsOf(person);
  const pick = (type, current) => rels.find((r) => r.type === type && (current === null || r.current === current) && r.email)?.email;
  return norm(pick('FACULTY', true) ?? pick('STUDENT', true) ?? pick('FACULTY', null) ?? pick('STUDENT', null) ?? person.user?.email) || null;
}

export function personStatusOf(person) {
  const rels = relationshipsOf(person);
  if (rels.some((r) => r.current)) return 'ACTIVE';
  if (person.student?.status === 'GRADUATED') return 'ALUMNI';
  return 'INACTIVE';
}

/** The person as other systems see it. `updatedAt` is the latest change to the person or any of their records. */
export function personDto(person) {
  const named = person.faculty ?? person.student;
  const rels = relationshipsOf(person);
  const emails = [...new Set([primaryEmailOf(person), ...rels.map((r) => norm(r.email))].filter(Boolean))];
  const updatedAt = [person.updatedAt, person.student?.updatedAt, person.faculty?.updatedAt].filter(Boolean).reduce((a, b) => (b > a ? b : a));
  return {
    id: person.id,
    personNumber: person.personNumber,
    firstName: named?.firstName ?? null,
    lastName: named?.lastName ?? null,
    preferredName: person.student?.preferredName ?? null,
    primaryEmail: primaryEmailOf(person),
    emails,
    status: personStatusOf(person),
    relationships: rels,
    hasCampusCoreLogin: Boolean(person.user),
    mergedInto: person.mergedIntoId ?? null,
    identityExcluded: Boolean(person.identityExcluded),
    updatedAt,
  };
}

export async function getPerson(institutionId, id, { provisionableOnly = false } = {}) {
  const p = await prisma.person.findFirst({ where: { id, institutionId, ...(provisionableOnly ? { identityExcluded: false } : {}) }, include: personInclude });
  if (!p) throw notFound('Person');
  return p;
}

/**
 * Directory/lookup of people. Identifier filters are exact. `updatedSince` returns people whose person row or
 * any record changed at or after that instant (the identity sync's incremental feed). With `provisionableOnly`
 * (the integration API), people excluded from identity provisioning are left out entirely, so no consumer (the
 * identity sync, a portal's first-sign-in account creation) can provision them, whatever its own logic.
 */
export async function findPeople(institutionId, { personNumber, studentNumber, employeeNumber, email, updatedSince, page = 1, pageSize = 50, provisionableOnly = false }) {
  const and = [];
  if (personNumber) and.push({ personNumber });
  if (studentNumber) and.push({ student: { is: { studentNumber } } });
  if (employeeNumber) and.push({ faculty: { is: { employeeNumber } } });
  if (email) {
    const e = { equals: norm(email), mode: 'insensitive' };
    and.push({ OR: [{ student: { is: { email: e } } }, { faculty: { is: { email: e } } }, { user: { is: { email: e } } }] });
  }
  if (updatedSince) and.push({ OR: [{ updatedAt: { gte: updatedSince } }, { student: { is: { updatedAt: { gte: updatedSince } } } }, { faculty: { is: { updatedAt: { gte: updatedSince } } } }] });
  const where = { institutionId, mergedIntoId: null, ...(provisionableOnly ? { identityExcluded: false } : {}), ...(and.length ? { AND: and } : {}) };
  const [rows, total] = await Promise.all([
    prisma.person.findMany({ where, include: personInclude, orderBy: [{ personNumber: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
    prisma.person.count({ where }),
  ]);
  return { rows, total };
}

/** Refuses linking or creating an external account for a record whose person is excluded from identity provisioning. */
export async function assertProvisionable(tx, personId) {
  const person = await tx.person.findUnique({ where: { id: personId }, select: { identityExcluded: true, personNumber: true } });
  if (person?.identityExcluded) throw ruleViolationErr('person_identity_excluded', `Person ${person.personNumber} is excluded from identity provisioning in CampusCore, so no external account can be linked or created for them. An administrator can include the person again.`);
}

/**
 * Include or exclude people from identity provisioning (audited per person). Records, logins and academic history
 * are untouched. Including a person again bumps their change time, so the next incremental identity sync sees them.
 */
export async function setIdentityExclusion(actor, personIds, { excluded, reason }, auditFn) {
  const changed = [];
  for (const id of personIds) {
    await prisma.$transaction(async (tx) => {
      const p = await tx.person.findFirst({ where: { id, institutionId: actor.institutionId } });
      if (!p) throw notFound('Person');
      if (p.identityExcluded === excluded) return;
      await tx.person.update({ where: { id }, data: { identityExcluded: excluded, identityExcludedReason: excluded ? reason : null, identityExcludedAt: excluded ? new Date() : null } });
      await auditFn(actor, { action: excluded ? 'person.identity_excluded' : 'person.identity_included', entityType: 'Person', entityId: id, summary: `${excluded ? 'Excluded' : 'Included'} ${p.personNumber} ${excluded ? 'from' : 'in'} identity provisioning: ${reason}`, before: { identityExcluded: p.identityExcluded }, after: { identityExcluded: excluded, reason } }, tx);
      changed.push(p.personNumber);
    });
  }
  return changed;
}

// Which records give their person's login something to do in CampusCore: a student record until the student
// withdraws (graduates keep transcript access), a faculty record while the faculty member is active.
export const LOGIN_ACCESS = {
  STUDENT: (s) => s.status !== 'WITHDRAWN',
  FACULTY: (f) => f.status === 'ACTIVE',
};

/**
 * Keep the person's CampusCore login consistent with their records, inside the caller's transaction:
 *  - its email follows the person's primary email (unless another login already uses that address);
 *  - with `access: true` (a record's status changed) it is disabled only when NO record on it still gives access,
 *    and re-enabled when one does again. A lecturer who withdraws from a degree keeps signing in as faculty.
 * Returns what changed. Staff-only logins have no person and are never touched.
 */
export async function syncLogin(tx, personId, { access = false } = {}) {
  const person = await tx.person.findUnique({ where: { id: personId }, include: { student: true, faculty: true, user: true } });
  const user = person?.user;
  if (!user) return {};
  const data = {};
  const email = primaryEmailOf(person);
  if (email && email !== user.email && !(await tx.user.findUnique({ where: { email }, select: { id: true } }))) data.email = email;
  if (access && !['ADMIN', 'REGISTRAR'].includes(user.role)) {
    const granted = (person.student?.userId === user.id && LOGIN_ACCESS.STUDENT(person.student)) || (person.faculty?.userId === user.id && LOGIN_ACCESS.FACULTY(person.faculty));
    const status = granted ? 'ACTIVE' : 'DISABLED';
    if (status !== user.status) data.status = status;
  }
  if (!Object.keys(data).length) return {};
  await tx.user.update({ where: { id: user.id }, data });
  if (data.status === 'DISABLED') await tx.session.deleteMany({ where: { userId: user.id } });
  return data;
}

/**
 * An administrator confirms that a record belongs to another person (the same human being was registered
 * twice, e.g. as a student and later, separately, as faculty). The record moves to `intoPersonId`; the emptied
 * person is kept, marked as merged (its number is never reused). Refused when the target already has a record
 * of that type, or when both people have a CampusCore login that is still active (one login per person: the
 * administrator disables the extra login first). Never automatic, never on name or email.
 */
export async function mergeRecordIntoPerson(actor, { recordType, recordId, intoPersonId, reason }, auditFn) {
  return prisma.$transaction(async (tx) => {
    const isStudent = recordType === 'STUDENT';
    const record = isStudent
      ? await tx.student.findFirst({ where: { id: recordId, institutionId: actor.institutionId } })
      : await tx.faculty.findFirst({ where: { id: recordId, institutionId: actor.institutionId } });
    if (!record) throw notFound(isStudent ? 'Student' : 'Faculty member');
    const target = await tx.person.findFirst({ where: { id: intoPersonId, institutionId: actor.institutionId, mergedIntoId: null }, include: { student: true, faculty: true, user: true } });
    if (!target) throw notFound('Person');
    if (target.id === record.personId) throw conflict_('already_same_person', 'This record already belongs to that person.');
    if (isStudent ? target.student : target.faculty) throw conflict_('person_has_record', `That person already has a ${isStudent ? 'student' : 'faculty'} record.`);
    const source = await tx.person.findUnique({ where: { id: record.personId }, include: { student: true, faculty: true, user: true } });
    if (isStudent ? source.faculty : source.student) throw conflict_('source_has_other_record', 'The record\'s current person also has another record. Move that person\'s records one at a time from the person that should survive.');
    if (source.user && target.user && source.user.status === 'ACTIVE') throw conflict_('two_active_logins', `Both people have an active CampusCore login (${source.user.email} and ${target.user.email}). Disable the login that should go away first.`);
    const userId = target.user?.id ?? (source.user?.status === 'ACTIVE' ? source.user.id : null);
    if (isStudent) await tx.student.update({ where: { id: record.id }, data: { personId: target.id, userId } });
    else await tx.faculty.update({ where: { id: record.id }, data: { personId: target.id, userId } });
    if (!target.user && userId) {
      await tx.user.update({ where: { id: userId }, data: { personId: target.id } });
    }
    await tx.person.update({ where: { id: source.id }, data: { mergedIntoId: target.id } });
    await tx.person.update({ where: { id: target.id }, data: { updatedAt: new Date() } });
    await syncLogin(tx, target.id);
    await auditFn(actor, { action: 'person.merged', entityType: 'Person', entityId: target.id, summary: `Confirmed ${isStudent ? `student ${record.studentNumber}` : `faculty ${record.employeeNumber}`} is the same person as ${target.personNumber} (was ${source.personNumber}): ${reason}`, before: { personId: source.id }, after: { personId: target.id, reason } }, tx);
    return { personId: target.id, mergedPersonId: source.id };
  });
}

const conflict_ = (code, message) => conflict(message, code);
