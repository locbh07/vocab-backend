import { Router, Request, Response } from 'express';
import { getSupabaseAdmin, getSupabaseAnon } from '../lib/supabase';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';

export function createAuthRouter() {
  const router = Router();

  router.post('/register', async (req: Request, res: Response) => {
    try {
      const username = String(req.body?.username || '').trim();
      const password = String(req.body?.password || '').trim();
      const fullName = String(req.body?.fullName || req.body?.fullname || '').trim();
      const email = String(req.body?.email || '').trim();

      if (!username || !password || !fullName || !email) {
        return res.status(400).json({ success: false, message: 'Missing fields' });
      }

      if (!isSupabaseConfigured()) {
        const existing = await prisma.userAccount.findFirst({
          where: {
            OR: [{ username }, { email }],
          },
        });
        if (existing) {
          return res.status(409).json({ success: false, message: 'Username or email already exists' });
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
          },
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
        return res.status(409).json({ success: false, message: 'Username or email already exists' });
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
        })
        .select('id, username, fullname, email, role, exam_enabled, exam_code')
        .maybeSingle();

      if (insertError) {
        await admin.auth.admin.deleteUser(authUserId).catch(() => {});
        return res.status(500).json({ success: false, message: 'Create profile failed' });
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
        .select('id, username, fullname, email, role, exam_enabled, exam_code')
        .eq('auth_user_id', authUserId)
        .maybeSingle();

      const profile = byAuth
        ? byAuth
        : (
            await admin
              .from('useraccount')
              .select('id, username, fullname, email, role, exam_enabled, exam_code')
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
            }
          : null,
        session: signInData.session,
      });
    } catch (error) {
      return res.status(500).json({ success: false, message: (error as Error).message });
    }
  });

  return router;
}

function isSupabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function sanitizeUser(user: {
  id: bigint;
  username: string;
  fullname: string;
  email: string;
  role: string;
  exam_enabled: boolean;
  exam_code: string | null;
}) {
  return {
    id: Number(user.id),
    username: user.username,
    fullName: user.fullname,
    email: user.email,
    role: user.role,
    examEnabled: user.exam_enabled,
    examCode: user.exam_code,
  };
}
