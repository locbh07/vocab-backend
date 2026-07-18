import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAdmin } from '../middleware/adminGuard';
import { requireUser } from '../middleware/userGuard';
import { formatUserLine, notifyTelegram } from '../lib/telegram';

type ManualPaymentProvider = 'MSB' | 'PAYPAY';
type ManualPaymentPlan = 'monthly' | 'yearly' | 'lifetime';
type ManualPaymentStatus = 'PENDING' | 'PAID_REPORTED' | 'APPROVED' | 'REJECTED';

const PROVIDERS = new Set<ManualPaymentProvider>(['MSB', 'PAYPAY']);
const PLANS = new Set<ManualPaymentPlan>(['monthly', 'yearly', 'lifetime']);
const MSB_DEFAULT_AMOUNTS = {
  monthly: 99000,
  yearly: 365000,
  lifetime: 1699000,
};
const LIFETIME_PREMIUM_UNTIL = new Date('9999-12-31T23:59:59.000Z');

let ensureManualPaymentTablePromise: Promise<void> | null = null;

async function ensureManualPaymentTable() {
  if (!ensureManualPaymentTablePromise) {
    ensureManualPaymentTablePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS manual_payment_request (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES useraccount(id) ON DELETE CASCADE,
          payment_code VARCHAR(64) NOT NULL UNIQUE,
          provider VARCHAR(24) NOT NULL,
          billing_period VARCHAR(24) NOT NULL,
          amount INTEGER NOT NULL,
          currency VARCHAR(8) NOT NULL,
          status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
          qr_image_url TEXT,
          payment_url TEXT,
          transfer_content TEXT NOT NULL,
          proof_note TEXT,
          admin_note TEXT,
          reviewed_by BIGINT REFERENCES useraccount(id) ON DELETE SET NULL,
          reviewed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_manual_payment_request_user_status
        ON manual_payment_request (user_id, status, created_at DESC);
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_manual_payment_request_status_created
        ON manual_payment_request (status, created_at DESC);
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS manual_payment_setting (
          provider VARCHAR(24) PRIMARY KEY,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          bank_id VARCHAR(32),
          account_no VARCHAR(128),
          account_name VARCHAR(255),
          qr_image_url TEXT,
          payment_url_template TEXT,
          qr_image_url_template TEXT,
          qr_template VARCHAR(64),
          monthly_amount INTEGER,
          six_months_amount INTEGER,
          yearly_amount INTEGER,
          lifetime_amount INTEGER,
          monthly_original_amount INTEGER,
          six_months_original_amount INTEGER,
          yearly_original_amount INTEGER,
          lifetime_original_amount INTEGER,
          currency VARCHAR(8),
          note TEXT,
          updated_by BIGINT REFERENCES useraccount(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await prisma.$executeRawUnsafe(`
        ALTER TABLE manual_payment_setting
        ADD COLUMN IF NOT EXISTS monthly_original_amount INTEGER,
        ADD COLUMN IF NOT EXISTS six_months_original_amount INTEGER,
        ADD COLUMN IF NOT EXISTS yearly_original_amount INTEGER,
        ADD COLUMN IF NOT EXISTS lifetime_amount INTEGER,
        ADD COLUMN IF NOT EXISTS lifetime_original_amount INTEGER;
      `);
      await prisma.$executeRawUnsafe(`
        ALTER TABLE useraccount
        ADD COLUMN IF NOT EXISTS premium_trial_started_at TIMESTAMPTZ NULL,
        ADD COLUMN IF NOT EXISTS premium_source VARCHAR(20) NULL,
        ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255) NULL;
      `);
    })();
  }
  return ensureManualPaymentTablePromise;
}

function normalizeProvider(input: unknown): ManualPaymentProvider {
  const value = String(input || '').trim().toUpperCase();
  return PROVIDERS.has(value as ManualPaymentProvider) ? (value as ManualPaymentProvider) : 'MSB';
}

function normalizePlan(input: unknown): ManualPaymentPlan {
  const value = String(input || '').trim().toLowerCase();
  // Legacy plan retired in favor of yearly (same duration was never priced consistently with
  // it — see six_months pricing bug). Map old clients straight to yearly instead of rejecting them.
  if (value === 'six_months') return 'yearly';
  return PLANS.has(value as ManualPaymentPlan) ? (value as ManualPaymentPlan) : 'monthly';
}

function normalizeStatus(input: unknown): ManualPaymentStatus | '' {
  const value = String(input || '').trim().toUpperCase();
  return ['PENDING', 'PAID_REPORTED', 'APPROVED', 'REJECTED'].includes(value)
    ? (value as ManualPaymentStatus)
    : '';
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function envText(name: string, fallback = ''): string {
  return String(process.env[name] || fallback).trim();
}

function planAmountKey(plan: ManualPaymentPlan): 'monthly_amount' | 'yearly_amount' | 'lifetime_amount' {
  if (plan === 'yearly') return 'yearly_amount';
  if (plan === 'lifetime') return 'lifetime_amount';
  return 'monthly_amount';
}

async function getManualPaymentSetting(provider: ManualPaymentProvider) {
  await ensureManualPaymentTable();
  const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT *
    FROM manual_payment_setting
    WHERE provider = ${provider}
    LIMIT 1
  `);
  return rows[0] || null;
}

async function getManualPaymentConfig(provider: ManualPaymentProvider, plan: ManualPaymentPlan) {
  const setting = await getManualPaymentSetting(provider);
  const amountEnv = plan === 'lifetime' ? 'LIFETIME' : plan === 'yearly' ? 'YEARLY' : 'MONTHLY';
  const settingAmount = Number(setting?.[planAmountKey(plan)] || 0);
  if (provider === 'PAYPAY') {
    return {
      amount: Number.isFinite(settingAmount) && settingAmount > 0
        ? Math.round(settingAmount)
        : envNumber(`MANUAL_PAYMENT_PAYPAY_${amountEnv}_AMOUNT`, plan === 'lifetime' ? 16999 : plan === 'yearly' ? 3650 : 990),
      currency: String(setting?.currency || 'JPY'),
      accountName: String(setting?.account_name || envText('MANUAL_PAYMENT_PAYPAY_ACCOUNT_NAME')),
      accountNo: String(setting?.account_no || envText('MANUAL_PAYMENT_PAYPAY_ACCOUNT_ID')),
      bankId: '',
      qrImageUrl: '',
      paymentUrlTemplate: '',
      qrImageUrlTemplate: '',
      qrTemplate: '',
      enabled: setting ? Boolean(setting.enabled) : true,
    };
  }

  return {
    amount: Number.isFinite(settingAmount) && settingAmount > 0
      ? Math.round(settingAmount)
      : envNumber(`MANUAL_PAYMENT_MSB_${amountEnv}_AMOUNT`, plan === 'lifetime' ? MSB_DEFAULT_AMOUNTS.lifetime : plan === 'yearly' ? MSB_DEFAULT_AMOUNTS.yearly : MSB_DEFAULT_AMOUNTS.monthly),
    currency: String(setting?.currency || 'VND'),
    accountName: String(setting?.account_name || envText('MANUAL_PAYMENT_MSB_ACCOUNT_NAME')),
    accountNo: String(setting?.account_no || envText('MANUAL_PAYMENT_MSB_ACCOUNT_NO')),
    bankId: String(setting?.bank_id || envText('MANUAL_PAYMENT_MSB_BANK_ID', 'MSB')),
    qrImageUrl: String(setting?.qr_image_url || ''),
    paymentUrlTemplate: '',
    qrImageUrlTemplate: '',
    qrTemplate: String(setting?.qr_template || envText('MANUAL_PAYMENT_MSB_QR_TEMPLATE', 'compact2')),
    enabled: setting ? Boolean(setting.enabled) : true,
  };
}

function premiumDays(plan: ManualPaymentPlan): number {
  if (plan === 'yearly') return envNumber('PREMIUM_YEARLY_DAYS', 365);
  return envNumber('PREMIUM_MONTHLY_DAYS', 30);
}

function buildPaymentCode(userId: number): string {
  const random = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `JPV${userId}${Date.now().toString(36).toUpperCase()}${random}`.slice(0, 48);
}

function buildVietQrImageUrl(args: {
  amount: number;
  paymentCode: string;
  bankId: string;
  accountNo: string;
  accountName: string;
  template: string;
}) {
  const bankId = args.bankId || 'MSB';
  const accountNo = args.accountNo;
  const accountName = args.accountName;
  const template = args.template || 'compact2';
  if (!accountNo) return '';
  const params = new URLSearchParams();
  params.set('amount', String(args.amount));
  params.set('addInfo', args.paymentCode);
  if (accountName) params.set('accountName', accountName);
  return `https://img.vietqr.io/image/${encodeURIComponent(bankId)}-${encodeURIComponent(accountNo)}-${encodeURIComponent(template)}.png?${params.toString()}`;
}

function buildPremiumUntil(existing: Date | null, plan: ManualPaymentPlan) {
  if (plan === 'lifetime') return LIFETIME_PREMIUM_UNTIL;
  const base = existing && existing.getTime() > Date.now() ? existing.getTime() : Date.now();
  return new Date(base + premiumDays(plan) * 24 * 60 * 60 * 1000);
}

function mapPaymentRow(row: any) {
  return {
    id: Number(row.id),
    userId: Number(row.user_id),
    username: row.username || null,
    fullName: row.fullname || null,
    email: row.email || null,
    paymentCode: row.payment_code,
    provider: row.provider,
    billingPeriod: row.billing_period,
    amount: Number(row.amount || 0),
    currency: row.currency,
    status: row.status,
    qrImageUrl: row.qr_image_url,
    paymentUrl: row.payment_url,
    transferContent: row.transfer_content,
    proofNote: row.proof_note,
    adminNote: row.admin_note,
    reviewedBy: row.reviewed_by ? Number(row.reviewed_by) : null,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cleanSettingText(value: unknown, maxLength = 2000): string | null {
  const text = String(value || '').trim();
  return text ? text.slice(0, maxLength) : null;
}

function cleanSettingNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function discountPercent(originalAmount: number | null, currentAmount: number): number | null {
  if (!originalAmount || !currentAmount || originalAmount <= currentAmount) return null;
  return Math.round(((originalAmount - currentAmount) / originalAmount) * 100);
}

function mapSettingRow(row: any, provider: ManualPaymentProvider) {
  const monthlyAmount = Number(row?.monthly_amount || envNumber(`MANUAL_PAYMENT_${provider}_MONTHLY_AMOUNT`, provider === 'MSB' ? MSB_DEFAULT_AMOUNTS.monthly : 599));
  const yearlyAmount = Number(row?.yearly_amount || envNumber(`MANUAL_PAYMENT_${provider}_YEARLY_AMOUNT`, provider === 'MSB' ? MSB_DEFAULT_AMOUNTS.yearly : 5999));
  const lifetimeAmount = Number(row?.lifetime_amount || envNumber(`MANUAL_PAYMENT_${provider}_LIFETIME_AMOUNT`, provider === 'MSB' ? MSB_DEFAULT_AMOUNTS.lifetime : 16999));
  const monthlyOriginalAmount = cleanSettingNumber(row?.monthly_original_amount);
  const yearlyOriginalAmount = cleanSettingNumber(row?.yearly_original_amount);
  const lifetimeOriginalAmount = cleanSettingNumber(row?.lifetime_original_amount);
  return {
    provider,
    enabled: row ? Boolean(row.enabled) : true,
    bankId: row?.bank_id || (provider === 'MSB' ? envText('MANUAL_PAYMENT_MSB_BANK_ID', 'MSB') : ''),
    accountNo: row?.account_no || (provider === 'MSB' ? envText('MANUAL_PAYMENT_MSB_ACCOUNT_NO') : envText('MANUAL_PAYMENT_PAYPAY_ACCOUNT_ID')),
    accountName: row?.account_name || (provider === 'MSB' ? envText('MANUAL_PAYMENT_MSB_ACCOUNT_NAME') : envText('MANUAL_PAYMENT_PAYPAY_ACCOUNT_NAME')),
    qrImageUrl: '',
    paymentUrlTemplate: '',
    qrImageUrlTemplate: '',
    qrTemplate: row?.qr_template || (provider === 'MSB' ? envText('MANUAL_PAYMENT_MSB_QR_TEMPLATE', 'compact2') : ''),
    monthlyAmount,
    yearlyAmount,
    lifetimeAmount,
    monthlyOriginalAmount,
    yearlyOriginalAmount,
    lifetimeOriginalAmount,
    monthlyDiscountPercent: discountPercent(monthlyOriginalAmount, monthlyAmount),
    yearlyDiscountPercent: discountPercent(yearlyOriginalAmount, yearlyAmount),
    lifetimeDiscountPercent: discountPercent(lifetimeOriginalAmount, lifetimeAmount),
    currency: row?.currency || (provider === 'MSB' ? 'VND' : 'JPY'),
    note: row?.note || '',
    updatedAt: row?.updated_at || null,
  };
}

async function getAllManualPaymentSettings() {
  await ensureManualPaymentTable();
  const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT *
    FROM manual_payment_setting
    WHERE provider IN ('MSB', 'PAYPAY')
  `);
  const byProvider = new Map(rows.map((row) => [String(row.provider), row]));
  return {
    MSB: mapSettingRow(byProvider.get('MSB'), 'MSB'),
    PAYPAY: mapSettingRow(byProvider.get('PAYPAY'), 'PAYPAY'),
  };
}

async function saveManualPaymentSetting(provider: ManualPaymentProvider, body: any, adminId: number) {
  await ensureManualPaymentTable();
  const isMsb = provider === 'MSB';
  const enabled = body?.enabled !== false;
  const bankId = isMsb ? cleanSettingText(body?.bankId, 32) || 'MSB' : null;
  const accountNo = cleanSettingText(body?.accountNo, 128);
  const accountName = cleanSettingText(body?.accountName, 255);
  const qrImageUrl = null;
  const paymentUrlTemplate = null;
  const qrImageUrlTemplate = null;
  const qrTemplate = isMsb ? cleanSettingText(body?.qrTemplate, 64) || 'compact2' : null;
  const monthlyAmount = cleanSettingNumber(body?.monthlyAmount);
  const yearlyAmount = cleanSettingNumber(body?.yearlyAmount);
  const lifetimeAmount = cleanSettingNumber(body?.lifetimeAmount);
  const monthlyOriginalAmount = cleanSettingNumber(body?.monthlyOriginalAmount);
  const yearlyOriginalAmount = cleanSettingNumber(body?.yearlyOriginalAmount);
  const lifetimeOriginalAmount = cleanSettingNumber(body?.lifetimeOriginalAmount);
  const currency = cleanSettingText(body?.currency, 8) || (isMsb ? 'VND' : 'JPY');
  const note = cleanSettingText(body?.note, 2000);

  const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
    INSERT INTO manual_payment_setting (
      provider, enabled, bank_id, account_no, account_name, qr_image_url,
      payment_url_template, qr_image_url_template, qr_template,
      monthly_amount, yearly_amount, lifetime_amount,
      monthly_original_amount, yearly_original_amount, lifetime_original_amount,
      currency, note, updated_by,
      created_at, updated_at
    )
    VALUES (
      ${provider}, ${enabled}, ${bankId}, ${accountNo}, ${accountName}, ${qrImageUrl},
      ${paymentUrlTemplate}, ${qrImageUrlTemplate}, ${qrTemplate},
      ${monthlyAmount}, ${yearlyAmount}, ${lifetimeAmount},
      ${monthlyOriginalAmount}, ${yearlyOriginalAmount}, ${lifetimeOriginalAmount},
      ${currency}, ${note}, ${BigInt(adminId)},
      NOW(), NOW()
    )
    ON CONFLICT (provider) DO UPDATE SET
      enabled = EXCLUDED.enabled,
      bank_id = EXCLUDED.bank_id,
      account_no = EXCLUDED.account_no,
      account_name = EXCLUDED.account_name,
      qr_image_url = EXCLUDED.qr_image_url,
      payment_url_template = EXCLUDED.payment_url_template,
      qr_image_url_template = EXCLUDED.qr_image_url_template,
      qr_template = EXCLUDED.qr_template,
      monthly_amount = EXCLUDED.monthly_amount,
      yearly_amount = EXCLUDED.yearly_amount,
      lifetime_amount = EXCLUDED.lifetime_amount,
      monthly_original_amount = EXCLUDED.monthly_original_amount,
      yearly_original_amount = EXCLUDED.yearly_original_amount,
      lifetime_original_amount = EXCLUDED.lifetime_original_amount,
      currency = EXCLUDED.currency,
      note = EXCLUDED.note,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
    RETURNING *
  `);
  return mapSettingRow(rows[0], provider);
}

export function createManualPaymentRouter() {
  const router = Router();

  router.get('/settings', async (_req: Request, res: Response) => {
    const settings = await getAllManualPaymentSettings();
    res.set('Cache-Control', 'no-store');
    return res.json({
      trialDays: envNumber('PREMIUM_TRIAL_DAYS', 30),
      plans: ['trial', 'monthly', 'yearly', 'lifetime'],
      MSB: {
        enabled: settings.MSB.enabled,
        monthlyAmount: settings.MSB.monthlyAmount,
        yearlyAmount: settings.MSB.yearlyAmount,
        lifetimeAmount: settings.MSB.lifetimeAmount,
        monthlyOriginalAmount: settings.MSB.monthlyOriginalAmount,
        yearlyOriginalAmount: settings.MSB.yearlyOriginalAmount,
        lifetimeOriginalAmount: settings.MSB.lifetimeOriginalAmount,
        monthlyDiscountPercent: settings.MSB.monthlyDiscountPercent,
        yearlyDiscountPercent: settings.MSB.yearlyDiscountPercent,
        lifetimeDiscountPercent: settings.MSB.lifetimeDiscountPercent,
        currency: settings.MSB.currency,
      },
      PAYPAY: {
        enabled: settings.PAYPAY.enabled,
        monthlyAmount: settings.PAYPAY.monthlyAmount,
        yearlyAmount: settings.PAYPAY.yearlyAmount,
        lifetimeAmount: settings.PAYPAY.lifetimeAmount,
        monthlyOriginalAmount: settings.PAYPAY.monthlyOriginalAmount,
        yearlyOriginalAmount: settings.PAYPAY.yearlyOriginalAmount,
        lifetimeOriginalAmount: settings.PAYPAY.lifetimeOriginalAmount,
        monthlyDiscountPercent: settings.PAYPAY.monthlyDiscountPercent,
        yearlyDiscountPercent: settings.PAYPAY.yearlyDiscountPercent,
        lifetimeDiscountPercent: settings.PAYPAY.lifetimeDiscountPercent,
        currency: settings.PAYPAY.currency,
      },
    });
  });

  router.post('/requests', async (req: Request, res: Response) => {
    await ensureManualPaymentTable();
    const user = await requireUser(req);
    const provider = normalizeProvider(req.body?.provider);
    const billingPeriod = normalizePlan(req.body?.billingPeriod || req.body?.plan);
    if (provider === 'PAYPAY') {
      return res.status(400).json({
        message: 'PayPay dang xu ly thu cong. Vui long lien he admin de duoc huong dan thanh toan.',
      });
    }
    const config = await getManualPaymentConfig(provider, billingPeriod);
    if (!config.enabled) {
      return res.status(400).json({ message: 'Phuong thuc thanh toan nay dang tam tat.' });
    }
    const paymentCode = buildPaymentCode(user.id);
    const paymentUrl = '';
    const qrImageUrl = buildVietQrImageUrl({
      amount: config.amount,
      paymentCode,
      bankId: config.bankId,
      accountNo: config.accountNo,
      accountName: config.accountName,
      template: config.qrTemplate,
    });
    if (!qrImageUrl && !paymentUrl) {
      return res.status(400).json({
        message: 'Admin chua cau hinh so tai khoan MSB de tao QR.',
      });
    }

    const [row] = await prisma.$queryRaw<any[]>(Prisma.sql`
      INSERT INTO manual_payment_request (
        user_id, payment_code, provider, billing_period, amount, currency,
        status, qr_image_url, payment_url, transfer_content
      )
      VALUES (
        ${BigInt(user.id)}, ${paymentCode}, ${provider}, ${billingPeriod}, ${config.amount}, ${config.currency},
        'PENDING', ${qrImageUrl || null}, ${paymentUrl || null}, ${paymentCode}
      )
      RETURNING *
    `);

    return res.json({
      request: mapPaymentRow(row),
      account: {
        provider,
        accountName: null,
        accountNo: null,
      },
      note: 'Thong tin tai khoan nhan khong hien thi tren web. Vui long kiem tra ten nguoi nhan trong app ngan hang sau khi quet QR.',
    });
  });

  router.get('/requests/mine', async (req: Request, res: Response) => {
    await ensureManualPaymentTable();
    const user = await requireUser(req);
    const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT *
      FROM manual_payment_request
      WHERE user_id = ${BigInt(user.id)}
      ORDER BY created_at DESC
      LIMIT 20
    `);
    return res.json({ items: rows.map(mapPaymentRow) });
  });

  router.post('/requests/:id/mark-paid', async (req: Request, res: Response) => {
    await ensureManualPaymentTable();
    const user = await requireUser(req);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: 'Invalid request id' });
    const proofNote = String(req.body?.proofNote || '').trim().slice(0, 1000) || null;

    const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
      UPDATE manual_payment_request
      SET status = CASE WHEN status = 'PENDING' THEN 'PAID_REPORTED' ELSE status END,
          proof_note = ${proofNote},
          updated_at = NOW()
      WHERE id = ${BigInt(id)}
        AND user_id = ${BigInt(user.id)}
        AND status IN ('PENDING', 'PAID_REPORTED')
      RETURNING *
    `);
    if (!rows.length) return res.status(404).json({ message: 'Payment request not found or cannot be updated' });
    return res.json({ request: mapPaymentRow(rows[0]) });
  });

  return router;
}

export function createAdminManualPaymentRouter() {
  const router = Router();

  router.get('/settings', async (_req: Request, res: Response) => {
    await requireAdmin(_req);
    const settings = await getAllManualPaymentSettings();
    res.set('Cache-Control', 'no-store');
    return res.json({
      trialDays: envNumber('PREMIUM_TRIAL_DAYS', 30),
      plans: ['trial', 'monthly', 'yearly', 'lifetime'],
      ...settings,
    });
  });

  router.put('/settings', async (req: Request, res: Response) => {
    const admin = await requireAdmin(req);
    const body = req.body || {};
    const [msb, paypay] = await Promise.all([
      saveManualPaymentSetting('MSB', body.MSB || body.msb || {}, admin.id),
      saveManualPaymentSetting('PAYPAY', body.PAYPAY || body.paypay || {}, admin.id),
    ]);
    res.set('Cache-Control', 'no-store');
    return res.json({ MSB: msb, PAYPAY: paypay });
  });

  router.get('/', async (req: Request, res: Response) => {
    await ensureManualPaymentTable();
    await requireAdmin(req);
    const status = normalizeStatus(req.query.status);
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 300);
    const predicates: Prisma.Sql[] = [];
    if (status) predicates.push(Prisma.sql`mpr.status = ${status}`);
    const whereSql = predicates.length ? Prisma.sql`WHERE ${Prisma.join(predicates, ' AND ')}` : Prisma.sql``;

    const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT
        mpr.*,
        u.username,
        u.fullname,
        u.email
      FROM manual_payment_request mpr
      LEFT JOIN useraccount u ON u.id = mpr.user_id
      ${whereSql}
      ORDER BY mpr.created_at DESC
      LIMIT ${limit}
    `);
    return res.json({ items: rows.map(mapPaymentRow) });
  });

  router.post('/:id/approve', async (req: Request, res: Response) => {
    await ensureManualPaymentTable();
    const admin = await requireAdmin(req);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: 'Invalid request id' });
    const adminNote = String(req.body?.adminNote || '').trim().slice(0, 1000) || null;

    const result = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<any[]>(Prisma.sql`
        SELECT *
        FROM manual_payment_request
        WHERE id = ${BigInt(id)}
        FOR UPDATE
      `);
      const payment = rows[0];
      if (!payment) return null;
      if (payment.status === 'APPROVED') return { payment, user: null, premiumUntil: null, newlyApproved: false };
      if (payment.status === 'REJECTED') {
        const error = new Error('Cannot approve a rejected payment') as Error & { status?: number };
        error.status = 400;
        throw error;
      }

      const user = await tx.userAccount.findUnique({ where: { id: payment.user_id } });
      if (!user) {
        const error = new Error('User not found') as Error & { status?: number };
        error.status = 404;
        throw error;
      }
      const premiumUntil = buildPremiumUntil(user.premiumValidUntil, normalizePlan(payment.billing_period));
      await tx.userAccount.update({
        where: { id: user.id },
        data: {
          plan: 'PREMIUM',
          premiumValidUntil: premiumUntil,
          premiumSource: 'manual',
        },
      });
      const updatedRows = await tx.$queryRaw<any[]>(Prisma.sql`
        UPDATE manual_payment_request
        SET status = 'APPROVED',
            admin_note = ${adminNote},
            reviewed_by = ${BigInt(admin.id)},
            reviewed_at = NOW(),
            updated_at = NOW()
        WHERE id = ${BigInt(id)}
        RETURNING *
      `);
      return { payment: updatedRows[0], user, premiumUntil, newlyApproved: true };
    });

    if (!result) return res.status(404).json({ message: 'Payment request not found' });
    if (result.newlyApproved && result.user && result.premiumUntil) {
      await notifyTelegram({
        title: 'Manual payment approved',
        lines: [
          `User: ${formatUserLine({
            id: result.user.id,
            username: result.user.username,
            fullname: result.user.fullname,
            email: result.user.email,
          })}`,
          `Plan: ${result.payment.billing_period}`,
          `Amount: ${result.payment.amount} ${result.payment.currency}`,
          `Provider: ${result.payment.provider}`,
          `Payment code: ${result.payment.payment_code}`,
          `Premium until: ${result.premiumUntil.toISOString()}`,
        ],
      });
    }
    return res.json({ request: mapPaymentRow(result.payment) });
  });

  router.post('/:id/reject', async (req: Request, res: Response) => {
    await ensureManualPaymentTable();
    const admin = await requireAdmin(req);
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ message: 'Invalid request id' });
    const adminNote = String(req.body?.adminNote || '').trim().slice(0, 1000) || null;
    const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
      UPDATE manual_payment_request
      SET status = 'REJECTED',
          admin_note = ${adminNote},
          reviewed_by = ${BigInt(admin.id)},
          reviewed_at = NOW(),
          updated_at = NOW()
      WHERE id = ${BigInt(id)}
        AND status <> 'APPROVED'
      RETURNING *
    `);
    if (!rows.length) return res.status(404).json({ message: 'Payment request not found or already approved' });
    return res.json({ request: mapPaymentRow(rows[0]) });
  });

  return router;
}
