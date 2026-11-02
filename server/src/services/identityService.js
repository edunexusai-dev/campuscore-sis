// Cross-system identity: explicit, audited links between external accounts (e.g. EdunexusAI users) and
// CampusCore student/faculty records.
//  - reconcile(): classifies external accounts using ONLY strong hints (institutional email, student/employee
//    number). Names are shown for review but never used to match. Nothing is linked automatically.
//  - link(): creates a link after explicit confirmation; refuses duplicates and evidence mismatches.
//  - revoke(): ends a link (history kept). Changing a mapping = revoke + link, both audited.
//  - resolve(): server-side lookup used on every request by the integrating backend.
// Everything is scoped to one institution; the database also enforces one ACTIVE link per record, and one ACTIVE
// link per account AND record type. One external account may therefore hold a STUDENT and a FACULTY link at the
// same time (a faculty member who is also a student), but only when both records belong to the same CampusCore
// Person (the person registry). Email alone never proves that; records of two different people are refused, and
// the fix is made in CampusCore (Admin: "same person" on the record), never in an integration.
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { notFound, conflict, ruleViolation } from '../lib/errors.js';
import { assertProvisionable } from './personService.js';

const norm = (s) => (s ?? '').trim().toLowerCase();

const studentSummary = (s) => s && ({ recordType: 'STUDENT', sisId: s.id, institutionalId: s.studentNumber, displayName: `${s.preferredName || s.firstName} ${s.lastName}`, firstName: s.firstName, lastName: s.lastName, email: s.email, status: s.status, program: s.program?.name ?? null });
const facultySummary = (f) => f && ({ recordType: 'FACULTY', sisId: f.id, institutionalId: f.employeeNumber, displayName: `${f.firstName} ${f.lastName}`, firstName: f.firstName, lastName: f.lastName, email: f.email, status: f.status, department: f.department?.name ?? null });

export function linkDto(l) {
  return {
    id: l.id, externalSystem: l.externalSystem, externalUserId: l.externalUserId, externalEmail: l.externalEmail, externalLabel: l.externalLabel,
    recordType: l.recordType, status: l.status, method: l.method, evidence: l.evidence,
    sisRecord: l.student ? studentSummary(l.student) : l.faculty ? facultySummary(l.faculty) : { recordType: l.recordType, sisId: l.studentId ?? l.facultyId },
    createdBy: l.createdByLabel, createdAt: l.createdAt, revokedAt: l.revokedAt, revokedReason: l.revokedReason, revokedBy: l.revokedByLabel,
  };
}
const include = { student: { include: { program: true } }, faculty: { include: { department: true } } };

async function findRecordByHints(institutionId, recordType, { email, institutionalId }) {
  const model = recordType === 'STUDENT' ? prisma.student : prisma.faculty;
  const numberField = recordType === 'STUDENT' ? 'studentNumber' : 'employeeNumber';
  const extraInclude = recordType === 'STUDENT' ? { program: true } : { department: true };
  const [byNumber, byEmail] = await Promise.all([
    institutionalId ? model.findMany({ where: { institutionId, [numberField]: institutionalId.trim() }, include: extraInclude }) : [],
    email ? model.findMany({ where: { institutionId, OR: [{ email: { equals: norm(email), mode: 'insensitive' } }, ...(recordType === 'STUDENT' ? [{ personalEmail: { equals: norm(email), mode: 'insensitive' } }] : [])] }, include: extraInclude }) : [],
  ]);
  return { byNumber, byEmail };
}

