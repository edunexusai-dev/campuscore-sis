// Portal API (/api/app) — used by the CampusCore web frontend. Session-cookie auth + CSRF protection.
import { Router } from 'express';
import { loadSession, requireAuth, csrfProtection, requireRole } from '../../middleware/session.js';
import auth from './auth.js';
import shared from './shared.js';
import student from './student.js';
import faculty from './faculty.js';
import people from './admin/people.js';
import academics from './admin/academics.js';
import records from './admin/records.js';
import system from './admin/system.js';
import finance from './admin/finance.js';

const router = Router();
router.use(loadSession);
router.use('/auth', auth);
router.use(requireAuth, csrfProtection);
router.use('/', shared);
router.use('/student', student);
router.use('/faculty', faculty);
router.use('/admin', requireRole('ADMIN', 'REGISTRAR'), people, academics, records, system, finance);

export default router;
