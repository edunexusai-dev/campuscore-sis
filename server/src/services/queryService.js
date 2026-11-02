// Shared, tenant-scoped list queries used by the portal API and the integration API.
// Callers choose the DTO; these functions only build filters and fetch.
import { prisma } from '../lib/prisma.js';
import { notFound } from '../lib/errors.js';
import { pageArgs, toOrderBy } from '../lib/validate.js';
import { sectionSeatSummary } from './registrationService.js';

export async function findStudents(institutionId, { search, status, programId, classLevel, standing, hasHold, email, studentNumber, sort = 'lastName', page, pageSize }) {
  const where = {
    institutionId,
    ...(status ? { status } : {}),
    ...(programId ? { programId } : {}),
    ...(classLevel ? { classLevel } : {}),
    ...(standing ? { academicStanding: standing } : {}),
    ...(hasHold === 'true' ? { holds: { some: { releasedAt: null } } } : {}),
    ...(email ? { email: { equals: email, mode: 'insensitive' } } : {}),
    ...(studentNumber ? { studentNumber } : {}),
    ...(search ? { OR: [
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName: { contains: search, mode: 'insensitive' } },
      { preferredName: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { studentNumber: { contains: search, mode: 'insensitive' } },
    ] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.student.findMany({ where, include: { program: true, admitTerm: true, holds: { where: { releasedAt: null } } }, orderBy: [toOrderBy(sort), { id: 'asc' }], ...(page ? pageArgs({ page, pageSize }) : {}) }),
    prisma.student.count({ where }),
  ]);
  return { rows, total };
}

export async function getStudent(institutionId, id) {
  const s = await prisma.student.findFirst({ where: { id, institutionId }, include: { program: { include: { department: true } }, admitTerm: true, holds: { orderBy: { placedAt: 'desc' } }, user: { select: { id: true, email: true, status: true, lastLoginAt: true } } } });
  if (!s) throw notFound('Student');
  return s;
}

export async function findFaculty(institutionId, { search, departmentId, sort = 'lastName', page, pageSize }) {
  const where = {
    institutionId,
    ...(departmentId ? { departmentId } : {}),
    ...(search ? { OR: [
      { firstName: { contains: search, mode: 'insensitive' } },
      { lastName: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { employeeNumber: { contains: search, mode: 'insensitive' } },
    ] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.faculty.findMany({ where, include: { department: true, user: { select: { id: true, status: true, lastLoginAt: true } } }, orderBy: [toOrderBy(sort), { id: 'asc' }], ...(page ? pageArgs({ page, pageSize }) : {}) }),
    prisma.faculty.count({ where }),
  ]);
  return { rows, total };
}

export const sectionInclude = {
  course: { include: { department: true } },
  term: true,
  meetings: { orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }] },
  instructors: { include: { faculty: true } },
};

export async function findSections(institutionId, { termId, courseId, departmentId, facultyId, search, status, scheduled, sort, page, pageSize }) {
  const where = {
    institutionId,
    ...(termId ? { termId } : {}),
    ...(courseId ? { courseId } : {}),
    ...(status ? { status } : {}),
    ...(departmentId ? { course: { departmentId } } : {}),
    ...(facultyId ? { instructors: { some: { facultyId } } } : {}),
    // scheduled=false finds sections with no meeting times yet (to be completed by an administrator).
    ...(scheduled === 'false' ? { meetings: { none: {} } } : scheduled === 'true' ? { meetings: { some: {} } } : {}),
    ...(search ? { OR: [
      { course: { code: { contains: search, mode: 'insensitive' } } },
      { course: { title: { contains: search, mode: 'insensitive' } } },
    ] } : {}),
  };
  const orderBy = sort === 'term' ? [{ term: { startDate: 'desc' } }, { course: { code: 'asc' } }] : [{ course: { code: 'asc' } }, { sectionNumber: 'asc' }];
  const [rows, total] = await Promise.all([
    prisma.section.findMany({ where, include: sectionInclude, orderBy, ...(page ? pageArgs({ page, pageSize }) : {}) }),
    prisma.section.count({ where }),
  ]);
  const seats = await sectionSeatSummary(rows.map((r) => r.id));
  return { rows: rows.map((r) => ({ ...r, seats: seats[r.id] })), total };
}

export async function getSection(institutionId, id) {
  const s = await prisma.section.findFirst({ where: { id, institutionId }, include: { ...sectionInclude, course: { include: { department: true, prerequisites: { include: { prerequisite: true } } } } } });
  if (!s) throw notFound('Section');
  const seats = await sectionSeatSummary([id]);
  return { ...s, seats: seats[id] };
}

export async function findCourses(institutionId, { search, departmentId, active, level, sort = 'code', page, pageSize }) {
  const where = {
    institutionId,
    ...(departmentId ? { departmentId } : {}),
    ...(active !== undefined ? { active } : {}),
    ...(level ? { level } : {}),
    ...(search ? { OR: [{ code: { contains: search, mode: 'insensitive' } }, { title: { contains: search, mode: 'insensitive' } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.course.findMany({ where, include: { department: true, prerequisites: { include: { prerequisite: true } } }, orderBy: [toOrderBy(sort), { id: 'asc' }], ...(page ? pageArgs({ page, pageSize }) : {}) }),
    prisma.course.count({ where }),
  ]);
  return { rows, total };
}

export async function currentTerm(institutionId) {
  return (await prisma.term.findFirst({ where: { institutionId, isCurrent: true } }))
    ?? prisma.term.findFirst({ where: { institutionId }, orderBy: { startDate: 'desc' } });
}

// Student weekly schedule for a term (registered sections only, waitlisted flagged separately).
export async function studentSchedule(studentId, termId) {
  const regs = await prisma.registration.findMany({
    where: { studentId, status: { in: ['REGISTERED', 'WAITLISTED', 'COMPLETED'] }, section: { termId } },
    include: { section: { include: sectionInclude } },
    orderBy: { section: { course: { code: 'asc' } } },
  });
  return regs.map((r) => ({ registrationId: r.id, registrationStatus: r.status, waitlistPosition: r.waitlistPosition, section: r.section }));
}