export async function reconcile(institutionId, externalSystem, candidates) {
  const results = [];
  for (const c of candidates) {
    const summarize = c.recordType === 'STUDENT' ? studentSummary : facultySummary;
    const existing = await prisma.externalIdentityLink.findFirst({ where: { institutionId, externalSystem, externalUserId: c.externalUserId, recordType: c.recordType, status: 'ACTIVE' }, include });
    const { byNumber, byEmail } = await findRecordByHints(institutionId, c.recordType, c);
    const nameMatches = (r) => !!(c.firstName && c.lastName && norm(r.firstName) === norm(c.firstName) && norm(r.lastName) === norm(c.lastName));
    const base = { externalUserId: c.externalUserId, recordType: c.recordType };
    if (existing) {
      const linked = linkDto(existing).sisRecord;
      const warnings = [];
      if (byNumber.length && byNumber[0].id !== linked.sisId) warnings.push('The institutional ID supplied now belongs to a different record than the linked one.');
      if (byEmail.length && !byEmail.some((r) => r.id === linked.sisId)) warnings.push('The email supplied now matches a different record than the linked one.');
      results.push({ ...base, status: 'LINKED', linkId: existing.id, sisRecord: linked, warnings });
      continue;
    }
    const ids = new Set([...byNumber, ...byEmail].map((r) => r.id));
    if (ids.size === 0) { results.push({ ...base, status: 'UNMATCHED', candidates: [], reason: c.email || c.institutionalId ? 'No CampusCore record has this email or institutional ID.' : 'No email or institutional ID supplied; names alone are never used to match.' }); continue; }
    const records = [...new Map([...byNumber, ...byEmail].map((r) => [r.id, r])).values()];
    const evidence = (r) => ({ institutionalIdMatch: byNumber.some((x) => x.id === r.id), emailMatch: byEmail.some((x) => x.id === r.id), nameMatch: nameMatches(r) });
    if (ids.size > 1) { results.push({ ...base, status: 'AMBIGUOUS', reason: 'The email and institutional ID point to different records, or several records match.', candidates: records.map((r) => ({ ...summarize(r), evidence: evidence(r) })) }); continue; }
    const r = records[0];
    const takenBy = await prisma.externalIdentityLink.findFirst({ where: { institutionId, externalSystem, status: 'ACTIVE', [c.recordType === 'STUDENT' ? 'studentId' : 'facultyId']: r.id } });
    if (takenBy) { results.push({ ...base, status: 'AMBIGUOUS', reason: 'The matching record is already linked to a different external account.', candidates: [{ ...summarize(r), evidence: evidence(r), linkedToExternalUserId: takenBy.externalUserId }] }); continue; }
    results.push({ ...base, status: 'CANDIDATE', reason: 'One record matches the supplied identifiers. Confirm before linking.', candidates: [{ ...summarize(r), evidence: evidence(r) }] });
  }
  return results;
}

// `status` is the LINK state; the SIS record's own lifecycle status is `recordStatus`.
const resolvedLink = (l) => {
  const { status: recordStatus, ...sis } = linkDto(l).sisRecord;
  return { linkId: l.id, ...sis, recordStatus };
};

// With `recordType`, resolves that one relationship (UNMAPPED when the account has no such link). Without it, an
// account with exactly one link resolves as before; an account with several returns LINKED_MULTIPLE and no single
// record, so a caller that does not say which relationship it needs can never be handed the wrong one.
export async function resolve(institutionId, externalSystem, externalUserId, recordType) {
  const rows = await prisma.externalIdentityLink.findMany({ where: { institutionId, externalSystem, externalUserId, status: 'ACTIVE', ...(recordType ? { recordType } : {}) }, include, orderBy: { createdAt: 'asc' } });
  const links = rows.map(resolvedLink);
  if (!rows.length) return { externalUserId, status: 'UNMAPPED', links: [] };
  if (rows.length > 1) return { externalUserId, status: 'LINKED_MULTIPLE', links };
  return { externalUserId, status: 'LINKED', ...links[0], links };
}

