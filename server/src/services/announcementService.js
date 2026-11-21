// Class announcements published through the integration API, on behalf of an instructor assigned to the section.
// The same record the faculty portal creates (audience STUDENTS, the instructor as author), so students see it
// wherever they read their class announcements.
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { forbidden, notFound, ruleViolation } from '../lib/errors.js';
import { assertInstructor } from './gradeService.js';

export async function createSectionAnnouncement(actor, { sectionId, facultyId, title, body, pinned = false }) {
  const section = await prisma.section.findFirst({ where: { id: sectionId, institutionId: actor.institutionId }, include: { course: true, term: true } });
  if (!section) throw notFound('Section');
  await assertInstructor(sectionId, facultyId, actor.institutionId);
  const faculty = await prisma.faculty.findFirst({ where: { id: facultyId, institutionId: actor.institutionId } });
  if (faculty.status !== 'ACTIVE') throw forbidden('The acting faculty member is not active.', 'faculty_inactive');
  if (section.status === 'CANCELLED') throw ruleViolation('section_cancelled', 'Announcements cannot be posted to a cancelled section.');

  const label = `${section.course.code}-${section.sectionNumber}`;
  return prisma.$transaction(async (tx) => {
    const a = await tx.announcement.create({
      data: { institutionId: actor.institutionId, sectionId, title, body, pinned, audience: 'STUDENTS', authorUserId: faculty.userId, authorName: `${faculty.firstName} ${faculty.lastName}` },
      include: { section: { include: { course: true, term: true } } },
    });
    await audit(actor, { action: 'announcement.created', entityType: 'Announcement', entityId: a.id, summary: `Posted class announcement "${a.title}" to ${label} on behalf of ${a.authorName} (${faculty.employeeNumber})`, after: { sectionId, facultyId, pinned } }, tx);
    return a;
  });
}
