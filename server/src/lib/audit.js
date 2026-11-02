import { prisma } from './prisma.js';

// Actor shape used throughout services:
//   { type: 'USER'|'INTEGRATION'|'SYSTEM', id, label, institutionId, role?, ip? }
export function actorFromUser(user, ip) {
  return { type: 'USER', id: user.id, label: `${user.firstName} ${user.lastName} (${(user.roles?.length ? user.roles : [user.role]).join(' + ').toLowerCase()})`, role: user.role, institutionId: user.institutionId, ip };
}

// `onBehalfOf` is the human the integrating system says it is acting for (X-Acting-User). It is recorded for
// accountability only; CampusCore authorizes the CLIENT, never the asserted human.
export function actorFromClient(client, ip, onBehalfOf) {
  return { type: 'INTEGRATION', id: client.id, label: `Integration: ${client.name}`, institutionId: client.institutionId, ip, onBehalfOf: onBehalfOf ?? null };
}

// Writes an audit event. Pass `tx` to make the audit record part of the same transaction as the change.
export async function audit(actor, { action, entityType, entityId, summary, before, after, outcome = 'SUCCESS' }, tx = prisma) {
  return tx.auditEvent.create({
    data: {
      institutionId: actor.institutionId,
      actorType: actor.type,
      actorId: actor.id ?? null,
      actorLabel: actor.label,
      onBehalfOf: actor.onBehalfOf ?? null,
      outcome,
      action,
      entityType,
      entityId: entityId ?? null,
      summary,
      before: before ?? undefined,
      after: after ?? undefined,
      ip: actor.ip ?? null,
    },
  });
}
