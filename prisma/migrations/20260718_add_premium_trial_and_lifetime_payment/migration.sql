ALTER TABLE useraccount
  ADD COLUMN IF NOT EXISTS premium_trial_started_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS premium_source VARCHAR(20) NULL,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255) NULL;

DO $$
BEGIN
  IF to_regclass('public.manual_payment_setting') IS NOT NULL THEN
    ALTER TABLE manual_payment_setting
      ADD COLUMN IF NOT EXISTS lifetime_amount INTEGER,
      ADD COLUMN IF NOT EXISTS lifetime_original_amount INTEGER;
  END IF;
END $$;
