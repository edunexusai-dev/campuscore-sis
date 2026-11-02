// Reference server-side service for the EdunexusAI backend. It is the ONLY place portal routes should get SIS
// data from. Rules it enforces:
//  - The SIS identity is resolved from the authenticated portal session (user.id), never from a student ID in
//    the URL or request body. Students therefore can only ever see their own record.
//  - Faculty rosters are returned only for sections the SIS says that faculty member teaches.
//  - Administrator operations require the portal's own admin check AND the integration's effective capability
//    (scope × CampusCore policy × client preferences). CampusCore re-checks everything server-side anyway.
//  - The portal user's tenant must match the CampusCore institution this connector is configured for.
//  - Failures are reported per section as UNAVAILABLE / FORBIDDEN; data is never invented.
// `user` is EdunexusAI's server-side session user: { id, role, tenantKey, email?, name? }.
import { SisError } from '../errors.js';

const ok = (data) => ({ state: 'OK', data });
const fromError = (e) => ({ state: e.status === 403 ? 'FORBIDDEN' : e.status === 404 ? 'NOT_FOUND' : 'UNAVAILABLE', error: { code: e.code, message: e.message, retryable: !!e.retryable, requestId: e.requestId } });
const settle = async (p) => { try { return ok(await p); } catch (e) { if (!(e instanceof SisError)) throw e; return fromError(e); } };

export class SisPortalService {
  constructor({ adapter, tenantKey, externalSystem = 'edunexusai', isAdmin = (u) => ['ADMIN', 'SUPER_ADMIN'].includes(u.role), identityCacheTtlMs = 60_000, now = Date.now }) {
    if (!adapter) throw new Error('SisPortalService requires an adapter');
    if (!tenantKey) throw new Error('SisPortalService requires the portal tenant key this SIS connection serves');
    this.sis = adapter;
    this.tenantKey = tenantKey;
    this.externalSystem = externalSystem;
    this.isAdmin = isAdmin;
    this.ttl = identityCacheTtlMs;
    this.now = now;
    this.cache = new Map(); // `${userId}:${recordType ?? '*'}` → { at, value }
  }

