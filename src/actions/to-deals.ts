import { createAttioCRM } from "../lib/attio.js";
import { postToDealsChannel } from "../lib/slack.js";
import { getFathomSummary } from "../lib/gmail.js";
import { summarizeTranscript } from "../lib/ai.js";
import { logger } from "../lib/errors.js";

export async function toDeals(payload: Record<string, string>) {
  const dealId = payload.deal_record_id ?? "";
  const dealName = payload.deal_name ?? "Unknown";
  const companyName = payload.company_name ?? "";
  const attendeeEmail = payload.attendee_email ?? "";

  const crm = createAttioCRM();
  const results: string[] = [];
  let overallSuccess = true;

  logger.info(`To Deals action for deal ${dealId} (${dealName})`);

  // 1. Get deal details for company record
  const dealDetails = dealId ? await crm.getDealDetails(dealId) : null;

  // 2. Get Fathom summary from Gmail and condense with Claude
  const fathomFullSummary = await getFathomSummary(dealName, attendeeEmail, companyName);
  const summary = fathomFullSummary
    ? await summarizeTranscript(fathomFullSummary, companyName)
    : "";

  // 3. Get LinkedIn links for attendees
  const linkedinLinks: string[] = [];
  if (attendeeEmail) {
    const personIds = await crm.findPersonByEmail(attendeeEmail);
    for (const pid of personIds) {
      const linkedin = await crm.getPersonLinkedin(pid);
      if (linkedin) linkedinLinks.push(linkedin);
    }
  }

  // 4. Get Fathom recording link from company
  let fathomLink = "";
  if (dealDetails?.companyRecordId) {
    fathomLink = await crm.getCompanyFathomLink(dealDetails.companyRecordId);
  }

  // 5. Get deck URL from deal links
  const deckUrl = dealId ? await crm.getDealDeckUrl(dealId) : "";

  // 6. Post to deals channel
  try {
    const ts = await postToDealsChannel(companyName, summary, linkedinLinks, fathomLink, deckUrl);
    if (ts) {
      results.push("Posted to deals channel");
    } else {
      results.push("Failed to post to deals channel");
      overallSuccess = false;
    }
  } catch (err) {
    results.push(`Failed to post to deals channel: ${err}`);
    logger.error(`Failed to post to deals channel: ${err}`);
    overallSuccess = false;
  }

  return {
    success: overallSuccess,
    message: results.length ? results.join("\n") : "Posted to deals channel",
  };
}
