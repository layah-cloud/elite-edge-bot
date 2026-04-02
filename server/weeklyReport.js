const cron = require('node-cron');
const { pool } = require('./db');

// Layah and Gideon's Telegram IDs
const REPORT_RECIPIENTS = ['793173917', '1220776946'];

function startWeeklyReport(bot) {
  if (!bot) {
    console.log('[WEEKLY REPORT] No bot instance, skipping scheduler');
    return;
  }

  // Every Monday at 6:00 AM EST (11:00 UTC)
  // Note: Railway servers run in UTC, so 6am EST = 11am UTC
  cron.schedule('0 11 * * 1', async () => {
    console.log('[WEEKLY REPORT] Running weekly revenue report...');
    try {
      const report = await generateReport();
      for (const chatId of REPORT_RECIPIENTS) {
        try {
          await bot.sendMessage(chatId, report, { parse_mode: 'HTML' });
          console.log(`[WEEKLY REPORT] Sent to ${chatId}`);
        } catch (e) {
          console.error(`[WEEKLY REPORT] Failed to send to ${chatId}:`, e.message);
        }
      }
    } catch (e) {
      console.error('[WEEKLY REPORT] Failed to generate report:', e.message);
    }
  }, { timezone: 'UTC' });

  console.log('[WEEKLY REPORT] Scheduled for every Monday at 6:00 AM EST');
}

