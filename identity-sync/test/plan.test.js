import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { desiredAccount, diffAccount, resolveAccount, usernameFor } from '../src/plan.js';

const rahul = {
  personNumber: 'P0000210', firstName: 'Rahul', lastName: 'Multirole', status: 'ACTIVE',
  primaryEmail: 'rahul.multirole@feddrick.edu', emails: ['rahul.multirole@feddrick.edu', 'rahul.multirole@students.feddrick.edu'],
  relationships: [
    { type: 'FACULTY', number: 'F01024', status: 'ACTIVE', current: true },
    { type: 'STUDENT', number: 'S2600187', status: 'ACTIVE', current: true },
  ],
};
const student = (over = {}) => ({ personNumber: 'P0000300', firstName: 'Keshav', lastName: 'Jha', status: 'ACTIVE', primaryEmail: 'keshav.jha@student.feddrick.edu', emails: ['keshav.jha@student.feddrick.edu'], relationships: [{ type: 'STUDENT', number: 'S2600188', status: 'ACTIVE', current: true }], ...over });
const none = { byPersonNumber: [], byNumbers: [], byEmail: [] };

describe('desiredAccount', () => {
  it('one account for a person who teaches and studies: both numbers, both roles, the faculty email', () => {
    assert.deepEqual(desiredAccount(rahul), {
      email: 'rahul.multirole@feddrick.edu', emailVerified: true, firstName: 'Rahul', lastName: 'Multirole', enabled: true,
      attributes: { person_number: ['P0000210'], student_number: ['S2600187'], employee_number: ['F01024'] },
      roles: ['faculty', 'learner'],
    });
  });

  it('a graduate keeps the student number, becomes alumni and stays enabled; nothing current means disabled', () => {
    const grad = desiredAccount(student({ status: 'ALUMNI', relationships: [{ type: 'STUDENT', number: 'S1', status: 'GRADUATED', current: false }] }));
    assert.deepEqual([grad.roles, grad.enabled, grad.attributes.student_number], [['alumni'], true, ['S1']]);
    const gone = desiredAccount(student({ status: 'INACTIVE', relationships: [{ type: 'STUDENT', number: 'S1', status: 'WITHDRAWN', current: false }] }));
    assert.deepEqual([gone.roles, gone.enabled], [[], false]);
  });
});

describe('current = the EdunexusAI policy, from the record status', () => {
  const withStudent = (status) => student({ status: 'ACTIVE', relationships: [{ type: 'STUDENT', number: 'S1', status, current: true }] });
  it('Active, Admitted and Leave of absence students are current; Suspended and Withdrawn are not', () => {
    for (const status of ['ACTIVE', 'ADMITTED', 'LEAVE_OF_ABSENCE']) assert.deepEqual(desiredAccount(withStudent(status)).roles, ['learner'], status);
    for (const status of ['SUSPENDED', 'WITHDRAWN', 'APPLICANT']) {
      // Even if CampusCore's own flag said otherwise, the policy decides.
      const d = desiredAccount(withStudent(status));
      assert.deepEqual([d.roles, d.enabled], [[], false], status);
      assert.deepEqual(resolveAccount(withStudent(status), none), { action: 'SKIP', reason: 'NO_CURRENT_RELATIONSHIP' }, status);
    }
  });

  it('only Active faculty are current', () => {
    const f = (status) => desiredAccount(student({ relationships: [{ type: 'FACULTY', number: 'F1', status, current: false }] }));
    assert.deepEqual([f('ACTIVE').roles, f('ACTIVE').enabled], [['faculty'], true]);
    assert.deepEqual([f('DISABLED').roles, f('DISABLED').enabled], [[], false]);
  });

  it('a suspended student who already has an account is disabled and loses learner, never deleted', () => {
    const account = { id: 'k', email: 'keshav.jha@student.feddrick.edu', emailVerified: true, firstName: 'Keshav', lastName: 'Jha', enabled: true, attributes: { person_number: ['P0000300'], student_number: ['S2600188'] } };
    const d = diffAccount(account, ['learner'], desiredAccount(student({ relationships: [{ type: 'STUDENT', number: 'S2600188', status: 'SUSPENDED', current: false }] })));
    assert.deepEqual([d.changed, d.removeRoles], [['enabled'], ['learner']]);
  });
});

