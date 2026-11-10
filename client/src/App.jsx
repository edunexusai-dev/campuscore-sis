import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth, homeFor, hasRole } from './lib/auth.jsx';
import Layout from './components/Layout.jsx';
import { Spinner, Empty } from './components/ui.jsx';
import Login from './pages/shared/Login.jsx';
import ChoosePersona from './pages/shared/ChoosePersona.jsx';

const p = (loader) => lazy(loader);
const pages = {
  AdminDashboard: p(() => import('./pages/admin/Dashboard.jsx')),
  Reports: p(() => import('./pages/admin/Reports.jsx')),
  Students: p(() => import('./pages/admin/Students.jsx')),
  StudentDetail: p(() => import('./pages/admin/StudentDetail.jsx')),
  Admissions: p(() => import('./pages/admin/Admissions.jsx')),
  Registrations: p(() => import('./pages/admin/Registrations.jsx')),
  AdminGrades: p(() => import('./pages/admin/Grades.jsx')),
  AdminDocuments: p(() => import('./pages/admin/Documents.jsx')),
  AdminFinance: p(() => import('./pages/admin/Finance.jsx')),
  Sections: p(() => import('./pages/admin/Sections.jsx')),
  SectionDetail: p(() => import('./pages/admin/SectionDetail.jsx')),
  Courses: p(() => import('./pages/admin/Courses.jsx')),
  CourseDetail: p(() => import('./pages/admin/CourseDetail.jsx')),
  Structure: p(() => import('./pages/admin/Structure.jsx')),
  Terms: p(() => import('./pages/admin/Terms.jsx')),
  Faculty: p(() => import('./pages/admin/Faculty.jsx')),
  FacultyDetail: p(() => import('./pages/admin/FacultyDetail.jsx')),
  Communications: p(() => import('./pages/admin/Communications.jsx')),
  Policies: p(() => import('./pages/admin/Policies.jsx')),
  Users: p(() => import('./pages/admin/Users.jsx')),
  Institution: p(() => import('./pages/admin/Institution.jsx')),
  Integrations: p(() => import('./pages/admin/Integrations.jsx')),
  IdentityLinks: p(() => import('./pages/admin/IdentityLinks.jsx')),
  IntegrationDetail: p(() => import('./pages/admin/IntegrationDetail.jsx')),
  Playground: p(() => import('./pages/admin/Playground.jsx')),
  Audit: p(() => import('./pages/admin/Audit.jsx')),
  System: p(() => import('./pages/admin/System.jsx')),
  FacultyDashboard: p(() => import('./pages/faculty/Dashboard.jsx')),
  FacultySection: p(() => import('./pages/faculty/Section.jsx')),
  FacultySchedule: p(() => import('./pages/faculty/Schedule.jsx')),
  FacultyGradeChanges: p(() => import('./pages/faculty/GradeChanges.jsx')),
  StudentDashboard: p(() => import('./pages/student/Dashboard.jsx')),
  StudentSchedule: p(() => import('./pages/student/Schedule.jsx')),
  StudentRegistration: p(() => import('./pages/student/Registration.jsx')),
  StudentGrades: p(() => import('./pages/student/Grades.jsx')),
  StudentProgress: p(() => import('./pages/student/Progress.jsx')),
  StudentAttendance: p(() => import('./pages/student/Attendance.jsx')),
  StudentTranscript: p(() => import('./pages/student/Transcript.jsx')),
  StudentDocuments: p(() => import('./pages/student/Documents.jsx')),
  StudentProfile: p(() => import('./pages/student/Profile.jsx')),
  Announcements: p(() => import('./pages/shared/Announcements.jsx')),
  Calendar: p(() => import('./pages/shared/Calendar.jsx')),
  Directory: p(() => import('./pages/shared/Directory.jsx')),
  Notifications: p(() => import('./pages/shared/Notifications.jsx')),
};

// Route guards are purely for navigation. The server enforces every permission independently.
const NotAvailable = () => <Empty title="Not available" description="Your account does not have access to this area." />;
function RoleRoute({ roles, children }) {
  const { user } = useAuth();
  return hasRole(user, ...roles) ? children : <NotAvailable />;
}
function Perm({ perm, children }) {
  const { can } = useAuth();
  return can(perm) ? children : <NotAvailable />;
}