async function generateReport() {
  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const thirtyDaysFromNow = new Date(now);
  thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

  // Active member count
  const activeResult = await pool.query(
    "SELECT COUNT(*) as count FROM members WHERE status = 'active'"
  );
  const activeCount = parseInt(activeResult.rows[0].count) || 0;

  // Total outstanding balance
  const balanceResult = await pool.query(
    "SELECT COALESCE(SUM(CAST(balance_owed AS NUMERIC)), 0) as total FROM members WHERE status = 'active' AND CAST(balance_owed AS NUMERIC) > 0"
  );
  const totalOutstanding = parseFloat(balanceResult.rows[0].total) || 0;

  // Members who are overdue (next_payment_due in the past and balance > 0)
  const overdueResult = await pool.query(
    "SELECT full_name, telegram_username, balance_owed, next_payment_due FROM members WHERE status = 'active' AND next_payment_due IS NOT NULL AND next_payment_due < NOW() AND CAST(balance_owed AS NUMERIC) > 0 ORDER BY next_payment_due ASC"
  );
  const overdueCount = overdueResult.rows.length;
  const overdueTotal = overdueResult.rows.reduce((sum, r) => sum + (parseFloat(r.balance_owed) || 0), 0);

  // Payments received this week (members where amount_paid changed)
  // We track this by looking at members updated in the last 7 days with payments
  // Since we don't have a payment history table, we check notes or use updated_at
  // For now, check members updated this week who have payments
  const paymentsResult = await pool.query(
    "SELECT full_name, telegram_username, amount_paid, payments_paid FROM members WHERE status = 'active' AND created_at >= $1 OR (status = 'active' AND amount_paid IS NOT NULL AND CAST(amount_paid AS NUMERIC) > 0)",
    [weekAgo.toISOString()]
  );

  // Renewals coming up in next 30 days
  const renewalResult = await pool.query(
    "SELECT full_name, telegram_username, renewal_date FROM members WHERE status = 'active' AND renewal_date IS NOT NULL AND renewal_date >= NOW() AND renewal_date <= $1 ORDER BY renewal_date ASC",
    [thirtyDaysFromNow.toISOString()]
  );

  // New members this week
  const newMembersResult = await pool.query(
    "SELECT full_name, telegram_username, plan FROM members WHERE created_at >= $1 AND status != 'archived' ORDER BY created_at DESC",
    [weekAgo.toISOString()]
  );

  // Archived/left this week
  const leftResult = await pool.query(
    "SELECT full_name, telegram_username, archived_reason FROM members WHERE status = 'archived' AND archived_date >= $1 ORDER BY archived_date DESC",
    [weekAgo.toISOString()]
  );

  // Format the date range
  const formatDate = (d) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  const weekRange = `${formatDate(weekAgo)} – ${formatDate(now)}`;

  // Build the report
  let report = `📊 <b>Weekly Report: ${weekRange}</b>\n\n`;

  report += `👥 Active Members: <b>${activeCount}</b>\n`;
  report += `💰 Outstanding Total: <b>$${totalOutstanding.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>\n`;
  report += `⚠️ Overdue: <b>${overdueCount} members</b> ($${overdueTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})\n\n`;

  // Renewals coming up
  if (renewalResult.rows.length > 0) {
    report += `🔄 <b>Renewals Next 30 Days (${renewalResult.rows.length}):</b>\n`;
    for (const r of renewalResult.rows.slice(0, 15)) {
      const name = r.full_name || r.telegram_username || 'Unknown';
      const date = new Date(r.renewal_date).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
      report += `  • ${name} — ${date}\n`;
    }
    if (renewalResult.rows.length > 15) {
      report += `  ... and ${renewalResult.rows.length - 15} more\n`;
    }
    report += '\n';
  } else {
    report += `🔄 No renewals in the next 30 days\n\n`;
  }

  // Copy trading renewals
  try {
    const ctRenewals = await pool.query(
      "SELECT full_name, telegram_username, renewal_date, amount_paid FROM ct_member_payments WHERE renewal_date IS NOT NULL AND renewal_date >= NOW() - INTERVAL '30 days' AND renewal_date <= $1 ORDER BY renewal_date ASC",
      [thirtyDaysFromNow.toISOString()]
    );
    if (ctRenewals.rows.length > 0) {
      report += `🤖 <b>Copy Trading Renewals (${ctRenewals.rows.length}):</b>\n`;
      for (const r of ctRenewals.rows) {
        const name = r.full_name || r.telegram_username || 'Unknown';
        const date = new Date(r.renewal_date).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const overdue = new Date(r.renewal_date) < new Date();
        report += `  • ${name} — ${date}${overdue ? ' ⚠️ OVERDUE' : ''}\n`;
      }
      report += '\n';
    }

    // Copy trading total sales
    const ctSales = await pool.query("SELECT COALESCE(SUM(CAST(amount_paid AS NUMERIC)), 0) as total FROM ct_member_payments");
    const ctTotal = parseFloat(ctSales.rows[0].total) || 0;
    if (ctTotal > 0) {
      report += `🤖 Copy Trading Total Sales: <b>$${ctTotal.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</b>\n\n`;
    }
  } catch (e) {
    console.error('[WEEKLY REPORT] CT renewals error:', e.message);
  }

  // New members this week
  if (newMembersResult.rows.length > 0) {
    report += `🆕 <b>New Members This Week (${newMembersResult.rows.length}):</b>\n`;
    for (const m of newMembersResult.rows) {
      const name = m.full_name || m.telegram_username || 'Unknown';
      report += `  • ${name} (${m.plan || 'No plan'})\n`;
    }
    report += '\n';
  }

  // Members who left this week
  if (leftResult.rows.length > 0) {
    report += `👋 <b>Left This Week (${leftResult.rows.length}):</b>\n`;
    for (const m of leftResult.rows) {
      const name = m.full_name || m.telegram_username || 'Unknown';
      report += `  • ${name} — ${m.archived_reason || 'Unknown reason'}\n`;
    }
    report += '\n';
  }

  // Overdue list (top 10)
  if (overdueResult.rows.length > 0) {
    report += `🚨 <b>Overdue Members:</b>\n`;
    for (const m of overdueResult.rows.slice(0, 10)) {
      const name = m.full_name || m.telegram_username || 'Unknown';
      const owed = parseFloat(m.balance_owed) || 0;
      const dueDate = new Date(m.next_payment_due).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' });
      report += `  • ${name} — $${owed.toFixed(0)} (due ${dueDate})\n`;
    }
    if (overdueResult.rows.length > 10) {
      report += `  ... and ${overdueResult.rows.length - 10} more\n`;
    }
  }

  return report;
}

module.exports = { startWeeklyReport, generateReport };
