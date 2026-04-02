import "dotenv/config";
import { extractDomain, IGNORED_DOMAINS } from "./types/crm.js";
import type { CRM } from "./types/crm.js";
import type { Recording } from "./types/recording.js";
import { createAttioCRM } from "./lib/attio.js";
import { createFathomRecording } from "./lib/fathom.js";
import { getRecentlyEndedMeetings, type CalendarMeeting } from "./lib/gcal.js";
import { getFathomSummary } from "./lib/gmail.js";
import { sendZoeMessage } from "./lib/slack.js";
import { summarizeTranscript } from "./lib/ai.js";
import { loadNotifiedEvents, saveNotifiedEvents, stateKey, readLastNotify, writeLastNotify } from "./lib/state.js";
import { ErrorCollector, createGitHubIssue, logger } from "./lib/errors.js";

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

async function getCallSummary(
  recording: Recording,
  meetingTitle: string,
  attendeeEmails: string[],
  companyName: string,
): Promise<{ summary: string; fathomLink: string }> {
  // Fetch only today's Fathom meetings
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const meetings = await recording.fetchMeetings(todayStart.toISOString());

  // Match strategy: attendee email first, then title fallback
  let fathomMeeting = meetings.find((m) =>
    m.invitees.some((inv) =>
      attendeeEmails.some((email) => inv.email.toLowerCase() === email.toLowerCase()),
    ),
  );

  // Fallback to title match
  if (!fathomMeeting) {
    const titleLower = meetingTitle.toLowerCase();
    fathomMeeting = meetings.find((m) => {
      const ft = m.title.toLowerCase();
      return ft.includes(titleLower) || titleLower.includes(ft);
    });
  }

  logger.info(
    `Fathom match for "${meetingTitle}": ${fathomMeeting ? `found "${fathomMeeting.title}" (id: ${fathomMeeting.id})` : "not found"} (searched ${meetings.length} meetings today)`,
  );

  let fathomLink = "";
  let summaryText = "";

  if (fathomMeeting) {
    fathomLink = fathomMeeting.shareUrl;

    // Use Fathom's default_summary first (already processed by Fathom)
    if (fathomMeeting.defaultSummary) {
      summaryText = fathomMeeting.defaultSummary;
      logger.info(`Using Fathom default_summary for "${meetingTitle}"`);
    }
    // Then try inline transcript → Claude
    else if (fathomMeeting.transcript) {
      summaryText = await summarizeTranscript(fathomMeeting.transcript, companyName);
    }
    // Fetch transcript from dedicated endpoint if not in list response
    else {
      const transcript = await recording.getTranscript(fathomMeeting.id);
      if (transcript) {
        logger.info(`Fetched transcript for "${meetingTitle}" via getTranscript`);
        summaryText = await summarizeTranscript(transcript, companyName);
      }
    }
  }

  // Fallback to Gmail Fathom email → Claude
  if (!summaryText) {
    const attendeeEmail = attendeeEmails[0] ?? "";
    const gmailText = await getFathomSummary(meetingTitle, attendeeEmail, companyName);
    if (gmailText) {
      summaryText = await summarizeTranscript(gmailText, companyName);
    }
  }

  return { summary: summaryText, fathomLink };
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

async function run(dryRun: boolean, fallbackWindowMinutes: number) {
  const errors = new ErrorCollector();
  const state = loadNotifiedEvents();
  const crm = createAttioCRM();
  const recording = createFathomRecording();

  // Use last notify timestamp for window, fall back to fixed window
  const lastNotify = readLastNotify();
  const now = new Date();
  let windowMinutes: number;

  if (lastNotify) {
    const elapsed = Math.ceil((now.getTime() - new Date(lastNotify).getTime()) / 60_000);
    // Cap at 180 min to avoid scanning too far back (e.g. overnight)
    windowMinutes = Math.min(Math.max(elapsed, fallbackWindowMinutes), 180);
  } else {
    windowMinutes = fallbackWindowMinutes;
  }

  logger.info(`Starting notification run (dry_run=${dryRun}, window=${windowMinutes}m, last_notify=${lastNotify ?? "none"})`);

  // Save the check timestamp now so the next run covers from this point
  if (!dryRun) writeLastNotify(now.toISOString());

  let meetings: CalendarMeeting[];
  try {
    meetings = await getRecentlyEndedMeetings(windowMinutes);
  } catch (err) {
    errors.add("calendar_poll", err);
    return;
  }

  if (!meetings.length) {
    logger.info("No recently ended meetings found.");
    return;
  }

  logger.info(`Found ${meetings.length} recently ended meetings`);
  let notificationsSent = 0;

  for (const meeting of meetings) {
    try {
      logger.info(`Processing meeting: ${meeting.title} (${meeting.eventId})`);
      const { matches, diagnostics } = await matchAttendeesToDeals(crm, meeting.attendeeEmails);

      if (!matches.length) {
        const allFilteredByStage = diagnostics.some((d) => d.dealsFilteredByStage > 0)
          && diagnostics.every((d) => d.dealsByPerson === d.dealsFilteredByStage && d.dealsByCompany === 0 || d.dealsByCompany === d.dealsFilteredByStage);

        if (allFilteredByStage) {
          logger.info(`  All deals filtered by stage for meeting '${meeting.title}' — skipping`);
          continue;
        }

        logger.info(`  No deal matches for meeting '${meeting.title}'`);
        const unmatchedKey = stateKey(meeting.eventId, "unmatched");
        if (unmatchedKey in state) {
          logger.info(`  Already filed unmatched issue for ${meeting.eventId}, skipping`);
          continue;
        }
        if (!dryRun) {
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
            `Unmatched call: ${meeting.title}`,
            [
              `**Meeting:** ${meeting.title}`,
              `**Ended:** ${meeting.endTime}`,
              `**Attendees:** ${meeting.attendeeEmails.join(", ")}`,
              "",
              "### Match pipeline results",
              "",
              ...diagLines,
            ].join("\n"),
            ["unmatched-call"],
          );
          state[unmatchedKey] = new Date().toISOString();
        }
        continue;
      }

      logger.info(`  Found ${matches.length} deal match(es)`);

      for (const match of matches) {
        const key = stateKey(meeting.eventId, match.dealRecordId);
        if (key in state) {
          logger.info(`  Already notified for ${key}, skipping`);
          continue;
        }

        if (dryRun) {
          logger.info(`  [DRY RUN] Would send: deal=${match.dealName} company=${match.companyName}`);
        } else {
          try {
            // Get transcript + summary + fathom link
            const { summary, fathomLink } = await getCallSummary(
              recording,
              meeting.title,
              meeting.attendeeEmails,
              match.companyName,
            );

            // Build LinkedIn map for attendees
            const linkedinMap = await buildLinkedinMap(crm, meeting.attendeeEmails);

            await sendZoeMessage({
              dealRecordId: match.dealRecordId,
              dealName: match.dealName,
              companyName: match.companyName,
              contactEmail: match.contactEmail,
              contactName: match.contactName,
              summary,
              fathomLink,
              attendeeEmails: meeting.attendeeEmails,
              linkedinMap,
              eventId: meeting.eventId,
              meetingTitle: meeting.title,
              endTime: meeting.endTime,
            });

            notificationsSent++;
          } catch (err) {
            errors.add(`slack_send:${match.dealRecordId}`, err);
            continue;
          }
        }

        state[key] = new Date().toISOString();
      }
    } catch (err) {
      errors.add(`meeting:${meeting.eventId}`, err);
    }
  }

  if (!dryRun) saveNotifiedEvents(state);

  logger.info(`Run complete. Notifications sent: ${notificationsSent}`);
  if (errors.hasErrors) {
    logger.warn(`Run completed with errors:\n${errors.summary()}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const windowIdx = args.indexOf("--window");
  const window = windowIdx >= 0 ? parseInt(args[windowIdx + 1], 10) : 10;

  await run(dryRun, window);
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
