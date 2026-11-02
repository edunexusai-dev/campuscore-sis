// Academic record computations: grade scale, GPA, credits, standing, class level, degree audit, transcript.
// Only PUBLISHED grades are part of the official record. Draft/submitted/approved grades are never exposed to students.
import { prisma } from '../lib/prisma.js';
import { notFound } from '../lib/errors.js';
import { getPolicies } from './policyService.js';

export async function getGradeScale(institutionId, tx = prisma) {
  const scale = await tx.gradeScale.findFirst({
    where: { institutionId, isDefault: true },
    include: { entries: { orderBy: { sortOrder: 'asc' } } },
  });
  if (!scale) throw notFound('Default grade scale');
  const byLetter = Object.fromEntries(scale.entries.map((e) => [e.letter, { ...e, points: Number(e.points) }]));
  return { ...scale, entries: scale.entries.map((e) => byLetter[e.letter]), byLetter };
}

// Does `letter` meet a minimum grade like "C"? Pass/no-GPA grades satisfy only if they earn credit.
export function meetsMinimum(scale, letter, minLetter) {
  const g = scale.byLetter[letter];
  const min = scale.byLetter[minLetter];
  if (!g || !g.earnsCredit) return false;
  if (!g.countsInGpa) return true; // e.g. P
  return !min || g.points >= min.points;
}

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// Loads the student's registrations with course/term/grade, used by most computations below.
async function loadHistory(studentId, tx = prisma) {
  return tx.registration.findMany({
    where: { studentId, status: { in: ['REGISTERED', 'COMPLETED', 'WITHDRAWN'] } },
    include: {
      grade: true,
      section: { include: { course: true, term: true } },
    },
    orderBy: { section: { term: { startDate: 'asc' } } },
  });
}

// Computes term-by-term and cumulative GPA from published grades.
export function computeRecord(registrations, scale) {
  const terms = new Map();
  let cumQualityPoints = 0, cumGpaCredits = 0, creditsEarned = 0, creditsAttempted = 0, creditsInProgress = 0;

  for (const r of registrations) {
    const term = r.section.term;
    if (!terms.has(term.id)) {
      terms.set(term.id, { term: { id: term.id, code: term.code, name: term.name, startDate: term.startDate }, courses: [], qualityPoints: 0, gpaCredits: 0, creditsEarned: 0, creditsAttempted: 0 });
    }
    const t = terms.get(term.id);
    const credits = r.creditsAttempted;
    const published = r.grade?.status === 'PUBLISHED' ? r.grade : null;
    let letter = null, state;
    if (r.status === 'WITHDRAWN') { letter = 'W'; state = 'WITHDRAWN'; }
    else if (published) { letter = published.letter; state = 'GRADED'; }
    else { state = 'IN_PROGRESS'; }

    const entry = letter ? scale.byLetter[letter] : null;
    if (state === 'GRADED' && entry) {
      t.creditsAttempted += credits; creditsAttempted += credits;
      if (entry.countsInGpa) { t.qualityPoints += entry.points * credits; t.gpaCredits += credits; }
      if (entry.earnsCredit) { t.creditsEarned += credits; creditsEarned += credits; }
    } else if (state === 'IN_PROGRESS') {
      creditsInProgress += credits;
    }
    t.courses.push({
      registrationId: r.id,
      sectionId: r.sectionId,
      courseId: r.section.course.id,
      courseCode: r.section.course.code,
      courseTitle: r.section.course.title,
      credits,
      grade: letter,
      gradePoints: entry?.countsInGpa ? entry.points : null,
      state,
    });
  }

  const termList = [...terms.values()].map((t) => {
    cumQualityPoints += t.qualityPoints;
    cumGpaCredits += t.gpaCredits;
    return {
      term: t.term,
      courses: t.courses,
      creditsAttempted: t.creditsAttempted,
      creditsEarned: t.creditsEarned,
      termGpa: t.gpaCredits ? round(t.qualityPoints / t.gpaCredits) : null,
      cumulativeGpa: cumGpaCredits ? round(cumQualityPoints / cumGpaCredits) : null,
    };
  });

  return {
    terms: termList,
    cumulativeGpa: cumGpaCredits ? round(cumQualityPoints / cumGpaCredits) : null,
    qualityPoints: round(cumQualityPoints),
    gpaCredits: cumGpaCredits,
    creditsAttempted,
    creditsEarned,
    creditsInProgress,
  };
}

export async function getAcademicRecord(studentId, institutionId, tx = prisma) {
  const [scale, history] = await Promise.all([getGradeScale(institutionId, tx), loadHistory(studentId, tx)]);
  return computeRecord(history, scale);
}

export function standingFor(gpa, policies) {
  if (gpa == null) return 'GOOD';
  if (gpa < policies['standing.probationGpa']) return 'PROBATION';
  if (gpa >= policies['standing.deansListGpa']) return 'DEANS_LIST';
  return 'GOOD';
}

