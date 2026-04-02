import "dotenv/config";
import type { CRM } from "./types/crm.js";
import type { Recording } from "./types/recording.js";
import { extractDomain, IGNORED_DOMAINS } from "./types/crm.js";
import { createAttioCRM } from "./lib/attio.js";
import { createFathomRecording } from "./lib/fathom.js";
import { readLastRun, writeLastRun } from "./lib/state.js";
import { logger } from "./lib/errors.js";

function formatDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

async function syncMeetings(
  crm: CRM,
  recording: Recording,
  since: string | null,
) {
  const meetings = await recording.fetchMeetings(since);
  if (!meetings.length) {
    logger.info("No new meetings found.");
    return;
  }

  const stats = { people: 0, companies: 0, skipped: 0 };

  for (let i = 0; i < meetings.length; i++) {
    const m = meetings[i];
    logger.info(`[${i + 1}/${meetings.length}] ${m.title}`);

    const external = m.invitees.filter((inv) => inv.isExternal && inv.email);
    if (!external.length) {
      logger.info("  No external invitees — skipping.");
      stats.skipped++;
      continue;
    }

    const date = formatDate(m.scheduledStartTime ?? m.createdAt);
    const linkEntry = `(${date}): ${m.shareUrl}`;

    // People
    for (const inv of external) {
      const recordIds = await crm.findPersonByEmail(inv.email);
      if (!recordIds.length) {
        logger.info(`  No Attio person found for ${inv.email}`);
        continue;
      }
      for (const recordId of recordIds) {
        const ok = await crm.appendLink("people", recordId, linkEntry);
        if (ok) {
          logger.info(`  Updated person ${inv.email}`);
          stats.people++;
        }
      }
    }

    // Companies (one per unique domain)
    const seenDomains = new Set<string>();
    for (const inv of external) {
      const domain = extractDomain(inv.email);
      if (!domain || IGNORED_DOMAINS.has(domain) || seenDomains.has(domain)) continue;
      seenDomains.add(domain);

      const recordIds = await crm.findCompanyByDomain(domain);
      if (!recordIds.length) {
        logger.info(`  No Attio company found for @${domain}`);
        continue;
      }
      for (const recordId of recordIds) {
        const ok = await crm.appendLink("companies", recordId, linkEntry);
        if (ok) {
          logger.info(`  Updated company @${domain}`);
          stats.companies++;
        }
      }
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  logger.info(`Summary — People: ${stats.people}, Companies: ${stats.companies}, Skipped: ${stats.skipped}`);
}

export async function runSync() {
  const crm = createAttioCRM();
  const recording = createFathomRecording();
  const runStartedAt = new Date().toISOString();
  const lastRun = readLastRun();
  await syncMeetings(crm, recording, lastRun);
  writeLastRun(runStartedAt);
  logger.info(`Last run updated to ${runStartedAt}`);
}

// CLI entrypoint
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/fathom-sync.ts");
if (isMain) {
  const args = process.argv.slice(2);
  const backfill = args.includes("--backfill");
  const daysIdx = args.indexOf("--days");
  const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1], 10) : 14;

  const crm = createAttioCRM();
  const recording = createFathomRecording();

  if (backfill) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    logger.info(`Backfill mode: fetching meetings from the last ${days} days`);
    syncMeetings(crm, recording, since).catch((err) => {
      logger.error("Fatal error:", err);
      process.exit(1);
    });
  } else {
    runSync().catch((err) => {
      logger.error("Fatal error:", err);
      process.exit(1);
    });
  }
}
