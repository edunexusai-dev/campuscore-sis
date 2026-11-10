// Student accounts (bursar). CampusCore is the system of record for what a student owes.
//   Fee catalogue (FeeDefinition) → assessing posts CHARGE entries to the student's term account (StudentAccount).
//   The ledger (LedgerEntry) is append-only: DEBIT increases the balance owed, CREDIT decreases it. A posted entry is
//   never edited (a database trigger enforces it); a correction is a REVERSAL of the entry or an ADJUSTMENT.
//   Every total and the balance are computed from the ledger, never stored.
// Money is handled in integer cents; Decimal values are converted exactly from their string form.
import { randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound, ruleViolation } from '../lib/errors.js';

const COUNTED = ['REGISTERED', 'COMPLETED'];

/** "1234.5" / Decimal → 123450 (exact). */
export function toCents(value) {
  const [whole, frac = ''] = String(value).trim().split('.');
  const negative = whole.startsWith('-');
  const cents = Math.abs(Number(whole)) * 100 + Number((frac + '00').slice(0, 2));
  return negative ? -cents : cents;
}
export const fromCents = (cents) => (cents / 100).toFixed(2);
const money = (cents) => fromCents(cents);

const reference = (prefix) => `${prefix}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomBytes(4).toString('hex').toUpperCase().slice(0, 6)}`;
const signed = (e) => (e.direction === 'DEBIT' ? 1 : -1) * toCents(e.amount);

/** Which way each kind of entry moves the balance (ADJUSTMENT chooses; REVERSAL mirrors what it reverses). */
const DIRECTION = { CHARGE: 'DEBIT', PAYMENT: 'CREDIT', CREDIT: 'CREDIT', REFUND: 'DEBIT' };

/* ───────────────────────────── fee catalogue ───────────────────────────── */

export function feeDto(f) {
  return { id: f.id, code: f.code, name: f.name, description: f.description, category: f.category, basis: f.basis, amount: money(toCents(f.amount)), currency: f.currency, termId: f.termId, term: f.term ? { id: f.term.id, code: f.term.code, name: f.term.name } : null, active: f.active, isDemo: f.isDemo, updatedAt: f.updatedAt };
}

export async function listFees(institutionId, { termId, activeOnly = false } = {}) {
  const rows = await prisma.feeDefinition.findMany({
    where: { institutionId, ...(activeOnly ? { active: true } : {}), ...(termId ? { OR: [{ termId: null }, { termId }] } : {}) },
    include: { term: true },
    orderBy: [{ category: 'asc' }, { code: 'asc' }],
  });
  return rows.map(feeDto);
}

export async function createFee(actor, input) {
  if (input.termId && !(await prisma.term.findFirst({ where: { id: input.termId, institutionId: actor.institutionId } }))) throw notFound('Term');
  return prisma.$transaction(async (tx) => {
    if (await tx.feeDefinition.findUnique({ where: { institutionId_code: { institutionId: actor.institutionId, code: input.code } } })) throw conflict(`A fee with code ${input.code} already exists.`, 'fee_code_taken');
    const fee = await tx.feeDefinition.create({ data: { ...input, institutionId: actor.institutionId }, include: { term: true } });
    await audit(actor, { action: 'finance.fee.create', entityType: 'FeeDefinition', entityId: fee.id, summary: `Created fee ${fee.code} (${fee.name}) at ${money(toCents(fee.amount))} ${fee.basis === 'PER_CREDIT' ? 'per credit' : 'flat'}`, after: feeDto(fee) }, tx);
    return feeDto(fee);
  });
}

/** Changing a fee affects future assessments only; charges already posted never change. */
export async function updateFee(actor, id, changes) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.feeDefinition.findFirst({ where: { id, institutionId: actor.institutionId }, include: { term: true } });
    if (!before) throw notFound('Fee');
    const fee = await tx.feeDefinition.update({ where: { id }, data: changes, include: { term: true } });
    await audit(actor, { action: 'finance.fee.update', entityType: 'FeeDefinition', entityId: id, summary: `Updated fee ${fee.code}`, before: feeDto(before), after: feeDto(fee) }, tx);
    return feeDto(fee);
  });
}

/* ───────────────────────────── accounts ───────────────────────────── */

