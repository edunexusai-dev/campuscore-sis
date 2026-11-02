#!/usr/bin/env node
// CampusCore → Keycloak identity sync (command line).
//
//   npm run sync                      dry run: report what would change, change nothing
//   npm run sync -- --apply           make the changes
//   --full                            every person (default: only people changed since the last successful --apply run)
//   --person P0000123[,P0000124]      only these people
//   --adopt P0000123=<keycloak id>    an administrator confirms that this existing account is this person's
//                                     (for an account that has the person's email but no institutional number)
//   --json                            machine-readable output
//
// Exit code 0: success; 1: configuration problem; 2: some people could not be synced (see ERROR / CONFLICT).
import fs from 'node:fs';
import path from 'node:path';
import { CampusCoreClient, KeycloakAdminClient } from '../src/clients.js';
import { runSync } from '../src/sync.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const values = (name) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : a.startsWith(`${name}=`) ? [a.slice(name.length + 1)] : []));

const env = process.env;
const missing = ['CAMPUSCORE_BASE_URL', 'CAMPUSCORE_CLIENT_ID', 'CAMPUSCORE_CLIENT_SECRET', 'KEYCLOAK_BASE_URL', 'KEYCLOAK_REALM', 'KEYCLOAK_CLIENT_ID', 'KEYCLOAK_CLIENT_SECRET'].filter((k) => !env[k]);
if (missing.length) {
  console.error(`Not configured: set ${missing.join(', ')} (see .env.example).`);
  process.exit(1);
}

const apply = flag('--apply');
const adopt = {};
for (const pair of values('--adopt')) {
  const [personNumber, accountId] = pair.split('=');
  if (!/^P\d{7}$/.test(personNumber ?? '') || !/^[0-9a-f-]{36}$/.test(accountId ?? '')) {
    console.error(`--adopt expects P0000123=<keycloak account id>, got "${pair}".`);
    process.exit(1);
  }
  adopt[personNumber] = accountId;
}
const only = values('--person').flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
const timeoutMs = Number(env.SYNC_TIMEOUT_MS) || 10_000;
const stateFile = path.resolve(env.SYNC_STATE_FILE || '.sync-state.json');
let state = {};
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first run */ }

const campuscore = new CampusCoreClient({ baseUrl: env.CAMPUSCORE_BASE_URL, clientId: env.CAMPUSCORE_CLIENT_ID, clientSecret: env.CAMPUSCORE_CLIENT_SECRET, timeoutMs });
const keycloak = new KeycloakAdminClient({ baseUrl: env.KEYCLOAK_BASE_URL, realm: env.KEYCLOAK_REALM, clientId: env.KEYCLOAK_CLIENT_ID, clientSecret: env.KEYCLOAK_CLIENT_SECRET, timeoutMs });

// Incremental only when a previous applied run succeeded; a minute of overlap absorbs clock differences.
const incremental = !flag('--full') && !only.length && state.lastSuccessfulRun;
const updatedSince = incremental ? new Date(new Date(state.lastSuccessfulRun).getTime() - 60_000) : undefined;
const startedAt = new Date();

async function* selected() {
  if (only.length) {
    for (const n of only) {
      const p = await campuscore.personByNumber(n);
      if (p) yield p;
      else console.error(`No CampusCore person ${n}.`);
    }
  } else {
    yield* campuscore.people({ updatedSince });
  }
}

try {
  const { results, summary } = await runSync({ people: selected(), keycloak, apply, adopt, sendSetupEmail: env.SYNC_SEND_SETUP_EMAIL === 'true' });
  const failed = results.some((r) => r.action === 'ERROR');
  if (apply && !failed && !only.length) fs.writeFileSync(stateFile, JSON.stringify({ lastSuccessfulRun: startedAt.toISOString() }, null, 2));
  if (flag('--json')) {
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', scope: only.length ? 'selected' : incremental ? 'incremental' : 'full', summary, results }, null, 2));
  } else {
    console.log(`${apply ? 'Applied' : 'Dry run (nothing changed; add --apply)'} · ${only.length ? 'selected people' : incremental ? `changes since ${updatedSince.toISOString()}` : 'all people'}`);
    for (const r of results.filter((x) => x.action !== 'UNCHANGED')) {
      const detail = [r.via && `via ${r.via}`, r.changed?.length && `fields: ${r.changed.join(', ')}`, r.addRoles?.length && `+roles: ${r.addRoles.join(', ')}`, r.removeRoles?.length && `-roles: ${r.removeRoles.join(', ')}`, r.roles?.length && `roles: ${r.roles.join(', ')}`, r.reason, r.message].filter(Boolean).join(' · ');
      console.log(`  ${r.personNumber}  ${r.action.padEnd(9)} ${detail}`);
    }
    console.log(`Summary: ${Object.entries(summary).map(([k, v]) => `${k} ${v}`).join(', ') || 'nobody to sync'}`);
  }
  process.exit(failed || results.some((r) => r.action === 'CONFLICT') ? 2 : 0);
} catch (error) {
  console.error(`Sync failed: ${error.code ?? 'ERROR'}: ${error.message}`);
  process.exit(error.code === 'AUTH_FAILED' || error.code === 'FORBIDDEN' ? 1 : 2);
}
