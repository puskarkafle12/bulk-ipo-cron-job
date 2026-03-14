// cron/meroshareClient.js
// Node-friendly CDSC / MeroShare client for cron bulk apply runs.
// This is intentionally minimal and separate from the browser cdsc.js (no window/localStorage).

/* eslint-disable no-console */

const fetch = (...args) =>
  import('node-fetch').then(({ default: fetchImpl }) => fetchImpl(...args));

const BASE_URL = 'https://webbackend.cdsc.com.np/api/meroShare';
const MEROSHARE_VIEW_BASE = 'https://webbackend.cdsc.com.np/api/meroShareView';
const SHARESANSAR_EXISTING_BASE = 'https://www.sharesansar.com/existing-issues';

const ENDPOINTS = {
  AUTH: BASE_URL + '/auth/',
  CHANGE_PASSWORD: BASE_URL + '/changePassword/',
  LOGOUT: BASE_URL + '/auth/logout/',
  CAPITAL: BASE_URL + '/capital/',
  BANK: BASE_URL + '/bank/',
  OWN_DETAIL: BASE_URL + '/ownDetail/',
  APPLICABLE_ISSUE: BASE_URL + '/companyShare/applicableIssue/',
  APPLY: BASE_URL + '/applicantForm/share/apply',
  MY_PORTFOLIO: MEROSHARE_VIEW_BASE + '/myPortfolio/',
};

const DEFAULT_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.8',
  'Content-Type': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

function stripHtml(html) {
  if (html == null) return '';
  return String(html).replace(/<[^>]*>/g, '').trim();
}

