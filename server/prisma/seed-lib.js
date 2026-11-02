// CampusCore SIS — fictional demo data generator.
// All people, institutions and records are fictional. Term dates are anchored to the date the seed runs,
// so there is always a completed history, a term in progress and an upcoming term with registration open.
import crypto from 'node:crypto';
import { hashPassword, hashClientSecret, randomToken } from '../src/lib/crypto.js';

// Demo password kept stable across the rebrand so existing local notes keep working.
export const DEMO_PASSWORD = 'Northbridge#2026';

// ── Deterministic PRNG so every seed produces the same data ──
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261012);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;
const uid = () => crypto.randomUUID();
const DAY = 86400000;
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const dateOnly = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

// ── Reference data ──
const FIRST = ['Maya', 'Jordan', 'Aisha', 'Liam', 'Sofia', 'Noah', 'Priya', 'Mateo', 'Hana', 'Ethan', 'Zara', 'Lucas', 'Amara', 'Oliver', 'Mei', 'Diego', 'Nadia', 'Caleb', 'Leila', 'Samuel', 'Ingrid', 'Kwame', 'Elif', 'Rohan', 'Chloe', 'Tariq', 'Yuki', 'Gabriel', 'Fatima', 'Isaac', 'Ana', 'Malik', 'Freya', 'Arjun', 'Grace', 'Omar', 'Lucia', 'Daniel', 'Imani', 'Henrik', 'Sana', 'Marcus', 'Valentina', 'Kai', 'Ruth', 'Tomas', 'Adaeze', 'Felix', 'Noor', 'Julian', 'Esther', 'Rafael', 'Mira', 'Andre', 'Keiko', 'Owen', 'Bianca', 'Ibrahim', 'Clara', 'Wei'];
const LAST = ['Chen', 'Rivera', 'Okafor', 'Murphy', 'Rossi', 'Kim', 'Sharma', 'Garcia', 'Sato', 'Johnson', 'Haddad', 'Nguyen', 'Mensah', 'Fischer', 'Wang', 'Lopez', 'Petrov', 'Brooks', 'Farah', 'Adeyemi', 'Larsen', 'Boateng', 'Yilmaz', 'Patel', 'Dubois', 'Rahman', 'Tanaka', 'Silva', 'Hussain', 'Cohen', 'Morales', 'Washington', 'Nilsson', 'Iyer', 'Kowalski', 'Mahmoud', 'Romero', 'Bennett', 'Abara', 'Lindqvist', 'Qureshi', 'Reid', 'Castillo', 'Park', 'Stein', 'Novak', 'Eze', 'Moreau', 'Aziz', 'Hart', 'Osei', 'Navarro', 'Holm', 'Grant', 'Ito', 'Walsh', 'Costa', 'Bakr', 'Weber', 'Zhou'];
const CITIES = [['Northbridge', 'MA', '01890'], ['Salem', 'MA', '01970'], ['Lowell', 'MA', '01852'], ['Providence', 'RI', '02903'], ['Nashua', 'NH', '03060'], ['Worcester', 'MA', '01608'], ['Hartford', 'CT', '06103'], ['Portland', 'ME', '04101']];
const STREETS = ['Maple Ave', 'Elm St', 'Harbor Rd', 'Chestnut St', 'Prospect Hill', 'Riverside Dr', 'Linden Ln', 'Water St', 'College Ave', 'Summit Rd'];
const RELATIONS = ['Mother', 'Father', 'Parent', 'Guardian', 'Sibling', 'Spouse', 'Aunt', 'Grandparent'];

const COLLEGES = [
  { code: 'CSE', name: 'College of Science & Engineering' },
  { code: 'CAH', name: 'College of Arts & Humanities' },
  { code: 'SOB', name: 'Hollis School of Business' },
  { code: 'SHS', name: 'School of Health Sciences' },
];
const DEPARTMENTS = [
  { code: 'CS', college: 'CSE', name: 'Computer Science', office: 'Turing Hall 210' },
  { code: 'MATH', college: 'CSE', name: 'Mathematics', office: 'Noether Hall 105' },
  { code: 'PHYS', college: 'CSE', name: 'Physics', office: 'Meitner Hall 120' },
  { code: 'BIO', college: 'CSE', name: 'Biological & Chemical Sciences', office: 'Franklin Science Center 300' },
  { code: 'ENGL', college: 'CAH', name: 'English', office: 'Morrison Hall 220' },
  { code: 'HIST', college: 'CAH', name: 'History', office: 'Morrison Hall 310' },
  { code: 'PSYC', college: 'CAH', name: 'Psychology', office: 'Hopper Hall 140' },
  { code: 'BUS', college: 'SOB', name: 'Business Administration', office: 'Hollis Hall 400' },
  { code: 'ECON', college: 'SOB', name: 'Economics', office: 'Hollis Hall 250' },
  { code: 'NURS', college: 'SHS', name: 'Nursing', office: 'Nightingale Center 115' },
];

