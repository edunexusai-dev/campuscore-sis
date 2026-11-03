// Pure decisions of the identity sync: what a person's account in the identity provider should look like, which
// existing account (if any) is theirs, and what has to change. No I/O here, so every rule is unit-tested.
//
// Rules:
//   - one account per person, found by its `person_number` attribute;
//   - an account without `person_number` is adopted only when it already carries one of the person's institutional
//     numbers AND its email is one of the person's addresses, or when an administrator explicitly confirms it
//     (--adopt P0000123=<account id>). Never on email or name alone;
//   - the sync owns: email (the person's primary email, verified), first/last name, enabled, the three identity
//     attributes and the realm roles learner / faculty / alumni. Every other attribute and role is left alone;
//   - accounts are never deleted. A person with nothing current is disabled (graduates keep alumni access);
//   - no account is created for a person with no current relationship.

export const IDENTITY_ATTRIBUTES = ['person_number', 'student_number', 'employee_number'];
export const MANAGED_ROLES = ['learner', 'faculty', 'alumni'];

// Which record statuses make a relationship current: the same policy as EdunexusAI (sisService PROVISIONABLE).
// Decided here from the record's status, not from CampusCore's own `current` flag, so the university identity always
// follows this policy. SUSPENDED and WITHDRAWN students are not current; CampusCore's own sign-in policy is separate.
export const CURRENT_STATUS = { STUDENT: ['ACTIVE', 'ADMITTED', 'LEAVE_OF_ABSENCE'], FACULTY: ['ACTIVE'] };

const norm = (s) => String(s ?? '').trim().toLowerCase();
const rel = (person, type) => person.relationships.find((r) => r.type === type) ?? null;
export const isCurrent = (r) => Boolean(r && CURRENT_STATUS[r.type]?.includes(r.status));
const hasAccess = (person) => person.relationships.some(isCurrent) || rel(person, 'STUDENT')?.status === 'GRADUATED';

/** The account a person should have. */
export function desiredAccount(person) {
  const student = rel(person, 'STUDENT');
  const faculty = rel(person, 'FACULTY');
  // Identifiers are facts about the person, kept for every relationship; entitlements are the roles and `enabled`.
  const attributes = { person_number: [person.personNumber] };
  if (student) attributes.student_number = [student.number];
  if (faculty) attributes.employee_number = [faculty.number];
  const roles = [];
  if (isCurrent(faculty)) roles.push('faculty');
  if (isCurrent(student)) roles.push('learner');
  if (student?.status === 'GRADUATED') roles.push('alumni');
  return {
    email: norm(person.primaryEmail),
    emailVerified: true,
    firstName: person.firstName ?? '',
    lastName: person.lastName ?? '',
    enabled: hasAccess(person),
    attributes,
    roles,
  };
}

/** The institutional numbers that identify this person (for adopting an existing account). */
export function numbersOf(person) {
  return person.relationships.map((r) => ({ attribute: r.type === 'STUDENT' ? 'student_number' : 'employee_number', value: r.number }));
}

/**
 * Which account belongs to the person.
 *   byPersonNumber: accounts whose person_number is this person's
 *   byNumbers: accounts carrying any of the person's student/employee numbers
 *   byEmail: accounts whose email is one of the person's addresses
 *   adoptId: an administrator-confirmed account id for this person (or null)
 *   formerPersonNumbers: numbers of people an administrator merged into this person; their accounts are this
 *     person's own (same human being), not another person's, but are still adopted only on the usual evidence
 * Returns { action: 'UPDATE' | 'ADOPT' | 'CREATE' | 'SKIP' | 'CONFLICT', account?, reason? }.
 */
export function resolveAccount(person, { byPersonNumber, byNumbers, byEmail, adoptId = null, adoptAccount = null, formerPersonNumbers = [] }) {
  if (byPersonNumber.length > 1) return { action: 'CONFLICT', reason: 'DUPLICATE_PERSON_NUMBER' };
  if (byPersonNumber.length === 1) return { action: 'UPDATE', account: byPersonNumber[0] };
  const ownNumbers = new Set([person.personNumber, ...formerPersonNumbers]);
  const ownedByOther = (a) => (a.attributes?.person_number ?? []).some((p) => !ownNumbers.has(p));
  if (adoptId) {
    if (!adoptAccount) return { action: 'CONFLICT', reason: 'ADOPT_ACCOUNT_NOT_FOUND' };
    if (ownedByOther(adoptAccount)) return { action: 'CONFLICT', reason: 'ADOPT_ACCOUNT_BELONGS_TO_OTHER_PERSON' };
    return { action: 'ADOPT', account: adoptAccount, via: 'ADMIN_CONFIRMED' };
  }
  const candidates = [...new Map(byNumbers.map((a) => [a.id, a])).values()];
  if (candidates.some(ownedByOther)) return { action: 'CONFLICT', reason: 'NUMBER_HELD_BY_OTHER_PERSON' };
  if (candidates.length > 1) return { action: 'CONFLICT', reason: 'AMBIGUOUS_ACCOUNTS' };
  if (candidates.length === 1) {
    const emails = new Set(person.emails.map(norm));
    if (!emails.has(norm(candidates[0].email))) return { action: 'CONFLICT', reason: 'EVIDENCE_MISMATCH' };
    return { action: 'ADOPT', account: candidates[0], via: 'INSTITUTIONAL_NUMBER' };
  }
  // Someone already has the address but no number: possibly this person, created by hand. Never decided on email
  // alone: an administrator checks and confirms with --adopt.
  if (byEmail.length) return { action: 'CONFLICT', reason: 'EMAIL_IN_USE_WITHOUT_NUMBER' };
  if (!hasAccess(person)) return { action: 'SKIP', reason: 'NO_CURRENT_RELATIONSHIP' };
  return { action: 'CREATE' };
}

/**
 * What must change on an existing account. `account` is the full representation; `currentRoles` its realm role
 * names. Returns { changed: [field names], representation (full, merged), addRoles, removeRoles }.
 * Attributes the sync does not own are carried over untouched (Keycloak replaces the whole attribute map on update).
 */
export function diffAccount(account, currentRoles, desired) {
  const changed = [];
  const representation = { ...account, attributes: { ...(account.attributes ?? {}) } };
  for (const field of ['email', 'emailVerified', 'firstName', 'lastName', 'enabled']) {
    const current = field === 'email' ? norm(account.email) : account[field];
    if (current !== desired[field]) { changed.push(field); representation[field] = desired[field]; }
  }
  for (const name of IDENTITY_ATTRIBUTES) {
    const want = desired.attributes[name];
    const have = representation.attributes[name];
    if (want && JSON.stringify(have ?? []) !== JSON.stringify(want)) { changed.push(name); representation.attributes[name] = want; }
    if (!want && have?.length) { changed.push(name); delete representation.attributes[name]; }
  }
  const managedNow = currentRoles.filter((r) => MANAGED_ROLES.includes(r));
  const addRoles = desired.roles.filter((r) => !managedNow.includes(r));
  const removeRoles = managedNow.filter((r) => !desired.roles.includes(r));
  return { changed, representation, addRoles, removeRoles };
}

/** A username for a new account: the primary email's local part, or with the person number when that is taken. */
export function usernameFor(person, taken) {
  const local = norm(person.primaryEmail).split('@')[0].replace(/[^a-z0-9._-]/g, '') || norm(person.personNumber);
  return taken(local) ? `${local}.${norm(person.personNumber)}` : local;
}
