// cron/bulk-apply.js
// GitHub Actions entrypoint to run bulk IPO apply for all configured users.

/* eslint-disable no-console */

const { runBulkApplyForUser } = require('./bulkApplyEngine');

function getUsersFromEnv() {
  const raw = process.env.BULK_IPO_USERS_JSON;
  if (!raw) {
    throw new Error('BULK_IPO_USERS_JSON is not set in environment.');
  }
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    throw new Error('BULK_IPO_USERS_JSON is not valid JSON: ' + e.message);
  }
  if (!Array.isArray(arr) || !arr.length) {
    throw new Error('BULK_IPO_USERS_JSON must be a non-empty JSON array.');
  }
  // Pass all users to the engine.
  // Inside bulkApplyEngine.js:
  // - IPO / non-right issues are applied only when user.bulkApply === true.
  // - Right shares are checked for all users.
  return arr;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const users = getUsersFromEnv();
  console.log('[cron] Starting bulk IPO apply for', users.length, 'users');

  const allResults = [];
  for (const user of users) {
    const label = user.username || '(unknown)';
    console.log('---');
    console.log('[cron] Processing user', label);
    const result = await runBulkApplyForUser(user);
    allResults.push(result);

    const okCount = result.applied.length;
    const errCount = result.errors.length;
    console.log(
      `[cron] User ${label}: applied=${okCount}, errors=${errCount}`
    );

    await sleep(500);
  }

  console.log('===');
  console.log('[cron] Final summary:\n', JSON.stringify(allResults, null, 2));

  const totalErrors = allResults.reduce((s, r) => s + r.errors.length, 0);
  if (totalErrors > 0) {
    console.error('[cron] There were errors during bulk apply.');
    // Fail the workflow so GitHub Actions can trigger notifications (email, etc.).
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[cron] Fatal error:', err && err.message ? err.message : String(err));
  process.exit(1);
});