// [code, title, credits, prerequisites ("CODE" or "CODE:minGrade")]
const COURSES = {
  CS: [['CS 101', 'Introduction to Programming', 4, []], ['CS 120', 'Discrete Structures', 3, []], ['CS 201', 'Data Structures', 4, ['CS 101:C']], ['CS 220', 'Computer Organization', 3, ['CS 101']], ['CS 301', 'Design & Analysis of Algorithms', 3, ['CS 201:C', 'CS 120']], ['CS 310', 'Database Systems', 3, ['CS 201']], ['CS 330', 'Operating Systems', 3, ['CS 201', 'CS 220']], ['CS 350', 'Software Engineering', 3, ['CS 201']], ['CS 410', 'Machine Learning', 3, ['CS 301', 'MATH 241']], ['CS 450', 'Computer Networks', 3, ['CS 330']], ['CS 495', 'Senior Capstone Project', 3, ['CS 350']], ['CS 601', 'Advanced Algorithms', 3, []], ['CS 620', 'Distributed Systems', 3, []], ['CS 650', 'Deep Learning', 3, []]],
  MATH: [['MATH 151', 'Calculus I', 4, []], ['MATH 152', 'Calculus II', 4, ['MATH 151:C-']], ['MATH 241', 'Linear Algebra', 3, ['MATH 151']], ['MATH 251', 'Probability & Statistics', 3, ['MATH 151']], ['MATH 310', 'Real Analysis', 3, ['MATH 152']], ['MATH 330', 'Abstract Algebra', 3, ['MATH 241']]],
  PHYS: [['PHYS 151', 'University Physics I', 4, []], ['PHYS 152', 'University Physics II', 4, ['PHYS 151']], ['PHYS 210', 'Modern Physics', 3, ['PHYS 152']]],
  BIO: [['BIO 110', 'Principles of Biology', 4, []], ['CHEM 110', 'General Chemistry', 4, []], ['BIO 210', 'Genetics', 3, ['BIO 110']], ['BIO 220', 'Cell Biology', 3, ['BIO 110']], ['BIO 330', 'Microbiology', 4, ['BIO 220']], ['BIO 340', 'Ecology', 3, ['BIO 110']]],
  ENGL: [['ENGL 101', 'College Writing', 3, []], ['ENGL 102', 'Writing & Research', 3, ['ENGL 101']], ['ENGL 210', 'British Literature Survey', 3, []], ['ENGL 220', 'American Literature Survey', 3, []], ['ENGL 330', 'Creative Writing Workshop', 3, ['ENGL 102']], ['ENGL 410', 'Literary Theory', 3, ['ENGL 210']]],
  HIST: [['HIST 101', 'World History to 1500', 3, []], ['HIST 102', 'World History since 1500', 3, []], ['HIST 210', 'United States History', 3, []], ['HIST 320', 'Modern Europe', 3, ['HIST 102']], ['HIST 450', 'Historiography Seminar', 3, ['HIST 320']]],
  PSYC: [['PSYC 101', 'Introduction to Psychology', 3, []], ['PSYC 210', 'Developmental Psychology', 3, ['PSYC 101']], ['PSYC 230', 'Research Methods', 3, ['PSYC 101']], ['PSYC 320', 'Cognitive Psychology', 3, ['PSYC 101']], ['PSYC 340', 'Abnormal Psychology', 3, ['PSYC 101']]],
  BUS: [['BUS 101', 'Introduction to Business', 3, []], ['BUS 210', 'Financial Accounting', 3, []], ['BUS 220', 'Principles of Marketing', 3, ['BUS 101']], ['BUS 310', 'Corporate Finance', 3, ['BUS 210']], ['BUS 330', 'Operations Management', 3, ['MATH 251']], ['BUS 450', 'Strategic Management', 3, ['BUS 310']], ['BUS 610', 'Managerial Economics', 3, []], ['BUS 620', 'Leadership & Organizations', 3, []]],
  ECON: [['ECON 201', 'Principles of Microeconomics', 3, []], ['ECON 202', 'Principles of Macroeconomics', 3, []], ['ECON 301', 'Intermediate Microeconomics', 3, ['ECON 201', 'MATH 151']], ['ECON 320', 'Econometrics', 3, ['MATH 251', 'ECON 201']]],
  NURS: [['NURS 101', 'Foundations of Nursing', 3, []], ['NURS 210', 'Health Assessment', 4, ['NURS 101', 'BIO 110']], ['NURS 220', 'Pharmacology', 3, ['NURS 101']], ['NURS 310', 'Adult Health Nursing', 4, ['NURS 210']], ['NURS 410', 'Community Health Nursing', 3, ['NURS 310']]],
};
const DESCRIPTIONS = {
  'CS 101': 'Problem solving and program design using a modern programming language. Variables, control flow, functions, collections and testing.',
  'CS 201': 'Abstract data types and their implementations: lists, stacks, queues, trees, hash tables and graphs. Complexity analysis.',
  'CS 301': 'Techniques for designing efficient algorithms: divide and conquer, dynamic programming, greedy methods, graph algorithms and NP-completeness.',
  'CS 410': 'Supervised and unsupervised learning, model evaluation, regularisation, neural networks and responsible ML practice.',
  'MATH 151': 'Limits, derivatives and integrals of functions of one variable, with applications.',
  'ENGL 101': 'Academic writing with an emphasis on argument, revision and source use.',
  'BIO 110': 'Foundations of modern biology: cells, genetics, evolution and ecology. Includes laboratory.',
  'PSYC 101': 'Survey of the science of behaviour and mental processes.',
  'BUS 101': 'Overview of business functions, organisations and the environment in which they operate.',
  'NURS 101': 'Introduction to the nursing profession, scope of practice, ethics and patient-centred care.',
};

const PROGRAMS = [
  { code: 'BS-CS', dept: 'CS', name: 'Computer Science', degreeType: 'BS', level: 'UNDERGRADUATE', credits: 120, req: ['CS 101', 'CS 120', 'CS 201', 'CS 220', 'CS 301', 'CS 310', 'CS 330', 'CS 350', 'CS 410', 'CS 495', 'MATH 151', 'MATH 152', 'MATH 241', 'MATH 251', 'ENGL 101'], weight: 30 },
  { code: 'BS-MATH', dept: 'MATH', name: 'Mathematics', degreeType: 'BS', level: 'UNDERGRADUATE', credits: 120, req: ['MATH 151', 'MATH 152', 'MATH 241', 'MATH 251', 'MATH 310', 'MATH 330', 'CS 101', 'PHYS 151', 'ENGL 101'], weight: 8 },
  { code: 'BS-BIO', dept: 'BIO', name: 'Biology', degreeType: 'BS', level: 'UNDERGRADUATE', credits: 120, req: ['BIO 110', 'CHEM 110', 'BIO 210', 'BIO 220', 'BIO 330', 'BIO 340', 'MATH 151', 'MATH 251', 'ENGL 101'], weight: 16 },
  { code: 'BA-ENGL', dept: 'ENGL', name: 'English', degreeType: 'BA', level: 'UNDERGRADUATE', credits: 120, req: ['ENGL 101', 'ENGL 102', 'ENGL 210', 'ENGL 220', 'ENGL 330', 'ENGL 410', 'HIST 101'], weight: 8 },
  { code: 'BA-HIST', dept: 'HIST', name: 'History', degreeType: 'BA', level: 'UNDERGRADUATE', credits: 120, req: ['HIST 101', 'HIST 102', 'HIST 210', 'HIST 320', 'HIST 450', 'ENGL 101'], weight: 6 },
  { code: 'BA-PSYC', dept: 'PSYC', name: 'Psychology', degreeType: 'BA', level: 'UNDERGRADUATE', credits: 120, req: ['PSYC 101', 'PSYC 210', 'PSYC 230', 'PSYC 320', 'PSYC 340', 'MATH 251', 'ENGL 101', 'BIO 110'], weight: 16 },
  { code: 'BBA', dept: 'BUS', name: 'Business Administration', degreeType: 'BBA', level: 'UNDERGRADUATE', credits: 120, req: ['BUS 101', 'BUS 210', 'BUS 220', 'BUS 310', 'BUS 330', 'BUS 450', 'ECON 201', 'ECON 202', 'MATH 151', 'MATH 251', 'ENGL 101'], weight: 22 },
  { code: 'BA-ECON', dept: 'ECON', name: 'Economics', degreeType: 'BA', level: 'UNDERGRADUATE', credits: 120, req: ['ECON 201', 'ECON 202', 'ECON 301', 'ECON 320', 'MATH 151', 'MATH 251', 'ENGL 101'], weight: 8 },
  { code: 'BSN', dept: 'NURS', name: 'Nursing', degreeType: 'BSN', level: 'UNDERGRADUATE', credits: 124, req: ['NURS 101', 'NURS 210', 'NURS 220', 'NURS 310', 'NURS 410', 'BIO 110', 'CHEM 110', 'PSYC 101', 'ENGL 101'], weight: 16 },
  { code: 'MS-CS', dept: 'CS', name: 'Computer Science', degreeType: 'MS', level: 'GRADUATE', credits: 30, req: ['CS 601', 'CS 620', 'CS 650', 'CS 410', 'CS 450'], weight: 6 },
  { code: 'MBA', dept: 'BUS', name: 'Business Administration', degreeType: 'MBA', level: 'GRADUATE', credits: 36, req: ['BUS 610', 'BUS 620', 'BUS 310', 'BUS 450'], weight: 6 },
];

