import { Request } from 'express';
import { prisma } from '../lib/prisma';
import { readBearerToken, verifyAuthToken } from '../lib/authToken';

type AdminIdentity = {
  id: number;
  username: string;
  role: string;
};

export async function requireAdmin(req: Request): Promise<AdminIdentity> {
  const token = readBearerToken(req.header('Authorization'));
  const decoded = token ? verifyAuthToken(token) : null;

  if (!decoded) {
    const error = new Error('Missing admin identity') as Error & { status?: number };
    error.status = 401;
    throw error;
  }

  const user = await prisma.userAccount.findUnique({ where: { id: BigInt(decoded.userId) } });

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
