require('dotenv').config();

const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const chatId = String(process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();

if (!token || !chatId) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID.');
  process.exit(1);
}

async function main() {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `Telegram notification test\nTime: ${new Date().toISOString()}`,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`Telegram send failed with status ${response.status}: ${body}`);
    process.exit(1);
  }

  console.log('Telegram test notification sent.');
}

main().catch((error) => {
  console.error(`Telegram test failed: ${error.message}`);
  process.exit(1);
});
