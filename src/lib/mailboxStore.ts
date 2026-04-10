import { prisma } from './prisma';

let ensureMailboxTablePromise: Promise<void> | null = null;

export async function ensureMailboxTable(): Promise<void> {
  if (!ensureMailboxTablePromise) {
    ensureMailboxTablePromise = (async () => {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS user_mailbox (
          id BIGSERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL REFERENCES useraccount(id) ON DELETE CASCADE,
          feedback_id BIGINT NULL,
          title VARCHAR(200) NOT NULL,
          body TEXT NOT NULL,
          is_read BOOLEAN NOT NULL DEFAULT FALSE,
          read_at TIMESTAMPTZ NULL,
          sent_by_admin_id BIGINT NULL REFERENCES useraccount(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_user_mailbox_user_read_created
          ON user_mailbox(user_id, is_read, created_at DESC);
      `);
      await prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_user_mailbox_feedback
          ON user_mailbox(feedback_id);
      `);
    })().catch((error) => {
      ensureMailboxTablePromise = null;
      throw error;
    });
  }

  await ensureMailboxTablePromise;
}