function parseRightRatioValue(ratioStr) {
  if (!ratioStr || typeof ratioStr !== 'string') return null;
  const cleaned = ratioStr.replace(/\s+/g, '');
  const parts = cleaned.split(':');
  if (parts.length !== 2) return null;
  const a = parseFloat(parts[0]);
  const b = parseFloat(parts[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
  return b / a;
}

async function fetchRightRatiosFromSharesansar() {
  const params = new URLSearchParams({
    draw: '1',
    start: '0',
    length: '50',
    'search[value]': '',
    'search[regex]': 'false',
    type: '3', // right shares
  });
  const url = SHARESANSAR_EXISTING_BASE + '?' + params.toString();
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: 'https://www.sharesansar.com/existing-issues',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(
      `ShareSansar right issues failed: ${res.status} ${String(t || '').slice(0, 120)}`
    );
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (e) {
    throw new Error(
      `Invalid ShareSansar right issues JSON: ${String(text || '').slice(0, 120)}`
    );
  }
  const rows = Array.isArray(data && data.data) ? data.data : [];
  const map = new Map();
  for (const row of rows) {
    if (!row || row.ratio_value == null) continue;
    const company = row.company || {};
    const symHtml = company.symbol || '';
    const sym = stripHtml(symHtml).toUpperCase();
    if (!sym) continue;
    const mult = parseRightRatioValue(row.ratio_value);
    if (mult && mult > 0) {
      map.set(sym, mult);
    }
  }
  return map;
}

async function parseJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (e) {
    const preview = text ? text.slice(0, 200) : '(empty)';
    throw new Error(
      `Invalid JSON from ${res.url || ''} status=${res.status}: ${preview}`
    );
  }
}

function headersWithAuth(token) {
  return token ? { ...DEFAULT_HEADERS, Authorization: token } : { ...DEFAULT_HEADERS };
}

// --- Password change helpers (adapted for cron) ---

const MAX_PASSWORD_LENGTH = 15;

function nextPassword(current) {
  if (current == null) current = '';
  const match = String(current).match(/\+(\d+)$/);
  let base = match ? current.replace(/\+\d+$/, '') : current;
  let suffix = match ? '+' + (parseInt(match[1], 10) + 1) : '+1';
  let maxBaseLen = MAX_PASSWORD_LENGTH - suffix.length;
  if (maxBaseLen < 1) maxBaseLen = 1;
  if (base.length > maxBaseLen) base = base.slice(0, maxBaseLen);
  return base + suffix;
}

async function callChangePasswordApi(authToken, oldPassword, newPassword) {
  const res = await fetch(ENDPOINTS.CHANGE_PASSWORD, {
    method: 'POST',
    headers: {
      ...DEFAULT_HEADERS,
      Authorization: authToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      oldPassword: oldPassword,
      newPassword: newPassword,
      confirmPassword: newPassword,
    }),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {}
  if (res.status < 200 || res.status >= 300) {
    const msg = (data && data.message) || 'Password change failed.';
    throw new Error(msg);
  }
}

/**
 * Proactively rotate password if it is going to expire within the given
 * threshold (in days). Uses the same +1, +2 suffix logic as login-based
 * password change so behaviour matches the static app.
 *
 * Returns true if a change was performed, false otherwise.
 */
async function rotatePasswordIfExpiringSoon(session, user, ownDetail, daysThreshold = 7) {
  if (!session || !session.token || !ownDetail || !ownDetail.passwordExpiryDateStr) {
    return false;
  }

  try {
    const expStr = String(ownDetail.passwordExpiryDateStr);
    const [y, m, d] = expStr.split('-').map((x) => parseInt(x, 10));
    if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return false;

    const expDate = new Date(y, m - 1, d);
    const now = new Date();
    const diffDays = Math.floor((expDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));

    // Only rotate when password will expire soon but is not already expired.
    if (diffDays > daysThreshold || diffDays < 0) {
      return false;
    }

    const originalPassword = String(user.password || '');
    if (!originalPassword) return false;

    // Change to a temporary password, then back to the original, so that
    // CDSC extends the expiry but the actual password remains the same.
    const tempPassword = nextPassword(originalPassword);

    // Step 1: original -> temp
    await callChangePasswordApi(session.token, originalPassword, tempPassword);

    // Step 2: login with temp to obtain a fresh token
    const tempLogin = await login({ ...user, password: tempPassword });

    // Step 3: temp -> original
    await callChangePasswordApi(tempLogin.token, tempPassword, originalPassword);

    try {
      await logout(tempLogin);
    } catch (_) {}

    console.log(
      '[cron] Proactively extended password expiry for',
      user.username,
      'before',
      expStr,
      'without changing stored password.'
    );
    return true;
  } catch (e) {
    console.warn(
      '[cron] Failed to proactively rotate password for',
      user && user.username,
      ':',
      e && e.message
    );
    return false;
  }
}

async function login(user) {
  // IMPORTANT: You may need to adjust this body to match exactly what your
  // frontend sends through cdsc-request (dpId, clientId, etc.).
  const body = {
    username: user.username,
    password: user.password,
    // CDSC login requires clientId; your JSON includes it as a string.
    // Send it as number when possible, otherwise as-is.
    clientId:
      user.clientId != null && user.clientId !== ''
        ? Number.isNaN(Number(user.clientId))
          ? user.clientId
          : Number(user.clientId)
        : undefined,
  };

  const doLogin = async (password) => {
    const res = await fetch(ENDPOINTS.AUTH, {
      method: 'POST',
      headers: DEFAULT_HEADERS,
      body: JSON.stringify({ ...body, password }),
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {}

    if (res.status !== 200) {
      const baseMsg =
        (data && (data.message || data.error_description || data.error)) ||
        (text ? text.substring(0, 200) : '') ||
        'Unknown login error';
      const msg = `Login failed (status ${res.status}): ${String(baseMsg)}`;
      throw new Error(msg);
    }

    // First login / password expired detection
    const needChangePassword =
      (data.passwordExpired && data.changePassword) ||
      (data.accountExpired &&
        /first login|please change password|change\s*password/i.test(
          String(data.message || '')
        ));

    return { res, data, needChangePassword };
  };

  // First attempt with current password
  let currentPassword = user.password;
  let loginRes = await doLogin(currentPassword);

  if (!loginRes.needChangePassword) {
    const token = loginRes.res.headers.get('Authorization');
    if (!token) {
      throw new Error('Login succeeded but Authorization header is missing.');
    }
    return { token, profile: loginRes.data };
  }

  // Handle first-login / password-expired:
  // Change password to a temporary one, then back to the original,
  // so expiry is extended but the actual password never changes.
  console.log(
    '[cron] Password expired / first login detected for',
    user.username,
    '- attempting automatic password change.'
  );

  const tokenForChange = loginRes.res.headers.get('Authorization');
  if (!tokenForChange) {
    throw new Error(
      (loginRes.data && loginRes.data.message) ||
        'First login: change password required, but no auth token.'
    );
  }

  const originalPassword = String(currentPassword || '');
  const tempPassword = nextPassword(originalPassword);

  // Step 1: original -> temp using first login token
  await callChangePasswordApi(tokenForChange, originalPassword, tempPassword);

  // Step 2: login with temp
  const tempLoginRes = await doLogin(tempPassword);
  const tempToken = tempLoginRes.res.headers.get('Authorization');
  if (!tempToken) {
    throw new Error('Login with temporary password succeeded but Authorization header is missing.');
  }

  // Step 3: temp -> original using temp token
  await callChangePasswordApi(tempToken, tempPassword, originalPassword);

  // Step 4: login again with original password; expiry should now be extended.
  const finalLoginRes = await doLogin(originalPassword);
  const finalToken = finalLoginRes.res.headers.get('Authorization');
  if (!finalToken) {
    throw new Error('Final login succeeded but Authorization header is missing.');
  }
  console.log(
    '[cron] Password expiry extended for',
    user.username,
    'without changing stored password.'
  );
  return { token: finalToken, profile: finalLoginRes.data };
}

async function logout(session) {
  if (!session || !session.token) return;
  try {
    await fetch(ENDPOINTS.LOGOUT, {
      method: 'GET',
      headers: headersWithAuth(session.token),
    });
  } catch (e) {
    console.error('[cron] Logout failed:', e && e.message);
  }
}

async function getOwnDetail(session) {
  const res = await fetch(ENDPOINTS.OWN_DETAIL, {
    method: 'GET',
    headers: headersWithAuth(session.token),
  });
  if (res.status !== 200) {
    const body = await res.text();
    throw new Error(`Own detail failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return parseJson(res);
}

async function getApplicableIssues(session) {
  const jsonData = {
    filterFieldParams: [
      { key: 'companyIssue.companyISIN.script', alias: 'Scrip' },
      { key: 'companyIssue.companyISIN.company.name', alias: 'Company Name' },
      { key: 'companyIssue.assignedToClient.name', value: '', alias: 'Issue Manager' },
    ],
    page: 1,
    size: 50,
    searchRoleViewConstants: 'VIEW_APPLICABLE_SHARE',
    filterDateParams: [
      { key: 'minIssueOpenDate', condition: '', alias: '', value: '' },
      { key: 'maxIssueCloseDate', condition: '', alias: '', value: '' },
    ],
  };

  const res = await fetch(ENDPOINTS.APPLICABLE_ISSUE, {
    method: 'POST',
    headers: headersWithAuth(session.token),
    body: JSON.stringify(jsonData),
  });

  if (res.status !== 200) {
    const body = await res.text();
    throw new Error(`getApplicableIssues failed: ${res.status} ${body.slice(0, 200)}`);
  }

  const responseData = await parseJson(res);
  const data = Array.isArray(responseData.object) ? responseData.object : [];

  const issues = [];
  let rightRatioMap = null;
  for (const item of data) {
    if (item.action === 'edit' || item.action === 'inProcess') continue;
    if (item.shareGroupName !== 'Ordinary Shares') continue;

    const base = {
      id: String(item.companyShareId),
      script: item.scrip,
      companyName: item.companyName,
      statusName: item.statusName,
      shareType: item.reservationTypeName,
    };

    // Attach right-share ratio when available from ShareSansar (by symbol).
    if (base.script && base.shareType && /right/i.test(String(base.shareType))) {
      try {
        if (!rightRatioMap) {
          rightRatioMap = await fetchRightRatiosFromSharesansar();
        }
        const sym = String(base.script).trim().toUpperCase();
        if (rightRatioMap && rightRatioMap.has(sym)) {
          base.rightRatio = rightRatioMap.get(sym);
        }
      } catch (e) {
        // If ShareSansar is unavailable, just skip ratio enrichment.
      }
    }

    if (item.action === 'reapply') {
      issues.push({ ...base, reapply: true });
    } else if (item.action === undefined) {
      issues.push({ ...base, reapply: false });
    }
  }
  return issues;
}

// Minimal portfolio helper: fetch current holdings (meroShareMyPortfolio) for this user.
async function getPortfolio(session) {
  const res = await fetch(ENDPOINTS.MY_PORTFOLIO, {
    method: 'POST',
    headers: headersWithAuth(session.token),
    body: JSON.stringify({
      page: 1,
      size: 200,
    }),
  });
  if (res.status !== 200) {
    const body = await res.text();
    throw new Error(`getPortfolio failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await parseJson(res);
  const rows = Array.isArray(data.meroShareMyPortfolio)
    ? data.meroShareMyPortfolio
    : [];
  return rows;
}

async function getBankAccounts(session) {
  const res = await fetch(ENDPOINTS.BANK, {
    method: 'GET',
    headers: headersWithAuth(session.token),
  });
  if (res.status !== 200) {
    const body = await res.text();
    throw new Error(`getBankAccounts failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await parseJson(res);
  // CDSC /bank/ can return:
  // - A plain array: [{ id, code, name }, ...]
  // - Wrapped objects: { object: [...] } or { data: [...] } or { accounts: [...] }
  const list =
    (Array.isArray(data) && data) ||
    (Array.isArray(data.object) && data.object) ||
    (Array.isArray(data.data) && data.data) ||
    (Array.isArray(data.accounts) && data.accounts) ||
    [];
  return list;
}

// Fetch detailed bank accounts for a given DP bank id (same shape as browser getBankDetails).
async function getBankDetails(bankId, session) {
  const url = ENDPOINTS.BANK + String(bankId);
  const res = await fetch(url, {
    method: 'GET',
    headers: headersWithAuth(session.token),
  });
  if (res.status !== 200) {
    const body = await res.text();
    throw new Error(`getBankDetails failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await parseJson(res);

  // Normalise various response shapes into an array of accounts.
  let list = [];

  function addAccount(acc) {
    if (!acc || typeof acc !== 'object') return;
    const hasKey =
      acc.id != null ||
      acc.accountNumber != null ||
      acc.accountNo != null ||
      acc.customerId != null ||
      acc.accountBranchId != null ||
      acc.accountTypeId != null;
    if (hasKey || list.length === 0) list.push(acc);
  }

  function extractList(val) {
    if (!val) return null;
    if (Array.isArray(val)) return val;
    if (typeof val === 'string') {
      try {
        return JSON.parse(val);
      } catch (_) {
        return null;
      }
    }
    if (typeof val === 'object') {
      if (Array.isArray(val.object)) return val.object;
      if (Array.isArray(val.data)) return val.data;
      if (Array.isArray(val.accounts)) return val.accounts;
      addAccount(val);
      return list.length ? list : null;
    }
    return null;
  }

  const raw =
    data && (data.object !== undefined ? data.object : data.data !== undefined ? data.data : data.accounts);
  list = extractList(raw) || extractList(data) || [];
  if (!Array.isArray(list)) list = list ? [list] : [];
  if (data && typeof data === 'object' && !Array.isArray(data) && list.length === 0) {
    addAccount(data);
  }

  if (!list[0]) {
    const snippet = (() => {
      try {
        return JSON.stringify(data).slice(0, 300);
      } catch (_) {
        return String(data).slice(0, 300);
      }
    })();
    throw new Error(`Bank details empty or invalid. Response (first 200 chars): ${snippet.slice(0, 200)}`);
  }
  return list;
}

async function applyForIssue({ session, user, issue, ownDetail, bankAccount, appliedKitta }) {
  const demat = ownDetail.demat;
  const qty =
    appliedKitta != null && Number.isFinite(appliedKitta)
      ? appliedKitta
      : user.defaultKitta || issue.kitta || 10; // adjust as needed

  const jsonData = {
    appliedKitta: qty,
    companyShareId: issue.id,
    customerId: bankAccount.id,
    boid: String(demat).slice(-8),
    crnNumber: user.crnNumber,
    bankId: bankAccount.bankId || bankAccount.id,
    accountNumber: bankAccount.accountNumber || bankAccount.accountNo,
    demat: demat,
    accountBranchId: bankAccount.accountBranchId,
    transactionPIN: user.pin,
    accountTypeId: bankAccount.accountTypeId,
  };

  const res = await fetch(ENDPOINTS.APPLY, {
    method: 'POST',
    headers: headersWithAuth(session.token),
    body: JSON.stringify(jsonData),
  });

  const bodyText = await res.text();
  let data = {};
  try {
    data = bodyText ? JSON.parse(bodyText) : {};
  } catch (_) {}

  if (res.status !== 201) {
    const msg = data.message || `Apply failed (status ${res.status})`;
    return { ok: false, status: res.status, message: msg, response: data };
  }

  return { ok: true, response: data };
}

// Reapply flow mirrors browser cdsc.js: GET /applicantForm/reapply/{companyShareId}
// to obtain formId, then POST /applicantForm/share/reapply/{formId} with same payload shape.
async function reapplyForIssue({ session, user, issue, ownDetail, bankAccount, appliedKitta }) {
  const demat = ownDetail.demat;
  const qty =
    appliedKitta != null && Number.isFinite(appliedKitta)
      ? appliedKitta
      : user.defaultKitta || issue.kitta || 10;

  const basePayload = {
    appliedKitta: qty,
    companyShareId: issue.id,
    customerId: bankAccount.id,
    boid: String(demat).slice(-8),
    crnNumber: user.crnNumber,
    bankId: bankAccount.bankId || bankAccount.id,
    accountNumber: bankAccount.accountNumber || bankAccount.accountNo,
    demat: demat,
    accountBranchId: bankAccount.accountBranchId,
    transactionPIN: user.pin,
    accountTypeId: bankAccount.accountTypeId,
  };

  const preRes = await fetch(
    BASE_URL + '/applicantForm/reapply/' + encodeURIComponent(String(issue.id)),
    {
      method: 'GET',
      headers: headersWithAuth(session.token),
    }
  );
  const preText = await preRes.text();
  let preData = {};
  try {
    preData = preText ? JSON.parse(preText) : {};
  } catch (_) {}
  if (preRes.status !== 200) {
    const msg = (preData && preData.message) || `Cannot get form id to reapply.`;
    return { ok: false, status: preRes.status, message: msg, response: preData };
  }
  const formId = preData.applicantFormId;
  const postRes = await fetch(
    BASE_URL + '/applicantForm/share/reapply/' + encodeURIComponent(String(formId)),
    {
      method: 'POST',
      headers: headersWithAuth(session.token),
      body: JSON.stringify(basePayload),
    }
  );
  const postText = await postRes.text();
  let postData = {};
  try {
    postData = postText ? JSON.parse(postText) : {};
  } catch (_) {}
  if (postRes.status !== 201) {
    const msg = (postData && postData.message) || 'Reapply failed.';
    return { ok: false, status: postRes.status, message: msg, response: postData };
  }
  return { ok: true, response: postData };
}

module.exports = {
  login,
  logout,
  getOwnDetail,
  getApplicableIssues,
  getBankAccounts,
  getBankDetails,
  applyForIssue,
  reapplyForIssue,
  rotatePasswordIfExpiringSoon,
  // Expose for test utilities / manual flows
  callChangePasswordApi,
  nextPassword,
};

