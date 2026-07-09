import { Router, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAdmin } from '../middleware/adminGuard';
import { requireUser } from '../middleware/userGuard';

type ManualPaymentProvider = 'MSB' | 'PAYPAY';
type ManualPaymentPlan = 'monthly' | 'six_months' | 'yearly';
type ManualPaymentStatus = 'PENDING' | 'PAID_REPORTED' | 'APPROVED' | 'REJECTED';

const PROVIDERS = new Set<ManualPaymentProvider>(['MSB', 'PAYPAY']);
const PLANS = new Set<ManualPaymentPlan>(['monthly', 'six_months', 'yearly']);

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
          currency VARCHAR(8),
          note TEXT,
          updated_by BIGINT REFERENCES useraccount(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
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

function planAmountKey(plan: ManualPaymentPlan): 'monthly_amount' | 'six_months_amount' | 'yearly_amount' {
  if (plan === 'yearly') return 'yearly_amount';
  if (plan === 'six_months') return 'six_months_amount';
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
  const amountEnv =
    plan === 'yearly'
      ? 'YEARLY'
      : plan === 'six_months'
        ? 'SIX_MONTHS'
        : 'MONTHLY';
  const settingAmount = Number(setting?.[planAmountKey(plan)] || 0);
  if (provider === 'PAYPAY') {
    return {
      amount: Number.isFinite(settingAmount) && settingAmount > 0
        ? Math.round(settingAmount)
        : envNumber(`MANUAL_PAYMENT_PAYPAY_${amountEnv}_AMOUNT`, plan === 'yearly' ? 5999 : plan === 'six_months' ? 2999 : 599),
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
      : envNumber(`MANUAL_PAYMENT_MSB_${amountEnv}_AMOUNT`, plan === 'yearly' ? 999000 : plan === 'six_months' ? 499000 : 99000),
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
  if (plan === 'six_months') return envNumber('PREMIUM_SIX_MONTHS_DAYS', 180);
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

function buildGenericQrImageUrl(value: string) {
  if (!value) return '';
  const params = new URLSearchParams({
    size: '320x320',
    margin: '12',
    data: value,
  });
  return `https://api.qrserver.com/v1/create-qr-code/?${params.toString()}`;
}

function buildPayPayAppUrl() {
  return 'https://paypay.ne.jp/rd/web/app-top/';
}

function buildPremiumUntil(existing: Date | null, plan: ManualPaymentPlan) {
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

function mapSettingRow(row: any, provider: ManualPaymentProvider) {
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
    monthlyAmount: Number(row?.monthly_amount || envNumber(`MANUAL_PAYMENT_${provider}_MONTHLY_AMOUNT`, provider === 'MSB' ? 99000 : 599)),
    sixMonthsAmount: Number(row?.six_months_amount || envNumber(`MANUAL_PAYMENT_${provider}_SIX_MONTHS_AMOUNT`, provider === 'MSB' ? 499000 : 2999)),
    yearlyAmount: Number(row?.yearly_amount || envNumber(`MANUAL_PAYMENT_${provider}_YEARLY_AMOUNT`, provider === 'MSB' ? 999000 : 5999)),
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
  const sixMonthsAmount = cleanSettingNumber(body?.sixMonthsAmount);
  const yearlyAmount = cleanSettingNumber(body?.yearlyAmount);
  const currency = cleanSettingText(body?.currency, 8) || (isMsb ? 'VND' : 'JPY');
  const note = cleanSettingText(body?.note, 2000);

  const rows = await prisma.$queryRaw<any[]>(Prisma.sql`
    INSERT INTO manual_payment_setting (
      provider, enabled, bank_id, account_no, account_name, qr_image_url,
      payment_url_template, qr_image_url_template, qr_template,
      monthly_amount, six_months_amount, yearly_amount, currency, note, updated_by,
      created_at, updated_at
    )
    VALUES (
      ${provider}, ${enabled}, ${bankId}, ${accountNo}, ${accountName}, ${qrImageUrl},
      ${paymentUrlTemplate}, ${qrImageUrlTemplate}, ${qrTemplate},
      ${monthlyAmount}, ${sixMonthsAmount}, ${yearlyAmount}, ${currency}, ${note}, ${BigInt(adminId)},
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
      six_months_amount = EXCLUDED.six_months_amount,
      yearly_amount = EXCLUDED.yearly_amount,
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

  router.post('/requests', async (req: Request, res: Response) => {
    await ensureManualPaymentTable();
    const user = await requireUser(req);
    const provider = normalizeProvider(req.body?.provider);
    const billingPeriod = normalizePlan(req.body?.billingPeriod || req.body?.plan);
    const config = await getManualPaymentConfig(provider, billingPeriod);
    if (!config.enabled) {
      return res.status(400).json({ message: 'Phuong thuc thanh toan nay dang tam tat.' });
    }
    const paymentCode = buildPaymentCode(user.id);
    const paymentUrl = provider === 'PAYPAY' ? buildPayPayAppUrl() : '';
    const qrImageUrl = provider === 'MSB'
      ? buildVietQrImageUrl({
        amount: config.amount,
        paymentCode,
        bankId: config.bankId,
        accountNo: config.accountNo,
        accountName: config.accountName,
        template: config.qrTemplate,
      })
      : buildGenericQrImageUrl(paymentUrl);
    if (!qrImageUrl && !paymentUrl) {
      return res.status(400).json({
        message: provider === 'MSB'
          ? 'Admin chua cau hinh so tai khoan MSB de tao QR.'
          : 'Admin chua cau hinh PayPay ID.',
      });
    }
    if (provider === 'PAYPAY' && !config.accountNo) {
      return res.status(400).json({ message: 'Admin chua cau hinh PayPay ID.' });
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
        accountName: config.accountName,
        accountNo: config.accountNo,
      },
      note: provider === 'PAYPAY'
        ? 'QR PayPay chi dung de mo ung dung. Vui long tim PayPay ID, ket ban neu can, roi chuyen dung so tien va ghi ma thanh toan neu PayPay cho nhap ghi chu.'
        : '',
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
    return res.json(settings);
  });

  router.put('/settings', async (req: Request, res: Response) => {
    const admin = await requireAdmin(req);
    const body = req.body || {};
    const [msb, paypay] = await Promise.all([
      saveManualPaymentSetting('MSB', body.MSB || body.msb || {}, admin.id),
      saveManualPaymentSetting('PAYPAY', body.PAYPAY || body.paypay || {}, admin.id),
    ]);
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
      if (payment.status === 'APPROVED') return payment;
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
      return updatedRows[0];
    });

    if (!result) return res.status(404).json({ message: 'Payment request not found' });
    return res.json({ request: mapPaymentRow(result) });
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
