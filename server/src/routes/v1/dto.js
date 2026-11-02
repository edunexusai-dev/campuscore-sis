// Explicit response DTOs for the external integration API. Nothing is serialised from Prisma models
// directly, so new database columns never leak into integration responses by accident.
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const DAYS = ['', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

export const institutionDto = (i) => ({ id: i.id, slug: i.slug, name: i.name, shortName: i.shortName, timezone: i.timezone, website: i.website, email: i.email, phone: i.phone, emailDomain: i.emailDomain, studentEmailDomain: i.studentEmailDomain, address: { line1: i.addressLine, city: i.city, region: i.region, postalCode: i.postalCode, country: i.country } });

export const termDto = (t) => ({ id: t.id, code: t.code, name: t.name, academicYear: t.academicYear?.name ?? undefined, startDate: day(t.startDate), endDate: day(t.endDate), status: t.status, isCurrent: t.isCurrent, registration: { opens: t.registrationOpens, closes: t.registrationCloses, addDropDeadline: t.addDropDeadline, withdrawDeadline: t.withdrawDeadline }, gradesDueDate: t.gradesDueDate });

export const departmentDto = (d) => ({ id: d.id, code: d.code, name: d.name, college: d.college ? { id: d.college.id, code: d.college.code, name: d.college.name } : undefined, email: d.email, officeLocation: d.officeLocation });

export const programDto = (p) => ({ id: p.id, code: p.code, name: p.name, degreeType: p.degreeType, level: p.level, requiredCredits: p.requiredCredits, departmentId: p.departmentId, department: p.department?.name, active: p.active, description: p.description });

export const courseDto = (c) => ({ id: c.id, code: c.code, title: c.title, description: c.description, credits: c.credits, level: c.level, active: c.active, department: c.department ? { id: c.department.id, code: c.department.code, name: c.department.name } : undefined, prerequisites: c.prerequisites?.map((p) => ({ courseId: p.prerequisiteId, code: p.prerequisite.code, minGrade: p.minGrade })) ?? undefined });

export const meetingDto = (m) => ({ day: DAYS[m.dayOfWeek], dayOfWeek: m.dayOfWeek, startTime: m.startTime, endTime: m.endTime, room: m.room });

export const sectionDto = (s) => ({
  id: s.id,
  termId: s.termId,
  termCode: s.term?.code,
  course: s.course ? { id: s.course.id, code: s.course.code, title: s.course.title, credits: s.course.credits } : undefined,
  sectionNumber: s.sectionNumber,
  status: s.status,
  deliveryMode: s.deliveryMode,
  location: s.location,
  capacity: s.capacity,
  waitlistCapacity: s.waitlistCapacity,
  enrolled: s.seats?.registered,
  waitlisted: s.seats?.waitlisted,
  seatsAvailable: s.seats ? Math.max(0, s.capacity - s.seats.registered) : undefined,
  meetings: s.meetings?.map(meetingDto),
  instructors: s.instructors?.map((i) => ({ facultyId: i.facultyId, name: `${i.faculty.firstName} ${i.faculty.lastName}`, email: i.faculty.email, isPrimary: i.isPrimary })),
});

// Intentionally excludes date of birth, home address, emergency contacts and financial references.
export const studentDto = (s) => ({
  id: s.id,
  personId: s.personId,
  studentNumber: s.studentNumber,
  firstName: s.firstName,
  lastName: s.lastName,
  preferredName: s.preferredName,
  email: s.email,
  phone: s.phone,
  status: s.status,
  classLevel: s.classLevel,
  academicStanding: s.academicStanding,
  program: s.program ? { id: s.program.id, code: s.program.code, name: s.program.name, degreeType: s.program.degreeType } : null,
  admitTerm: s.admitTerm?.code ?? null,
  expectedGraduation: s.expectedGraduation,
  hasRegistrationHold: s.holds ? s.holds.some((h) => !h.releasedAt && h.blocksRegistration) : undefined,
  updatedAt: s.updatedAt,
});

export const facultyDto = (f) => ({ id: f.id, personId: f.personId, employeeNumber: f.employeeNumber, firstName: f.firstName, lastName: f.lastName, email: f.email, phone: f.phone, title: f.title, status: f.status, department: f.department ? { id: f.department.id, code: f.department.code, name: f.department.name } : undefined, officeLocation: f.officeLocation, officeHours: f.officeHours });

export const registrationDto = (r) => ({
  id: r.id,
  studentId: r.studentId,
  sectionId: r.sectionId,
  status: r.status,
  waitlistPosition: r.waitlistPosition,
  credits: r.creditsAttempted,
  source: r.source,
  registeredAt: r.registeredAt,
  statusChangedAt: r.statusChangedAt,
  student: r.student ? { id: r.student.id, studentNumber: r.student.studentNumber, name: `${r.student.preferredName || r.student.firstName} ${r.student.lastName}`, email: r.student.email } : undefined,
  section: r.section ? { id: r.section.id, termCode: r.section.term?.code, courseCode: r.section.course?.code, courseTitle: r.section.course?.title, sectionNumber: r.section.sectionNumber } : undefined,
});

export const calendarDto = (e) => ({ id: e.id, title: e.title, description: e.description, category: e.category, startDate: day(e.startDate), endDate: day(e.endDate), termId: e.termId });

export const announcementDto = (a) => ({ id: a.id, title: a.title, body: a.body, audience: a.audience, pinned: a.pinned, author: a.authorName, publishedAt: a.publishedAt, expiresAt: a.expiresAt });
