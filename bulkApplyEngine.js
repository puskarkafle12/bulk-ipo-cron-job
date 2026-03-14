// cron/bulkApplyEngine.js
// Shared engine to perform bulk IPO apply for a single user using the Node client.

/* eslint-disable no-console */

const {
  login,
  logout,
  getOwnDetail,
  getApplicableIssues,
  getBankAccounts,
  getBankDetails,
  applyForIssue,
  reapplyForIssue,
  rotatePasswordIfExpiringSoon,
  getPortfolio,
} = require('./meroshareClient');

async function runBulkApplyForUser(userConfig) {
  const userLabel = userConfig.username || '(unknown)';
  const result = {
    user: userLabel,
    applied: [],
    skipped: [],
    errors: [],
  };

  let session = null;

  try {
    session = await login(userConfig);
    console.log('[cron] Logged in as', userLabel);

    const ownDetail = await getOwnDetail(session);
    // Warn if password is close to expiry, and proactively rotate when <= 7 days.
    if (ownDetail && ownDetail.passwordExpiryDateStr) {
      try {
        const expStr = String(ownDetail.passwordExpiryDateStr);
        const [y, m, d] = expStr.split('-').map((x) => parseInt(x, 10));
        if (!Number.isNaN(y) && !Number.isNaN(m) && !Number.isNaN(d)) {
          const expDate = new Date(y, m - 1, d);
          const now = new Date();
          const diffDays = Math.floor(
            (expDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)
          );
          console.warn(
            `[cron] Password for ${userLabel} will expire on ${expStr} (in ${diffDays} day(s)).`
          );
        }
      } catch (e) {
        console.warn(
          '[cron] Could not parse passwordExpiryDateStr for',
          userLabel,
          e && e.message
        );
      }
      // Change password if it is going to expire soon (<= 7 days), matching static app behaviour.
      await rotatePasswordIfExpiringSoon(session, userConfig, ownDetail, 7);
    }
    const issues = await getApplicableIssues(session);
    const banks = await getBankAccounts(session);

    if (!banks.length) {
      throw new Error('No banks returned by CDSC for user ' + userLabel);
    }
    // Prefer matching DP bank based on userConfig.bankId or bankName.
    let selectedBank = null;
    if (userConfig.bankId != null) {
      const targetId = String(userConfig.bankId);
      selectedBank =
        banks.find((b) => String(b.bankId || b.id) === targetId) || null;
    }
    if (!selectedBank && userConfig.bankName) {
      const targetName = String(userConfig.bankName).toLowerCase();
      selectedBank =
        banks.find((b) => {
          const name =
            (b.bankName || b.name || b.bank || '').toString().toLowerCase();
          return name.includes(targetName);
        }) || null;
    }
    if (!selectedBank) {
      selectedBank = banks[0];
    }

    const bankIdForDetails = selectedBank.bankId || selectedBank.id;
    const bankNameForLog =
      selectedBank.bankName || selectedBank.name || selectedBank.bank || '(unknown bank)';
    const accounts = await getBankDetails(bankIdForDetails, session);
    if (!accounts.length) {
      throw new Error(
        'No bank accounts returned by CDSC for user ' + userLabel + ' and bank ' + bankNameForLog
      );
    }
    const account = {
      ...accounts[0],
      bankId: bankIdForDetails,
      bankName: bankNameForLog,
    };
    console.log(
      '[cron] Using bank account for',
      userLabel,
      '->',
      account.bankName || '(unknown bank)'
    );

    if (!Array.isArray(issues) || !issues.length) {
      console.log('[cron] No applicable issues for', userLabel);
      return result;
    }

    // Preload portfolio once for right-share entitlement calculations.
    let portfolio = [];
    try {
      portfolio = await getPortfolio(session);
    } catch (e) {
      console.warn('[cron] Could not load portfolio for', userLabel, ':', e && e.message);
    }

    function getHeldQuantityForScript(script) {
      if (!script || !Array.isArray(portfolio)) return 0;
      const target = String(script).trim().toUpperCase();
      let total = 0;
      for (const row of portfolio) {
        const s = row && row.script ? String(row.script).trim().toUpperCase() : '';
        if (s === target) total += Number(row.currentBalance) || 0;
      }
      return total;
    }


    // Log per-user mode so it's clear what this run will try to apply.
    console.log(
      '[cron] Mode for',
      userLabel,
      '=>',
      userConfig.bulkApply ? 'IPO + right shares' : 'Right shares only'
    );

    for (const issue of issues) {
      try {
        // Here you can mirror any filters from js/modules/ipo-applier.js.
        var isRightShare = issue.shareType && /right/i.test(String(issue.shareType));

        // New rule:
        // - For IPO / non-right issues: only users with bulkApply === true should apply.
        // - For right shares: check eligibility for ALL users (bulkApply flag does not skip them).
        if (!isRightShare && !userConfig.bulkApply) {
          // Non-right share and this user is bulkApply=false → skip this IPO for this user.
          console.log(
            '[cron] Skipping IPO/non-right issue',
            issue.script,
            'for',
            userLabel,
            'because bulkApply=false (right-share-only mode).'
          );
          continue;
        }

        // For right shares, compute entitlement based on current holdings.
        let appliedKittaOverride = undefined;
        if (isRightShare) {
          const qtyHeld = getHeldQuantityForScript(issue.script);
          if (qtyHeld > 0 && typeof issue.rightRatio === 'number' && issue.rightRatio > 0) {
            const eligible = Math.floor(qtyHeld * issue.rightRatio);
            if (eligible > 0) appliedKittaOverride = eligible;
          }
        }

        const res = issue.reapply
          ? await reapplyForIssue({
              session,
              user: userConfig,
              issue,
              ownDetail,
              bankAccount: account,
              appliedKitta: appliedKittaOverride,
            })
          : await applyForIssue({
              session,
              user: userConfig,
              issue,
              ownDetail,
              bankAccount: account,
              appliedKitta: appliedKittaOverride,
            });
        if (res.ok) {
          console.log(
            issue.reapply ? '[cron] Reapplied' : '[cron] Applied',
            issue.script,
            'for',
            userLabel,
            'status=OK'
          );
          result.applied.push({
            id: issue.id,
            script: issue.script,
            companyName: issue.companyName,
            shareType: issue.shareType,
          });
        } else {
          console.warn(
            '[cron] Apply failed',
            issue.script,
            'for',
            userLabel,
            'message=',
            res.message
          );
          result.errors.push({
            issueId: issue.id,
            script: issue.script,
            message: res.message || 'Unknown apply error',
          });
        }
      } catch (e) {
        console.error(
          '[cron] Error applying',
          issue.script,
          'for',
          userLabel,
          ':',
          e && e.message ? e.message : String(e)
        );
        result.errors.push({
          issueId: issue.id,
          script: issue.script,
          message: e && e.message ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    console.error(
      '[cron] Setup error for user',
      userLabel,
      ':',
      e && e.message ? e.message : String(e)
    );
    result.errors.push({
      stage: 'setup',
      message: e && e.message ? e.message : String(e),
    });
  } finally {
    try {
      if (session) await logout(session);
    } catch (e) {
      console.error('[cron] Logout error for user', userLabel, ':', e && e.message);
    }
  }

  return result;
}

module.exports = {
  runBulkApplyForUser,
};