const FACULTY = [
  ['Elena', 'Vasquez', 'CS', 'Associate Professor'], ['Marcus', 'Whitfield', 'CS', 'Professor'], ['Anika', 'Desai', 'CS', 'Assistant Professor'], ['Tobias', 'Lindgren', 'CS', 'Lecturer'],
  ['Rebecca', 'Okonkwo', 'MATH', 'Professor'], ['Daniel', 'Reyes', 'MATH', 'Associate Professor'], ['Sun-hee', 'Park', 'MATH', 'Lecturer'],
  ['Victor', 'Almeida', 'PHYS', 'Associate Professor'],
  ['Hannah', 'Brightwater', 'BIO', 'Professor'], ['Kofi', 'Asante', 'BIO', 'Assistant Professor'], ['Lena', 'Hoffmann', 'BIO', 'Lecturer'],
  ['Margaret', 'Ellison', 'ENGL', 'Professor'], ['Julien', 'Marchand', 'ENGL', 'Assistant Professor'],
  ['Samuel', 'Achebe', 'HIST', 'Associate Professor'], ['Clara', 'Bergström', 'HIST', 'Lecturer'],
  ['Naomi', 'Feldman', 'PSYC', 'Professor'], ['Ravi', 'Kapoor', 'PSYC', 'Assistant Professor'],
  ['Catherine', 'Doyle', 'BUS', 'Professor'], ['Andre', 'Mbeki', 'BUS', 'Associate Professor'], ['Laura', 'Chen-Ward', 'BUS', 'Lecturer'],
  ['Peter', 'Novak', 'ECON', 'Associate Professor'],
  ['Grace', 'Adeyemi', 'NURS', 'Professor'], ['Michelle', 'Santos', 'NURS', 'Clinical Assistant Professor'],
];
// Explicit teaching assignments for the demo faculty account; others are assigned round-robin.
const ASSIGN = { 'CS 201': 'Vasquez', 'CS 301': 'Vasquez', 'CS 410': 'Vasquez', 'CS 601': 'Vasquez' };

// Meeting patterns: [days, start, end]
const SLOTS = [
  [[1, 3, 5], '09:00', '09:50'], [[2, 4], '09:30', '10:45'], [[1, 3, 5], '10:00', '10:50'], [[2, 4], '11:00', '12:15'],
  [[1, 3, 5], '11:00', '11:50'], [[1, 3], '13:00', '14:15'], [[2, 4], '14:00', '15:15'], [[1, 3, 5], '14:00', '14:50'],
  [[2, 4], '15:30', '16:45'], [[1, 3], '16:00', '17:15'], [[3], '18:00', '20:45'], [[1, 3, 5], '08:00', '08:50'],
];
const BUILDINGS = { CS: 'Turing Hall', MATH: 'Noether Hall', PHYS: 'Meitner Hall', BIO: 'Franklin Science Center', ENGL: 'Morrison Hall', HIST: 'Morrison Hall', PSYC: 'Hopper Hall', BUS: 'Hollis Hall', ECON: 'Hollis Hall', NURS: 'Nightingale Center' };

const GRADE_SCALE = [
  ['A', 4.0, 93, true, true, 'Excellent'], ['A-', 3.7, 90, true, true, null], ['B+', 3.3, 87, true, true, null], ['B', 3.0, 83, true, true, 'Good'], ['B-', 2.7, 80, true, true, null],
  ['C+', 2.3, 77, true, true, null], ['C', 2.0, 73, true, true, 'Satisfactory'], ['C-', 1.7, 70, true, true, null], ['D+', 1.3, 67, true, true, null], ['D', 1.0, 60, true, true, 'Poor'],
  ['F', 0.0, 0, true, false, 'Failing'], ['P', 0.0, null, false, true, 'Pass (no GPA effect)'], ['NP', 0.0, null, false, false, 'No pass'], ['I', 0.0, null, false, false, 'Incomplete'], ['W', 0.0, null, false, false, 'Withdrawn'],
];
const LETTER_POINTS = Object.fromEntries(GRADE_SCALE.map(([l, p]) => [l, p]));
const GRADE_LADDER = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'F'];

function gradeFor(ability) {
  // ability ~ 0..1 → index into ladder with noise.
  const idx = Math.round((1 - ability) * 9 + (rand() - 0.5) * 4);
  return GRADE_LADDER[Math.max(0, Math.min(GRADE_LADDER.length - 1, idx))];
}

// ── Terms anchored to today ──
// The current term started ~7 weeks ago. Terms alternate Fall/Spring with realistic spacing
// (Fall → Spring: 21 weeks start-to-start; Spring → Fall: 31 weeks).
function buildTerms(now) {
  const monday = (d) => { const x = dateOnly(d); const dow = (x.getUTCDay() + 6) % 7; return addDays(x, -dow); };
  const currentStart = monday(addDays(now, -49));
  const isFall = (d) => { const m = d.getUTCMonth(); return m >= 6 && m <= 10; };
  const starts = { 0: currentStart };
  for (let k = -1; k >= -7; k--) starts[k] = addDays(starts[k + 1], isFall(starts[k + 1]) ? -217 : -147);
  starts[1] = addDays(currentStart, isFall(currentStart) ? 147 : 217);
  const terms = [];
  for (let k = -7; k <= 1; k++) {
    const start = starts[k];
    const end = addDays(start, 16 * 7 - 3);
    const fall = isFall(start);
    const year = fall ? start.getUTCFullYear() : addDays(start, 28).getUTCFullYear();
    const code = `${year}${fall ? 'FA' : 'SP'}`;
    const name = `${fall ? 'Fall' : 'Spring'} ${year}`;
    const status = k < 0 ? 'COMPLETED' : k === 0 ? 'IN_PROGRESS' : 'REGISTRATION_OPEN';
    terms.push({
      k, code, name, start, end, status, isCurrent: k === 0,
      registrationOpens: k === 1 ? addDays(dateOnly(now), -10) : addDays(start, -120),
      registrationCloses: addDays(start, 10),
      addDropDeadline: addDays(start, 10),
      withdrawDeadline: k === 0 ? addDays(dateOnly(now), 18) : addDays(start, 63),
      gradesDueDate: addDays(end, 5),
    });
  }
  return terms;
}

