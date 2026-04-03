# Zoe — Post-Call Deal Decision Tool

Deployed on **Railway**. Runs a single Node.js process that handles cron jobs (notify every 10 min, Fathom sync hourly) and the Slack bot via Socket Mode, with a health check on port 8080.

## How it works

After a founder call ends, Zoe polls Google Calendar for recently ended meetings, then checks Attio to confirm the company has a deal in Magic (filtering out Rejected and Invested stages). It fetches the Fathom recording link via the Fathom API, logs it in Attio, then assembles and sends a Slack notification with the company name, AI-generated call summary, hyperlinked founder LinkedIn profiles, and Fathom recording link. The deal is automatically moved to "Deal Review" stage in Attio.

The lookback window is computed dynamically from the last successful run (stored in `last_notify.txt`), so even if a cron cycle is delayed, the next run catches everything in the gap (capped at 3 hours). Duplicate notifications are prevented via `notified_events.json` state tracking.

Unmatched calls (no deal found in Attio) automatically create a GitHub issue with diagnostic info showing where the match pipeline broke down.

## Actions

Ali gets two buttons on each Zoe notification:

- **To Deals** — Fetches the deal name, company description, founding team with LinkedIn profiles (from Company > Team in Attio), Fathom recording link, and deal links (Deck, Dataroom, Demo), then DMs Mae to add to the deals pipeline
- **Ali to Reject** — Updates the deal stage to "Ali to Reject" in Attio and drafts a rejection email in Gmail (threading into an existing conversation if one exists)

## Architecture

```
src/
  bot.ts                  # Entry point: cron + Slack Socket Mode
  notify.ts               # Post-call notification pipeline
  fathom-sync.ts          # Hourly Fathom recording link sync to Attio
  actions/
    registry.ts           # Action handler routing
    to-deals.ts           # DM Mae with deal info
    ali-to-reject.ts      # Reject + Gmail draft
  lib/
    attio.ts              # Attio CRM client
    fathom.ts             # Fathom recording API client
    gcal.ts               # Google Calendar polling
    gmail.ts              # Gmail search + rejection drafts
    slack.ts              # Slack message formatting + posting
    ai.ts                 # Claude API for call summaries
    config.ts             # Env var management + Google OAuth
    errors.ts             # Error classes, logger, GitHub issue creation
    state.ts              # File I/O for last_run, last_notify, notified_events
    http.ts               # fetchWithRetry with rate-limit handling
  types/
    crm.ts                # CRM interface (Attio implementation)
    recording.ts          # Recording interface (Fathom implementation)
templates/
  rejection_email.txt     # Rejection email template
future/                   # Parked features for later
scripts/                  # Utility scripts (e.g. Google OAuth reauth)
```

## Data flow

Attio (source of truth) / Fathom / Google Calendar / Gmail / Slack / Anthropic API

- **CRM interface** in `src/types/crm.ts`, implemented by `src/lib/attio.ts`
- **Recording interface** in `src/types/recording.ts`, implemented by `src/lib/fathom.ts`
- Deals object slug in Attio is `magic`

## Environment variables

| Variable | Purpose |
|---|---|
| `ATTIO_API_KEY` | Attio CRM API |
| `FATHOM_API_KEY` | Fathom recording API |
| `SLACK_BOT_TOKEN` | Slack bot (xoxb) |
| `SLACK_APP_TOKEN` | Slack Socket Mode (xapp) |
| `SLACK_CHANNEL` | Primary notification channel |
| `GOOGLE_CREDENTIALS_JSON` | Google OAuth credentials (JSON string) |
| `ANTHROPIC_API_KEY` | Claude API for AI summaries |
| `GITHUB_TOKEN` | GitHub API for unmatched call issues |

## Local development

```bash
npm ci
cp .env.example .env   # fill in credentials
npm run bot             # start bot + cron
npm run notify          # one-off notify check (--window 60 --dry-run)
npm run sync            # one-off Fathom sync
```
