import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireUser } from '../middleware/userGuard';
import { formatUserLine, notifyTelegram } from '../lib/telegram';

type PrismaExecutor = typeof prisma | Prisma.TransactionClient;
type StripeCheckoutNotification = {
  user: {
    id: bigint;
    username: string;
    fullname: string;
    email: string;
  };
  billingPeriod: string;
  premiumUntil: Date;
  stripeCustomerId: string;
  subscriptionId: string | null;
};

const TRIAL_DAYS = Math.max(1, Number(process.env.PREMIUM_TRIAL_DAYS || 30));
let ensurePremiumTrialColumnsPromise: Promise<void> | null = null;

async function ensurePremiumTrialColumns() {
  if (!ensurePremiumTrialColumnsPromise) {
    ensurePremiumTrialColumnsPromise = prisma.$executeRawUnsafe(`
      ALTER TABLE useraccount
      ADD COLUMN IF NOT EXISTS premium_trial_started_at TIMESTAMPTZ NULL,
      ADD COLUMN IF NOT EXISTS premium_source VARCHAR(20) NULL,
      ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255) NULL;
    `).then(() => undefined);
  }
  return ensurePremiumTrialColumnsPromise;
}

function getStripe(): Stripe {
  const secretKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!secretKey) {
    const error = new Error('STRIPE_SECRET_KEY is not configured') as Error & { status?: number };
    error.status = 500;
    throw error;
  }
  return new Stripe(secretKey);
}

// STRIPE_PREMIUM_{MONTHLY,YEARLY,LIFETIME}_PRICE_ID must point at Stripe Dashboard prices set
// to 99.000₫/365.000₫/1.699.000₫ (or the FX equivalent) to stay in sync with the manual-payment
// amounts in manualPayments.ts (MSB_DEFAULT_AMOUNTS) — Stripe does not read those from here.
function getPriceId(input: unknown): { priceId: string; billingPeriod: string; mode: Stripe.Checkout.SessionCreateParams.Mode } {
  const requested = String(input || 'monthly').trim().toLowerCase();
  const monthly = String(process.env.STRIPE_PREMIUM_MONTHLY_PRICE_ID || '').trim();
  const yearly = String(process.env.STRIPE_PREMIUM_YEARLY_PRICE_ID || '').trim();
  const lifetime = String(process.env.STRIPE_PREMIUM_LIFETIME_PRICE_ID || '').trim();
  if (requested === 'lifetime') {
    if (!lifetime) throwConfiguredPriceError('STRIPE_PREMIUM_LIFETIME_PRICE_ID');
    return { priceId: lifetime, billingPeriod: 'lifetime', mode: 'payment' };
  }
  if (requested === 'yearly' || requested === 'annual') {
    if (!yearly) throwConfiguredPriceError('STRIPE_PREMIUM_YEARLY_PRICE_ID');
    return { priceId: yearly, billingPeriod: 'yearly', mode: 'subscription' };
  }
  if (!monthly) throwConfiguredPriceError('STRIPE_PREMIUM_MONTHLY_PRICE_ID');
  return { priceId: monthly, billingPeriod: 'monthly', mode: 'subscription' };
}

function throwConfiguredPriceError(name: string): never {
  const error = new Error(`${name} is not configured`) as Error & { status?: number };
  error.status = 500;
  throw error;
}

function getCheckoutUrl(envName: string, fallback: string): string {
  return String(process.env[envName] || process.env.FRONTEND_URL || fallback).trim();
}

function getCustomerId(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getUserIdFromMetadata(value: unknown): number | null {
  const userId = Number(value);
  return Number.isSafeInteger(userId) && userId > 0 ? userId : null;
}

function fallbackPremiumUntil(existing: Date | null | undefined, billingPeriod: string): Date {
  if (billingPeriod === 'lifetime') return new Date('9999-12-31T23:59:59.000Z');
  const baseTime = existing && existing.getTime() > Date.now() ? existing.getTime() : Date.now();
  const days = billingPeriod === 'yearly' ? 365 : 30;
  return new Date(baseTime + days * 24 * 60 * 60 * 1000);
}

async function subscriptionPeriodEnd(stripe: Stripe, subscriptionId: unknown): Promise<Date | null> {
  if (typeof subscriptionId !== 'string' || !subscriptionId) return null;
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const periodEnd = Number((subscription as any).current_period_end || 0);
  return periodEnd > 0 ? new Date(periodEnd * 1000) : null;
}

function getSubscriptionId(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id;
  }
  return null;
}

