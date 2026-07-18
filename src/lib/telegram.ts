type TelegramNotification = {
  title: string;
  lines?: Array<string | null | undefined | false>;
};

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const MAX_MESSAGE_LENGTH = 3900;
const SEND_TIMEOUT_MS = 4000;

function configuredTelegram() {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
  if (!token || !chatId) return null;
  return { token, chatId };
}

function truncate(value: unknown, maxLength: number): string {
  const text = String(value ?? '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

export function formatUserLine(user: {
  id?: number | bigint | string | null;
  username?: string | null;
  fullName?: string | null;
  fullname?: string | null;
  email?: string | null;
}) {
  const parts = [
    user.id ? `#${String(user.id)}` : null,
    user.username ? `@${user.username}` : null,
    user.fullName || user.fullname || null,
    user.email || null,
  ].filter(Boolean);
  return parts.length ? parts.join(' | ') : 'unknown user';
}

export async function notifyTelegram(notification: TelegramNotification): Promise<void> {
  const config = configuredTelegram();
  if (!config) return;

  const body = [
    notification.title,
    ...(notification.lines || []).filter(Boolean).map((line) => String(line)),
  ].join('\n');
  const text = truncate(body, MAX_MESSAGE_LENGTH);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

  try {
    const response = await fetch(`${TELEGRAM_API_BASE}/bot${config.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!response.ok) {
      console.warn(`Telegram notification failed with status ${response.status}`);
    }
  } catch (error) {
    console.warn(`Telegram notification failed: ${(error as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }
}

export function notificationText(value: unknown, maxLength = 600): string {
  return truncate(value, maxLength);
}
