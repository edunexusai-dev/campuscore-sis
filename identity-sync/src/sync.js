// CampusCore → Keycloak identity sync. One pass over the person registry (all people, or those changed since the
// last successful run): for each person, find their account, decide what must change (plan.js) and, with
// `apply`, make the change. A dry run (the default) only reports. Results name person numbers and changed field
// names, never email addresses or names.
import { desiredAccount, diffAccount, numbersOf, resolveAccount, usernameFor } from './plan.js';

export async function syncPerson(person, { keycloak, apply = false, adopt = {}, sendSetupEmail = false }) {
  const base = { personNumber: person.personNumber };
  if (person.mergedInto) return { ...base, action: 'SKIP', reason: 'MERGED_PERSON' };
  const byPersonNumber = await keycloak.byAttribute('person_number', person.personNumber);
  const byNumbers = byPersonNumber.length ? [] : (await Promise.all(numbersOf(person).map((n) => keycloak.byAttribute(n.attribute, n.value)))).flat();
  const byEmail = byPersonNumber.length || byNumbers.length ? [] : (await Promise.all(person.emails.map((e) => keycloak.byEmail(e)))).flat();
  const adoptId = adopt[person.personNumber] ?? null;
  const adoptAccount = adoptId ? await keycloak.getUser(adoptId).catch(() => null) : null;
  const resolved = resolveAccount(person, { byPersonNumber, byNumbers, byEmail, adoptId, adoptAccount, formerPersonNumbers: person.formerPersonNumbers ?? [] });
  if (resolved.action === 'CONFLICT' || resolved.action === 'SKIP') return { ...base, action: resolved.action, reason: resolved.reason };

  const desired = desiredAccount(person);
  if (resolved.action === 'CREATE') {
    const result = { ...base, action: 'CREATE', roles: desired.roles };
    if (!apply) return result;
    const username = usernameFor(person, () => false);
    const finalUsername = (await keycloak.usernameTaken(username)) ? usernameFor(person, () => true) : username;
    const id = await keycloak.createUser({ username: finalUsername, email: desired.email, emailVerified: true, firstName: desired.firstName, lastName: desired.lastName, enabled: desired.enabled, attributes: desired.attributes, requiredActions: ['UPDATE_PASSWORD'] });
    await keycloak.addRealmRoles(id, desired.roles);
    if (sendSetupEmail) await keycloak.sendSetupEmail(id);
    return { ...result, accountId: id, applied: true };
  }

  // UPDATE or ADOPT: compare with the full current account (Keycloak replaces attribute maps wholesale).
  const account = await keycloak.getUser(resolved.account.id);
  const { changed, representation, addRoles, removeRoles } = diffAccount(account, await keycloak.realmRoles(account.id), desired);
  const result = { ...base, action: resolved.action, ...(resolved.via ? { via: resolved.via } : {}), accountId: account.id, changed, addRoles, removeRoles };
  if (!changed.length && !addRoles.length && !removeRoles.length) return { ...result, action: resolved.action === 'ADOPT' ? 'ADOPT' : 'UNCHANGED' };
  if (!apply) return result;
  if (changed.length) await keycloak.updateUser(account.id, representation);
  await keycloak.addRealmRoles(account.id, addRoles);
  await keycloak.removeRealmRoles(account.id, removeRoles);
  return { ...result, applied: true };
}

/**
 * `people`: an async iterable of CampusCore people. Returns { results, summary }. One person's failure is recorded
 * (code only) and the run continues; the caller treats any ERROR as an unsuccessful run.
 */
export async function runSync({ people, keycloak, apply = false, adopt = {}, sendSetupEmail = false }) {
  const results = [];
  for await (const person of people) {
    try {
      results.push(await syncPerson(person, { keycloak, apply, adopt, sendSetupEmail }));
    } catch (error) {
      results.push({ personNumber: person.personNumber, action: 'ERROR', reason: error.code ?? 'UNEXPECTED', message: error.code ? error.message : 'Unexpected error' });
    }
  }
  const summary = {};
  for (const r of results) summary[r.action] = (summary[r.action] ?? 0) + 1;
  return { results, summary };
}
