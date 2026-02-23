import { Request } from 'express';
import { prisma } from '../lib/prisma';

type AdminIdentity = {
  id: number;
  username: string;
  role: string;
};

export async function requireAdmin(req: Request): Promise<AdminIdentity> {
  const adminUsername = String(req.header('X-Admin-Username') || '').trim();
  const idHeader = req.header('X-Admin-UserId');
  const adminUserId = idHeader ? Number(idHeader) : null;

  if (!adminUsername && !adminUserId) {
    const error = new Error('Missing admin identity') as Error & { status?: number };
    error.status = 401;
    throw error;
  }

  const user = adminUserId
    ? await prisma.userAccount.findUnique({ where: { id: BigInt(adminUserId) } })
    : await prisma.userAccount.findUnique({ where: { username: adminUsername } });

  if (!user) {
    const error = new Error('Admin not found') as Error & { status?: number };
    error.status = 401;
    throw error;
  }

  if (!String(user.role || '').toUpperCase().includes('ADMIN')) {
    const error = new Error('Admin role required') as Error & { status?: number };
    error.status = 403;
    throw error;
  }

  return {
    id: Number(user.id),
    username: user.username,
    role: user.role,
  };
}
