# Fathom → Attio Sync

Automatically appends Fathom recording links to matching Person and Company records in Attio. Runs hourly via GitHub Actions.

Each link is formatted as `(YYYY-MM-DD): https://fathom.video/share/...` and appended to a text attribute on the record.

---

## Setup

### 1. Attio — create the attribute

In Attio, create a custom **Text** attribute on both **People** and **Companies**:
- Name: `Fathom Recordings`
- Slug: `fathom_recordings` (Attio generates this automatically)

If Attio generates a different slug, update the `ATTIO_ATTRIBUTE` value at the top of `sync.py`.

### 2. Fork / create the repo

Push these files to a new GitHub repo. It can be private.

### 3. Add secrets

In your GitHub repo go to **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret name | Value |
|---|---|
| `FATHOM_API_KEY` | From fathom.video/customize#api-access-header |
| `ATTIO_API_KEY` | From Attio workspace settings → API |

### 4. Enable Actions

Go to the **Actions** tab in your repo and enable workflows if prompted.

### 5. First run

Trigger a manual run from **Actions → Fathom → Attio Sync → Run workflow**. This will:
- Fetch your full Fathom meeting history (first run only)
- Match attendees to Attio records
- Write `last_run.txt` to the repo

All subsequent runs will only fetch meetings since the last run.

---

## Schedule

Runs every hour. To change the frequency, edit the cron expression in `.github/workflows/sync.yml`:

```
0 * * * *   → every hour
*/30 * * * * → every 30 minutes
0 9 * * *   → once daily at 9am UTC
```

---

## How it works

1. Reads `last_run.txt` to get the timestamp of the last successful run
2. Fetches all Fathom meetings created after that timestamp
3. For each meeting, finds external attendees and looks them up in Attio by email
4. Appends `(date): link` to the `fathom_recordings` field on matched Person records
5. Also matches on email domain → appends to matched Company records
6. Updates `last_run.txt` and commits it back to the repo

Free/personal email domains (Gmail, Outlook, etc.) are excluded from company matching.
