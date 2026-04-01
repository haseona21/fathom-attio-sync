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

  // 1. Get LinkedIn links for attendees
  const linkedinLinks: string[] = [];
  if (attendeeEmail) {
    const personIds = await crm.findPersonByEmail(attendeeEmail);
    for (const pid of personIds) {
      const person = await crm.getPersonDetails(pid);
      const linkedin = await crm.getPersonLinkedin(pid);
      if (linkedin && person?.name) {
        linkedinLinks.push(`<${linkedin}|${person.name}>`);
      } else if (linkedin) {
        linkedinLinks.push(linkedin);
      }
    }
  }

  // 2. Get all deal links (Deck, Dataroom, Demo, etc.)
  const dealLinks = dealId ? await crm.getDealLinkedRecords(dealId) : [];

  // 3. Get files uploaded to the deal record
  const dealFiles = dealId ? await crm.getDealFiles(dealId) : [];
  const files: { name: string; downloadUrl: string }[] = [];
  for (const file of dealFiles) {
    const downloadUrl = await crm.getFileDownloadUrl(file.fileId);
    files.push({ name: file.name, downloadUrl });
  }

  // 4. Post to deals channel
  try {
    const ts = await postToDealsChannel({
      companyName,
      summary,
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
