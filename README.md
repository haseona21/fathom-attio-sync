# attio-sync

A Slack–Attio bridge that automates deal flow after founder calls. Powered by **Zoe**, a Slack bot that notifies the team and handles post-call workflows.

## Features

### 1. Fathom Link Sync (hourly cron)
Fetches Fathom recordings and appends share links to matching Person and Company records in Attio.

### 2. Zoe: Post-Call Notifications (every 10 min)
- Polls Google Calendar for ended calls (5am–9pm PT, weekdays)
- Matches attendees to Attio deals (via person or company domain)
- Pulls transcript from Fathom API (Gmail email as fallback)
- Generates a one-sentence AI summary via Claude
- Posts to Slack with company name, summary, LinkedIn-linked attendees, Fathom link, and action buttons

### 3. Action Buttons
Each Zoe message has three buttons handled by a Slack bot running in **Socket Mode**:

| Button | Action |
|---|---|
| **To Deals** | Posts deal summary to the deals channel |
| **Ali to Reject** | Updates deal stage + creates Gmail rejection draft |
| **Deal Review** | Updates deal stage to "Deal Review" |

### 4. Unmatched Call Alerts
When a call has no matching deal in Attio, a GitHub issue is created with full pipeline diagnostics (person lookup, domain handling, company match results).

---

## Project Structure

```
src/
  types/
    crm.ts             # CRM interface (swappable)
    recording.ts        # Recording interface (swappable)
  lib/
    config.ts           # Env vars, Google auth
    errors.ts           # Error classes, logger, GitHub issue creation
    http.ts             # fetchWithRetry (429 handling)
    state.ts            # State file I/O
    attio.ts            # CRM implementation (Attio)
    fathom.ts           # Recording implementation (Fathom)
    gcal.ts             # Google Calendar
    gmail.ts            # Gmail drafts + Fathom email search
    slack.ts            # Zoe message formatting
    ai.ts               # Claude summarization
  actions/
    registry.ts         # Button handler registry
    to-deals.ts
    ali-to-reject.ts
    deal-review.ts
  main.ts               # Unified entrypoint: bot + cron schedules + health check
  fathom-sync.ts        # Fathom → Attio link sync (also runnable standalone)
  notify.ts             # Zoe post-call notifications (also runnable standalone)
  bot.ts                # Slack bot (Socket Mode)
scripts/
  reauth-google.ts      # Re-authorize Google OAuth credentials
templates/
  rejection_email.txt   # Template for rejection email drafts
```

CRM and Recording providers are behind interfaces — swap Attio or Fathom by writing a new implementation and changing one line in `config.ts`.

---

## Setup

### Prerequisites
- Node.js 22+
- npm

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```

Fill in your API keys. See `.env.example` for all required variables.

### 3. Attio setup
Create a custom **Text** attribute called `Fathom Links` (slug: `fathom_links`) on both **People** and **Companies** objects.

### 4. Environment variables (Railway)

| Variable | Used by |
|---|---|
| `FATHOM_API_KEY` | sync, notify |
| `ATTIO_API_KEY` | sync, notify |
| `SLACK_BOT_TOKEN` | notify, bot |
| `SLACK_APP_TOKEN` | bot (Socket Mode) |
| `SLACK_CHANNEL` | notify |
| `SLACK_DEALS_CHANNEL` | to-deals action |
| `GOOGLE_CREDENTIALS_JSON` | notify |
| `ANTHROPIC_API_KEY` | notify |
| `GITHUB_TOKEN` | unmatched call issues |
| `GITHUB_REPOSITORY` | unmatched call issues |
| `STATE_DIR` | `/data` on Railway (persistent volume) |

---

## Running

### npm scripts

| Command | Description |
|---|---|
| `npm start` | Run everything (bot + cron schedules + health check) |
| `npm run sync` | Run Fathom → Attio link sync (standalone) |
| `npm run backfill` | Backfill last 14 days (no state update) |
| `npm run notify` | Run Zoe notification check (standalone) |
| `npm run bot` | Start Slack bot only (Socket Mode) |
| `npm run typecheck` | TypeScript type checking |

### CLI flags

```bash
# Backfill with custom window
npm run backfill -- --days 30

# Notify with custom window and dry run
npm run notify -- --window 60 --dry-run
```

### Google re-auth
```bash
npx tsx scripts/reauth-google.ts
```

Opens a browser flow to re-authorize Google OAuth credentials (Calendar + Gmail scopes).

---

## Deployment (Railway)

Deployed as a single always-on service on Railway. The unified entrypoint (`npm start`) runs:

| Workload | Schedule | Description |
|---|---|---|
| **Slack Bot** | Always-on | Socket Mode — handles button clicks |
| **Fathom Sync** | Hourly | Syncs Fathom links to Attio |
| **Notify** | Every 10 min (5am–9pm PT, weekdays) | Post-call notifications |

### Railway setup
1. Create a new service from the GitHub repo
2. **Build command:** `npm ci`
3. **Start command:** `npm start`
4. Create a **persistent volume** mounted at `/data`
5. Set `STATE_DIR=/data` and all other env vars above
6. Health check: HTTP on `PORT` (auto-set by Railway)