async function upgradeUserFromCheckoutSession(
  db: PrismaExecutor,
  stripe: Stripe,
  session: Stripe.Checkout.Session,
): Promise<StripeCheckoutNotification | null> {
  const stripeCustomerId = getCustomerId(session.customer);
  const userId = getUserIdFromMetadata(session.client_reference_id || session.metadata?.userId);
  const billingPeriod = String(session.metadata?.billingPeriod || 'monthly');
  const isLifetime = billingPeriod === 'lifetime';
  const subscriptionId = getSubscriptionId(session.subscription);
  const premiumUntil = (await subscriptionPeriodEnd(stripe, session.subscription))
    || fallbackPremiumUntil(null, billingPeriod);

  const existing = stripeCustomerId
    ? await db.userAccount.findUnique({ where: { stripeCustomerId } })
    : null;
  const target = existing || (userId ? await db.userAccount.findUnique({ where: { id: BigInt(userId) } }) : null);
  if (!target) return null;

  await db.userAccount.update({
    where: { id: target.id },
    data: {
      plan: 'PREMIUM',
      premiumValidUntil: premiumUntil,
      // Lifetime checkouts use mode:'payment' (no subscription); tagging the source lets the
      // subscription.deleted/invoice.payment_failed webhooks below avoid wiping it out when an
      // unrelated older subscription on the same Stripe customer later lapses.
      premiumSource: isLifetime ? 'lifetime' : 'stripe',
      stripeSubscriptionId: isLifetime ? null : subscriptionId,
      ...(stripeCustomerId ? { stripeCustomerId } : {}),
    },
  });

  return {
    user: {
      id: target.id,
      username: target.username,
      fullname: target.fullname,
      email: target.email,
    },
    billingPeriod,
    premiumUntil,
    stripeCustomerId,
    subscriptionId,
  };
}

async function downgradeCustomer(db: PrismaExecutor, customer: unknown, subscriptionId: string | null) {
  const stripeCustomerId = getCustomerId(customer);
  if (!stripeCustomerId) return;
  // Only claw back premium that this Stripe subscription actually granted. A user who is on
  // lifetime/manual/trial premium, or whose current subscription differs from the one that just
  // failed/cancelled (e.g. they already upgraded), must not be downgraded.
  await db.userAccount.updateMany({
    where: {
      stripeCustomerId,
      premiumSource: 'stripe',
      ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
    },
    data: {
      plan: 'FREE',
      premiumValidUntil: null,
      premiumSource: null,
      stripeSubscriptionId: null,
    },
  });
}

async function processStripeEvent(db: PrismaExecutor, stripe: Stripe, event: Stripe.Event) {
  switch (event.type) {
    case 'checkout.session.completed':
      return upgradeUserFromCheckoutSession(db, stripe, event.data.object as Stripe.Checkout.Session);
    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;
      await downgradeCustomer(db, subscription.customer, subscription.id);
      return null;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const subscriptionId = getSubscriptionId(invoice.parent?.subscription_details?.subscription);
      await downgradeCustomer(db, invoice.customer, subscriptionId);
      return null;
    }
    default:
      return null;
  }
}

