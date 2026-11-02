import { prisma } from '../lib/prisma.js';

export async function notifyUser(userId, { title, body, link }, tx = prisma) {
  if (!userId) return null;
  return tx.notification.create({ data: { userId, title, body, link } });
}

export async function notifyStudent(studentId, message, tx = prisma) {
  const student = await tx.student.findUnique({ where: { id: studentId }, select: { userId: true } });
  return notifyUser(student?.userId, message, tx);
}
