import { Request } from 'express';
import { prisma } from '../lib/prisma';

export type UserIdentity = {
  id: number;
  username: string;
  fullName: string;
  role: string;
  plan: string;
  premiumValidUntil: Date | null;
};

export async function requireUser(req: Request): Promise<UserIdentity> {
  const rawUserId = req.header('X-User-Id');
  const userId = rawUserId ? Number(rawUserId) : NaN;

  if (!Number.isSafeInteger(userId) || userId <= 0) {
    const error = new Error('Bạn cần đăng nhập để thực hiện thao tác này.') as Error & { status?: number };
    error.status = 401;
    throw error;
  }

  const user = await prisma.userAccount.findUnique({
    where: { id: BigInt(userId) },
    select: { id: true, username: true, fullname: true, role: true, plan: true, premiumValidUntil: true },
  });

  if (!user) {
    const error = new Error('Không tìm thấy tài khoản.') as Error & { status?: number };
    error.status = 401;
    throw error;
  }

  return {
    id: Number(user.id),
    username: user.username,
    fullName: user.fullname,
    role: user.role,
    plan: user.plan,
    premiumValidUntil: user.premiumValidUntil,
  };
}
