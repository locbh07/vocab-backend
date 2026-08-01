import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { ensureMailboxTable } from './mailboxStore';
import { notifyTelegram } from './telegram';

type AdminNotification = {
  title: string;
  lines?: Array<string | null | undefined | false>;
  link?: string;
};

const WELCOME_TITLE = 'Chào mừng bạn đến với Tiếng Nhật 大好き! 🎌';
const WELCOME_BODY =
  'Cảm ơn bạn đã tạo tài khoản! Hãy bắt đầu học từ vựng, luyện nghe và làm đề thi thử ngay hôm nay. ' +
  'Nếu cần hỗ trợ hoặc có góp ý, hãy gửi cho chúng tôi qua mục Thông báo & liên hệ nhé.';

// Mirrors an admin-facing event to both channels: the existing Telegram integration, and the
// in-app notification bell (user_mailbox) for every admin account, so admins don't have to rely
// on Telegram alone to see events like new registrations.
export async function notifyAdmins(notification: AdminNotification): Promise<void> {
  const body = (notification.lines || []).filter(Boolean).map((line) => String(line)).join('\n');

  await Promise.all([
    notifyTelegram(notification),
    notifyAdminMailboxes(notification.title, body || notification.title, notification.link || null),
  ]);
}

async function notifyAdminMailboxes(title: string, body: string, link: string | null = null): Promise<void> {
  try {
    const admins = await prisma.userAccount.findMany({
      where: { role: { contains: 'ADMIN', mode: 'insensitive' } },
      select: { id: true },
    });
    if (!admins.length) return;

    await ensureMailboxTable();
    await Promise.all(
      admins.map((admin) =>
        prisma.$executeRaw(Prisma.sql`
          INSERT INTO user_mailbox (user_id, title, body, link)
          VALUES (${admin.id}, ${title}, ${body}, ${link})
        `),
      ),
    );
  } catch (error) {
    console.warn(`Admin mailbox notification failed: ${(error as Error).message}`);
  }
}

export async function sendWelcomeMailbox(userId: number | bigint): Promise<void> {
  try {
    await ensureMailboxTable();
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO user_mailbox (user_id, title, body)
      VALUES (${BigInt(userId)}, ${WELCOME_TITLE}, ${WELCOME_BODY})
    `);
  } catch (error) {
    console.warn(`Welcome mailbox notification failed: ${(error as Error).message}`);
  }
}