const accountInclude = {
  student: { select: { id: true, personId: true, studentNumber: true, firstName: true, lastName: true, institutionId: true } },
  term: { select: { id: true, code: true, name: true, startDate: true, endDate: true } },
  entries: { orderBy: [{ postedAt: 'asc' }, { id: 'asc' }], include: { feeDefinition: { select: { code: true, category: true } }, reversedBy: { select: { id: true, reference: true } }, invoiceLine: { select: { invoiceId: true } } } },
  invoices: { orderBy: { issuedAt: 'desc' }, include: { lines: { include: { ledgerEntry: { select: { reference: true, type: true } } } } } },
};

/**
 * Totals from the ledger. A reversal counts against the kind of entry it reverses, so a reversed payment lowers
 * "payments" rather than raising "charges".
 */
export function summarize(entries) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const t = { charges: 0, payments: 0, credits: 0, refunds: 0, adjustments: 0 };
  let balance = 0;
  for (const e of entries) {
    const s = signed(e);
    balance += s;
    const kind = e.type === 'REVERSAL' ? byId.get(e.reversesId)?.type ?? 'ADJUSTMENT' : e.type;
    if (kind === 'CHARGE') t.charges += s;
    else if (kind === 'PAYMENT') t.payments -= s;
    else if (kind === 'CREDIT') t.credits -= s;
    else if (kind === 'REFUND') t.refunds += s;
    else t.adjustments += s;
  }
  return { ...t, balance };
}

export function entryDto(e) {
  return {
    id: e.id,
    reference: e.reference,
    type: e.type,
    direction: e.direction,
    amount: money(toCents(e.amount)),
    signedAmount: money(signed(e)),
    description: e.description,
    feeCode: e.feeDefinition?.code ?? null,
    category: e.feeDefinition?.category ?? null,
    quantity: e.quantity != null ? String(e.quantity) : null,
    unitAmount: e.unitAmount != null ? money(toCents(e.unitAmount)) : null,
    method: e.method,
    externalRef: e.externalRef,
    effectiveDate: e.effectiveDate.toISOString().slice(0, 10),
    postedAt: e.postedAt,
    // Derived, never stored on the posted entry: REVERSED once a reversal names it.
    status: e.reversedBy ? 'REVERSED' : 'POSTED',
    reversedBy: e.reversedBy?.reference ?? null,
    reversesId: e.reversesId,
    invoiced: Boolean(e.invoiceLine),
    isDemo: e.isDemo,
    postedBy: e.createdByLabel,
  };
}

function invoiceDto(i) {
  return { id: i.id, number: i.number, status: i.status, issuedAt: i.issuedAt, dueDate: i.dueDate.toISOString().slice(0, 10), total: money(toCents(i.total)), isDemo: i.isDemo, lines: i.lines.map((l) => ({ description: l.description, amount: money(toCents(l.amount)), reference: l.ledgerEntry.reference, type: l.ledgerEntry.type })) };
}

/** Payment deadlines: unpaid issued invoices, then the account due date while a balance remains. */
function deadlines(account, balance, today = new Date().toISOString().slice(0, 10)) {
  const out = account.invoices.filter((i) => i.status === 'ISSUED').map((i) => ({ kind: 'INVOICE', label: `Invoice ${i.number}`, dueDate: i.dueDate.toISOString().slice(0, 10), amount: money(toCents(i.total)) }));
  if (account.dueDate && !out.some((d) => d.dueDate === account.dueDate.toISOString().slice(0, 10))) out.push({ kind: 'ACCOUNT', label: `${account.term.name} balance`, dueDate: account.dueDate.toISOString().slice(0, 10), amount: money(balance) });
  const upcoming = balance > 0 ? out.filter((d) => d.dueDate >= today).sort((a, b) => a.dueDate.localeCompare(b.dueDate)) : [];
  const overdue = balance > 0 ? out.filter((d) => d.dueDate < today) : [];
  return { upcoming, overdue, next: upcoming[0] ?? null };
}

