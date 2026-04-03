import "dotenv/config";
import type { CRM } from "./types/crm.js";
import type { Meeting, Recording } from "./types/recording.js";
import { extractDomain, IGNORED_DOMAINS } from "./types/crm.js";
import { createAttioCRM } from "./lib/attio.js";
import { createFathomRecording } from "./lib/fathom.js";
import { sendZoeMessage } from "./lib/slack.js";
import { summarizeTranscript } from "./lib/ai.js";
import {
  readLastRun,
  writeLastRun,
  loadNotifiedEvents,
  saveNotifiedEvents,
  stateKey,
} from "./lib/state.js";
import { ErrorCollector, createGitHubIssue, logger } from "./lib/errors.js";

function formatDate(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

// -- Deal matching (moved from notify.ts) --

interface DealMatch {
  dealRecordId: string;
  dealName: string;
  companyName: string;
  contactEmail: string;
  contactName: string;
  companyRecordId: string;
}

interface MatchDiagnostic {
  email: string;
  personFound: boolean;
  personIds: string[];
  dealsByPerson: number;
  dealsFilteredByStage: number;
  domain: string | null;
  domainIgnored: boolean;
  companyFound: boolean;
  companyIds: string[];
  dealsByCompany: number;
}

interface MatchResult {
  matches: DealMatch[];
  diagnostics: MatchDiagnostic[];
}

const EXCLUDED_STAGES = new Set(["Reject", "Invested"]);

async function matchAttendeesToDeals(
  crm: CRM,
  attendeeEmails: string[],
): Promise<MatchResult> {
  const matches: DealMatch[] = [];
  const diagnostics: MatchDiagnostic[] = [];
  const seenDealIds = new Set<string>();

  for (const email of attendeeEmails) {
    const diag: MatchDiagnostic = {
      email,
      personFound: false,
      personIds: [],
      dealsByPerson: 0,
      dealsFilteredByStage: 0,
      domain: extractDomain(email),
      domainIgnored: false,
      companyFound: false,
      companyIds: [],
      dealsByCompany: 0,
    };

    // Person → deal
    const personIds = await crm.findPersonByEmail(email);
    diag.personFound = personIds.length > 0;
    diag.personIds = personIds;

    for (const personId of personIds) {
      const deals = await crm.findDealsByPerson(personId);
      diag.dealsByPerson += deals.length;

      for (const deal of deals) {
        if (seenDealIds.has(deal.recordId)) continue;
        seenDealIds.add(deal.recordId);

        const person = await crm.getPersonDetails(personId);
        const details = await crm.getDealDetails(deal.recordId);

        if (details && EXCLUDED_STAGES.has(details.dealStage)) {
          logger.info(`  Skipping deal ${details.dealName} — stage "${details.dealStage}" excluded`);
          diag.dealsFilteredByStage++;
          continue;
        }

        let companyName = "";
        if (details?.companyRecordId) {
          companyName = await crm.getCompanyName(details.companyRecordId);
        }

        matches.push({
          dealRecordId: deal.recordId,
          dealName: details?.dealName ?? deal.dealName ?? "Unknown",
          companyName,
          contactEmail: email,
          contactName: person?.name ?? "",
          companyRecordId: details?.companyRecordId ?? "",
        });
      }
    }

    // Domain → company → deal
    const domain = diag.domain;
    if (!domain || IGNORED_DOMAINS.has(domain)) {
      diag.domainIgnored = !domain || IGNORED_DOMAINS.has(domain);
      diagnostics.push(diag);
      continue;
    }

    const companyIds = await crm.findCompanyByDomain(domain);
    diag.companyFound = companyIds.length > 0;
    diag.companyIds = companyIds;

    for (const companyId of companyIds) {
      const deals = await crm.findDealsByCompany(companyId);
      diag.dealsByCompany += deals.length;

      for (const deal of deals) {
        if (seenDealIds.has(deal.recordId)) continue;
        seenDealIds.add(deal.recordId);

        const details = await crm.getDealDetails(deal.recordId);

        if (details && EXCLUDED_STAGES.has(details.dealStage)) {
          logger.info(`  Skipping deal ${details.dealName} — stage "${details.dealStage}" excluded`);
          diag.dealsFilteredByStage++;
          continue;
        }

        const companyName = await crm.getCompanyName(companyId);

        matches.push({
          dealRecordId: deal.recordId,
          dealName: details?.dealName ?? deal.dealName ?? "Unknown",
          companyName,
          contactEmail: email,
          contactName: "",
          companyRecordId: companyId,
        });
      }
    }

    diagnostics.push(diag);
  }

  return { matches, diagnostics };
}

// -- Summary helpers --

async function getSummaryFromMeeting(
  meeting: Meeting,
  recording: Recording,
  companyName: string,
): Promise<string> {
  // Use Fathom's default_summary first
  if (meeting.defaultSummary) {
    logger.info(`Using Fathom default_summary for "${meeting.title}"`);
    return meeting.defaultSummary;
  }

  // Try inline transcript → Claude
  if (meeting.transcript) {
    return summarizeTranscript(meeting.transcript, companyName);
  }

  // Fetch transcript from dedicated endpoint
  const transcript = await recording.getTranscript(meeting.id);
  if (transcript) {
    logger.info(`Fetched transcript for "${meeting.title}" via getTranscript`);
    return summarizeTranscript(transcript, companyName);
  }

  return "";
}

async function buildLinkedinMap(
  crm: CRM,
  emails: string[],
): Promise<Record<string, { name: string; linkedin: string }>> {
  const map: Record<string, { name: string; linkedin: string }> = {};
  for (const email of emails) {
    const personIds = await crm.findPersonByEmail(email);
    if (!personIds.length) continue;
    const details = await crm.getPersonDetails(personIds[0]);
    const linkedin = await crm.getPersonLinkedin(personIds[0]);
    if (details) {
      map[email] = { name: details.name, linkedin };
    }
  }
  return map;
}

// -- Main sync + notify flow --

async function syncAndNotify(
  crm: CRM,
  recording: Recording,
  since: string | null,
  dryRun: boolean,
) {
  const meetings = await recording.fetchMeetings(since);
  if (!meetings.length) {
    logger.info("No new meetings found.");
    return;
  }

  const errors = new ErrorCollector();
  const state = loadNotifiedEvents();
  const stats = { people: 0, skipped: 0, notifications: 0 };

  for (let i = 0; i < meetings.length; i++) {
    const m = meetings[i];
    logger.info(`[${i + 1}/${meetings.length}] ${m.title}`);

    const external = m.invitees.filter((inv) => inv.isExternal && inv.email);
    if (!external.length) {
      logger.info("  No external invitees — skipping.");
      stats.skipped++;
      continue;
    }

    const attendeeEmails = external.map((inv) => inv.email);

    // --- Sync: update People fathom_links ---
    const date = formatDate(m.scheduledStartTime ?? m.createdAt);
    const linkEntry = `(${date}): ${m.shareUrl}`;

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

    // --- Notify: match to deals and post to Slack ---
    try {
      const { matches, diagnostics } = await matchAttendeesToDeals(crm, attendeeEmails);

      if (!matches.length) {
        const allFilteredByStage = diagnostics.some((d) => d.dealsFilteredByStage > 0)
          && diagnostics.every((d) => d.dealsByPerson === d.dealsFilteredByStage && d.dealsByCompany === 0 || d.dealsByCompany === d.dealsFilteredByStage);

        if (allFilteredByStage) {
          logger.info(`  All deals filtered by stage for "${m.title}" — skipping`);
        } else {
          logger.info(`  No deal matches for "${m.title}"`);
          const unmatchedKey = stateKey(m.id, "unmatched");
          if (!(unmatchedKey in state) && !dryRun) {
            const diagLines = diagnostics.map((d) => {
              const steps: string[] = [`  - \`${d.email}\``];
              if (d.personFound) {
                steps.push(`    - Person found (${d.personIds.join(", ")})`);
                steps.push(`    - Deals via primary_contact: ${d.dealsByPerson}`);
              } else {
                steps.push(`    - No person found in Attio`);
              }
              if (d.domainIgnored) {
                steps.push(`    - Domain \`${d.domain ?? "none"}\` is personal/ignored — company lookup skipped`);
              } else if (d.domain) {
                if (d.companyFound) {
                  steps.push(`    - Company found for \`${d.domain}\` (${d.companyIds.join(", ")})`);
                  steps.push(`    - Deals via company: ${d.dealsByCompany}`);
                } else {
                  steps.push(`    - No company found for \`${d.domain}\``);
                }
              }
              return steps.join("\n");
            });

            await createGitHubIssue(
              `Unmatched call: ${m.title}`,
              [
                `**Meeting:** ${m.title}`,
                `**Ended:** ${m.createdAt}`,
                `**Attendees:** ${attendeeEmails.join(", ")}`,
                "",
                "### Match pipeline results",
                "",
                ...diagLines,
              ].join("\n"),
              ["unmatched-call"],
            );
            state[unmatchedKey] = new Date().toISOString();
          }
        }
        continue;
      }

      logger.info(`  Found ${matches.length} deal match(es)`);

      for (const match of matches) {
        const key = stateKey(m.id, match.dealRecordId);
        if (key in state) {
          logger.info(`  Already notified for ${key}, skipping`);
          continue;
        }

        if (dryRun) {
          logger.info(`  [DRY RUN] Would send: deal=${match.dealName} company=${match.companyName}`);
        } else {
          try {
            const summary = await getSummaryFromMeeting(m, recording, match.companyName);
            const linkedinMap = await buildLinkedinMap(crm, attendeeEmails);

            await sendZoeMessage({
              dealRecordId: match.dealRecordId,
              dealName: match.dealName,
              companyName: match.companyName,
              contactEmail: match.contactEmail,
              contactName: match.contactName,
              summary,
              fathomLink: m.shareUrl,
              attendeeEmails,
              linkedinMap,
              eventId: m.id,
              meetingTitle: m.title,
              endTime: m.createdAt,
            });

            await crm.updateDealStage(match.dealRecordId, "Deal Review");
            stats.notifications++;
          } catch (err) {
            errors.add(`slack_send:${match.dealRecordId}`, err);
            continue;
          }
        }

        state[key] = new Date().toISOString();
      }
    } catch (err) {
      errors.add(`notify:${m.id}`, err);
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  if (!dryRun) saveNotifiedEvents(state);

  logger.info(`Summary — People: ${stats.people}, Notifications: ${stats.notifications}, Skipped: ${stats.skipped}`);
  if (errors.hasErrors) {
    logger.warn(`Run completed with errors:\n${errors.summary()}`);
  }
}

export async function runSync() {
  const crm = createAttioCRM();
  const recording = createFathomRecording();
  const runStartedAt = new Date().toISOString();
  const lastRun = readLastRun();
  await syncAndNotify(crm, recording, lastRun, false);
  writeLastRun(runStartedAt);
  logger.info(`Last run updated to ${runStartedAt}`);
}

// CLI entrypoint
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/fathom-sync.ts");
if (isMain) {
  const args = process.argv.slice(2);
  const backfill = args.includes("--backfill");
  const dryRun = args.includes("--dry-run");
  const daysIdx = args.indexOf("--days");
  const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1], 10) : 14;

  const crm = createAttioCRM();
  const recording = createFathomRecording();

  if (backfill) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    logger.info(`Backfill mode: fetching meetings from the last ${days} days`);
    syncAndNotify(crm, recording, since, dryRun).catch((err) => {
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