export function classLevelFor(creditsEarned, programLevel) {
  if (programLevel === 'GRADUATE') return 'GRADUATE';
  if (creditsEarned >= 90) return 'SENIOR';
  if (creditsEarned >= 60) return 'JUNIOR';
  if (creditsEarned >= 30) return 'SOPHOMORE';
  return 'FRESHMAN';
}

// Recomputes derived standing/class level after grades are published or changed.
// A manually-imposed SUSPENSION is never overwritten automatically.
export async function refreshStudentStanding(studentId, tx = prisma) {
  const student = await tx.student.findUnique({ where: { id: studentId }, include: { program: true } });
  if (!student) return null;
  const [record, policies] = await Promise.all([getAcademicRecord(studentId, student.institutionId, tx), getPolicies(student.institutionId, tx)]);
  const data = { classLevel: classLevelFor(record.creditsEarned, student.program?.level) };
  if (student.academicStanding !== 'SUSPENSION') data.academicStanding = standingFor(record.cumulativeGpa, policies);
  return tx.student.update({ where: { id: studentId }, data });
}

// Degree audit: required program courses, credit total and minimum GPA.
export async function getDegreeAudit(studentId, institutionId) {
  const student = await prisma.student.findFirst({
    where: { id: studentId, institutionId },
    include: { program: { include: { requirements: { include: { course: true } } } }, holds: { where: { releasedAt: null } } },
  });
  if (!student) throw notFound('Student');
  const scale = await getGradeScale(institutionId);
  const history = await loadHistory(studentId);
  const record = computeRecord(history, scale);
  if (!student.program) return { program: null, record, requirements: [], eligibleToGraduate: false, checks: [] };

  const requirements = student.program.requirements
    .sort((a, b) => a.course.code.localeCompare(b.course.code))
    .map((req) => {
      const attempts = history.filter((r) => r.section.courseId === req.courseId);
      const completed = attempts.find((r) => r.status !== 'WITHDRAWN' && r.grade?.status === 'PUBLISHED' && scale.byLetter[r.grade.letter]?.earnsCredit);
      const inProgress = attempts.find((r) => r.status === 'REGISTERED' && r.grade?.status !== 'PUBLISHED');
      return {
        courseId: req.courseId,
        courseCode: req.course.code,
        courseTitle: req.course.title,
        credits: req.course.credits,
        category: req.category,
        status: completed ? 'COMPLETE' : inProgress ? 'IN_PROGRESS' : 'NOT_STARTED',
        grade: completed?.grade.letter ?? null,
        term: (completed ?? inProgress)?.section.term.code ?? null,
      };
    });

  const minGpa = Number(student.program.minGpa);
  const checks = [
    { label: `Earn ${student.program.requiredCredits} credits`, met: record.creditsEarned >= student.program.requiredCredits, detail: `${record.creditsEarned} earned, ${record.creditsInProgress} in progress` },
    { label: 'Complete all required courses', met: requirements.every((r) => r.status === 'COMPLETE'), detail: `${requirements.filter((r) => r.status === 'COMPLETE').length} of ${requirements.length} complete` },
    { label: `Cumulative GPA of at least ${minGpa.toFixed(2)}`, met: (record.cumulativeGpa ?? 0) >= minGpa, detail: record.cumulativeGpa == null ? 'No GPA yet' : `Current GPA ${record.cumulativeGpa.toFixed(2)}` },
    { label: 'No active holds', met: student.holds.length === 0, detail: student.holds.length ? `${student.holds.length} active hold(s)` : 'None' },
  ];

  return {
    program: { id: student.program.id, code: student.program.code, name: student.program.name, degreeType: student.program.degreeType, requiredCredits: student.program.requiredCredits, minGpa },
    record: { cumulativeGpa: record.cumulativeGpa, creditsEarned: record.creditsEarned, creditsInProgress: record.creditsInProgress },
    percentComplete: Math.min(100, Math.round((record.creditsEarned / student.program.requiredCredits) * 100)),
    requirements,
    checks,
    eligibleToGraduate: checks.every((c) => c.met),
  };
}

export async function getTranscript(studentId, institutionId) {
  const student = await prisma.student.findFirst({
    where: { id: studentId, institutionId },
    include: { program: true, institution: true },
  });
  if (!student) throw notFound('Student');
  const record = await getAcademicRecord(studentId, institutionId);
  return {
    unofficial: true,
    generatedAt: new Date().toISOString(),
    institution: { name: student.institution.name, addressLine: student.institution.addressLine, city: student.institution.city, region: student.institution.region, postalCode: student.institution.postalCode },
    student: {
      id: student.id,
      studentNumber: student.studentNumber,
      name: `${student.firstName} ${student.lastName}`,
      program: student.program ? `${student.program.degreeType} ${student.program.name}` : null,
      status: student.status,
      academicStanding: student.academicStanding,
    },
    terms: record.terms,
    totals: { cumulativeGpa: record.cumulativeGpa, creditsAttempted: record.creditsAttempted, creditsEarned: record.creditsEarned, creditsInProgress: record.creditsInProgress, qualityPoints: record.qualityPoints },
  };
}