export function accountDto(account) {
  const totals = summarize(account.entries);
  const due = deadlines(account, totals.balance);
  return {
    id: account.id,
    accountNumber: account.accountNumber,
    status: account.status,
    // What the student sees: settled once nothing is owed; past due when a deadline has passed with a balance.
    standing: totals.balance <= 0 ? (totals.balance < 0 ? 'CREDIT_BALANCE' : 'SETTLED') : due.overdue.length ? 'PAST_DUE' : 'BALANCE_DUE',
    currency: account.currency,
    isDemo: account.isDemo,
    student: { id: account.student.id, personId: account.student.personId, studentNumber: account.student.studentNumber, name: `${account.student.firstName} ${account.student.lastName}` },
    term: { id: account.term.id, code: account.term.code, name: account.term.name },
    dueDate: account.dueDate ? account.dueDate.toISOString().slice(0, 10) : null,
    totals: { charges: money(totals.charges), payments: money(totals.payments), credits: money(totals.credits), refunds: money(totals.refunds), adjustments: money(totals.adjustments), balance: money(totals.balance) },
    deadlines: due,
    entries: account.entries.map(entryDto),
    invoices: account.invoices.map(invoiceDto),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

async function loadAccount(institutionId, id, tx = prisma) {
  const account = await tx.studentAccount.findFirst({ where: { id, institutionId }, include: accountInclude });
  if (!account) throw notFound('Student account');
  return account;
}

export const getAccount = async (institutionId, id) => accountDto(await loadAccount(institutionId, id));

/** A student's accounts, newest term first. */
export async function listStudentAccounts(institutionId, studentId) {
  const rows = await prisma.studentAccount.findMany({ where: { institutionId, studentId }, include: accountInclude, orderBy: { term: { startDate: 'desc' } } });
  return rows.map(accountDto);
}

/** The account for `termId`, else the current term's, else the most recent one; null when the student has none. */
export async function currentStudentAccount(institutionId, studentId, termId) {
  const where = { institutionId, studentId };
  if (termId) {
    const row = await prisma.studentAccount.findFirst({ where: { ...where, termId }, include: accountInclude });
    return row ? accountDto(row) : null;
  }
  const row = (await prisma.studentAccount.findFirst({ where: { ...where, term: { isCurrent: true } }, include: accountInclude }))
    ?? (await prisma.studentAccount.findFirst({ where, include: accountInclude, orderBy: { term: { startDate: 'desc' } } }));
  return row ? accountDto(row) : null;
}

/** Open (or return) the student's account for a term. Idempotent: one account per student and term. */
export async function openAccount(actor, { studentId, termId, dueDate, isDemo = false }) {
  const student = await prisma.student.findFirst({ where: { id: studentId, institutionId: actor.institutionId } });
  if (!student) throw notFound('Student');
  const term = await prisma.term.findFirst({ where: { id: termId, institutionId: actor.institutionId } });
  if (!term) throw notFound('Term');
  const existing = await prisma.studentAccount.findUnique({ where: { studentId_termId: { studentId, termId } } });
  if (existing) return { account: await getAccount(actor.institutionId, existing.id), created: false };
  const id = await prisma.$transaction(async (tx) => {
    const account = await tx.studentAccount.create({
      data: { institutionId: actor.institutionId, studentId, termId, accountNumber: `${student.financialAccountRef ?? student.studentNumber}-${term.code}`, dueDate: dueDate ? new Date(`${dueDate}T00:00:00Z`) : null, isDemo },
    });
    await audit(actor, { action: 'finance.account.open', entityType: 'StudentAccount', entityId: account.id, summary: `Opened ${term.code} account ${account.accountNumber} for ${student.studentNumber}${isDemo ? ' (illustrative)' : ''}` }, tx);
    return account.id;
  });
  return { account: await getAccount(actor.institutionId, id), created: true };
}

export async function updateAccount(actor, id, { status, dueDate }) {
  await prisma.$transaction(async (tx) => {
    const before = await loadAccount(actor.institutionId, id, tx);
    await tx.studentAccount.update({ where: { id }, data: { ...(status ? { status } : {}), ...(dueDate !== undefined ? { dueDate: dueDate ? new Date(`${dueDate}T00:00:00Z`) : null } : {}) } });
    await audit(actor, { action: 'finance.account.update', entityType: 'StudentAccount', entityId: id, summary: `Updated account ${before.accountNumber}`, before: { status: before.status, dueDate: before.dueDate }, after: { status, dueDate } }, tx);
  });
  return getAccount(actor.institutionId, id);
}

/* ───────────────────────────── ledger ───────────────────────────── */

async function postEntryTx(tx, actor, account, data) {
  if (account.status === 'CLOSED') throw ruleViolation('account_closed', 'This account is closed; no entries can be posted.');
  if (data.idempotencyKey) {
    const prior = await tx.ledgerEntry.findUnique({ where: { accountId_idempotencyKey: { accountId: account.id, idempotencyKey: data.idempotencyKey } } });
    if (prior) return { entry: prior, replayed: true };
  }
  const entry = await tx.ledgerEntry.create({
    data: { ...data, accountId: account.id, reference: reference(data.type === 'PAYMENT' ? 'PAY' : 'TXN'), isDemo: data.isDemo ?? account.isDemo, createdById: actor.id ?? null, createdByLabel: actor.label },
  });
  await audit(actor, { action: `finance.entry.${data.type.toLowerCase()}`, entityType: 'LedgerEntry', entityId: entry.id, summary: `${data.type} ${data.direction} ${money(toCents(entry.amount))} on ${account.accountNumber}: ${entry.description} (${entry.reference})` }, tx);
  return { entry, replayed: false };
}

/**
 * Assess the applicable active fees for the account's term. FLAT fees post their amount; PER_CREDIT fees post the
 * rate × the credits the student is registered for in that term. Each fee is assessed once per account (re-running
 * posts nothing new); a later change is an ADJUSTMENT.
 */
export async function assessFees(actor, accountId, { feeIds } = {}) {
  const result = await prisma.$transaction(async (tx) => {
    const account = await loadAccount(actor.institutionId, accountId, tx);
    const fees = await tx.feeDefinition.findMany({ where: { institutionId: actor.institutionId, active: true, OR: [{ termId: null }, { termId: account.termId }], ...(feeIds?.length ? { id: { in: feeIds } } : {}) }, orderBy: [{ category: 'asc' }, { code: 'asc' }] });
    if (feeIds?.length && fees.length !== new Set(feeIds).size) throw badRequest('Some fees are inactive, belong to another term or do not exist.');
    const regs = await tx.registration.findMany({ where: { studentId: account.studentId, status: { in: COUNTED }, section: { termId: account.termId } }, select: { creditsAttempted: true, section: { select: { course: { select: { credits: true } } } } } });
    const credits = regs.reduce((n, r) => n + Number(r.creditsAttempted ?? r.section.course.credits ?? 0), 0);
    const posted = [];
    const skipped = [];
    for (const fee of fees) {
      const rate = toCents(fee.amount);
      const quantity = fee.basis === 'PER_CREDIT' ? credits : null;
      const cents = fee.basis === 'PER_CREDIT' ? rate * credits : rate;
      if (cents <= 0) { skipped.push({ code: fee.code, reason: fee.basis === 'PER_CREDIT' ? 'NO_REGISTERED_CREDITS' : 'ZERO_AMOUNT' }); continue; }
      const { entry, replayed } = await postEntryTx(tx, actor, account, {
        type: 'CHARGE', direction: 'DEBIT', amount: money(cents), feeDefinitionId: fee.id,
        description: fee.basis === 'PER_CREDIT' ? `${fee.name} (${credits} credits × ${money(rate)})` : fee.name,
        quantity: quantity != null ? String(quantity) : null, unitAmount: fee.basis === 'PER_CREDIT' ? money(rate) : null,
        effectiveDate: new Date(), idempotencyKey: `assess:${fee.id}`, isDemo: account.isDemo || fee.isDemo,
      });
      (replayed ? skipped : posted).push(replayed ? { code: fee.code, reason: 'ALREADY_ASSESSED', reference: entry.reference } : { code: fee.code, reference: entry.reference, amount: money(cents) });
    }
    return { posted, skipped, credits };
  });
  return { ...result, account: await getAccount(actor.institutionId, accountId) };
}

/** Payments, credits (scholarships, waivers), refunds and adjustments recorded by an authorized administrator. */
export async function postEntry(actor, accountId, { type, direction, amount, description, method, externalRef, effectiveDate, idempotencyKey, isDemo }) {
  if (!['PAYMENT', 'CREDIT', 'REFUND', 'ADJUSTMENT'].includes(type)) throw badRequest('Only payments, credits, refunds and adjustments can be recorded here; charges come from assessing fees.');
  const dir = type === 'ADJUSTMENT' ? direction : DIRECTION[type];
  if (!dir) throw badRequest('An adjustment needs a direction: DEBIT (increase the balance) or CREDIT (decrease it).');
  const cents = toCents(amount);
  if (!(cents > 0)) throw badRequest('The amount must be greater than zero.');
  const { entry, replayed } = await prisma.$transaction(async (tx) => {
    const account = await loadAccount(actor.institutionId, accountId, tx);
    if (type === 'REFUND' && summarize(account.entries).balance + cents > 0) throw ruleViolation('refund_exceeds_credit', 'A refund cannot exceed the credit balance on the account.');
    return postEntryTx(tx, actor, account, { type, direction: dir, amount: money(cents), description, method: method ?? null, externalRef: externalRef ?? null, effectiveDate: effectiveDate ? new Date(`${effectiveDate}T00:00:00Z`) : new Date(), idempotencyKey: idempotencyKey ?? null, ...(isDemo != null ? { isDemo } : {}) });
  });
  return { entry: entryDto({ ...entry, reversedBy: null, invoiceLine: null }), replayed, account: await getAccount(actor.institutionId, accountId) };
}

/** Cancel a posted entry with an equal and opposite REVERSAL. The original stays as it was posted. */
export async function reverseEntry(actor, entryId, { reason, idempotencyKey }) {
  const accountId = await prisma.$transaction(async (tx) => {
    const original = await tx.ledgerEntry.findFirst({ where: { id: entryId, account: { institutionId: actor.institutionId } }, include: { reversedBy: true, account: true } });
    if (!original) throw notFound('Ledger entry');
    if (original.type === 'REVERSAL') throw ruleViolation('cannot_reverse_reversal', 'A reversal cannot itself be reversed; post an adjustment instead.');
    if (original.reversedBy) throw conflict(`This entry was already reversed by ${original.reversedBy.reference}.`, 'already_reversed');
    await postEntryTx(tx, actor, original.account, {
      type: 'REVERSAL', direction: original.direction === 'DEBIT' ? 'CREDIT' : 'DEBIT', amount: original.amount, reversesId: original.id,
      description: `Reversal of ${original.reference}: ${reason}`, effectiveDate: new Date(), idempotencyKey: idempotencyKey ?? `reverse:${original.id}`, isDemo: original.isDemo,
    });
    return original.accountId;
  });
  return getAccount(actor.institutionId, accountId);
}

/** Bundle the account's charges that are not on an invoice yet into a term invoice. */
export async function issueInvoice(actor, accountId, { dueDate }) {
  const id = await prisma.$transaction(async (tx) => {
    const account = await loadAccount(actor.institutionId, accountId, tx);
    const lines = account.entries.filter((e) => e.type === 'CHARGE' && !e.invoiceLine && !e.reversedBy);
    if (!lines.length) throw ruleViolation('nothing_to_invoice', 'Every charge on this account is already invoiced.');
    const total = lines.reduce((n, e) => n + toCents(e.amount), 0);
    const due = dueDate ?? account.dueDate?.toISOString().slice(0, 10);
    if (!due) throw badRequest('Give the invoice a due date (the account has none).');
    const count = await tx.invoice.count({ where: { account: { termId: account.termId, institutionId: actor.institutionId } } });
    const invoice = await tx.invoice.create({
      data: {
        accountId, number: `INV-${account.term.code}-${account.student.studentNumber}-${String(count + 1).padStart(2, '0')}`, dueDate: new Date(`${due}T00:00:00Z`), total: money(total), isDemo: account.isDemo, createdById: actor.id ?? null,
        lines: { create: lines.map((e) => ({ ledgerEntryId: e.id, description: e.description, amount: e.amount })) },
      },
    });
    await audit(actor, { action: 'finance.invoice.issue', entityType: 'Invoice', entityId: invoice.id, summary: `Issued ${invoice.number} for ${money(total)} due ${due}` }, tx);
    return invoice.id;
  });
  const account = await getAccount(actor.institutionId, accountId);
  return { invoice: account.invoices.find((i) => i.id === id), account };
}

/** Statement: every entry in posting order with the running balance, plus the totals and deadlines. */
export async function statement(institutionId, accountId) {
  const account = await loadAccount(institutionId, accountId);
  const dto = accountDto(account);
  let running = 0;
  const lines = account.entries.map((e) => { running += signed(e); return { ...entryDto(e), runningBalance: money(running) }; });
  return { generatedAt: new Date().toISOString(), account: { ...dto, entries: undefined }, lines };
}
