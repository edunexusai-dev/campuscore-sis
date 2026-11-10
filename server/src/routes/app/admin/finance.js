// Student accounts (bursar) administration. Every route needs finance.manage; faculty and registrar staff without it
// never see a student's finances.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../../lib/prisma.js';
import { parse, id, isoDate } from '../../../lib/validate.js';
import { requirePermission } from '../../../lib/permissions.js';
import { notFound } from '../../../lib/errors.js';
import * as finance from '../../../services/financeService.js';

const router = Router();
const inst = (req) => req.user.institutionId;
const manage = requirePermission('finance.manage');

const amount = z.union([z.string(), z.number()]).transform(String).refine((v) => /^\d{1,10}(\.\d{1,2})?$/.test(v), 'Expected an amount such as 1250 or 1250.50');
const idempotencyKey = z.string().trim().min(8).max(100).optional();

// ── Fee catalogue ──
const feeBody = z.object({
  code: z.string().trim().min(2).max(30).regex(/^[A-Z0-9_-]+$/, 'Use capitals, digits, - or _'),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional(),
  category: z.enum(['TUITION', 'TECHNOLOGY', 'STUDENT_SERVICES', 'REGISTRATION', 'LABORATORY', 'COURSE', 'OTHER']),
  basis: z.enum(['FLAT', 'PER_CREDIT']).default('FLAT'),
  amount,
  termId: id.nullable().optional(),
  active: z.boolean().default(true),
  isDemo: z.boolean().default(false),
});
router.get('/finance/fees', manage, async (req, res) => {
  const q = parse(z.object({ termId: id.optional() }), req.query);
  res.json({ data: await finance.listFees(inst(req), q) });
});
router.post('/finance/fees', manage, async (req, res) => res.status(201).json({ data: await finance.createFee(req.actor, parse(feeBody, req.body)) }));
router.patch('/finance/fees/:id', manage, async (req, res) => {
  const changes = parse(feeBody.omit({ code: true }).partial(), req.body);
  res.json({ data: await finance.updateFee(req.actor, req.params.id, changes) });
});

// ── Students and their accounts ──
router.get('/finance/students', manage, async (req, res) => {
  const q = parse(z.object({ search: z.string().trim().max(100).optional(), termId: id.optional() }), req.query);
  const term = q.termId ? await prisma.term.findFirst({ where: { id: q.termId, institutionId: inst(req) } }) : await prisma.term.findFirst({ where: { institutionId: inst(req), isCurrent: true } });
  const words = (q.search ?? '').split(/\s+/).filter(Boolean);
  const students = await prisma.student.findMany({
    where: { institutionId: inst(req), AND: words.map((w) => ({ OR: [{ firstName: { contains: w, mode: 'insensitive' } }, { lastName: { contains: w, mode: 'insensitive' } }, { studentNumber: { contains: w, mode: 'insensitive' } }, { email: { contains: w, mode: 'insensitive' } }] })) },
    select: { id: true, studentNumber: true, firstName: true, lastName: true, status: true, program: { select: { code: true } } },
    orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
    take: 25,
  });
  const accounts = term ? await prisma.studentAccount.findMany({ where: { termId: term.id, studentId: { in: students.map((s) => s.id) } }, include: { entries: true } }) : [];
  const byStudent = new Map(accounts.map((a) => [a.studentId, a]));
  res.json({
    term: term ? { id: term.id, code: term.code, name: term.name } : null,
    data: students.map((s) => {
      const a = byStudent.get(s.id);
      return { id: s.id, studentNumber: s.studentNumber, name: `${s.firstName} ${s.lastName}`, status: s.status, program: s.program?.code ?? null, account: a ? { id: a.id, accountNumber: a.accountNumber, status: a.status, isDemo: a.isDemo, balance: finance.fromCents(finance.summarize(a.entries).balance) } : null };
    }),
  });
});
router.get('/finance/students/:id/accounts', manage, async (req, res) => {
  const student = await prisma.student.findFirst({ where: { id: req.params.id, institutionId: inst(req) }, select: { id: true, studentNumber: true, firstName: true, lastName: true, personId: true, financialAccountRef: true, status: true } });
  if (!student) throw notFound('Student');
  res.json({ student, data: await finance.listStudentAccounts(inst(req), student.id) });
});
router.post('/finance/students/:id/accounts', manage, async (req, res) => {
  const body = parse(z.object({ termId: id, dueDate: isoDate.optional(), isDemo: z.boolean().default(false) }), req.body);
  const { account, created } = await finance.openAccount(req.actor, { studentId: req.params.id, ...body });
  res.status(created ? 201 : 200).json({ data: account, created });
});

router.get('/finance/accounts/:id', manage, async (req, res) => res.json({ data: await finance.getAccount(inst(req), req.params.id) }));
router.patch('/finance/accounts/:id', manage, async (req, res) => {
  const body = parse(z.object({ status: z.enum(['OPEN', 'ON_HOLD', 'CLOSED']).optional(), dueDate: isoDate.nullable().optional() }), req.body);
  res.json({ data: await finance.updateAccount(req.actor, req.params.id, body) });
});
router.post('/finance/accounts/:id/assess', manage, async (req, res) => {
  const body = parse(z.object({ feeIds: z.array(id).max(50).optional() }), req.body ?? {});
  res.json({ data: await finance.assessFees(req.actor, req.params.id, body) });
});
router.post('/finance/accounts/:id/entries', manage, async (req, res) => {
  const body = parse(z.object({
    type: z.enum(['PAYMENT', 'CREDIT', 'REFUND', 'ADJUSTMENT']),
    direction: z.enum(['DEBIT', 'CREDIT']).optional(),
    amount,
    description: z.string().trim().min(3).max(200),
    method: z.string().trim().max(60).optional(),
    externalRef: z.string().trim().max(100).optional(),
    effectiveDate: isoDate.optional(),
    isDemo: z.boolean().optional(),
    idempotencyKey,
  }), req.body);
  const out = await finance.postEntry(req.actor, req.params.id, body);
  res.status(out.replayed ? 200 : 201).json({ data: out });
});
router.post('/finance/entries/:id/reverse', manage, async (req, res) => {
  const body = parse(z.object({ reason: z.string().trim().min(5).max(200), idempotencyKey }), req.body);
  res.json({ data: await finance.reverseEntry(req.actor, req.params.id, body) });
});
router.post('/finance/accounts/:id/invoices', manage, async (req, res) => {
  const body = parse(z.object({ dueDate: isoDate.optional() }), req.body ?? {});
  res.status(201).json({ data: await finance.issueInvoice(req.actor, req.params.id, body) });
});
router.get('/finance/accounts/:id/statement', manage, async (req, res) => res.json({ data: await finance.statement(inst(req), req.params.id) }));

export default router;
