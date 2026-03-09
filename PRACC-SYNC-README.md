# Pracc → Racker Auto Sync

Automatically syncs your pracc.gg match schedule to your Racker tracker calendar every day. Runs free on GitHub Actions — nothing needs to be installed or running on your PC.

---

## Setup (10 minutes, one time)

### Step 1 — Create a private GitHub repo

1. Go to **github.com** → **New repository**
2. Name it `pracc-racker-sync`
3. Set it to **Private** (your passwords will be stored here)
4. Click **Create repository**

---

### Step 2 — Upload these files

Upload all 3 files to the repo root:
- `sync-pracc.js`
- `package.json`
- `.github/workflows/sync-pracc.yml`

To upload: on the repo page click **Add file → Upload files**

For the workflow file you need to create the folder structure. Easiest way:
1. Click **Add file → Create new file**
2. In the filename box type: `.github/workflows/sync-pracc.yml`
3. Paste the contents of `sync-pracc.yml`
4. Commit

---

### Step 3 — Add your secrets

Your passwords are stored as **GitHub Secrets** — encrypted, never visible in logs.

1. Go to your repo → **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret** for each of these:

| Secret name        | Value                                      |
|--------------------|--------------------------------------------|
| `TRACKER_URL`      | `https://tracker2-ten.vercel.app`          |
| `TRACKER_USERNAME` | `admin`                                    |
| `TRACKER_PASSWORD` | your tracker admin password                |
| `PRACC_EMAIL`      | your pracc.gg email                        |
| `PRACC_PASSWORD`   | your pracc.gg password                     |

---

### Step 4 — Test it manually

1. Go to your repo → **Actions** tab
2. Click **Sync Pracc Matches** in the left sidebar
3. Click **Run workflow** → **Run workflow**
4. Watch the logs — you should see matches being synced

---

### That's it!

It now runs **automatically every day at 8:00 AM UTC**. You can change the schedule by editing the `cron` line in `sync-pracc.yml`:

```yaml
- cron: '0 8 * * *'   # 8am UTC daily
- cron: '0 0 * * *'   # midnight UTC daily  
- cron: '0 8 * * 1'   # every Monday at 8am UTC
```

Use https://crontab.guru to build cron expressions.

---

## Running locally (optional)

If you ever want to trigger a sync manually from your PC:

```bash
# Windows
set TRACKER_URL=https://tracker2-ten.vercel.app
set TRACKER_USERNAME=admin
set TRACKER_PASSWORD=yourpassword
set PRACC_EMAIL=your@email.com
set PRACC_PASSWORD=yourpraccpassword
npm install
node sync-pracc.js

# Mac/Linux
TRACKER_URL=https://tracker2-ten.vercel.app \
TRACKER_USERNAME=admin \
TRACKER_PASSWORD=yourpassword \
PRACC_EMAIL=your@email.com \
PRACC_PASSWORD=yourpraccpassword \
npm install && node sync-pracc.js
```

To see the browser window while debugging:
```bash
# Add DEBUG=true
DEBUG=true node sync-pracc.js
```

---

## How it works

```
GitHub Actions (daily 8am)
    │
    ├─ Logs into your Racker tracker API
    ├─ Opens headless Chrome, logs into pracc.gg
    ├─ Navigates to Matches calendar
    ├─ Scrapes all upcoming matches (current + next 2 months)
    ├─ Deletes old future "Pracc" events from tracker
    └─ Posts all scraped matches as orange "Pracc" events
```

Matches show up in your tracker calendar as orange **Pracc** events with the time, opponent name, and map.
