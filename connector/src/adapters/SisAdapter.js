// Contract every SIS adapter implements. EdunexusAI depends only on this interface, so a commercial SIS
// (e.g. via its own REST or batch APIs) can be added as another adapter without changing the portal.
export class SisAdapter {
  /** @returns {{ system: string, reads: string[], writes: string[] }} what this connection may do */
  capabilities() { throw new Error('not implemented'); }
  async getInstitution() { throw new Error('not implemented'); }
  /** @returns {Promise<import('../canonical.js').CanonicalTerm[]>} */
  async listTerms() { throw new Error('not implemented'); }
  async getCurrentTerm() { throw new Error('not implemented'); }
  /** @returns {Promise<{ items: import('../canonical.js').CanonicalStudent[], total: number }>} */
  async searchStudents(_query) { throw new Error('not implemented'); }
  async getStudent(_id) { throw new Error('not implemented'); }
  /** @returns {Promise<{ term: object, items: (import('../canonical.js').CanonicalSection & { enrollment: object })[] }>} */
  async getStudentSchedule(_id, _termId) { throw new Error('not implemented'); }
  /** @returns {Promise<import('../canonical.js').CanonicalAcademicSummary>} */
  async getAcademicSummary(_id) { throw new Error('not implemented'); }
  async getGradeHistory(_id) { throw new Error('not implemented'); }
  async listFacultySections(_facultyId, _termId) { throw new Error('not implemented'); }
  async getRoster(_sectionId) { throw new Error('not implemented'); }
  async listAnnouncements() { throw new Error('not implemented'); }
  // Writes — adapters throw SisError('not_supported') when the connection lacks permission.
  async enroll(_studentId, _sectionId) { throw new Error('not implemented'); }
  async drop(_enrollmentId, _reason) { throw new Error('not implemented'); }
  async recordAttendance(_sectionId, _instructorId, _date, _records) { throw new Error('not implemented'); }
}
