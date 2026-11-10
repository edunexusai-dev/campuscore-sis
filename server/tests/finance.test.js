import { describe, it, expect, beforeAll } from 'vitest';
import { login, getToken, api, prisma } from './helpers.js';
import { summarize, toCents } from '../src/services/financeService.js';

// Student accounts: fee catalogue → assessed charges → append-only ledger → totals, invoices and statements, with
// finance.manage for administrators, the student's own read, and the finance:read integration scope.

let admin, student, me, term, account;

beforeAll(async () => {
  admin = await login('admin');
  student = await login('student');
  me = await prisma.student.findFirst({ where: { email: 'maya.chen@students.feddrick.edu' } });
  term = await prisma.term.findFirst({ where: { institutionId: me.institutionId, isCurrent: true } });
});

describe('money', () => {
  it('converts decimal strings exactly and nets reversals against what they reverse', () => {
    expect(toCents('1234.5')).toBe(123450);
    expect(toCents('0.07')).toBe(7);
    const e = (id, type, direction, amount, reversesId) => ({ id, type, direction, amount, reversesId });
    const t = summarize([e('a', 'CHARGE', 'DEBIT', '1000.00'), e('b', 'PAYMENT', 'CREDIT', '400.00'), e('c', 'REVERSAL', 'DEBIT', '400.00', 'b'), e('d', 'CREDIT', 'CREDIT', '100.00')]);
    expect(t).toMatchObject({ charges: 100000, payments: 0, credits: 10000, balance: 90000 });
  });
});

describe('fee catalogue', () => {
  it('administrators configure fees; the registrar and faculty cannot', async () => {
    const tuition = await admin.post('/api/app/admin/finance/fees', { code: 'T-TUITION', name: 'Tuition', category: 'TUITION', basis: 'PER_CREDIT', amount: '350.00' });
    expect(tuition.status).toBe(201);
    expect((await admin.post('/api/app/admin/finance/fees', { code: 'T-TECH', name: 'Technology fee', category: 'TECHNOLOGY', amount: 150 })).status).toBe(201);
    expect((await admin.post('/api/app/admin/finance/fees', { code: 'T-TECH', name: 'Duplicate', category: 'TECHNOLOGY', amount: 1 })).status).toBe(409);
    expect((await admin.post('/api/app/admin/finance/fees', { code: 'T-BAD', name: 'Bad', category: 'OTHER', amount: '12.345' })).status).toBe(400);
    expect((await (await login('registrar')).get('/api/app/admin/finance/fees')).status).toBe(403);
    expect((await (await login('faculty')).get('/api/app/admin/finance/fees')).status).toBe(403);
    expect(await prisma.auditEvent.findFirst({ where: { action: 'finance.fee.create', entityId: tuition.body.data.id } })).toBeTruthy();
  });
});

