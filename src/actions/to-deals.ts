import { createAttioCRM } from "../lib/attio.js";
import { postToDealsChannel } from "../lib/slack.js";
import { logger } from "../lib/errors.js";

export async function toDeals(payload: Record<string, string>) {
  const dealId = payload.deal_record_id ?? "";
  const companyName = payload.company_name ?? "";
  const attendeeEmail = payload.attendee_email ?? "";
  const summary = payload.summary ?? "";
  const fathomLink = payload.fathom_link ?? "";

  const crm = createAttioCRM();

  logger.info(`To Deals action for deal ${dealId} (${companyName})`);

  // 1. Get company description + team from Attio
  let description = "";
  const linkedinLinks: string[] = [];
  if (dealId) {
    const details = await crm.getDealDetails(dealId);
    if (details?.companyRecordId) {
      description = await crm.getCompanyDescription(details.companyRecordId);
      const team = await crm.getCompanyTeam(details.companyRecordId);
      for (const member of team) {
        if (member.linkedin) {
          linkedinLinks.push(`<${member.linkedin}|${member.name}>`);
        } else {
          linkedinLinks.push(member.name);
        }
      }
    }
  }

  // 4. Get all deal links (Deck, Dataroom, Demo, etc.)
  const dealLinks = dealId ? await crm.getDealLinkedRecords(dealId) : [];

  // 5. Get files uploaded to the deal record
  const dealFiles = dealId ? await crm.getDealFiles(dealId) : [];
  const files: { name: string; downloadUrl: string }[] = [];
  for (const file of dealFiles) {
    const downloadUrl = await crm.getFileDownloadUrl(file.fileId);
    files.push({ name: file.name, downloadUrl });
  }

  // 6. Post to deals channel
  try {
    const ts = await postToDealsChannel({
      companyName,
      summary: description || summary,
      linkedinLinks,
      fathomLink,
      dealLinks,
      files,
    });

    if (ts) {
      return { success: true, message: "Posted to deals channel" };
    }
    return { success: false, message: "Failed to post to deals channel" };
  } catch (err) {
    logger.error(`Failed to post to deals channel: ${err}`);
    return { success: false, message: `Failed to post to deals channel: ${err}` };
  }
}
