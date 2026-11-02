// Maps CampusCore SIS API responses into the EdunexusAI canonical model.
import { SisAdapter } from './SisAdapter.js';
import { CampusCoreClient } from '../CampusCoreClient.js';
import { SisError } from '../errors.js';
import { STATUS_MAP, ENROLLMENT_MAP } from '../canonical.js';

const SYSTEM = 'campuscore';
const ref = (id) => ({ system: SYSTEM, id });

export class CampusCoreAdapter extends SisAdapter {
  constructor(options) {
    super();
    this.client = options instanceof CampusCoreClient ? options : new CampusCoreClient(options);
  }

  capabilities() {
    const s = this.client.grantedScopes;
    return { system: SYSTEM, reads: s.filter((x) => x.endsWith(':read')), writes: s.filter((x) => x.endsWith(':write')) };
  }

  #require(scope) {
    if (this.client.token && !this.client.grantedScopes.includes(scope)) throw new SisError(`This EdunexusAI connection is not permitted to ${scope.replace(':', ' ')} in CampusCore.`, { code: 'not_supported', status: 403 });
  }

  mapTerm = (t) => ({ source: ref(t.id), code: t.code, name: t.name, startDate: t.startDate, endDate: t.endDate, isCurrent: t.isCurrent, registrationOpen: t.status === 'REGISTRATION_OPEN' });

  mapStudent = (s) => ({
    source: ref(s.id),
    institutionalId: s.studentNumber,
    displayName: `${s.preferredName || s.firstName} ${s.lastName}`,
    givenName: s.firstName,
    familyName: s.lastName,
    email: s.email,
    phone: s.phone,
    enrollmentStatus: STATUS_MAP[s.status] ?? 'inactive',
    level: s.classLevel.toLowerCase(),
    standing: s.academicStanding.toLowerCase(),
    program: s.program ? { code: s.program.code, name: s.program.name, credential: s.program.degreeType } : null,
    hasRegistrationHold: s.hasRegistrationHold ?? null,
  });

  mapSection = (s) => ({
    source: ref(s.id),
    termCode: s.termCode,
    courseCode: s.course.code,
    courseTitle: s.course.title,
    sectionCode: s.sectionNumber,
    credits: s.course.credits,
    instructors: (s.instructors ?? []).map((i) => i.name),
    meetings: (s.meetings ?? []).map((m) => ({ day: m.day, start: m.startTime, end: m.endTime, location: m.room ?? s.location ?? null })),
    seats: { capacity: s.capacity, enrolled: s.enrolled ?? null, available: s.seatsAvailable ?? null, waitlisted: s.waitlisted ?? null },
    status: s.status.toLowerCase(),
  });

  mapEnrollment = (r) => ({ source: ref(r.id), studentRef: ref(r.studentId), sectionRef: ref(r.sectionId), status: ENROLLMENT_MAP[r.status], waitlistPosition: r.waitlistPosition ?? null, credits: r.credits });

  async getInstitution() { return (await this.client.get('/institution')).data; }
  async listTerms() { return (await this.client.get('/terms')).data.map(this.mapTerm); }
  async getCurrentTerm() { return (await this.client.get('/terms', { current: 'true' })).data.map(this.mapTerm)[0] ?? null; }

  async searchStudents({ search, status, page = 1, pageSize = 25 } = {}) {
    const res = await this.client.get('/students', { search, status, page, pageSize });
    return { items: res.data.map(this.mapStudent), total: res.pagination.total, page: res.pagination.page, totalPages: res.pagination.totalPages };
  }

  async getStudent(id) { return this.mapStudent((await this.client.get(`/students/${encodeURIComponent(id)}`)).data); }

  async getStudentSchedule(id, termId) {
    const res = await this.client.get(`/students/${encodeURIComponent(id)}/schedule`, { termId });
    return {
      term: { source: ref(res.data.term.id), code: res.data.term.code, name: res.data.term.name },
      items: res.data.classes.map((c) => ({ ...this.mapSection(c), enrollment: { source: ref(c.registrationId), status: ENROLLMENT_MAP[c.registrationStatus], waitlistPosition: c.waitlistPosition } })),
    };
  }

  async getAcademicSummary(id) {
    const d = (await this.client.get(`/students/${encodeURIComponent(id)}/academic-record`)).data;
    return { studentRef: ref(d.studentId), gpa: d.cumulativeGpa, creditsEarned: d.creditsEarned, creditsInProgress: d.creditsInProgress, standing: d.academicStanding.toLowerCase(), level: d.classLevel.toLowerCase(), terms: d.terms.map((t) => ({ termCode: t.term, gpa: t.termGpa })) };
  }

  async getGradeHistory(id) {
    const d = (await this.client.get(`/students/${encodeURIComponent(id)}/grades`)).data;
    return d.map((t) => ({ termCode: t.term, termName: t.termName, gpa: t.termGpa, courses: t.courses.map((c) => ({ courseCode: c.courseCode, courseTitle: c.courseTitle, credits: c.credits, grade: c.grade, inProgress: c.state === 'IN_PROGRESS' })) }));
  }

  async listFacultySections(facultyId, termId) { return (await this.client.get(`/faculty/${encodeURIComponent(facultyId)}/sections`, { termId })).data.map(this.mapSection); }

  async getRoster(sectionId) {
    return (await this.client.get(`/sections/${encodeURIComponent(sectionId)}/roster`)).data.map((r) => ({ ...this.mapEnrollment(r), student: { source: ref(r.student.id), institutionalId: r.student.studentNumber, displayName: r.student.name, email: r.student.email } }));
  }

  async listAnnouncements() { return (await this.client.get('/announcements')).data.map((a) => ({ source: ref(a.id), title: a.title, body: a.body, audience: a.audience.toLowerCase(), pinned: a.pinned, publishedAt: a.publishedAt })); }

  async enroll(studentId, sectionId) {
    this.#require('registrations:write');
    return this.mapEnrollment((await this.client.post('/registrations', { studentId, sectionId })).data);
  }

  async drop(enrollmentId, reason) {
    this.#require('registrations:write');
    return this.mapEnrollment((await this.client.post(`/registrations/${encodeURIComponent(enrollmentId)}/drop`, { reason })).data);
  }

  // ── Institution verification & health ──
  // Refuses to operate if the credentials belong to a different institution than this deployment expects.
  async verifyInstitution(expected) {
    const me = await this.client.get('/me');
    const ok = !expected || [me.institution?.slug, me.institution?.id].includes(expected);
    if (!ok) throw new SisError(`These CampusCore credentials belong to "${me.institution?.name}" (${me.institution?.slug}), not "${expected}".`, { code: 'institution_mismatch', status: 409 });
    return me.institution;
  }
  health() { return this.client.health(); }
  async getCapabilities() { return (await this.client.get('/capabilities')).data; }
  async setWritePreferences(prefs, { actingUser } = {}) { return (await this.client.put('/integration/write-preferences', prefs, { actingUser })).data; }

  // ── Student administration (CampusCore is authoritative; never fake a local result) ──
  async findStudent({ email, institutionalId }) {
    const res = await this.client.get('/students', { email, studentNumber: institutionalId, pageSize: 2 });
    return res.data.map(this.mapStudent);
  }
  async getStudentForEdit(id) {
    const r = await this.client.get(`/students/${encodeURIComponent(id)}`, undefined, { withMeta: true });
    return { student: this.mapStudent(r.data.data), etag: r.etag };
  }
  // `idempotencyKey` must be stable for one logical submission (e.g. generated when the form opens) so that a
  // retry after a timeout can never create a second student.
  async createStudent(input, { idempotencyKey, actingUser }) {
    if (!idempotencyKey) throw new SisError('createStudent requires an idempotencyKey.', { code: 'idempotency_key_required' });
    const r = await this.client.post('/students', input, { idempotencyKey, actingUser, withMeta: true });
    return { student: this.mapStudent(r.data.data), etag: r.etag, replayed: r.replayed };
  }
  async updateStudent(id, changes, { ifMatch, actingUser } = {}) {
    const r = await this.client.patch(`/students/${encodeURIComponent(id)}`, changes, { ifMatch, actingUser, withMeta: true });
    return { student: this.mapStudent(r.data.data), etag: r.etag, changedFields: r.data.meta?.changedFields ?? [] };
  }
  async deactivateStudent(id, { reason, dropFutureRegistrations = false, actingUser, idempotencyKey }) {
    const r = await this.client.post(`/students/${encodeURIComponent(id)}/deactivate`, { reason, dropFutureRegistrations }, { actingUser, idempotencyKey });
    return { student: this.mapStudent(r.data), ...r.meta };
  }
  async getStudentAudit(id, { page = 1, pageSize = 25 } = {}) { return this.client.get(`/students/${encodeURIComponent(id)}/audit`, { page, pageSize }); }
  async getRegistrations(id, { termId } = {}) { return (await this.client.get(`/students/${encodeURIComponent(id)}/registrations`, { termId })).data.map((r) => ({ ...this.mapEnrollment(r), section: r.section })); }
  async getFacultySchedule(facultyId, termId) { const d = (await this.client.get(`/faculty/${encodeURIComponent(facultyId)}/schedule`, { termId })).data; return { term: d.term, items: d.classes.map(this.mapSection) }; }
  async getCalendar(query = {}) { return (await this.client.get('/calendar', query)).data; }

  // ── Identity (explicit links between portal accounts and SIS records) ──
  async reconcileIdentities(candidates, { externalSystem = 'edunexusai' } = {}) { return this.client.post('/identity/reconcile', { externalSystem, candidates }); }
  // With `recordType` (STUDENT | FACULTY), resolves that one relationship; a person may hold both.
  async resolveIdentity(externalUserId, { externalSystem = 'edunexusai', recordType } = {}) { return (await this.client.get('/identity/resolve', { externalSystem, externalUserId, ...(recordType ? { recordType } : {}) })).data; }
  async listIdentityLinks(query = {}) { return this.client.get('/identity/links', query); }
  async linkIdentity({ externalUserId, externalEmail, externalLabel, recordType, sisRecordId, evidenceMismatchReason, externalSystem = 'edunexusai' }, { actingUser, idempotencyKey } = {}) {
    return (await this.client.post('/identity/links', { externalSystem, externalUserId, externalEmail, externalLabel, recordType, sisRecordId, evidenceMismatchReason, confirm: true }, { actingUser, idempotencyKey })).data;
  }
  async revokeIdentityLink(linkId, reason, { actingUser } = {}) { return (await this.client.post(`/identity/links/${encodeURIComponent(linkId)}/revoke`, { reason }, { actingUser })).data; }

  async recordAttendance(sectionId, instructorId, date, records) {
    this.#require('attendance:write');
    return (await this.client.post(`/sections/${encodeURIComponent(sectionId)}/attendance`, { actingFacultyId: instructorId, date, records: records.map((r) => ({ studentId: r.studentId, status: r.status.toUpperCase(), note: r.note })) })).data;
  }
}
