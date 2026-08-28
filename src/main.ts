import app from './app';
import { runDailyReminderSweep } from './lib/dailyReminder';

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('uncaughtException:', error);
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`vocab-backend listening on ${port}`);
});

// No real cron/queue infra in this project yet -- a plain interval tick is the
// lightest way to get a once-a-day nudge. Idempotency lives in runDailyReminderSweep
// itself (unique user_id+reminder_date constraint), so frequent/overlapping ticks
// across dev-server restarts or multiple processes are harmless.
const REMINDER_HOUR = 19;
const REMINDER_CHECK_INTERVAL_MS = 15 * 60 * 1000;

function maybeRunDailyReminderSweep() {
  if (new Date().getHours() < REMINDER_HOUR) return;
  runDailyReminderSweep()
    .then(({ sent }) => {
      if (sent > 0) console.log(`Daily reminder sweep sent ${sent} reminder(s)`);
    })
    .catch((error) => console.error('Daily reminder sweep failed:', error));
}

setInterval(maybeRunDailyReminderSweep, REMINDER_CHECK_INTERVAL_MS);
maybeRunDailyReminderSweep();