export async function listLinks(institutionId, { externalSystem, externalUserId, recordType, status, sisRecordId, page, pageSize }) {
  const where = {
    institutionId,
    ...(externalSystem ? { externalSystem } : {}), ...(externalUserId ? { externalUserId } : {}), ...(recordType ? { recordType } : {}), ...(status ? { status } : {}),
    ...(sisRecordId ? { OR: [{ studentId: sisRecordId }, { facultyId: sisRecordId }] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.externalIdentityLink.findMany({ where, include, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.externalIdentityLink.count({ where }),
  ]);
  return { rows: rows.map(linkDto), total };
}

// Creates a link. `evidenceMismatchReason` is required when the supplied external email does not match the
// SIS record's institutional or personal email — this stops an administrator linking the wrong person by mistake.
export async function link(actor, { externalSystem, externalUserId, externalEmail, externalLabel, recordType, sisRecordId, method, evidenceMismatchReason, clientId }) {
  const isStudent = recordType === 'STUDENT';
  const record = isStudent
    ? await prisma.student.findFirst({ where: { id: sisRecordId, institutionId: actor.institutionId }, include: { program: true } })
    : await prisma.faculty.findFirst({ where: { id: sisRecordId, institutionId: actor.institutionId }, include: { department: true } });
  if (!record) throw notFound(isStudent ? 'Student' : 'Faculty member');
  // Excluded people never get an external account linked, whichever system asks (portal provisioning, JIT, admin).
  await assertProvisionable(prisma, record.personId);
  // When the account already holds the other relationship (student + faculty) and both records belong to the same
  // CampusCore person, the external email matching the ALREADY-LINKED record is sufficient evidence: a person's
  // student and staff addresses usually differ.
  const otherLink = await prisma.externalIdentityLink.findFirst({ where: { institutionId: actor.institutionId, externalSystem, externalUserId, status: 'ACTIVE', recordType: isStudent ? 'FACULTY' : 'STUDENT' }, include });
  const otherRecord = otherLink ? (otherLink.student ?? otherLink.faculty) : null;
  const samePersonRecord = Boolean(otherRecord && otherRecord.personId === record.personId);
  const emailsOf = (r) => [r.email, r.personalEmail].filter(Boolean).map(norm);
  const emailMatch = externalEmail
    ? emailsOf(record).includes(norm(externalEmail)) || (samePersonRecord && emailsOf(otherRecord).includes(norm(externalEmail)))
    : null;
  if (emailMatch === false && !evidenceMismatchReason) {
    throw ruleViolation('identity_evidence_mismatch', `The external email ${externalEmail} does not match this ${isStudent ? 'student' : 'faculty'} record (${record.email}). Supply evidenceMismatchReason to link anyway after verifying identity.`);
  }
  const evidence = { emailMatch, verifiedBy: actor.onBehalfOf ?? actor.label, ...(evidenceMismatchReason ? { mismatchReason: evidenceMismatchReason } : {}) };
  try {
    return await prisma.$transaction(async (tx) => {
      const dupAccount = await tx.externalIdentityLink.findFirst({ where: { institutionId: actor.institutionId, externalSystem, externalUserId, recordType, status: 'ACTIVE' } });
      if (dupAccount) throw conflict(`This external account is already linked to a ${isStudent ? 'student' : 'faculty'} record. Revoke the existing link first.`, 'identity_already_linked', { linkId: dupAccount.id });
      // A second relationship (student + faculty) must belong to the same person as the first.
      const other = await tx.externalIdentityLink.findFirst({ where: { institutionId: actor.institutionId, externalSystem, externalUserId, status: 'ACTIVE', recordType: isStudent ? 'FACULTY' : 'STUDENT' }, include });
      if (other) {
        if ((other.student ?? other.faculty)?.personId !== record.personId) {
          throw ruleViolation('identity_different_person', 'This record belongs to a different CampusCore person than the record already linked to this external account. If they are the same human being, a CampusCore administrator confirms that on the record first ("Same person").');
        }
        evidence.samePerson = 'CAMPUSCORE_PERSON';
      }
      const dupRecord = await tx.externalIdentityLink.findFirst({ where: { institutionId: actor.institutionId, externalSystem, status: 'ACTIVE', [isStudent ? 'studentId' : 'facultyId']: record.id } });
      if (dupRecord) throw conflict('This SIS record is already linked to another external account.', 'record_already_linked', { linkId: dupRecord.id, externalUserId: dupRecord.externalUserId });
      const l = await tx.externalIdentityLink.create({
        data: { institutionId: actor.institutionId, externalSystem, externalUserId, externalEmail: externalEmail ?? null, externalLabel: externalLabel ?? null, recordType, studentId: isStudent ? record.id : null, facultyId: isStudent ? null : record.id, method, evidence, createdByType: actor.type, createdById: actor.id, createdByLabel: actor.onBehalfOf ? `${actor.label} on behalf of ${actor.onBehalfOf}` : actor.label, clientId: clientId ?? null },
        include,
      });
      await audit(actor, { action: 'identity.linked', entityType: isStudent ? 'Student' : 'Faculty', entityId: record.id, summary: `Linked ${externalSystem} account ${externalUserId}${externalEmail ? ` (${externalEmail})` : ''} to ${isStudent ? record.studentNumber : record.employeeNumber}${emailMatch === false ? ' despite email mismatch' : ''}`, after: { linkId: l.id, externalSystem, externalUserId, evidence } }, tx);
      return linkDto(l);
    });
  } catch (e) {
    // The partial unique indexes are the final guard against concurrent duplicate links.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('A conflicting active link was created concurrently.', 'identity_link_conflict');
    throw e;
  }
}

export async function revoke(actor, { linkId, reason }) {
  const l = await prisma.externalIdentityLink.findFirst({ where: { id: linkId, institutionId: actor.institutionId }, include });
  if (!l) throw notFound('Identity link');
  if (l.status === 'REVOKED') throw ruleViolation('already_revoked', 'This link is already revoked.');
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.externalIdentityLink.update({ where: { id: l.id }, data: { status: 'REVOKED', revokedAt: new Date(), revokedReason: reason, revokedByLabel: actor.onBehalfOf ? `${actor.label} on behalf of ${actor.onBehalfOf}` : actor.label }, include });
    await audit(actor, { action: 'identity.unlinked', entityType: l.recordType === 'STUDENT' ? 'Student' : 'Faculty', entityId: l.studentId ?? l.facultyId, summary: `Revoked link between ${l.externalSystem} account ${l.externalUserId} and ${linkDto(l).sisRecord.institutionalId}: ${reason}`, before: { status: 'ACTIVE' }, after: { status: 'REVOKED', reason } }, tx);
    return u;
  });
  return linkDto(updated);
}