export default function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-screen grid place-items-center"><Spinner label="Loading CampusCore…" /></div>;
  if (!user) return <Routes><Route path="*" element={<Login />} /></Routes>;
  const P = pages;
  const staff = ['ADMIN', 'REGISTRAR'];
  const S = (C) => <Suspense fallback={<Spinner />}><C /></Suspense>;
  return (
    <Routes>
      <Route path="/login" element={<Navigate to={homeFor(user)} replace />} />
      <Route path="/choose" element={<ChoosePersona />} />
      <Route element={<Layout />}>
        <Route index element={<Navigate to={homeFor(user)} replace />} />
        <Route path="admin/*" element={<RoleRoute roles={staff}><Routes>
          <Route index element={<Perm perm="reports.view">{S(P.AdminDashboard)}</Perm>} />
          <Route path="reports" element={<Perm perm="reports.view">{S(P.Reports)}</Perm>} />
          <Route path="students" element={<Perm perm="students.manage">{S(P.Students)}</Perm>} />
          <Route path="students/:id" element={<Perm perm="students.manage">{S(P.StudentDetail)}</Perm>} />
          <Route path="admissions" element={<Perm perm="admissions.manage">{S(P.Admissions)}</Perm>} />
          <Route path="registrations" element={<Perm perm="registrations.manage">{S(P.Registrations)}</Perm>} />
          <Route path="grades" element={<Perm perm="grades.approve">{S(P.AdminGrades)}</Perm>} />
          <Route path="documents" element={<Perm perm="documents.manage">{S(P.AdminDocuments)}</Perm>} />
          <Route path="finance" element={<Perm perm="finance.manage">{S(P.AdminFinance)}</Perm>} />
          <Route path="sections" element={<Perm perm="academics.manage">{S(P.Sections)}</Perm>} />
          <Route path="sections/:id" element={<Perm perm="academics.manage">{S(P.SectionDetail)}</Perm>} />
          <Route path="courses" element={<Perm perm="academics.manage">{S(P.Courses)}</Perm>} />
          <Route path="courses/:id" element={<Perm perm="academics.manage">{S(P.CourseDetail)}</Perm>} />
          <Route path="structure" element={<Perm perm="academics.manage">{S(P.Structure)}</Perm>} />
          <Route path="terms" element={<Perm perm="academics.manage">{S(P.Terms)}</Perm>} />
          <Route path="faculty" element={<Perm perm="academics.manage">{S(P.Faculty)}</Perm>} />
          <Route path="faculty/:id" element={<Perm perm="academics.manage">{S(P.FacultyDetail)}</Perm>} />
          <Route path="communications" element={<Perm perm="communications.manage">{S(P.Communications)}</Perm>} />
          <Route path="policies" element={<Perm perm="policies.manage">{S(P.Policies)}</Perm>} />
          <Route path="users" element={<Perm perm="users.manage">{S(P.Users)}</Perm>} />
          <Route path="institution" element={<Perm perm="institution.manage">{S(P.Institution)}</Perm>} />
          <Route path="integrations" element={<Perm perm="integrations.manage">{S(P.Integrations)}</Perm>} />
          <Route path="integrations/playground" element={<Perm perm="integrations.manage">{S(P.Playground)}</Perm>} />
          <Route path="integrations/:id" element={<Perm perm="integrations.manage">{S(P.IntegrationDetail)}</Perm>} />
          <Route path="identity" element={<Perm perm="identity.manage">{S(P.IdentityLinks)}</Perm>} />
          <Route path="audit" element={<Perm perm="audit.view">{S(P.Audit)}</Perm>} />
          <Route path="system" element={<Perm perm="audit.view">{S(P.System)}</Perm>} />
          <Route path="*" element={<Empty title="Page not found" />} />
        </Routes></RoleRoute>} />
        <Route path="faculty/*" element={<RoleRoute roles={['FACULTY']}><Routes>
          <Route index element={S(P.FacultyDashboard)} />
          <Route path="sections/:id/*" element={S(P.FacultySection)} />
          <Route path="schedule" element={S(P.FacultySchedule)} />
          <Route path="grade-changes" element={S(P.FacultyGradeChanges)} />
          <Route path="*" element={<Empty title="Page not found" />} />
        </Routes></RoleRoute>} />
        <Route path="student/*" element={<RoleRoute roles={['STUDENT']}><Routes>
          <Route index element={S(P.StudentDashboard)} />
          <Route path="schedule" element={S(P.StudentSchedule)} />
          <Route path="registration" element={S(P.StudentRegistration)} />
          <Route path="grades" element={S(P.StudentGrades)} />
          <Route path="progress" element={S(P.StudentProgress)} />
          <Route path="attendance" element={S(P.StudentAttendance)} />
          <Route path="transcript" element={S(P.StudentTranscript)} />
          <Route path="documents" element={S(P.StudentDocuments)} />
          <Route path="profile" element={S(P.StudentProfile)} />
          <Route path="*" element={<Empty title="Page not found" />} />
        </Routes></RoleRoute>} />
        <Route path="announcements" element={S(P.Announcements)} />
        <Route path="calendar" element={S(P.Calendar)} />
        <Route path="directory" element={S(P.Directory)} />
        <Route path="notifications" element={S(P.Notifications)} />
        <Route path="*" element={<Empty title="Page not found" description="Check the address or use the navigation." />} />
      </Route>
    </Routes>
  );
}
