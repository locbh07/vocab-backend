import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireUser } from '../middleware/userGuard';

type PrismaExecutor = typeof prisma | Prisma.TransactionClient;

function getStripe(): Stripe {
  const secretKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!secretKey) {
    const error = new Error('STRIPE_SECRET_KEY is not configured') as Error & { status?: number };
    error.status = 500;
    throw error;
  }
  return new Stripe(secretKey);
}

function getPriceId(input: unknown): { priceId: string; billingPeriod: string } {
  const requested = String(input || 'monthly').trim().toLowerCase();
  const monthly = String(process.env.STRIPE_PREMIUM_MONTHLY_PRICE_ID || '').trim();
  const yearly = String(process.env.STRIPE_PREMIUM_YEARLY_PRICE_ID || '').trim();
  if (requested === 'yearly' || requested === 'annual') {
    if (!yearly) throwConfiguredPriceError('STRIPE_PREMIUM_YEARLY_PRICE_ID');
    return { priceId: yearly, billingPeriod: 'yearly' };
  }
  if (!monthly) throwConfiguredPriceError('STRIPE_PREMIUM_MONTHLY_PRICE_ID');
  return { priceId: monthly, billingPeriod: 'monthly' };
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

async function upgradeUserFromCheckoutSession(db: PrismaExecutor, stripe: Stripe, session: Stripe.Checkout.Session) {
  const stripeCustomerId = getCustomerId(session.customer);
  const userId = getUserIdFromMetadata(session.client_reference_id || session.metadata?.userId);
  const billingPeriod = String(session.metadata?.billingPeriod || 'monthly');
  const premiumUntil = await subscriptionPeriodEnd(stripe, session.subscription)
    || fallbackPremiumUntil(null, billingPeriod);

  const existing = stripeCustomerId
    ? await db.userAccount.findUnique({ where: { stripeCustomerId } })
    : null;
  const target = existing || (userId ? await db.userAccount.findUnique({ where: { id: BigInt(userId) } }) : null);
  if (!target) return;

  await db.userAccount.update({
    where: { id: target.id },
    data: {
      plan: 'PREMIUM',
      premiumValidUntil: premiumUntil,
      ...(stripeCustomerId ? { stripeCustomerId } : {}),
    },
  });
}

async function downgradeCustomer(db: PrismaExecutor, customer: unknown) {
  const stripeCustomerId = getCustomerId(customer);
  if (!stripeCustomerId) return;
  await db.userAccount.updateMany({
    where: { stripeCustomerId },
    data: {
      plan: 'FREE',
      premiumValidUntil: null,
    },
  });
}

async function processStripeEvent(db: PrismaExecutor, stripe: Stripe, event: Stripe.Event) {
  switch (event.type) {
    case 'checkout.session.completed':
      await upgradeUserFromCheckoutSession(db, stripe, event.data.object as Stripe.Checkout.Session);
      return;
    case 'customer.subscription.deleted':
      await downgradeCustomer(db, (event.data.object as Stripe.Subscription).customer);
      return;
    case 'invoice.payment_failed':
      await downgradeCustomer(db, (event.data.object as Stripe.Invoice).customer);
      return;
    default:
      return;
  }
}

export function createBillingRouter() {
  const router = Router();

  router.post('/checkout-session', async (req: Request, res: Response) => {
    const user = await requireUser(req);
    const stripe = getStripe();
    const { priceId, billingPeriod } = getPriceId(req.body?.billingPeriod || req.body?.plan);
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
      mode: 'subscription',
      customer: stripeCustomerId,
      client_reference_id: String(user.id),
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        userId: String(user.id),
        billingPeriod,
      },
      subscription_data: {
        metadata: {
          userId: String(user.id),
          billingPeriod,
        },
      },
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

    try {
      await prisma.$transaction(async (tx) => {
        await processStripeEvent(tx, stripe, event);
        await tx.stripeWebhookEvent.create({
          data: {
            eventId: event.id,
            eventType: event.type,
          },
        });
      });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') {
        return res.json({ received: true, duplicate: true });
      }
      throw error;
    }

    return res.json({ received: true });
  });

  return router;
}
