// Limit identity provisioning to a keep-list of people (e.g. a demo environment). Every other person of the
// institution is excluded: they keep their records and academic history, but the People API no longer offers them,
// no external account can be linked for them, and no CampusCore login is created for them at sign-in.
//
//   node --env-file=.env scripts/identity-exclusion.js --institution feddrick --keep P0000210,P0000107 --reason "…"
//   … --apply          make the change (default: dry run, nothing written)
//
// Each change is audited per person. Reversible: run again with a different keep-list, or per person in the admin API.
import { prisma } from '../src/lib/prisma.js';
import { audit } from '../src/lib/audit.js';
import { setIdentityExclusion } from '../src/services/personService.js';

const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const slug = value('--institution');
const keep = (value('--keep') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const reason = value('--reason') ?? '';
const apply = args.includes('--apply');
if (!slug || !keep.length || reason.length < 10) {
  console.error('Usage: --institution <slug> --keep P0000001[,P…] --reason "<at least 10 characters>" [--apply]');
  process.exit(1);
}
const institution = await prisma.institution.findUnique({ where: { slug } });
if (!institution) { console.error(`No institution ${slug}.`); process.exit(1); }
const people = await prisma.person.findMany({ where: { institutionId: institution.id, mergedIntoId: null }, select: { id: true, personNumber: true, identityExcluded: true } });
const missing = keep.filter((n) => !people.some((p) => p.personNumber === n));
if (missing.length) { console.error(`Not found (or merged): ${missing.join(', ')}. Nothing changed.`); process.exit(1); }
const toExclude = people.filter((p) => !keep.includes(p.personNumber) && !p.identityExcluded);
const toInclude = people.filter((p) => keep.includes(p.personNumber) && p.identityExcluded);
console.log(`${apply ? 'Applying' : 'Dry run'} · ${slug}: ${people.length} people · keep eligible: ${keep.join(', ')}`);
console.log(`  exclude ${toExclude.length} · include again ${toInclude.length} · already as wanted ${people.length - toExclude.length - toInclude.length}`);
if (apply) {
  const actor = { type: 'SYSTEM', id: null, label: 'Identity provisioning scope (keep-list)', institutionId: institution.id };
  const excluded = await setIdentityExclusion(actor, toExclude.map((p) => p.id), { excluded: true, reason }, audit);
  const included = await setIdentityExclusion(actor, toInclude.map((p) => p.id), { excluded: false, reason }, audit);
  console.log(`  done: excluded ${excluded.length}, included ${included.length}`);
}
await prisma.$disconnect();
