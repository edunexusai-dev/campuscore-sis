import { useState } from 'react';
import { RotateCw, UserCheck } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApi, useAction } from '../../lib/hooks.js';
import { useAuth } from '../../lib/auth.jsx';
import { fmtDateTime } from '../../lib/format.js';
import { Card, Spinner, Badge, Button, KeyValue, Modal, Field, Input, Textarea, ApiErrorDetails, Alert } from '../../components/ui.jsx';

// Plain-language reasons for the provisioning worker's decisions (codes from @campuscore/identity-sync and the worker).
const REASONS = {
  EMAIL_IN_USE_WITHOUT_NUMBER: 'An account with this person\'s email exists in the university sign-in but carries none of their institutional numbers. It is never taken over on email alone: check it in Keycloak, then confirm it here.',
  EVIDENCE_MISMATCH: 'An account carries this person\'s student or employee number but a different email address.',
  AMBIGUOUS_ACCOUNTS: 'Several accounts carry this person\'s institutional numbers.',
  NUMBER_HELD_BY_OTHER_PERSON: 'An account carrying this person\'s number belongs to another person number.',
  DUPLICATE_PERSON_NUMBER: 'Several accounts carry this person number.',
  ADOPT_ACCOUNT_NOT_FOUND: 'The confirmed account was not found in Keycloak.',
  ADOPT_ACCOUNT_BELONGS_TO_OTHER_PERSON: 'The confirmed account belongs to another person number.',
  MERGED_PERSON_HAS_ACCOUNT: 'This person was merged into another, but an enabled account still carries this person number. Disable it in Keycloak (the surviving person has their own), then retry.',
  KEYCLOAK_USERNAME_OR_EMAIL_TAKEN: 'Keycloak refused the account because its username or email is already in use.',
  NO_CURRENT_RELATIONSHIP: 'No current student or faculty relationship, so no account is needed.',
  IDENTITY_EXCLUDED: 'Excluded from identity provisioning.',
  MERGED_PERSON: 'Merged into another person, whose account is used.',
};

/** Where this person's university account (identity provider) stands, with the administrator's actions. */
export default function UniversityAccountCard({ personId }) {
  const { can } = useAuth();
  const path = `/admin/persons/${personId}/identity-provisioning`;
  const { data, isLoading } = useApi(can('identity.manage') && personId ? path : null);
  const [adopting, setAdopting] = useState(false);
  const retry = useAction(() => api.post(`${path}/retry`), { invalidate: [path], success: 'Queued for provisioning' });
  if (!can('identity.manage') || !personId) return null;
  if (isLoading) return <Card title="University account"><Spinner /></Card>;
  const p = data.data;
  const canRetry = p.status && !['PENDING', 'PROCESSING'].includes(p.status);
  return (
    <Card title="University account" actions={p.status && <Badge status={p.status} />}>
      {!p.status ? <p className="text-sm text-ink-500">Not provisioned: this person has no student or faculty record.</p> : <>
        {p.reason && <Alert tone={p.status === 'NEEDS_REVIEW' ? 'warn' : 'info'} className="mb-3">{REASONS[p.reason] ?? p.reason}</Alert>}
        {p.lastError && <Alert tone="error" className="mb-3">{p.lastError}{p.nextAttemptAt ? ` Retrying automatically at ${fmtDateTime(p.nextAttemptAt)}.` : ''}</Alert>}
        <KeyValue cols={1} items={[
          ['Account ID', p.keycloakUserId ? <span className="mono text-[12px]">{p.keycloakUserId}</span> : 'None yet'],
          p.lastAction && ['Last result', `${p.lastAction.toLowerCase()}${p.lastResult?.via ? ` (matched by ${p.lastResult.via.toLowerCase().replace(/_/g, ' ')})` : ''}`],
          p.provisionedAt && ['Last in sync', fmtDateTime(p.provisionedAt)],
          p.keycloakUserId && ['Password setup email', p.setupEmailSentAt ? `Sent ${fmtDateTime(p.setupEmailSentAt)}` : 'Not sent (needs SMTP in the university sign-in)'],
          p.attempts > 0 && ['Attempts', p.attempts],
          p.adoptionPending && ['Confirmed account', 'Waiting to be adopted'],
        ]} />
        <div className="mt-4 flex flex-wrap gap-2">
          {canRetry && <Button size="sm" variant="secondary" icon={RotateCw} loading={retry.isPending} onClick={() => retry.mutate()}>Retry</Button>}
          {p.status === 'NEEDS_REVIEW' && can('users.manage') && <Button size="sm" variant="secondary" icon={UserCheck} onClick={() => setAdopting(true)}>Confirm existing account…</Button>}
        </div>
      </>}
      <AdoptModal open={adopting} onClose={() => setAdopting(false)} path={path} />
    </Card>
  );
}

function AdoptModal({ open, onClose, path }) {
  const [f, setF] = useState({ accountId: '', reason: '' });
  const save = useAction(() => api.post(`${path}/adopt`, f), { invalidate: [path], success: 'Account confirmed; it will be adopted shortly', onSuccess: () => { setF({ accountId: '', reason: '' }); onClose(); }, toastErrors: false });
  return (
    <Modal open={open} onClose={onClose} title="Confirm an existing account" description="Only when you have verified that this Keycloak account belongs to this person. Whoever controls the account will sign in as them."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending}>Confirm account</Button></>}>
      <ApiErrorDetails error={save.error} />
      <div className="mt-2 space-y-4">
        <Field label="Keycloak account ID" hint="Keycloak admin console → Users → the account → ID" required><Input className="mono" value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })} /></Field>
        <Field label="How did you verify it?" required><Textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
