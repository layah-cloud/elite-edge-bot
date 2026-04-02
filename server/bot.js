const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const path = require('path');
const { pool } = require('./db');

const CRYPTO_BIBLE_PATH = path.join(__dirname, 'crypto_bible.pdf');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID = process.env.TELEGRAM_GROUP_ID; // VIP broadcast channel
const CONNECTED_CHAT_ID = process.env.CONNECTED_CHAT_ID; // Connected discussion supergroup
const NOTIFY_CHAT_ID = process.env.NOTIFY_CHAT_ID; // @EECryptoTrade account ID for DM notifications

// Build set of monitored chat IDs
function getMonitoredIds() {
  const ids = new Set();
  if (GROUP_ID) ids.add(GROUP_ID);
  if (CONNECTED_CHAT_ID) ids.add(CONNECTED_CHAT_ID);
  return ids;
}

function isMonitoredChat(chatId) {
  const ids = getMonitoredIds();
  if (ids.size === 0) return true; // No filter = monitor all
  return ids.has(String(chatId));
}

function startBot() {
  if (!TOKEN) {
    console.log('No TELEGRAM_BOT_TOKEN set — bot disabled');
    return null;
  }

  // Enable chat_member updates so we catch joins in channels AND supergroups
  // channel_post needed so the bot stays aware of channel activity
  const bot = new TelegramBot(TOKEN, {
    polling: {
      params: {
        allowed_updates: ['message', 'chat_member', 'my_chat_member', 'channel_post', 'chat_join_request']
      }
    }
  });
  console.log('Telegram bot started — monitoring for new members (message + chat_member + channel events)...');
  console.log(`GROUP_ID (channel): ${GROUP_ID || 'NOT SET'}`);
  console.log(`CONNECTED_CHAT_ID (supergroup): ${CONNECTED_CHAT_ID || 'NOT SET'}`);
  console.log(`NOTIFY_CHAT_ID: ${NOTIFY_CHAT_ID || 'NOT SET (no DM notifications)'}`);
  console.log(`Monitoring chat IDs: ${[...getMonitoredIds()].join(', ') || 'ALL (no filter)'}`);

  // ── RAW UPDATE HANDLER — catches chat_member events the library might miss ──
  bot.on('raw_event', (update) => {
    // Log ALL raw updates for debugging
    if (update.chat_member) {
      console.log(`[RAW chat_member] Chat: ${update.chat_member.chat.id} (${update.chat_member.chat.title || 'unknown'})`);
      const oldStatus = update.chat_member.old_chat_member?.status;
      const newStatus = update.chat_member.new_chat_member?.status;
      const user = update.chat_member.new_chat_member?.user;
      console.log(`[RAW chat_member] ${user?.first_name} ${user?.last_name || ''}: ${oldStatus} → ${newStatus}`);
    }
    if (update.my_chat_member) {
      console.log(`[RAW my_chat_member] Chat: ${update.my_chat_member.chat.id} (${update.my_chat_member.chat.title || 'unknown'})`);
    }
  });

  // ── Shared helper: handle a new member joining ──
  async function handleNewMember(tgId, tgUsername, fullName) {
    // Check if already exists by telegram_id
    const existing = await pool.query(
      'SELECT id, status FROM members WHERE telegram_id = $1',
      [tgId]
    );

    if (existing.rows.length > 0) {
      if (existing.rows[0].status === 'archived') {
        await pool.query(
          `UPDATE members SET status='pending', archived_reason=NULL, archived_date=NULL,
           notes='Re-joined group — reactivated from archive', join_date=CURRENT_DATE WHERE id=$1`,
          [existing.rows[0].id]
        );
        console.log(`[REACTIVATED] ${fullName} (${tgId}) was archived — moved back to Pending`);
        if (NOTIFY_CHAT_ID) {
          try {
            await bot.sendMessage(NOTIFY_CHAT_ID, `\u{1F504} Returning member re-joined the group!\n\nName: ${fullName}\nUsername: ${tgUsername || 'No username'}\nTelegram ID: ${tgId}\n\nMoved back to Pending on CRM.`);
          } catch (e) { console.error('[NOTIFY ERROR]', e.message); }
        }
      } else {
        console.log(`[EXISTS] ${fullName} (${tgId}) already exists with status: ${existing.rows[0].status} — notifying`);
        if (NOTIFY_CHAT_ID) {
          try {
            await bot.sendMessage(NOTIFY_CHAT_ID, `\u{1F44B} Existing member re-joined the group!\n\nName: ${fullName}\nUsername: ${tgUsername || 'No username'}\nTelegram ID: ${tgId}\nCRM Status: ${existing.rows[0].status}\n\nNo CRM changes made — they already exist.`);
          } catch (e) { console.error('[NOTIFY ERROR]', e.message); }
        }
      }
      return;
    }

    // Check by username/name across both columns (handles swapped fields from bulk imports)
    // Case-insensitive search in telegram_username, full_name, and also by display name
    if (tgUsername || fullName) {
      let existingByMatch = { rows: [] };
      if (tgUsername) {
        existingByMatch = await pool.query(
          'SELECT id, status FROM members WHERE LOWER(telegram_username) = LOWER($1) OR LOWER(full_name) = LOWER($1)',
          [tgUsername]
        );
      }
      // Also check by full name if not found by username
      if (existingByMatch.rows.length === 0 && fullName) {
        existingByMatch = await pool.query(
          'SELECT id, status FROM members WHERE LOWER(full_name) = LOWER($1) OR LOWER(telegram_username) = LOWER($1)',
          [fullName]
        );
      }

      if (existingByMatch.rows.length > 0) {
        const row = existingByMatch.rows[0];
        if (row.status === 'archived') {
          await pool.query(
            `UPDATE members SET telegram_id=$1, status='pending', archived_reason=NULL, archived_date=NULL,
             notes='Re-joined group — reactivated from archive', join_date=CURRENT_DATE WHERE id=$2`,
            [tgId, row.id]
          );
          console.log(`[REACTIVATED BY MATCH] ${fullName} (${tgUsername}) — moved back to Pending`);
        } else {
          await pool.query(
            'UPDATE members SET telegram_id=$1 WHERE id=$2',
            [tgId, row.id]
          );
          console.log(`[UPDATED] ${fullName} (${tgUsername}) — added telegram_id ${tgId}`);
          if (NOTIFY_CHAT_ID) {
            try {
              await bot.sendMessage(NOTIFY_CHAT_ID, `\u{1F44B} Existing member re-joined the group!\n\nName: ${fullName}\nUsername: ${tgUsername || 'No username'}\nTelegram ID: ${tgId}\nCRM Status: ${row.status}\n\nTelegram ID updated on CRM.`);
            } catch (e) { console.error('[NOTIFY ERROR]', e.message); }
          }
        }
        return;
      }
    }

    // Brand new member
    await pool.query(
      `INSERT INTO members (telegram_username, telegram_id, full_name, join_date, status, notes)
       VALUES ($1, $2, $3, CURRENT_DATE, 'pending', 'Auto-detected by bot')`,
      [tgUsername, tgId, fullName]
    );

    console.log(`[ADDED] New member: ${fullName} (${tgUsername || tgId}) — added to Pending`);

    // Send DM notification
    if (NOTIFY_CHAT_ID) {
      try {
        const notifyMsg = `\u{1F195} New member joined the group!\n\nName: ${fullName}\nUsername: ${tgUsername || 'No username'}\nTelegram ID: ${tgId}\n\nAdded to Pending on CRM.`;
        await bot.sendMessage(NOTIFY_CHAT_ID, notifyMsg);
        console.log(`[NOTIFIED] Sent DM to ${NOTIFY_CHAT_ID} about ${fullName}`);
      } catch (notifyErr) {
        console.error(`[NOTIFY ERROR] Could not DM ${NOTIFY_CHAT_ID}:`, notifyErr.message);
      }
    }
  }

  // ── Shared helper: handle a member leaving ──
  // removedBy: { id, firstName, username } — the person who triggered the removal
  // If removedBy.id === tgId, the member left on their own
  async function handleMemberLeft(tgId, fullName, removedBy, tgUsername) {
    let existing = await pool.query(
      'SELECT id, status FROM members WHERE telegram_id = $1',
      [tgId]
    );

    // Also try by username if not found by ID
    if (existing.rows.length === 0 && tgUsername) {
      existing = await pool.query(
        'SELECT id, status FROM members WHERE telegram_username = $1',
        [tgUsername]
      );
    }

    if (existing.rows.length > 0 && existing.rows[0].status !== 'archived') {
      let reason;
      if (removedBy && String(removedBy.id) !== String(tgId)) {
        const adminName = removedBy.username ? `@${removedBy.username}` : removedBy.firstName;
        reason = `Removed by admin (${adminName})`;
      } else {
        reason = 'Left group themselves';
      }

      await pool.query(
        `UPDATE members SET status='archived', archived_reason=$1, archived_date=CURRENT_DATE WHERE id=$2`,
        [reason, existing.rows[0].id]
      );
      console.log(`[ARCHIVED] ${fullName} (${tgId}) — ${reason}`);

      // Notify @EECryptoTrade
      if (NOTIFY_CHAT_ID) {
        try {
          const emoji = reason.startsWith('Removed') ? '🚫' : '👋';
          await bot.sendMessage(NOTIFY_CHAT_ID, `${emoji} Member left the group!\n\nName: ${fullName}\nTelegram ID: ${tgId}\nReason: ${reason}\n\nMoved to Removed on CRM.`);
        } catch (e) { console.error('[NOTIFY ERROR]', e.message); }
      }
    }
  }

  // /getid command — DM the bot to get your Telegram user ID
  bot.onText(/\/getid/, (msg) => {
    bot.sendMessage(msg.chat.id, `Your chat ID: ${msg.chat.id}\nYour user ID: ${msg.from.id}`);
  });

  // ── Google Drive DeFi Course Sharing ──
  // Members DM the bot with their email to receive view-only access to the DeFi course folder
  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
  const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

  let driveClient = null;
  if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REFRESH_TOKEN && GOOGLE_DRIVE_FOLDER_ID) {
    const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
    oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
    driveClient = google.drive({ version: 'v3', auth: oauth2Client });
    console.log('[DRIVE] Google Drive sharing enabled — folder:', GOOGLE_DRIVE_FOLDER_ID);
  } else {
    console.log('[DRIVE] Google Drive sharing disabled — missing env vars');
  }

  // Handle DMs with email addresses — share DeFi course folder
  bot.onText(/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/, async (msg) => {
    // Only respond to DMs (private chats), not group messages
    if (msg.chat.type !== 'private') return;

    const email = msg.text.trim().toLowerCase();
    const tgId = String(msg.from.id);
    const fullName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');

    console.log(`[DRIVE] Email received from ${fullName} (${tgId}): ${email}`);

    if (!driveClient) {
      await bot.sendMessage(msg.chat.id, 'Sorry, the course sharing feature is not available right now. Please contact @EECryptoTrade.');
      return;
    }

    try {
      // Check if this person is an active member in the CRM
      const memberResult = await pool.query(
        "SELECT id, status, full_name FROM members WHERE telegram_id = $1",
        [tgId]
      );

      let memberId = null;
      if (memberResult.rows.length === 0) {
        // Try by username
        const tgUsername = msg.from.username ? `@${msg.from.username}` : null;
        if (tgUsername) {
          const byUsername = await pool.query(
            "SELECT id, status, full_name FROM members WHERE telegram_username = $1",
            [tgUsername]
          );
          if (byUsername.rows.length > 0 && byUsername.rows[0].status === 'active') {
            memberId = byUsername.rows[0].id;
          }
        }
        if (!memberId) {
          await bot.sendMessage(msg.chat.id, "You need to be a VIP member to access this course. Please make sure you have clicked the link the sign up team gave you and requested to join.");
          console.log(`[DRIVE] Denied — ${fullName} (${tgId}) not found in CRM`);
          return;
        }
      } else if (memberResult.rows[0].status !== 'active') {
        await bot.sendMessage(msg.chat.id, "You need to be a VIP member to access this course. Please make sure you have clicked the link the sign up team gave you and requested to join.");
        console.log(`[DRIVE] Denied — ${fullName} (${tgId}) status is ${memberResult.rows[0].status}`);
        return;
      } else {
        memberId = memberResult.rows[0].id;
      }

      // Store email in CRM
      if (memberId) {
        await pool.query('UPDATE members SET email = $1 WHERE id = $2', [email, memberId]);
        console.log(`[DRIVE] Stored email ${email} for member ID ${memberId}`);
      }

      // Member is active — share the Drive folder with their email (view-only)
      await driveClient.permissions.create({
        fileId: GOOGLE_DRIVE_FOLDER_ID,
        requestBody: {
          type: 'user',
          role: 'reader',
          emailAddress: email
        },
        sendNotificationEmail: true
      });

      await bot.sendMessage(msg.chat.id,
        `✅ Done! Layah's DeFi Video Course has been shared with ${email}.\n\nCheck your email for the Google Drive invitation. If you don't see it, check your spam folder.`
      );
      console.log(`[DRIVE] Shared folder with ${email} for member ${fullName} (${tgId})`);

      // Send the Crypto Bible PDF
      try {
        await bot.sendDocument(msg.chat.id, CRYPTO_BIBLE_PATH, {
          caption: '📖 Here\'s your Crypto Bible! A must read.'
        }, { filename: 'Crypto Bible.pdf', contentType: 'application/pdf' });
        console.log(`[BIBLE] Sent Crypto Bible to ${fullName} (${tgId})`);
      } catch (bibleErr) {
        console.error(`[BIBLE ERROR] Failed to send Crypto Bible to ${fullName}:`, bibleErr.message);
      }

      // Notify @EECryptoTrade
      if (NOTIFY_CHAT_ID) {
        try {
          const tgHandle = msg.from.username ? ` (@${msg.from.username})` : '';
          await bot.sendMessage(NOTIFY_CHAT_ID, `📚 DeFi course shared!\n\nMember: ${fullName}${tgHandle}\nEmail: ${email}`);
        } catch (e) { console.error('[NOTIFY ERROR]', e.message); }
      }

    } catch (err) {
      console.error(`[DRIVE ERROR] Failed to share with ${email}:`, err.message);
      if (err.message?.includes('invalid_grant')) {
        await bot.sendMessage(msg.chat.id, 'Sorry, there was an authentication issue. Please contact @EECryptoTrade.');
      } else {
        await bot.sendMessage(msg.chat.id, 'Sorry, something went wrong sharing the course. Please contact @EECryptoTrade and try again later.');
      }
    }
  });

  // Log all incoming events and passively capture telegram_ids
  bot.on('message', async (msg) => {
    console.log(`[MESSAGE] Chat: ${msg.chat.id} (${msg.chat.title || 'DM'}) | From: ${msg.from?.first_name || 'unknown'} | Type: ${msg.new_chat_members ? 'new_chat_members' : msg.left_chat_member ? 'left_chat_member' : 'text'}`);

    // Passively capture telegram_id for existing CRM members who don't have one stored
    // Also detect unknown members who aren't in CRM at all
    // Ignore Telegram system account, owner, admins, and signup team
    const IGNORED_IDS = new Set(['777000', '793173917', '1220776946', '6402066483']);
    if (msg.from && !msg.from.is_bot && isMonitoredChat(String(msg.chat.id)) && !IGNORED_IDS.has(String(msg.from.id))) {
      const tgId = String(msg.from.id);
      const tgUsername = msg.from.username ? `@${msg.from.username}` : null;
      const fullName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');

      try {
        // First check if they exist by telegram_id
        const byId = await pool.query('SELECT id, full_name FROM members WHERE telegram_id = $1', [tgId]);

        if (byId.rows.length > 0) {
          // Known member, already has TG ID stored — nothing to do
        } else {
          // Check by username AND name across both columns (handles swapped fields from bulk imports)
          let found = null;
          if (tgUsername) {
            const byUsername = await pool.query(
              'SELECT id, full_name FROM members WHERE LOWER(telegram_username) = LOWER($1) OR LOWER(full_name) = LOWER($1)',
              [tgUsername]
            );
            if (byUsername.rows.length > 0) found = byUsername.rows[0];
          }
          // Also check by display name if not found by username
          if (!found && fullName) {
            const byName = await pool.query(
              'SELECT id, full_name FROM members WHERE LOWER(full_name) = LOWER($1) OR LOWER(telegram_username) = LOWER($1)',
              [fullName]
            );
            if (byName.rows.length > 0) found = byName.rows[0];
          }

          if (found) {
            // Found existing member, just update their telegram_id
            await pool.query('UPDATE members SET telegram_id = $1 WHERE id = $2', [tgId, found.id]);
            console.log(`[ID CAPTURED] Stored telegram_id ${tgId} for ${found.full_name} (${tgUsername})`);
          } else {
            // Truly not found anywhere — unknown member in the group
            await pool.query(
              `INSERT INTO members (telegram_username, telegram_id, full_name, join_date, status, notes)
               VALUES ($1, $2, $3, CURRENT_DATE, 'pending', 'Auto-detected from group chat — not previously in CRM')`,
              [tgUsername, tgId, fullName]
            );
            console.log(`[UNKNOWN MEMBER ADDED] ${fullName} (${tgUsername || 'no username'}, ${tgId}) — added to CRM as pending`);
            try {
              await bot.sendMessage('6402066483',
                `⚠️ Unknown member detected in VIP group:\n\n👤 ${fullName}\n📎 ${tgUsername || 'No username'}\n🆔 ${tgId}\n\nThey were not in the CRM. Added as Pending for review.`
              );
            } catch (notifyErr) { /* ignore notification failure */ }
          }
        }
      } catch (e) {
        console.error('[ERROR] Passive member detection:', e.message);
      }
    }
  });

  // ── PRIMARY: chat_member update handler (reliable for supergroups) ──
  bot.on('chat_member', async (update) => {
    try {
      const chatId = String(update.chat.id);
      console.log(`[CHAT_MEMBER EVENT] Chat: ${chatId} (${update.chat.title || 'unknown'}) | Monitored: ${isMonitoredChat(chatId)}`);
      if (!isMonitoredChat(chatId)) return;

      const oldStatus = update.old_chat_member?.status;
      const newStatus = update.new_chat_member?.status;
      const member = update.new_chat_member?.user;

      if (!member || member.is_bot) return;

      // Detect JOIN: left/kicked → member/administrator
      if ((oldStatus === 'left' || oldStatus === 'kicked') &&
          (newStatus === 'member' || newStatus === 'administrator')) {
        const tgId = String(member.id);
        const tgUsername = member.username ? `@${member.username}` : null;
        const fullName = [member.first_name, member.last_name].filter(Boolean).join(' ');
        console.log(`[CHAT_MEMBER JOIN] ${fullName} (${tgUsername || tgId}) joined`);
        await handleNewMember(tgId, tgUsername, fullName);
      }

      // Detect LEAVE: member/administrator → left/kicked
      if ((oldStatus === 'member' || oldStatus === 'administrator') &&
          (newStatus === 'left' || newStatus === 'kicked')) {
        const tgId = String(member.id);
        const fullName = [member.first_name, member.last_name].filter(Boolean).join(' ');
        const tgUsername = member.username ? `@${member.username}` : null;
        const removedBy = update.from ? { id: String(update.from.id), firstName: update.from.first_name, username: update.from.username } : null;
        console.log(`[CHAT_MEMBER LEFT] ${fullName} (${tgId}) left/removed | By: ${removedBy?.username || removedBy?.firstName || 'unknown'}`);
        await handleMemberLeft(tgId, fullName, removedBy, tgUsername);
      }
    } catch (err) {
      console.error('[ERROR] chat_member handler failed:', err.message, err.stack);
    }
  });

  // ── FALLBACK: new_chat_members (still works for some group types) ──
  bot.on('new_chat_members', async (msg) => {
    try {
      const chatId = String(msg.chat.id);
      console.log(`[NEW MEMBER EVENT] Chat ID: ${chatId} | Monitored: ${isMonitoredChat(chatId)}`);

      if (!isMonitoredChat(chatId)) {
        console.log(`[SKIPPED] Chat ${chatId} not in monitored list`);
        return;
      }

      for (const member of msg.new_chat_members) {
        if (member.is_bot) continue;
        const tgId = String(member.id);
        const tgUsername = member.username ? `@${member.username}` : null;
        const fullName = [member.first_name, member.last_name].filter(Boolean).join(' ');
        console.log(`[PROCESSING] New member: ${fullName} (${tgUsername || tgId})`);
        await handleNewMember(tgId, tgUsername, fullName);
      }
    } catch (err) {
      console.error('[ERROR] new_chat_members handler failed:', err.message, err.stack);
    }
  });

  // ── FALLBACK: left_chat_member ──
  bot.on('left_chat_member', async (msg) => {
    try {
      const chatId = String(msg.chat.id);
      if (!isMonitoredChat(chatId)) return;

      const member = msg.left_chat_member;
      if (member.is_bot) return;

      const tgId = String(member.id);
      const fullName = [member.first_name, member.last_name].filter(Boolean).join(' ');
      const tgUsername = member.username ? `@${member.username}` : null;
      // Fallback handler doesn't reliably tell us who removed — pass null
      await handleMemberLeft(tgId, fullName, null, tgUsername);
    } catch (err) {
      console.error('[ERROR] left_chat_member handler failed:', err.message, err.stack);
    }
  });

  bot.on('polling_error', (err) => {
    console.error('[POLLING ERROR]', err.message);
  });

  // ── SAFETY NET: Manually process chat_member from raw polling updates ──
  // node-telegram-bot-api may not emit 'chat_member' events for channels.
  // We intercept the raw polling response to handle them ourselves.
  const originalProcessUpdate = bot.processUpdate.bind(bot);
  bot.processUpdate = function(update) {
    // Log every single update type received
    const updateTypes = Object.keys(update).filter(k => k !== 'update_id');
    console.log(`[RAW UPDATE #${update.update_id}] Types: ${updateTypes.join(', ')}`);

    // If this is a chat_member update that the library might skip, handle it manually
    if (update.chat_member) {
      const cm = update.chat_member;
      const chatId = String(cm.chat.id);
      const oldStatus = cm.old_chat_member?.status;
      const newStatus = cm.new_chat_member?.status;
      const member = cm.new_chat_member?.user;

      console.log(`[RAW CHAT_MEMBER] Chat: ${chatId} (${cm.chat.title || 'unknown'}) | ${member?.first_name || '?'}: ${oldStatus} → ${newStatus} | Monitored: ${isMonitoredChat(chatId)}`);

      if (member && !member.is_bot && isMonitoredChat(chatId)) {
        const tgId = String(member.id);
        const tgUsername = member.username ? `@${member.username}` : null;
        const fullName = [member.first_name, member.last_name].filter(Boolean).join(' ');

        // JOIN: left/kicked → member/administrator
        if ((oldStatus === 'left' || oldStatus === 'kicked') &&
            (newStatus === 'member' || newStatus === 'administrator')) {
          console.log(`[RAW JOIN DETECTED] ${fullName} (${tgUsername || tgId})`);
          handleNewMember(tgId, tgUsername, fullName).catch(err => {
            console.error('[ERROR] raw chat_member join handler:', err.message);
          });
        }

        // LEAVE: member/administrator → left/kicked
        if ((oldStatus === 'member' || oldStatus === 'administrator') &&
            (newStatus === 'left' || newStatus === 'kicked')) {
          const removedBy = cm.from ? { id: String(cm.from.id), firstName: cm.from.first_name, username: cm.from.username } : null;
          console.log(`[RAW LEAVE DETECTED] ${fullName} (${tgId}) | By: ${removedBy?.username || removedBy?.firstName || 'unknown'}`);
          handleMemberLeft(tgId, fullName, removedBy, tgUsername).catch(err => {
            console.error('[ERROR] raw chat_member leave handler:', err.message);
          });
        }
      }
    }

    // ── Handle chat_join_request (channel/group requires admin approval to join) ──
    if (update.chat_join_request) {
      const jr = update.chat_join_request;
      const chatId = String(jr.chat.id);
      const user = jr.from;

      console.log(`[JOIN REQUEST] Chat: ${chatId} (${jr.chat.title || 'unknown'}) | User: ${user.first_name} ${user.last_name || ''} (@${user.username || 'none'}) | Monitored: ${isMonitoredChat(chatId)}`);

      if (user && !user.is_bot && isMonitoredChat(chatId)) {
        const tgId = String(user.id);
        const tgUsername = user.username ? `@${user.username}` : null;
        const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ');

        // Just log it — do NOT add to CRM yet. Wait for admin to approve.
        // Once approved, Telegram sends a chat_member event (left → member)
        // which triggers handleNewMember via the chat_member handler.
        console.log(`[JOIN REQUEST] ${fullName} (${tgUsername || tgId}) requested to join — waiting for admin approval`);
      }
    }

    // Still call the original so the library processes other update types normally
    return originalProcessUpdate(update);
  };

  // Graceful shutdown — stop polling immediately when Railway sends SIGTERM during deploys
  // This prevents the old instance from competing with the new one for Telegram updates
  process.on('SIGTERM', () => {
    console.log('[SHUTDOWN] SIGTERM received — stopping Telegram polling...');
    bot.stopPolling();
    process.exit(0);
  });
  process.on('SIGINT', () => {
    console.log('[SHUTDOWN] SIGINT received — stopping Telegram polling...');
    bot.stopPolling();
    process.exit(0);
  });

  return bot;
}

module.exports = { startBot };
