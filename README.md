## Bulk IPO cron jobs

This folder contains the **Node.js scripts** that run bulk IPO apply for all users, without opening the browser.

- `bulk-apply.js` — main entry script you run.
- `bulkApplyEngine.js` — applies IPOs/right shares for one user.
- `meroshareClient.js` — talks to MeroShare + ShareSansar.
- `test-user.json` — example/local users (ignored by Git).

> ⚠️ **Important:** Never commit real passwords / CRN / PIN.  
> `cron/test-user.json` is in `.gitignore` so it only lives on your computer.

---

## 1. Run the cron on your computer (step by step)

### 1.1. Install tools (one time)

1. Install **Node.js 18 or 20** from `nodejs.org` (if you don’t have it).
2. Install project dependencies:

```bash
cd /path/to/bulk-ipo
npm install
```

### 1.2. Add your users for testing

1. Open `cron/test-user.json`.
2. Put your users inside an array like this:

```json
[
  {
    "clientId": "163",
    "username": "00358242",
    "password": "********",
    "crnNumber": "********",
    "pin": "****",
    "dpName": "naasa securities company ltd 15900",
    "bankId": 44,
    "bankName": "NIC ASIA BANK LTD.",
    "displayName": "Example User",
    "bulkApply": true,
    "history": true,
    "dashboard": true
  }
]
```

- `bulkApply: true` → apply **IPOs + right shares** for this user.
- `bulkApply: false` → apply **right shares only** (no IPOs) for this user.

### 1.3. Run the cron once (manual run)

From the repo root:

```bash
cd /path/to/bulk-ipo
export BULK_IPO_USERS_JSON="$(cat cron/test-user.json)"
node cron/bulk-apply.js
```

What happens:

- `BULK_IPO_USERS_JSON` = JSON from `cron/test-user.json`.
- `cron/bulk-apply.js` reads this env var, runs for each user, and prints:
  - which users were processed,
  - which IPOs/right shares were applied,
  - any errors, plus a final JSON summary.

> 💡 Tip: start with **one** test user first. When it looks good, add more.

---

## 2. Run every day forever with GitHub Actions

GitHub Actions can run this job for you even when your computer is off.

There is already a workflow file:  
`.github/workflows/bulk-apply-cron.yml`

### 2.1. Put your users JSON into a GitHub secret

1. Go to **GitHub → this repo → Settings → Secrets and variables → Actions**.
2. Click **“New repository secret”**.
3. Name: **`BULK_IPO_USERS_JSON`**.
4. Value: paste the **same JSON array** you used in `cron/test-user.json` (all users you want the cron to run for).
5. Save.

GitHub will now inject this JSON into the env as `BULK_IPO_USERS_JSON` when the workflow runs.

### 2.2. What the workflow does

Inside `.github/workflows/bulk-apply-cron.yml`:

1. **Trigger**
   - On the configured **cron schedule** (see `on.schedule.cron`).
   - You can also run it manually from the **Actions** tab.
2. **Steps**
   - Checks out the repo.
   - Sets `BULK_IPO_USERS_JSON` from the secret.
   - Installs Node + dependencies.
   - Runs:

```bash
node cron/bulk-apply.js
```

3. **Result**
   - If there are errors for any user, the script exits with `process.exit(1)`.
   - The workflow shows as **failed**, so you can see it and get GitHub notifications if enabled.

### 2.3. Change how often it runs

In `.github/workflows/bulk-apply-cron.yml`:

```yaml
on:
  schedule:
    - cron: '0 6 * * *'
```

- This `cron` value is in **UTC**.
- Examples:
  - Every day at 03:00 UTC → `'0 3 * * *'`
  - Every Sunday at 06:00 UTC → `'0 6 * * 0'`

Commit and push after you change it; GitHub will use the new schedule automatically.

### 2.4. Change which users run in production

You don’t need to touch code for this:

1. Go back to **Settings → Secrets and variables → Actions**.
2. Edit the **`BULK_IPO_USERS_JSON`** secret.
3. Paste new JSON (add/remove users, change `bulkApply` flags, etc.).

Next scheduled run will use the updated users.

---

## 3. Run from other cron systems (optional)

If you want to run the same script from another scheduler (Render, your own server, Linux `cron`, etc.):

1. Install Node and dependencies (same as section **1.1**).
2. Set `BULK_IPO_USERS_JSON` in that environment to your users JSON.
3. Execute:

```bash
node cron/bulk-apply.js
```

It will behave exactly like in GitHub Actions: log in for each user, apply IPOs/right shares based on `bulkApply`, and exit with a non‑zero code if there were errors.