  #assertTenant(user) {
    if (!user?.id) throw new SisError('Not signed in.', { status: 401, code: 'unauthenticated' });
    if (user.tenantKey !== this.tenantKey) throw new SisError('This account belongs to a different institution than this SIS connection.', { status: 403, code: 'tenant_mismatch' });
  }
  #assertAdmin(user) {
    this.#assertTenant(user);
    if (!this.isAdmin(user)) throw new SisError('Administrator access is required.', { status: 403, code: 'not_portal_admin' });
  }
  actingUser(user) { return `${this.externalSystem}:${user.id}`.slice(0, 120); }

  // Server-side identity resolution with a short cache. Call invalidate() after linking/unlinking.
  // `recordType` (STUDENT | FACULTY) selects one relationship: a faculty member who is also a student holds both,
  // and every role-specific call must use the record of its own role, never "whichever link comes first".
  async resolve(user, { recordType } = {}) {
    this.#assertTenant(user);
    const key = `${user.id}:${recordType ?? '*'}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttl) return hit.value;
    const value = await this.sis.resolveIdentity(String(user.id), { externalSystem: this.externalSystem, ...(recordType ? { recordType } : {}) });
    this.cache.set(key, { at: this.now(), value });
    return value;
  }
  invalidate(userId) { for (const key of [...this.cache.keys()]) if (key.startsWith(`${userId}:`)) this.cache.delete(key); }
  // The relationship of `recordType`, or why there is none: NOT_LINKED (no link at all) or OTHER_ROLE (the account
  // is linked, but only to a record of another type). Works with servers that ignore `recordType` as well.
  async #relationship(user, recordType) {
    const identity = await this.resolve(user, { recordType });
    if (identity.status === 'LINKED' && identity.recordType === recordType) return { identity };
    if (identity.status === 'LINKED') return { missing: 'OTHER_ROLE' }; // an older server answered with its only link
    const any = await this.resolve(user);
    return { missing: any.status === 'LINKED' || any.status === 'LINKED_MULTIPLE' ? 'OTHER_ROLE' : 'NOT_LINKED' };
  }

  // ── Student self-service ──
  async studentOverview(user, { termId } = {}) {
    let found;
    try { found = await this.#relationship(user, 'STUDENT'); } catch (e) { if (e instanceof SisError && e.status !== 401 && e.code !== 'tenant_mismatch') return { state: 'UNAVAILABLE', error: fromError(e).error }; throw e; }
    if (found.missing === 'OTHER_ROLE') return { state: 'NOT_A_STUDENT' };
    if (found.missing) return { state: 'UNMAPPED', message: 'Your portal account is not yet linked to a student record. Contact the registrar.' };
    const { identity } = found;
    const id = identity.sisId; // from the verified link — never from client input
    const [profile, academic, schedule, grades, registrations] = await Promise.all([
      settle(this.sis.getStudent(id)), settle(this.sis.getAcademicSummary(id)), settle(this.sis.getStudentSchedule(id, termId)),
      settle(this.sis.getGradeHistory(id)), settle(this.sis.getRegistrations(id, { termId })),
    ]);
    return { state: 'OK', identity: { sisId: id, institutionalId: identity.institutionalId }, profile, academic, schedule, grades, registrations };
  }

  // ── Faculty ──
  async #facultyId(user) {
    const found = await this.#relationship(user, 'FACULTY');
    if (found.missing === 'OTHER_ROLE') throw new SisError('This account is not a faculty member in the SIS.', { status: 403, code: 'not_faculty' });
    if (found.missing) throw new SisError('Your portal account is not linked to a faculty record.', { status: 403, code: 'unmapped' });
    return found.identity.sisId;
  }
  async facultyTeaching(user, { termId } = {}) {
    const fid = await this.#facultyId(user);
    return { schedule: await settle(this.sis.getFacultySchedule(fid, termId)), sections: await settle(this.sis.listFacultySections(fid, termId)) };
  }
  async facultyRoster(user, sectionId) {
    const fid = await this.#facultyId(user);
    const sections = await this.sis.listFacultySections(fid);
    if (!sections.some((s) => s.source.id === sectionId)) throw new SisError('You are not assigned to this section.', { status: 403, code: 'not_section_instructor' });
    return this.sis.getRoster(sectionId);
  }

  // ── Administration ──
  async #requireCapability(operation) {
    const caps = await this.sis.getCapabilities();
    const c = caps.operations.find((o) => o.operation === operation);
    if (!c?.effective) throw new SisError(c?.reason ?? 'This operation is not available for this SIS connection.', { status: 403, code: 'write_not_permitted', details: c });
    return c;
  }
  async adminCapabilities(user) { this.#assertAdmin(user); return this.sis.getCapabilities(); }
  async adminSearchStudents(user, query) { this.#assertAdmin(user); return this.sis.searchStudents(query); }
  async adminGetStudent(user, sisId) {
    this.#assertAdmin(user);
    const [record, links] = await Promise.all([this.sis.getStudentForEdit(sisId), this.sis.listIdentityLinks({ sisRecordId: sisId, status: 'ACTIVE' })]);
    return { ...record, mapping: links.data[0] ?? null };
  }
  async adminCreateStudent(user, input, { idempotencyKey }) {
    this.#assertAdmin(user);
    await this.#requireCapability('student.create');
    return this.sis.createStudent(input, { idempotencyKey, actingUser: this.actingUser(user) });
  }
  async adminUpdateStudent(user, sisId, changes, { etag } = {}) {
    this.#assertAdmin(user);
    return this.sis.updateStudent(sisId, changes, { ifMatch: etag, actingUser: this.actingUser(user) }); // CampusCore returns per-field reasons
  }
  async adminDeactivateStudent(user, sisId, { reason, dropFutureRegistrations, idempotencyKey }) {
    this.#assertAdmin(user);
    await this.#requireCapability('student.deactivate');
    return this.sis.deactivateStudent(sisId, { reason, dropFutureRegistrations, idempotencyKey, actingUser: this.actingUser(user) });
  }
  async adminReconcile(user, candidates) { this.#assertAdmin(user); return this.sis.reconcileIdentities(candidates, { externalSystem: this.externalSystem }); }
  async adminLinkIdentity(user, input) {
    this.#assertAdmin(user);
    const link = await this.sis.linkIdentity({ ...input, externalSystem: this.externalSystem }, { actingUser: this.actingUser(user) });
    this.invalidate(input.externalUserId);
    return link;
  }
  async adminRevokeIdentityLink(user, linkId, reason, externalUserId) {
    this.#assertAdmin(user);
    const r = await this.sis.revokeIdentityLink(linkId, reason, { actingUser: this.actingUser(user) });
    if (externalUserId) this.invalidate(externalUserId);
    return r;
  }
}
