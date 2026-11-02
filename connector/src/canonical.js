// EdunexusAI canonical academic model (SIS-agnostic). Every SIS adapter maps its native responses into
// these shapes, so the portal never depends on a particular vendor's field names.
//
// `source` on each record identifies the system of record and its native ID, so updates can be routed back.
//
/** @typedef {{ system: string, id: string }} SourceRef */
/** @typedef {{ source: SourceRef, code: string, name: string, startDate: string, endDate: string, isCurrent: boolean, registrationOpen: boolean }} CanonicalTerm */
/** @typedef {{ source: SourceRef, institutionalId: string, displayName: string, givenName: string, familyName: string, email: string, phone: string|null, enrollmentStatus: 'prospective'|'active'|'inactive'|'alumni', level: string, standing: string, program: { code: string, name: string, credential: string }|null, hasRegistrationHold: boolean|null }} CanonicalStudent */
/** @typedef {{ day: string, start: string, end: string, location: string|null }} CanonicalMeeting */
/** @typedef {{ source: SourceRef, termCode: string, courseCode: string, courseTitle: string, sectionCode: string, credits: number, instructors: string[], meetings: CanonicalMeeting[], seats: { capacity: number, enrolled: number|null, available: number|null, waitlisted: number|null }, status: string }} CanonicalSection */
/** @typedef {{ source: SourceRef, studentRef: SourceRef, sectionRef: SourceRef, status: 'enrolled'|'waitlisted'|'dropped'|'withdrawn'|'completed', waitlistPosition: number|null, credits: number }} CanonicalEnrollment */
/** @typedef {{ studentRef: SourceRef, gpa: number|null, creditsEarned: number, creditsInProgress: number, standing: string, level: string, terms: { termCode: string, gpa: number|null }[] }} CanonicalAcademicSummary */

export const STATUS_MAP = {
  APPLICANT: 'prospective', ADMITTED: 'prospective', ACTIVE: 'active', LEAVE_OF_ABSENCE: 'inactive', SUSPENDED: 'inactive', WITHDRAWN: 'inactive', GRADUATED: 'alumni',
};
export const ENROLLMENT_MAP = { REGISTERED: 'enrolled', WAITLISTED: 'waitlisted', DROPPED: 'dropped', WITHDRAWN: 'withdrawn', COMPLETED: 'completed' };
