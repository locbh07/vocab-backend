import { Router, Request, Response } from 'express';
import { getSupabaseAdmin, getSupabaseAnon } from '../lib/supabase';
import bcrypt from 'bcryptjs';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '../lib/prisma';
import { formatUserLine, notifyTelegram } from '../lib/telegram';

const googleOAuthClient = new OAuth2Client();
const JLPT_LEVELS = new Set(['N5', 'N4', 'N3', 'N2', 'N1']);

export function createAuthRouter() {
  const router = Router();

  router.post('/register', async (req: Request, res: Response) => {
    try {
      const username = String(req.body?.username || '').trim();
      const password = String(req.body?.password || '').trim();
      const confirmPassword = String(
        req.body?.confirmPassword || req.body?.passwordConfirm || req.body?.rePassword || '',
      ).trim();
      const fullName = String(req.body?.fullName || req.body?.fullname || '').trim();
      const email = String(req.body?.email || '').trim().toLowerCase();
      const level = normalizeJlptLevel(req.body?.level);

      if (!username || !password || !confirmPassword || !fullName || !email) {
        return res.status(400).json({ success: false, message: 'Vui lòng nhập đầy đủ thông tin đăng ký.' });
      }
      if (password !== confirmPassword) {
        return res.status(400).json({ success: false, message: 'Mật khẩu nhập lại không khớp.' });
      }
      if (!level) {
        return res.status(400).json({ success: false, message: 'Trình độ không hợp lệ. Vui lòng chọn từ N5 đến N1.' });
      }

      if (!isSupabaseConfigured()) {
        const existing = await prisma.userAccount.findFirst({
          where: {
            OR: [{ username }, { email }],
          },
        });
        if (existing) {
          return res.status(409).json({ success: false, message: 'Tên đăng nhập hoặc email đã tồn tại.' });
        }

        const passwordhash = await bcrypt.hash(password, 10);
        const created = await prisma.userAccount.create({
          data: {
            username,
            passwordhash,
            fullname: fullName,
            email,
            role: 'USER',
            exam_enabled: false,
            level,
          },
        });

        await notifyTelegram({
          title: 'New user registered',
          lines: [
            `User: ${formatUserLine({
              id: created.id,
              username: created.username,
              fullname: created.fullname,
              email: created.email,
            })}`,
            `Level: ${created.level || '-'}`,
            'Method: password',
          ],
        });

        return res.json({
          success: true,
          message: 'Register success',
          user: sanitizeUser(created),
        });
      }

      const admin = getSupabaseAdmin();
      const { data: existing } = await admin
        .from('useraccount')
        .select('id')
        .or(`username.eq.${username},email.eq.${email}`)
        .limit(1);

      if (existing && existing.length > 0) {
        return res.status(409).json({ success: false, message: 'Tên đăng nhập hoặc email đã tồn tại.' });
      }

      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });

      if (createError || !created?.user?.id) {
        return res.status(400).json({ success: false, message: 'Create user failed' });
      }

      const authUserId = created.user.id;
      const { error: insertError, data: inserted } = await admin
        .from('useraccount')
        .insert({
          username,
          passwordhash: 'supabase',
          fullname: fullName,
          email,
          role: 'USER',
          exam_enabled: false,
          auth_user_id: authUserId,
          level,
        })
        .select('id, username, fullname, email, role, exam_enabled, exam_code, level, google_id, plan, premium_valid_until, premium_trial_started_at')
        .maybeSingle();

      if (insertError) {
        await admin.auth.admin.deleteUser(authUserId).catch(() => {});
        return res.status(500).json({ success: false, message: 'Create profile failed' });
      }

      if (inserted) {
        await notifyTelegram({
          title: 'New user registered',
          lines: [
            `User: ${formatUserLine({
              id: inserted.id,
              username: inserted.username,
              fullname: inserted.fullname,
              email: inserted.email,
            })}`,
            `Level: ${inserted.level || '-'}`,
            'Method: password',
          ],
        });
      }

      return res.json({
        success: true,
        message: 'Register success',
        user: inserted
          ? {
              id: inserted.id,
              username: inserted.username,
              fullName: inserted.fullname,
              email: inserted.email,
              role: inserted.role,
              examEnabled: inserted.exam_enabled,
              examCode: inserted.exam_code,
              level: inserted.level,
              googleId: inserted.google_id,
              plan: inserted.plan,
              premiumValidUntil: inserted.premium_valid_until,
              premiumTrialStartedAt: inserted.premium_trial_started_at,
            }
          : null,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: (error as Error).message });
    }
  });

  router.post('/login', async (req: Request, res: Response) => {
    try {
      const identifier = String(req.body?.identifier || req.body?.username || req.body?.email || '').trim();
      const password = String(req.body?.password || '').trim();
      if (!identifier || !password) {
        return res.status(400).json({ success: false, message: 'Missing identifier or password' });
      }

      if (!isSupabaseConfigured()) {
        const profile = identifier.includes('@')
          ? await prisma.userAccount.findUnique({ where: { email: identifier } })
          : await prisma.userAccount.findUnique({ where: { username: identifier } });

        if (!profile) {
          return res.status(401).json({ success: false, message: 'Sai tài khoản hoặc mật khẩu.' });
        }

        const isMatch = await bcrypt.compare(password, profile.passwordhash);
        if (!isMatch) {
          return res.status(401).json({ success: false, message: 'Sai tài khoản hoặc mật khẩu.' });
        }

        return res.json({
          success: true,
          message: 'Đăng nhập thành công',
          user: sanitizeUser(profile),
        });
      }

      const admin = getSupabaseAdmin();
      let email = identifier;

      if (!identifier.includes('@')) {
        const { data } = await admin.from('useraccount').select('email').eq('username', identifier).maybeSingle();
        if (!data?.email) {
          return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
        email = data.email;
      }

      const anon = getSupabaseAnon();
      const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({ email, password });
      if (signInError || !signInData?.user) {
        return res.status(401).json({ success: false, message: 'Invalid credentials' });
      }

      const authUserId = signInData.user.id;
      const { data: byAuth } = await admin
        .from('useraccount')
        .select('id, username, fullname, email, role, exam_enabled, exam_code, level, google_id, plan, premium_valid_until, premium_trial_started_at')
        .eq('auth_user_id', authUserId)
        .maybeSingle();

      const profile = byAuth
        ? byAuth
        : (
            await admin
              .from('useraccount')
              .select('id, username, fullname, email, role, exam_enabled, exam_code, level, google_id, plan, premium_valid_until, premium_trial_started_at')
              .eq('email', email)
              .maybeSingle()
          ).data;

      return res.json({
        success: true,
        message: 'Login success',
        user: profile
          ? {
              id: profile.id,
              username: profile.username,
              fullName: profile.fullname,
              email: profile.email,
              role: profile.role,
              examEnabled: profile.exam_enabled,
              examCode: profile.exam_code,
              level: profile.level,
              googleId: profile.google_id,
              plan: profile.plan,
              premiumValidUntil: profile.premium_valid_until,
              premiumTrialStartedAt: profile.premium_trial_started_at,
            }
          : null,
        session: signInData.session,
      });
    } catch (error) {
      const status = (error as { status?: number })?.status || 500;
      return res.status(status).json({ success: false, message: (error as Error).message });
    }
  });

  router.post('/google', async (req: Request, res: Response) => {
    try {
      const idToken = String(req.body?.credential || req.body?.idToken || req.body?.token || '').trim();
      const level = normalizeJlptLevel(req.body?.level) || 'N5';

      if (!idToken) {
        return res.status(400).json({ success: false, message: 'Missing Google credential' });
      }

      const googleProfile = await verifyGoogleIdToken(idToken);
      if (!googleProfile.email || !googleProfile.googleId) {
        return res.status(401).json({ success: false, message: 'Invalid Google credential' });
      }

      const email = googleProfile.email;
      const fullName = googleProfile.fullName || email.split('@')[0];
      const googleId = googleProfile.googleId;
      let authUserId: string | null = null;
      let session: unknown = null;

      if (isSupabaseConfigured()) {
        const anon = getSupabaseAnon();
        const { data: signInData, error: signInError } = await anon.auth.signInWithIdToken({
          provider: 'google',
          token: idToken,
        });
        if (!signInError && signInData?.user?.id) {
          authUserId = signInData.user.id;
          session = signInData.session;
        }
      }

      let user = authUserId
        ? await prisma.userAccount.findUnique({ where: { authUserId } })
        : await prisma.userAccount.findUnique({
            where: { googleId },
          });

      if (!user) {
        let createdGoogleUser = false;
        user =
          (await prisma.userAccount.findUnique({
            where: { googleId },
          })) ||
          (await prisma.userAccount.findUnique({
            where: { email },
          }));

        if (user) {
          user = await prisma.userAccount.update({
            where: { id: user.id },
            data: {
              googleId,
              ...(authUserId && !user.authUserId ? { authUserId } : {}),
              ...(level && !user.level ? { level } : {}),
            },
          });
        } else {
          const username = await createUniqueUsername(email);
          const passwordhash = await bcrypt.hash(Math.random().toString(36), 10);
          user = await prisma.userAccount.create({
            data: {
              username,
              passwordhash,
              fullname: fullName,
              email,
              role: 'USER',
              exam_enabled: false,
              level,
              googleId,
              ...(authUserId ? { authUserId } : {}),
            },
          });
          createdGoogleUser = true;
        }

        if (createdGoogleUser) {
          await notifyTelegram({
            title: 'New user registered',
            lines: [
              `User: ${formatUserLine({
                id: user.id,
                username: user.username,
                fullname: user.fullname,
                email: user.email,
              })}`,
              `Level: ${user.level || '-'}`,
              'Method: google',
            ],
          });
        }
      } else {
        if (!user.level || (authUserId && !user.authUserId) || !user.googleId) {
          user = await prisma.userAccount.update({
            where: { id: user.id },
            data: {
              ...(!user.level ? { level } : {}),
              ...(authUserId && !user.authUserId ? { authUserId } : {}),
              ...(!user.googleId ? { googleId } : {}),
            },
          });
        }
      }

      return res.json({
        success: true,
        message: 'Google login success',
        user: sanitizeUser(user),
        session,
      });
    } catch (error) {
      const status = (error as { status?: number })?.status || 500;
      return res.status(status).json({ success: false, message: (error as Error).message });
    }
  });

  return router;
}

function isSupabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function normalizeJlptLevel(value: unknown): string | null {
  const level = String(value || '').trim().toUpperCase();
  return JLPT_LEVELS.has(level) ? level : null;
}

async function verifyGoogleIdToken(idToken: string): Promise<{ googleId: string; email: string; fullName: string }> {
  const clientId = String(process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || '').trim();
  const ticket = await googleOAuthClient.verifyIdToken({
    idToken,
    ...(clientId ? { audience: clientId } : {}),
  });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email || payload.email_verified === false) {
    const error = new Error('Invalid Google credential') as Error & { status?: number };
    error.status = 401;
    throw error;
  }
  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    fullName: payload.name || payload.email.split('@')[0],
  };
}

async function createUniqueUsername(email: string): Promise<string> {
  const normalized = email
    .split('@')[0]
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
  const baseUsername = normalized || 'google_user';
  let username = baseUsername;
  let attempt = 0;
  while (true) {
    const existing = await prisma.userAccount.findUnique({
      where: { username },
    });
    if (!existing) return username;
    attempt += 1;
    username = `${baseUsername.slice(0, 25)}_${attempt}`;
  }
}

function sanitizeUser(user: {
  id: bigint;
  username: string;
  fullname: string;
  email: string;
  role: string;
  exam_enabled: boolean;
  exam_code: string | null;
  level: string | null;
  googleId: string | null;
  plan?: string | null;
  premiumValidUntil?: Date | string | null;
  premiumTrialStartedAt?: Date | string | null;
}) {
  return {
    id: Number(user.id),
    username: user.username,
    fullName: user.fullname,
    email: user.email,
    role: user.role,
    examEnabled: user.exam_enabled,
    examCode: user.exam_code,
    level: user.level,
    googleId: user.googleId,
    plan: user.plan || 'FREE',
    premiumValidUntil: user.premiumValidUntil || null,
    premiumTrialStartedAt: user.premiumTrialStartedAt || null,
  };
}