describe('student account and ledger', () => {
  it('opens one account per student and term', async () => {
    const res = await admin.post(`/api/app/admin/finance/students/${me.id}/accounts`, { termId: term.id, dueDate: '2099-01-15' });
    expect(res.status).toBe(201);
    account = res.body.data;
    expect(account.totals.balance).toBe('0.00');
    const again = await admin.post(`/api/app/admin/finance/students/${me.id}/accounts`, { termId: term.id });
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(account.id);
  });

  it('assesses fees from the catalogue once, per credit and flat', async () => {
    const credits = (await prisma.registration.findMany({ where: { studentId: me.id, status: { in: ['REGISTERED', 'COMPLETED'] }, section: { termId: term.id } }, include: { section: { include: { course: true } } } }))
      .reduce((n, r) => n + Number(r.creditsAttempted ?? r.section.course.credits), 0);
    const res = await admin.post(`/api/app/admin/finance/accounts/${account.id}/assess`, {});
    expect(res.status).toBe(200);
    const charges = (35000 * credits + 15000) / 100;
    expect(res.body.data.account.totals.charges).toBe(charges.toFixed(2));
    const again = await admin.post(`/api/app/admin/finance/accounts/${account.id}/assess`, {});
    expect(again.body.data.posted).toEqual([]);
    expect(again.body.data.account.totals.charges).toBe(charges.toFixed(2));
  });

  it('records payments and credits, idempotently, and computes the balance from the ledger', async () => {
    const pay = { type: 'PAYMENT', amount: '500.00', description: 'Payment received', method: 'Bank transfer', idempotencyKey: 'test-payment-0001' };
    const first = await admin.post(`/api/app/admin/finance/accounts/${account.id}/entries`, pay);
    expect(first.status).toBe(201);
    const replay = await admin.post(`/api/app/admin/finance/accounts/${account.id}/entries`, pay);
    expect(replay.status).toBe(200);
    expect(replay.body.data.entry.reference).toBe(first.body.data.entry.reference);
    await admin.post(`/api/app/admin/finance/accounts/${account.id}/entries`, { type: 'CREDIT', amount: '250', description: 'Merit scholarship' });
    const a = (await admin.get(`/api/app/admin/finance/accounts/${account.id}`)).body.data;
    expect(a.totals.payments).toBe('500.00');
    expect(a.totals.credits).toBe('250.00');
    expect(toCents(a.totals.balance)).toBe(toCents(a.totals.charges) - 50000 - 25000);
    expect(a.standing).toBe('BALANCE_DUE');
    expect(a.deadlines.next.dueDate).toBe('2099-01-15');
  });

  it('corrects by reversal: the original entry is kept and never edited', async () => {
    const a = (await admin.get(`/api/app/admin/finance/accounts/${account.id}`)).body.data;
    const payment = a.entries.find((e) => e.type === 'PAYMENT');
    const res = await admin.post(`/api/app/admin/finance/entries/${payment.id}/reverse`, { reason: 'Returned by the bank' });
    expect(res.status).toBe(200);
    expect(res.body.data.totals.payments).toBe('0.00');
    expect(res.body.data.entries.find((e) => e.id === payment.id).status).toBe('REVERSED');
    expect((await admin.post(`/api/app/admin/finance/entries/${payment.id}/reverse`, { reason: 'Again please' })).status).toBe(409);
    // The database itself refuses to change or delete a posted entry.
    await expect(prisma.ledgerEntry.update({ where: { id: payment.id }, data: { amount: '1.00' } })).rejects.toThrow(/cannot be changed/);
    await expect(prisma.ledgerEntry.delete({ where: { id: payment.id } })).rejects.toThrow(/cannot be deleted/);
  });

  it('issues an invoice for uninvoiced charges and produces a statement with running balances', async () => {
    const inv = await admin.post(`/api/app/admin/finance/accounts/${account.id}/invoices`, {});
    expect(inv.status).toBe(201);
    expect(inv.body.data.invoice.total).toBe(inv.body.data.account.totals.charges);
    expect((await admin.post(`/api/app/admin/finance/accounts/${account.id}/invoices`, {})).status).toBe(422);
    const st = (await admin.get(`/api/app/admin/finance/accounts/${account.id}/statement`)).body.data;
    expect(st.lines.at(-1).runningBalance).toBe(st.account.totals.balance);
  });
});

describe('who can read an account', () => {
  it('the student reads only their own accounts', async () => {
    const res = await student.get('/api/app/student/accounts');
    expect(res.status).toBe(200);
    expect(res.body.data.map((a) => a.id)).toEqual([account.id]);
    expect((await student.get(`/api/app/admin/finance/accounts/${account.id}`)).status).toBe(403);
  });

  it('integrations need finance:read; the account is null for a student without one', async () => {
    const make = async (scopes) => {
      const c = await admin.post('/api/app/admin/integrations', { name: `Finance ${scopes.join(' ')}`, scopes });
      return api((await getToken(c.body.client.clientId, c.body.clientSecret)).body.access_token);
    };
    const reader = await make(['finance:read']);
    const res = await reader.get(`/api/v1/students/${me.id}/account`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(account.id);
    expect(res.body.data.totals.balance).toMatch(/^\d+\.\d{2}$/);
    const other = await prisma.student.findFirst({ where: { institutionId: me.institutionId, id: { not: me.id }, accounts: { none: {} } } });
    expect((await reader.get(`/api/v1/students/${other.id}/account`)).body).toEqual({ data: null });
    expect((await (await make(['students:read'])).get(`/api/v1/students/${me.id}/account`)).status).toBe(403);
    const lake = await prisma.student.findFirst({ where: { institutionId: { not: me.institutionId } } });
    if (lake) expect((await reader.get(`/api/v1/students/${lake.id}/account`)).status).toBe(404);
  });
});
