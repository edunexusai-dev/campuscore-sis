// Grants scopes to an existing integration client through the normal (audited) client update. Never removes a scope,
// never touches the secret. Tokens issued before the change keep their old scopes until they expire.
//
//   node scripts/grant-integration-scope.js --slug feddrick --client-id cc_xxx --scope finance:read            (dry run)
//   node scripts/grant-integration-scope.js --slug feddrick --client-id cc_xxx --scope finance:read --apply
// The same change can be made in the web app: Developer & integrations → the client → Scopes.
import { parseArgs } from 'node:util';
import { prisma } from '../src/lib/prisma.js';
import { SCOPE_NAMES, updateClient } from '../src/services/integrationService.js';

const { values: a } = parseArgs({ options: { slug: { type: 'string' }, 'client-id': { type: 'string' }, scope: { type: 'string', multiple: true }, apply: { type: 'boolean', default: false } } });
const fail = (m) => { console.error(m); process.exit(1); };
if (!a.slug || !a['client-id'] || !a.scope?.length) fail('Usage: grant-integration-scope.js --slug <institution> --client-id <id> --scope <scope> [--scope …] [--apply]');
const unknown = a.scope.filter((s) => !SCOPE_NAMES.includes(s));
if (unknown.length) fail(`Unknown scope(s): ${unknown.join(', ')}`);
try {
  const inst = await prisma.institution.findFirst({ where: { slug: a.slug } });
  if (!inst) fail(`No institution "${a.slug}".`);
  const client = await prisma.integrationClient.findFirst({ where: { institutionId: inst.id, clientId: a['client-id'] } });
  if (!client) fail('No such integration client in this institution.');
  const missing = a.scope.filter((s) => !client.scopes.includes(s));
  console.log(`${client.name} (${client.clientId}): ${missing.length ? `would add ${missing.join(', ')}` : 'already has every scope'}`);
  if (a.apply && missing.length) {
    const admin = await prisma.user.findFirst({ where: { institutionId: inst.id, role: 'ADMIN', status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } });
    if (!admin) fail('No active administrator to attribute the change to.');
    const actor = { type: 'USER', id: admin.id, role: 'ADMIN', label: `Scope grant script (as ${admin.firstName} ${admin.lastName})`, institutionId: inst.id };
    const updated = await updateClient(actor, client.id, { scopes: [...client.scopes, ...missing] });
    console.log(`added; the client now has ${updated.scopes.length} scopes`);
  } else if (!a.apply) console.log('Dry run: nothing was written. Re-run with --apply.');
} finally {
  await prisma.$disconnect();
}
