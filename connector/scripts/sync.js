// Pulls a few real records from a running CampusCore SIS and prints them in the EdunexusAI canonical model.
import { createSisAdapter } from '../src/index.js';

const sis = createSisAdapter();
const term = await sis.getCurrentTerm();
console.log('Current term:', term);
console.log('Capabilities:', sis.capabilities());
const { items, total } = await sis.searchStudents({ search: 'Maya Chen'.split(' ')[1], pageSize: 3 });
console.log(`Students matching "Chen": ${total}`);
const maya = items.find((s) => s.givenName === 'Maya') ?? items[0];
console.log('Student:', maya);
console.log('Academic summary:', await sis.getAcademicSummary(maya.source.id));
const schedule = await sis.getStudentSchedule(maya.source.id);
console.log(`Schedule for ${schedule.term.name}:`);
for (const c of schedule.items) console.log(`  ${c.courseCode}-${c.sectionCode} ${c.courseTitle} · ${c.meetings.map((m) => `${m.day} ${m.start}-${m.end}`).join(', ')} · ${c.enrollment.status}`);
console.log('Announcements:', (await sis.listAnnouncements()).slice(0, 3).map((a) => a.title));