describe('resolveAccount: never on email alone', () => {
  it('the account carrying the person number is theirs; two such accounts is a conflict', () => {
    assert.equal(resolveAccount(rahul, { ...none, byPersonNumber: [{ id: 'a' }] }).action, 'UPDATE');
    assert.equal(resolveAccount(rahul, { ...none, byPersonNumber: [{ id: 'a' }, { id: 'b' }] }).reason, 'DUPLICATE_PERSON_NUMBER');
  });

  it('adopts an account that carries the person\'s number and one of their addresses (Rahul, set up by hand)', () => {
    const acct = { id: 'kc-rahul', email: 'rahul.multirole@feddrick.edu', attributes: { student_number: ['S2600187'], employee_number: ['F01024'] } };
    const r = resolveAccount(rahul, { ...none, byNumbers: [acct, acct] });
    assert.deepEqual([r.action, r.via, r.account.id], ['ADOPT', 'INSTITUTIONAL_NUMBER', 'kc-rahul']);
  });

  it('refuses a numbered account with a foreign email, several accounts, or a number another person holds', () => {
    assert.equal(resolveAccount(rahul, { ...none, byNumbers: [{ id: 'x', email: 'someone@else.edu' }] }).reason, 'EVIDENCE_MISMATCH');
    assert.equal(resolveAccount(rahul, { ...none, byNumbers: [{ id: 'x', email: 'rahul.multirole@feddrick.edu' }, { id: 'y', email: 'rahul.multirole@students.feddrick.edu' }] }).reason, 'AMBIGUOUS_ACCOUNTS');
    assert.equal(resolveAccount(rahul, { ...none, byNumbers: [{ id: 'x', email: 'rahul.multirole@feddrick.edu', attributes: { person_number: ['P0000999'] } }] }).reason, 'NUMBER_HELD_BY_OTHER_PERSON');
  });

  it('an account with the address but no number (Keshav, created by hand) needs an administrator\'s confirmation', () => {
    const handMade = { id: 'kc-keshav', email: 'keshav.jha@student.feddrick.edu', attributes: {} };
    assert.deepEqual(resolveAccount(student(), { ...none, byEmail: [handMade] }), { action: 'CONFLICT', reason: 'EMAIL_IN_USE_WITHOUT_NUMBER' });
    const confirmed = resolveAccount(student(), { ...none, byEmail: [handMade], adoptId: 'kc-keshav', adoptAccount: handMade });
    assert.deepEqual([confirmed.action, confirmed.via], ['ADOPT', 'ADMIN_CONFIRMED']);
    assert.equal(resolveAccount(student(), { ...none, adoptId: 'kc-x', adoptAccount: { id: 'kc-x', attributes: { person_number: ['P0000001'] } } }).reason, 'ADOPT_ACCOUNT_BELONGS_TO_OTHER_PERSON');
  });

  it('creates an account only for someone with a current relationship', () => {
    assert.equal(resolveAccount(student(), none).action, 'CREATE');
    assert.deepEqual(resolveAccount(student({ status: 'INACTIVE', relationships: [{ type: 'STUDENT', number: 'S2600188', status: 'WITHDRAWN', current: false }] }), none), { action: 'SKIP', reason: 'NO_CURRENT_RELATIONSHIP' });
  });
});

describe('diffAccount', () => {
  it('changes only what the sync owns and keeps every other attribute and role', () => {
    const account = { id: 'kc-rahul', username: 'rahul.multirole', email: 'Rahul.Multirole@feddrick.edu', emailVerified: true, firstName: 'Rahul', lastName: 'Multirole', enabled: true, attributes: { student_number: ['S2600187'], employee_number: ['F01024'], demo: ['synthetic'] } };
    const d = diffAccount(account, ['faculty', 'learner', 'offline_access', 'it-admins'], desiredAccount(rahul));
    assert.deepEqual(d.changed, ['person_number']);
    assert.deepEqual(d.representation.attributes, { student_number: ['S2600187'], employee_number: ['F01024'], demo: ['synthetic'], person_number: ['P0000210'] });
    assert.equal(d.representation.username, 'rahul.multirole');
    assert.deepEqual([d.addRoles, d.removeRoles], [[], []]);
  });

  it('a student who leaves: learner removed, account disabled; the student number stays an identifier', () => {
    const account = { id: 'k', email: 'keshav.jha@student.feddrick.edu', emailVerified: true, firstName: 'Keshav', lastName: 'Jha', enabled: true, attributes: { person_number: ['P0000300'], student_number: ['S2600188'] } };
    const d = diffAccount(account, ['learner'], desiredAccount(student({ status: 'INACTIVE', relationships: [{ type: 'STUDENT', number: 'S2600188', status: 'WITHDRAWN', current: false }] })));
    assert.deepEqual([d.changed, d.removeRoles, d.addRoles], [['enabled'], ['learner'], []]);
  });

  it('removes an identity attribute for a relationship the person no longer has', () => {
    const account = { id: 'k', email: 'keshav.jha@student.feddrick.edu', emailVerified: true, firstName: 'Keshav', lastName: 'Jha', enabled: true, attributes: { person_number: ['P0000300'], student_number: ['S2600188'], employee_number: ['F9'] } };
    const d = diffAccount(account, ['learner'], desiredAccount(student()));
    assert.deepEqual(d.changed, ['employee_number']);
    assert.equal('employee_number' in d.representation.attributes, false);
  });
});

describe('usernameFor', () => {
  it('uses the email local part, with the person number when taken', () => {
    assert.equal(usernameFor(student(), () => false), 'keshav.jha');
    assert.equal(usernameFor(student(), () => true), 'keshav.jha.p0000300');
  });
});