function academicYearFor(d) {
  const y = d.getUTCFullYear();
  return d.getUTCMonth() >= 6 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

export async function seed(prisma, { log = console.log } = {}) {
  const now = new Date();
  log('Clearing existing data…');
  const tables = await prisma.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length) await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);

  const passwordHash = await hashPassword(DEMO_PASSWORD);

  // ── Institution ──
  const instId = uid();
  await prisma.institution.create({ data: { id: instId, slug: 'feddrick', name: 'Feddrick University', shortName: 'FU', timezone: 'America/New_York', website: 'https://www.feddrick.example.edu', email: 'registrar@feddrick.edu', emailDomain: 'feddrick.edu', studentEmailDomain: 'students.feddrick.edu', phone: '+1 (978) 555-0100', addressLine: '1 University Commons', city: 'Feddrick Heights', region: 'MA', postalCode: '01890', country: 'US' } });

  const scaleId = uid();
  await prisma.gradeScale.create({ data: { id: scaleId, institutionId: instId, name: 'Standard 4.0', isDefault: true, entries: { create: GRADE_SCALE.map(([letter, points, minPercent, countsInGpa, earnsCredit, description], i) => ({ letter, points, minPercent, countsInGpa, earnsCredit, description, sortOrder: i })) } } });

  // Persist a few non-default policy values so the policy screen shows real stored values.
  await prisma.policy.createMany({ data: [
    { institutionId: instId, key: 'registration.maxCreditsPerTerm', value: 18 },
    { institutionId: instId, key: 'api.allowGradeWrites', value: false },
  ] });

  // ── Terms ──
  const termDefs = buildTerms(now);
  const years = {};
  for (const t of termDefs) {
    const name = academicYearFor(t.start);
    if (!years[name]) {
      const y0 = Number(name.slice(0, 4));
      years[name] = uid();
      await prisma.academicYear.create({ data: { id: years[name], institutionId: instId, name, startDate: new Date(Date.UTC(y0, 6, 1)), endDate: new Date(Date.UTC(y0 + 1, 5, 30)) } });
    }
    t.id = uid();
    await prisma.term.create({ data: { id: t.id, institutionId: instId, academicYearId: years[name], code: t.code, name: t.name, startDate: t.start, endDate: t.end, registrationOpens: t.registrationOpens, registrationCloses: t.registrationCloses, addDropDeadline: t.addDropDeadline, withdrawDeadline: t.withdrawDeadline, gradesDueDate: t.gradesDueDate, status: t.status, isCurrent: t.isCurrent } });
  }
  const current = termDefs.find((t) => t.k === 0);
  const next = termDefs.find((t) => t.k === 1);
  const past = termDefs.filter((t) => t.k < 0);
  log(`Terms: ${termDefs.map((t) => t.code).join(', ')} (current ${current.code}, registration open for ${next.code})`);

  // ── Structure ──
  const collegeIds = {};
  for (const c of COLLEGES) { collegeIds[c.code] = uid(); await prisma.college.create({ data: { id: collegeIds[c.code], institutionId: instId, ...c } }); }
  const deptIds = {};
  for (const d of DEPARTMENTS) {
    deptIds[d.code] = uid();
    await prisma.department.create({ data: { id: deptIds[d.code], institutionId: instId, collegeId: collegeIds[d.college], code: d.code, name: d.name, officeLocation: d.office, email: `${d.code.toLowerCase()}@feddrick.edu` } });
  }
  const courses = {}; // code → { id, credits, dept, prereqs: [{code,min}], level }
  for (const [dept, list] of Object.entries(COURSES)) {
    for (const [code, title, credits, prereqs] of list) {
      const level = Number(code.split(' ')[1].slice(0, 1)) * 100;
      courses[code] = { id: uid(), code, title, credits, dept, level, prereqs: prereqs.map((p) => { const [c, m] = p.split(':'); return { code: c, min: m || 'D' }; }) };
      await prisma.course.create({ data: { id: courses[code].id, institutionId: instId, departmentId: deptIds[dept], code, title, credits, level, description: DESCRIPTIONS[code] ?? `${title}. See the department for the full syllabus and learning outcomes.` } });
    }
  }
  await prisma.coursePrerequisite.createMany({ data: Object.values(courses).flatMap((c) => c.prereqs.map((p) => ({ courseId: c.id, prerequisiteId: courses[p.code].id, minGrade: p.min }))) });

  const programs = {};
  for (const p of PROGRAMS) {
    programs[p.code] = { ...p, id: uid() };
    await prisma.program.create({ data: { id: programs[p.code].id, institutionId: instId, departmentId: deptIds[p.dept], code: p.code, name: p.name, degreeType: p.degreeType, level: p.level, requiredCredits: p.credits, minGpa: p.level === 'GRADUATE' ? 3.0 : 2.0, description: `${p.degreeType} in ${p.name} offered by the Department of ${DEPARTMENTS.find((d) => d.code === p.dept).name}.` } });
    await prisma.programRequirement.createMany({ data: p.req.map((code) => ({ programId: programs[p.code].id, courseId: courses[code].id, category: courses[code].dept === p.dept ? 'MAJOR' : code === 'ENGL 101' ? 'GENERAL_EDUCATION' : 'CORE' })) });
  }

  // ── Staff users ──
  const adminUserId = uid();
  await prisma.user.createMany({ data: [
    { id: adminUserId, institutionId: instId, email: 'admin@feddrick.edu', passwordHash, firstName: 'Avery', lastName: 'Collins', role: 'ADMIN' },
    { id: uid(), institutionId: instId, email: 'registrar@feddrick.edu', passwordHash, firstName: 'Priya', lastName: 'Raman', role: 'REGISTRAR' },
  ] });

  // ── Faculty ── (every person gets the next person number, in creation order like the registry migration)
  let personSeq = 0;
  const nextPerson = () => `P${String(++personSeq).padStart(7, '0')}`;
  const faculty = [];
  for (const [i, [first, last, dept, title]] of FACULTY.entries()) {
    const userId = uid();
    const email = `${first[0].toLowerCase()}.${last.toLowerCase().replace(/[^a-z]/g, '')}@feddrick.edu`;
    const person = await prisma.person.create({ data: { institutionId: instId, personNumber: nextPerson() } });
    await prisma.user.create({ data: { id: userId, institutionId: instId, personId: person.id, email, passwordHash, firstName: first, lastName: last, role: 'FACULTY' } });
    const f = { id: uid(), first, last, dept, userId, personId: person.id };
    await prisma.faculty.create({ data: { id: f.id, institutionId: instId, personId: person.id, userId, employeeNumber: `F${String(1001 + i).padStart(5, '0')}`, firstName: first, lastName: last, email, phone: `+1 (978) 555-${String(2100 + i).padStart(4, '0')}`, title: title.startsWith('Lecturer') || title.startsWith('Clinical') ? title : `${title} of ${DEPARTMENTS.find((d) => d.code === dept).name}`, departmentId: deptIds[dept], officeLocation: `${BUILDINGS[dept]} ${200 + i}`, officeHours: pick(['Mon & Wed 2:00–3:30 pm', 'Tue & Thu 10:00–11:30 am', 'Wed 1:00–4:00 pm', 'Mon 10:00 am–12:00 pm, Thu 3:00–4:00 pm', 'By appointment and Fri 9:00–11:00 am']) } });
    faculty.push(f);
  }
  const facultyByDept = {};
  for (const f of faculty) (facultyByDept[f.dept] ??= []).push(f);

  // ── Sections for every term ──
  const sections = []; // { id, termK, course, number, capacity, slot, facultyId, enrolled }
  let slotCursor = 0;
  for (const t of termDefs) {
    for (const c of Object.values(courses)) {
      // Graduate and some upper-level courses run once a year (alternate terms).
      if (c.level >= 400 && Math.abs(t.k) % 2 === 1 && !['CS 410', 'CS 495', 'BUS 450', 'NURS 410'].includes(c.code)) continue;
      const big = ['CS 101', 'MATH 151', 'ENGL 101', 'BIO 110', 'PSYC 101', 'BUS 101', 'ECON 201', 'CHEM 110', 'HIST 101'].includes(c.code);
      const count = big ? 2 : 1;
      const deptFaculty = facultyByDept[c.dept];
      for (let n = 1; n <= count; n++) {
        const assigned = n === 1 && ASSIGN[c.code] ? faculty.find((f) => f.last === ASSIGN[c.code]) : deptFaculty.filter((f) => f.last !== 'Vasquez' || c.dept !== 'CS')[(Object.keys(courses).indexOf(c.code) + n) % deptFaculty.filter((f) => f.last !== 'Vasquez' || c.dept !== 'CS').length];
        const slot = SLOTS[(slotCursor++ * 7 + n) % SLOTS.length];
        const capacity = c.level >= 600 ? 20 : big ? 40 : c.level >= 300 ? 24 : 32;
        sections.push({ id: uid(), termK: t.k, termId: t.id, course: c, number: String(n).padStart(2, '0'), capacity, waitlistCapacity: c.level >= 600 ? 3 : 5, slot, facultyId: assigned.id, enrolled: 0, room: `${BUILDINGS[c.dept]} ${100 + ((slotCursor * 13) % 300)}` });
      }
    }
  }
  // Demo-friendly fixed slots: Vasquez's sections never overlap each other, and the demo student's plan fits.
  const fixSlot = (code, slotIdx) => sections.filter((s) => s.course.code === code && s.number === '01').forEach((s) => { s.slot = SLOTS[slotIdx]; });
  fixSlot('CS 201', 0); fixSlot('CS 301', 3); fixSlot('CS 410', 6); fixSlot('CS 601', 10); fixSlot('CS 330', 2); fixSlot('ENGL 210', 5); fixSlot('BUS 101', 8);
  for (const s of sections) {
    await prisma.section.create({ data: {
      id: s.id, institutionId: instId, termId: s.termId, courseId: s.course.id, sectionNumber: s.number, capacity: s.capacity, waitlistCapacity: s.waitlistCapacity,
      location: s.room, deliveryMode: s.course.level >= 600 && chance(0.4) ? 'HYBRID' : 'IN_PERSON', status: 'OPEN',
      meetings: { create: s.slot[0].map((d) => ({ dayOfWeek: d, startTime: s.slot[1], endTime: s.slot[2], room: s.room })) },
      instructors: { create: [{ facultyId: s.facultyId, isPrimary: true }] },
    } });
  }
  log(`Sections: ${sections.length}`);

  const toMin = (h) => { const [a, b] = h.split(':').map(Number); return a * 60 + b; };
  const overlaps = (a, b) => a.slot[0].some((d) => b.slot[0].includes(d)) && toMin(a.slot[1]) < toMin(b.slot[2]) && toMin(b.slot[1]) < toMin(a.slot[2]);

  // ── Students ──
  const programPool = PROGRAMS.flatMap((p) => Array(p.weight).fill(p.code));
  const students = [];
  const usedNames = new Set();
  const N = 180;
  for (let i = 0; i < N; i++) {
    let first, last;
    do { first = pick(FIRST); last = pick(LAST); } while (usedNames.has(`${first} ${last}`));
    usedNames.add(`${first} ${last}`);
    const programCode = i === 0 ? 'BS-CS' : i === 1 ? 'BBA' : pick(programPool);
    const program = programs[programCode];
    const grad = program.level === 'GRADUATE';
    const admitK = i === 0 ? -4 : i === 1 ? -3 : grad ? pick([-3, -2, -1, 0]) : pick([-7, -7, -6, -6, -5, -4, -4, -3, -2, -2, -1, 0, 0]);
    students.push({ i, first, last, program, admitK, ability: i === 0 ? 0.86 : i === 1 ? 0.6 : Math.min(1, Math.max(0.05, 0.25 + rand() * 0.72 + (chance(0.1) ? -0.3 : 0))), status: 'ACTIVE' });
  }
  students[0].first = 'Maya'; students[0].last = 'Chen';
  students[1].first = 'Jordan'; students[1].last = 'Rivera';
  // A few non-active statuses.
  for (const idx of [12, 47, 88, 131, 160]) students[idx].status = 'LEAVE_OF_ABSENCE';
  for (const idx of [23, 99, 142]) students[idx].status = 'WITHDRAWN';
  students[77].status = 'SUSPENDED';

  const termByK = Object.fromEntries(termDefs.map((t) => [t.k, t]));
  const studentRows = [], userRows = [], personRows = [], regRows = [], gradeRows = [], eventRows = [];
  const yr = String(now.getUTCFullYear()).slice(2);

  // Demo student's exact course plan by term offset.
  const MAYA_PLAN = { [-4]: ['CS 101', 'MATH 151', 'ENGL 101', 'HIST 101'], [-3]: ['CS 120', 'CS 201', 'MATH 152', 'PSYC 101'], [-2]: ['CS 220', 'MATH 241', 'CS 310', 'ENGL 102'], [-1]: ['CS 350', 'MATH 251', 'ECON 201', 'BIO 110'], 0: ['CS 301', 'CS 330', 'ENGL 210', 'BUS 101'] };

  for (const s of students) {
    s.id = uid();
    s.userId = uid();
    s.personId = uid();
    s.studentNumber = `S${String(Number(yr) - Math.ceil(-s.admitK / 2)).padStart(2, '0')}${String(s.i + 1).padStart(5, '0')}`;
    s.email = `${s.first}.${s.last}`.toLowerCase().replace(/[^a-z.]/g, '') + (s.i > 1 ? s.i : '') + '@students.feddrick.edu';
    const [city, region, postal] = pick(CITIES);
    const completed = {}; // code → letter
    const termGrades = [];
    const lastK = s.status === 'ACTIVE' ? 0 : -1 - (s.i % 2);
    for (let k = s.admitK; k <= lastK; k++) {
      const t = termByK[k];
      const termSections = sections.filter((x) => x.termK === k);
      const taken = [];
      const load = s.program.level === 'GRADUATE' ? 3 : chance(0.75) ? 4 : 5;
      const wanted = s.i === 0 ? MAYA_PLAN[k] ?? [] : null;
      const isEligible = (c) => !completed[c.code] && c.prereqs.every((p) => completed[p.code] && (LETTER_POINTS[completed[p.code]] ?? 0) >= LETTER_POINTS[p.min]) && !taken.some((x) => x.course.code === c.code);
      const candidates = wanted
        ? wanted.map((code) => courses[code])
        : [
            ...s.program.req.map((c) => courses[c]).filter((c) => c.level < 600 || s.program.level === 'GRADUATE'),
            ...Object.values(courses).filter((c) => (s.program.level === 'GRADUATE' ? c.level >= 400 && c.dept === s.program.dept : c.level <= 200)).sort(() => rand() - 0.5),
          ];
      for (const c of candidates) {
        if (taken.length >= load) break;
        if (!wanted && (!isEligible(c) || (s.program.level !== 'GRADUATE' && c.level >= 600))) continue;
        const options = termSections.filter((x) => x.course.code === c.code && x.enrolled < x.capacity && !taken.some((y) => overlaps(x, y)));
        if (!options.length) continue;
        const sec = options[0];
        sec.enrolled += 1;
        taken.push(sec);
      }
      if (k === 0) s.currentCourses = taken.map((x) => x.course.code);
      for (const sec of taken) {
        const regId = uid();
        const isPast = k < 0;
        const withdrew = isPast && chance(0.03);
        const status = !isPast ? 'REGISTERED' : withdrew ? 'WITHDRAWN' : 'COMPLETED';
        regRows.push({ id: regId, institutionId: instId, studentId: s.id, sectionId: sec.id, status, source: k <= -2 ? 'ADMIN' : 'STUDENT_PORTAL', registeredAt: addDays(t.registrationOpens, 3 + Math.floor(rand() * 40)), statusChangedAt: isPast ? addDays(t.end, withdrew ? -50 : 7) : addDays(t.registrationOpens, 20), creditsAttempted: sec.course.credits });
        eventRows.push({ id: uid(), registrationId: regId, action: 'ADD', toStatus: 'REGISTERED', actorType: 'USER', createdAt: addDays(t.registrationOpens, 3) });
        if (withdrew) eventRows.push({ id: uid(), registrationId: regId, action: 'WITHDRAW', fromStatus: 'REGISTERED', toStatus: 'WITHDRAWN', actorType: 'USER', reason: 'Student-initiated withdrawal', createdAt: addDays(t.end, -50) });
        if (isPast && !withdrew) {
          const letter = s.i === 0 ? pick(['A', 'A', 'A-', 'B+', 'A-']) : gradeFor(s.ability);
          completed[sec.course.code] = letter;
          termGrades.push({ letter, credits: sec.course.credits });
          gradeRows.push({ id: uid(), registrationId: regId, letter, status: 'PUBLISHED', enteredByType: 'USER', submittedAt: addDays(t.end, 2), approvedAt: addDays(t.end, 4), publishedAt: addDays(t.end, 6), sec, regId });
        }
      }
    }
    s.completed = completed;
    // Derived standing and class level (same rules as academicService).
    const gpaCredits = termGrades.reduce((a, g) => a + g.credits, 0);
    const gpa = gpaCredits ? termGrades.reduce((a, g) => a + LETTER_POINTS[g.letter] * g.credits, 0) / gpaCredits : null;
    const earned = termGrades.filter((g) => g.letter !== 'F').reduce((a, g) => a + g.credits, 0);
    const classLevel = s.program.level === 'GRADUATE' ? 'GRADUATE' : earned >= 90 ? 'SENIOR' : earned >= 60 ? 'JUNIOR' : earned >= 30 ? 'SOPHOMORE' : 'FRESHMAN';
    const standing = s.i === 77 ? 'SUSPENSION' : gpa == null ? 'GOOD' : gpa < 2 ? 'PROBATION' : gpa >= 3.5 ? 'DEANS_LIST' : 'GOOD';
    s.gpa = gpa;
    const gradYear = now.getUTCFullYear() + Math.max(0, Math.ceil((s.program.credits - earned) / 30));
    personRows.push({ id: s.personId, institutionId: instId, personNumber: nextPerson() });
    userRows.push({ id: s.userId, institutionId: instId, personId: s.personId, email: s.email, passwordHash, firstName: s.first, lastName: s.last, role: 'STUDENT', status: s.status === 'WITHDRAWN' ? 'DISABLED' : 'ACTIVE' });
    studentRows.push({
      id: s.id, institutionId: instId, personId: s.personId, userId: s.userId, studentNumber: s.studentNumber, firstName: s.first, lastName: s.last,
      preferredName: chance(0.1) ? s.first.slice(0, 3) : null, email: s.email,
      personalEmail: `${s.first.toLowerCase()}${Math.floor(rand() * 900 + 100)}@example.com`, phone: `+1 (${pick(['978', '617', '401', '603'])}) 555-${String(Math.floor(rand() * 9000) + 1000)}`,
      dateOfBirth: new Date(Date.UTC(now.getUTCFullYear() - (s.program.level === 'GRADUATE' ? 25 : 19) - Math.floor(-s.admitK / 2) - Math.floor(rand() * 3), Math.floor(rand() * 12), 1 + Math.floor(rand() * 27))),
      addressLine: `${Math.floor(rand() * 900) + 10} ${pick(STREETS)}`, city, region, postalCode: postal, country: 'US',
      emergencyContactName: `${pick(FIRST)} ${s.last}`, emergencyContactPhone: `+1 (978) 555-${String(Math.floor(rand() * 9000) + 1000)}`, emergencyContactRelation: pick(RELATIONS),
      programId: s.program.id, status: s.status, classLevel, academicStanding: standing, admitTermId: termByK[s.admitK].id,
      expectedGraduation: `Spring ${gradYear}`, financialAccountRef: `BUR-${String(500000 + s.i * 37)}`, financialAidStatus: pick(['Awarded', 'Awarded', 'Not applied', 'Pending verification', 'Awarded']),
      createdAt: termByK[s.admitK].registrationOpens,
    });
  }
  await prisma.person.createMany({ data: personRows });
  await prisma.user.createMany({ data: userRows });
  await prisma.student.createMany({ data: studentRows });
  await prisma.registration.createMany({ data: regRows });
  await prisma.registrationEvent.createMany({ data: eventRows });

  // Right-size capacities for past and current terms so fill rates look like a real schedule (≈70–100% full).
  for (const sec of sections.filter((x) => x.termK <= 0)) {
    sec.capacity = Math.max(10, Math.ceil(sec.enrolled / (0.72 + rand() * 0.28)));
  }
  await prisma.$transaction(sections.filter((x) => x.termK <= 0).map((sec) => prisma.section.update({ where: { id: sec.id }, data: { capacity: sec.capacity } })));

  // Grade workflow states for demo: in the most recent completed term, one section awaits approval and one
  // awaits publication (those registrations remain REGISTERED until grades are published).
  const lastPast = termByK[-1];
  const pendingSections = { SUBMITTED: sections.find((x) => x.termK === -1 && x.course.code === 'PSYC 101' && x.number === '01'), APPROVED: sections.find((x) => x.termK === -1 && x.course.code === 'HIST 101' && x.number === '01') };
  const gradeData = gradeRows.map(({ sec, regId, ...g }) => {
    for (const [status, ps] of Object.entries(pendingSections)) {
      if (ps && sec.id === ps.id) return { ...g, status, publishedAt: null, approvedAt: status === 'APPROVED' ? addDays(lastPast.end, 4) : null, _reg: regId };
    }
    return g;
  });
  const pendingRegIds = gradeData.filter((g) => g._reg).map((g) => g._reg);
  await prisma.grade.createMany({ data: gradeData.map(({ _reg, ...g }) => g) });
  await prisma.registration.updateMany({ where: { id: { in: pendingRegIds } }, data: { status: 'REGISTERED' } });
  for (let i = 0; i < gradeData.length; i += 5000) await prisma.gradeHistory.createMany({ data: gradeData.slice(i, i + 5000).map((g) => ({ gradeId: g.id, toLetter: g.letter, toStatus: g.status, actorType: 'SYSTEM', reason: 'Imported from legacy SIS' })) });
  log(`Students: ${students.length}, registrations: ${regRows.length}, grades: ${gradeData.length}`);

  // ── A full current-term section with a waitlist (demo for waitlist promotion) ──
  const fullSec = sections.find((x) => x.termK === 0 && x.course.code === 'CS 301' && x.number === '01');
  const currentRegs = await prisma.registration.count({ where: { sectionId: fullSec.id, status: 'REGISTERED' } });
  await prisma.section.update({ where: { id: fullSec.id }, data: { capacity: Math.max(currentRegs, 1) } });
  const waitlisters = students.filter((s) => s.status === 'ACTIVE' && s.program.code === 'BS-CS' && s.i > 1).slice(0, 12);
  let pos = 1;
  for (const w of waitlisters) {
    const has = await prisma.registration.findFirst({ where: { studentId: w.id, sectionId: fullSec.id } });
    if (has || pos > 3) continue;
    const regId = uid();
    await prisma.registration.create({ data: { id: regId, institutionId: instId, studentId: w.id, sectionId: fullSec.id, status: 'WAITLISTED', waitlistPosition: pos, source: 'STUDENT_PORTAL', creditsAttempted: 3, registeredAt: addDays(current.registrationOpens, 30 + pos) } });
    await prisma.registrationEvent.create({ data: { registrationId: regId, action: 'WAITLIST', toStatus: 'WAITLISTED', actorType: 'USER' } });
    pos += 1;
  }

  // ── Attendance for the current term (class meetings from term start up to yesterday) ──
  const curSections = sections.filter((x) => x.termK === 0);
  const curRegs = await prisma.registration.findMany({ where: { sectionId: { in: curSections.map((x) => x.id) }, status: 'REGISTERED' } });
  const regsBySection = {};
  for (const r of curRegs) (regsBySection[r.sectionId] ??= []).push(r);
  const attendance = [];
  const yesterday = addDays(dateOnly(now), -1);
  for (const sec of curSections) {
    const regs = regsBySection[sec.id] ?? [];
    for (let d = new Date(current.start); d <= yesterday; d = addDays(d, 1)) {
      const dow = ((d.getUTCDay() + 6) % 7) + 1;
      if (!sec.slot[0].includes(dow)) continue;
      // Leave the most recent class of the demo instructor unrecorded so the workflow can be tried.
      if (sec.facultyId === faculty[0].id && d >= addDays(yesterday, -6)) continue;
      for (const r of regs) {
        const roll = rand();
        attendance.push({ id: uid(), sectionId: sec.id, studentId: r.studentId, registrationId: r.id, date: dateOnly(d), status: roll < 0.86 ? 'PRESENT' : roll < 0.92 ? 'LATE' : roll < 0.98 ? 'ABSENT' : 'EXCUSED', recordedByType: 'USER', recordedById: sec.facultyId });
      }
    }
  }
  for (let i = 0; i < attendance.length; i += 5000) await prisma.attendanceRecord.createMany({ data: attendance.slice(i, i + 5000) });
  log(`Attendance records: ${attendance.length}`);

  // ── Pre-registrations for the upcoming term ──
  const nextSections = sections.filter((x) => x.termK === 1);
  const preRegs = [];
  for (const s of students.filter((x) => x.status === 'ACTIVE' && x.i > 0).slice(0, 70)) {
    const choices = nextSections.filter((x) => s.program.req.includes(x.course.code) && x.course.prereqs.length === 0 && !s.completed[x.course.code] && !(s.currentCourses ?? []).includes(x.course.code));
    const picked = [];
    for (const c of choices) {
      if (picked.length >= 2 || picked.some((p) => p.course.code === c.course.code || overlaps(p, c))) continue;
      picked.push(c);
      if (preRegs.some((p) => p.studentId === s.id && p._course === c.course.code)) continue;
      preRegs.push({ id: uid(), institutionId: instId, studentId: s.id, sectionId: c.id, status: 'REGISTERED', source: 'STUDENT_PORTAL', creditsAttempted: c.course.credits, registeredAt: addDays(next.registrationOpens, Math.floor(rand() * 9)), _course: c.course.code });
    }
  }
  const seenPair = new Set();
  await prisma.registration.createMany({ data: preRegs.filter((p) => { const k = `${p.studentId}|${p.sectionId}`; if (seenPair.has(k)) return false; seenPair.add(k); return true; }).map(({ _course, ...p }) => p) });

  // ── Holds ──
  const holdTargets = [[1, 'FINANCIAL', 'Outstanding tuition balance of $1,240 — contact the Bursar', true], [5, 'ADVISING', 'Meet with your academic advisor before registering for next term', true], [19, 'IMMUNIZATION', 'Missing MMR immunization record', true], [33, 'FINANCIAL', 'Library fines over $50', false], [58, 'ACADEMIC', 'Academic probation — complete success plan', true], [77, 'ADMINISTRATIVE', 'Academic suspension in effect', true], [104, 'FINANCIAL', 'Returned payment — contact the Bursar', true]];
  for (const [idx, type, reason, blocks] of holdTargets) await prisma.hold.create({ data: { studentId: students[idx].id, type, reason, blocksRegistration: blocks, placedById: adminUserId, placedAt: addDays(now, -Math.floor(rand() * 40) - 3) } });
  await prisma.hold.create({ data: { studentId: students[0].id, type: 'ADVISING', reason: 'Pre-registration advising (cleared)', blocksRegistration: true, placedById: adminUserId, placedAt: addDays(now, -60), releasedAt: addDays(now, -45), releasedById: adminUserId } });

  // ── Applications for the upcoming term ──
  const appStatuses = ['SUBMITTED', 'SUBMITTED', 'SUBMITTED', 'UNDER_REVIEW', 'UNDER_REVIEW', 'UNDER_REVIEW', 'ADMITTED', 'ADMITTED', 'WAITLISTED', 'REJECTED'];
  for (let i = 0; i < 28; i++) {
    const first = pick(FIRST), last = pick(LAST), status = appStatuses[i % appStatuses.length];
    const program = programs[pick(programPool)];
    await prisma.application.create({ data: { institutionId: instId, applicationNumber: `APP-${now.getUTCFullYear()}-${String(i + 1).padStart(5, '0')}`, firstName: first, lastName: last, email: `${first}.${last}${i}@example.com`.toLowerCase(), phone: `+1 (617) 555-${String(3000 + i)}`, programId: program.id, termId: next.id, status, priorGpa: (2.4 + rand() * 1.6).toFixed(2), submittedAt: addDays(now, -Math.floor(rand() * 60) - 1), ...(['ADMITTED', 'REJECTED', 'WAITLISTED'].includes(status) ? { decisionAt: addDays(now, -Math.floor(rand() * 10)), decisionById: adminUserId } : {}) } });
  }

  // ── Calendar ──
  const cal = [];
  for (const t of termDefs.filter((x) => x.k >= -1)) {
    cal.push(
      { title: `${t.name} registration opens`, category: 'DEADLINE', startDate: dateOnly(t.registrationOpens), termId: t.id },
      { title: `${t.name} classes begin`, category: 'ACADEMIC', startDate: t.start, termId: t.id },
      { title: 'Last day to add/drop without a W', category: 'DEADLINE', startDate: dateOnly(t.addDropDeadline), termId: t.id },
      { title: 'Last day to withdraw with a W', category: 'DEADLINE', startDate: dateOnly(t.withdrawDeadline), termId: t.id },
      { title: 'Reading days', category: 'HOLIDAY', startDate: addDays(t.start, 52), endDate: addDays(t.start, 53), termId: t.id },
      { title: 'Final examinations', category: 'EXAM', startDate: addDays(t.end, -4), endDate: t.end, termId: t.id },
      { title: 'Final grades due from faculty', category: 'DEADLINE', startDate: dateOnly(t.gradesDueDate), termId: t.id },
    );
  }
  cal.push({ title: 'Research & Creativity Showcase', category: 'EVENT', startDate: addDays(dateOnly(now), 9), description: 'Undergraduate research posters in the Franklin Science Center atrium.', termId: current.id });
  cal.push({ title: 'Career Fair', category: 'EVENT', startDate: addDays(dateOnly(now), 16), description: 'Over 80 employers in the Hollis Hall Commons.', termId: current.id });
  await prisma.calendarEvent.createMany({ data: cal.map((e) => ({ ...e, institutionId: instId })) });

  // ── Announcements ──
  await prisma.announcement.createMany({ data: [
    { institutionId: instId, title: `${next.name} registration is open`, body: `Registration for ${next.name} opened on ${next.registrationOpens.toDateString()}. Review your degree progress, clear any holds, and use Class Search to plan your schedule. Seats are limited in upper-level courses.`, audience: 'STUDENTS', pinned: true, authorName: 'Office of the Registrar', authorUserId: adminUserId, publishedAt: next.registrationOpens },
    { institutionId: instId, title: 'Withdrawal deadline approaching', body: `The last day to withdraw from a ${current.name} course with a W is ${current.withdrawDeadline.toDateString()}. After this date, withdrawals require a petition to the Dean.`, audience: 'STUDENTS', authorName: 'Office of the Registrar', authorUserId: adminUserId, publishedAt: addDays(now, -2) },
    { institutionId: instId, title: 'Midterm attendance reporting', body: 'Please make sure attendance is up to date for all sections by Friday. Students with three or more absences will be contacted by Academic Success.', audience: 'FACULTY', authorName: 'Office of the Provost', authorUserId: adminUserId, publishedAt: addDays(now, -4) },
    { institutionId: instId, title: `Final grades for ${current.name}`, body: `Final grades are due ${current.gradesDueDate.toDateString()}. Submitted grades are reviewed by the Registrar before publication to students.`, audience: 'FACULTY', authorName: 'Office of the Registrar', authorUserId: adminUserId, publishedAt: addDays(now, -9) },
    { institutionId: instId, title: 'Library extended hours', body: 'Morrison Library will be open until 2 am Sunday through Thursday for the rest of the term.', audience: 'ALL', authorName: 'University Libraries', authorUserId: adminUserId, publishedAt: addDays(now, -6) },
    { institutionId: instId, title: 'Scheduled maintenance', body: 'CampusCore will be briefly unavailable on Sunday between 1:00 and 2:00 am for scheduled maintenance.', audience: 'ALL', authorName: 'IT Services', authorUserId: adminUserId, publishedAt: addDays(now, -1), expiresAt: addDays(now, 6) },
  ] });
  const vasquezCs301 = fullSec;
  await prisma.announcement.create({ data: { institutionId: instId, sectionId: vasquezCs301.id, title: 'Problem Set 4 posted', body: 'Problem Set 4 (dynamic programming) is due next Thursday. Office hours are extended this week.', audience: 'STUDENTS', authorName: 'Elena Vasquez', authorUserId: faculty[0].userId, publishedAt: addDays(now, -3) } });

  // ── Document requests, grade change request, notifications ──
  await prisma.documentRequest.createMany({ data: [
    { institutionId: instId, studentId: students[0].id, type: 'ENROLLMENT_VERIFICATION', status: 'COMPLETED', recipient: 'Commonwealth Health Insurance', processedAt: addDays(now, -20), processedById: adminUserId, createdAt: addDays(now, -22) },
    { institutionId: instId, studentId: students[3].id, type: 'OFFICIAL_TRANSCRIPT', status: 'PENDING', recipient: 'Graduate Admissions, Eastfield University', createdAt: addDays(now, -2) },
    { institutionId: instId, studentId: students[8].id, type: 'OFFICIAL_TRANSCRIPT', status: 'PROCESSING', recipient: 'Self (mailed)', deliveryMethod: 'MAIL', createdAt: addDays(now, -4) },
    { institutionId: instId, studentId: students[15].id, type: 'DEGREE_VERIFICATION', status: 'PENDING', recipient: 'Brightline Consulting HR', createdAt: addDays(now, -1) },
  ] });

  const cs201Past = sections.find((x) => x.termK === -2 && x.course.code === 'CS 201');
  const gradeForChange = cs201Past && await prisma.grade.findFirst({ where: { registration: { sectionId: cs201Past.id, studentId: { not: students[0].id } }, status: 'PUBLISHED', letter: { in: ['B', 'B-', 'C+'] } } });
  if (gradeForChange) await prisma.gradeChangeRequest.create({ data: { gradeId: gradeForChange.id, fromLetter: gradeForChange.letter, toLetter: 'B+', reason: 'Final project regrade: rubric item 3 was mis-scored; corrected total moves the course grade from ' + gradeForChange.letter + ' to B+.', requestedByType: 'USER', requestedById: faculty[0].userId, createdAt: addDays(now, -2) } });

  await prisma.notification.createMany({ data: [
    { userId: students[0].userId, title: `${next.name} registration is open`, body: 'Plan your schedule in Class Search.', link: '/student/registration', createdAt: next.registrationOpens },
    { userId: students[0].userId, title: 'Final grades posted', body: `All final grades for ${lastPast.name} are available.`, link: '/student/grades', readAt: addDays(lastPast.end, 8), createdAt: addDays(lastPast.end, 6) },
    { userId: students[1].userId, title: 'A hold was placed on your account', body: 'Financial hold: Outstanding tuition balance.', link: '/student/profile', createdAt: addDays(now, -5) },
    { userId: faculty[0].userId, title: 'Attendance reminder', body: 'Attendance has not been recorded for your most recent classes.', link: '/faculty', createdAt: addDays(now, -1) },
  ] });

  // ── Integration clients (secrets printed once and returned to the caller) ──
  const makeClient = async (name, description, scopes, institutionId = instId, createdById = adminUserId) => {
    const secret = `ccs_${randomToken(32)}`;
    const clientId = `cc_${crypto.randomBytes(12).toString('hex')}`;
    await prisma.integrationClient.create({ data: { institutionId, name, description, clientId, secretHash: hashClientSecret(secret), secretHint: secret.slice(-4), scopes, createdById } });
    return { name, clientId, clientSecret: secret, scopes };
  };
  const edunexus = await makeClient('EdunexusAI Campus Portal', 'Campus digital experience platform. Reads academic records for the unified student/faculty portal and records attendance on behalf of instructors.', ['institution:read', 'terms:read', 'calendar:read', 'programs:read', 'courses:read', 'sections:read', 'students:read', 'faculty:read', 'registrations:read', 'registrations:write', 'schedules:read', 'grades:read', 'attendance:read', 'attendance:write', 'announcements:read']);
  const analytics = await makeClient('Institutional Research (read-only)', 'Read-only reporting extract for the Office of Institutional Research.', ['terms:read', 'courses:read', 'sections:read', 'registrations:read']);

  await prisma.auditEvent.create({ data: { institutionId: instId, actorType: 'SYSTEM', actorLabel: 'System (seed)', action: 'system.seeded', entityType: 'System', summary: `Loaded fictional demo data: ${students.length} students, ${faculty.length} faculty, ${sections.length} sections across ${termDefs.length} terms` } });

  // ── Second, independent institution (tenant isolation) ──
  const lakeId = uid();
  await prisma.institution.create({ data: { id: lakeId, slug: 'lakeshore', name: 'Lakeshore Community College', shortName: 'LCC', emailDomain: 'lakeshore.edu', studentEmailDomain: 'students.lakeshore.edu', city: 'Erie', region: 'PA', country: 'US' } });
  await prisma.gradeScale.create({ data: { institutionId: lakeId, name: 'Standard 4.0', isDefault: true, entries: { create: GRADE_SCALE.map(([letter, points, minPercent, countsInGpa, earnsCredit, description], i) => ({ letter, points, minPercent, countsInGpa, earnsCredit, description, sortOrder: i })) } } });
  const lakeYear = await prisma.academicYear.create({ data: { institutionId: lakeId, name: academicYearFor(current.start), startDate: current.start, endDate: addDays(current.start, 300) } });
  const lakeTerm = await prisma.term.create({ data: { institutionId: lakeId, academicYearId: lakeYear.id, code: current.code, name: current.name, startDate: current.start, endDate: current.end, registrationOpens: current.registrationOpens, registrationCloses: current.registrationCloses, addDropDeadline: current.addDropDeadline, withdrawDeadline: current.withdrawDeadline, gradesDueDate: current.gradesDueDate, status: 'IN_PROGRESS', isCurrent: true } });
  const lakeCollege = await prisma.college.create({ data: { institutionId: lakeId, code: 'GEN', name: 'General Studies' } });
  const lakeDept = await prisma.department.create({ data: { institutionId: lakeId, collegeId: lakeCollege.id, code: 'GEN', name: 'General Studies' } });
  const lakeCourse = await prisma.course.create({ data: { institutionId: lakeId, departmentId: lakeDept.id, code: 'GEN 100', title: 'College Success Seminar', credits: 1 } });
  await prisma.section.create({ data: { institutionId: lakeId, termId: lakeTerm.id, courseId: lakeCourse.id, sectionNumber: '01', capacity: 25 } });
  await prisma.user.create({ data: { institutionId: lakeId, email: 'admin@lakeshore.edu', passwordHash, firstName: 'Morgan', lastName: 'Ellis', role: 'ADMIN' } });
  for (const [i, [first, last]] of [['Riley', 'Shaw'], ['Casey', 'Moreno']].entries()) {
    const person = await prisma.person.create({ data: { institutionId: lakeId, personNumber: `P${String(i + 1).padStart(7, '0')}` } });
    await prisma.student.create({ data: { institutionId: lakeId, personId: person.id, studentNumber: `L${Math.floor(rand() * 90000 + 10000)}`, firstName: first, lastName: last, email: `${first}.${last}@students.lakeshore.edu`.toLowerCase() } });
  }
  const lakeshoreClient = await makeClient('Lakeshore Portal', 'Lakeshore integration (tenant isolation test)', ['students:read', 'courses:read', 'sections:read'], lakeId, null);

  return {
    institutionId: instId,
    lakeshoreId: lakeId,
    terms: { current: { id: current.id, code: current.code }, next: { id: next.id, code: next.code } },
    clients: { edunexus, analytics, lakeshore: lakeshoreClient },
    demo: { mayaId: students[0].id, jordanId: students[1].id, vasquezFacultyId: faculty[0].id, fullSectionId: fullSec.id },
  };
}