export function createBillingRouter() {
  const router = Router();

  router.post('/trial/activate', async (req: Request, res: Response) => {
    await ensurePremiumTrialColumns();
    const user = await requireUser(req);
    const now = new Date();
    const premiumUntil = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const rows = await prisma.$queryRaw<Array<{
      id: bigint;
      plan: string;
      premium_valid_until: Date | null;
      premium_trial_started_at: Date | null;
    }>>(Prisma.sql`
      UPDATE useraccount
      SET plan = 'PREMIUM',
          premium_valid_until = ${premiumUntil},
          premium_trial_started_at = ${now},
          premium_source = 'trial'
      WHERE id = ${BigInt(user.id)}
        AND premium_trial_started_at IS NULL
        AND (
          plan <> 'PREMIUM'
          OR premium_valid_until IS NULL
          OR premium_valid_until <= ${now}
        )
      RETURNING id, plan, premium_valid_until, premium_trial_started_at
    `);

    if (!rows.length) {
      return res.status(400).json({ message: 'Trial already activated or premium is already active for this account' });
    }

    const activated = rows[0];
    await notifyTelegram({
      title: 'Premium trial activated',
      lines: [
        `User: ${formatUserLine(user)}`,
        `Trial days: ${TRIAL_DAYS}`,
        `Premium until: ${activated.premium_valid_until?.toISOString() || '-'}`,
      ],
    });

    return res.json({
      plan: activated.plan,
      premiumValidUntil: activated.premium_valid_until,
      trialStartedAt: activated.premium_trial_started_at,
      trialDays: TRIAL_DAYS,
    });
  });

  router.post('/checkout-session', async (req: Request, res: Response) => {
    const user = await requireUser(req);
    const stripe = getStripe();
    const { priceId, billingPeriod, mode } = getPriceId(req.body?.billingPeriod || req.body?.plan);
    const successUrl = getCheckoutUrl(
      'STRIPE_CHECKOUT_SUCCESS_URL',
      'http://localhost:5173/account?checkout=success',
    );
    const cancelUrl = getCheckoutUrl(
      'STRIPE_CHECKOUT_CANCEL_URL',
      'http://localhost:5173/account?checkout=cancel',
    );

    const account = await prisma.userAccount.findUnique({ where: { id: BigInt(user.id) } });
    if (!account) return res.status(404).json({ message: 'User not found' });

    let stripeCustomerId = account.stripeCustomerId || '';
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: account.email,
        name: account.fullname,
        metadata: { userId: String(user.id) },
      });
      stripeCustomerId = customer.id;
      await prisma.userAccount.update({
        where: { id: account.id },
        data: { stripeCustomerId },
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode,
      customer: stripeCustomerId,
      client_reference_id: String(user.id),
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        userId: String(user.id),
        billingPeriod,
      },
      ...(mode === 'subscription'
        ? {
            subscription_data: {
              metadata: {
                userId: String(user.id),
                billingPeriod,
              },
            },
          }
        : {}),
    });

    return res.json({ sessionId: session.id, url: session.url });
  });

  return router;
}

export function createStripeWebhookRouter() {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const stripe = getStripe();
    const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
    if (!webhookSecret) return res.status(500).json({ message: 'STRIPE_WEBHOOK_SECRET is not configured' });

    const signature = req.header('stripe-signature');
    if (!signature) return res.status(400).json({ message: 'Missing Stripe signature' });

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
    } catch (error) {
      return res.status(400).json({ message: `Invalid Stripe webhook: ${(error as Error).message}` });
    }

    const existing = await prisma.stripeWebhookEvent.findUnique({ where: { eventId: event.id } });
    if (existing) return res.json({ received: true, duplicate: true });

    let notification: StripeCheckoutNotification | null = null;
    try {
      notification = await prisma.$transaction(async (tx) => {
        const eventNotification = await processStripeEvent(tx, stripe, event);
        await tx.stripeWebhookEvent.create({
          data: {
            eventId: event.id,
            eventType: event.type,
          },
        });
        return eventNotification;
      });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') {
        return res.json({ received: true, duplicate: true });
      }
      throw error;
    }

    if (notification) {
      await notifyTelegram({
        title: 'Premium purchase completed',
        lines: [
          `User: ${formatUserLine(notification.user)}`,
          `Plan: ${notification.billingPeriod}`,
          `Premium until: ${notification.premiumUntil.toISOString()}`,
          `Stripe customer: ${notification.stripeCustomerId || '-'}`,
          `Subscription: ${notification.subscriptionId || '-'}`,
        ],
      });
    }

    return res.json({ received: true });
  });

  return router;
}
