import { createAttioCRM } from "../lib/attio.js";
import { createRejectionDraft } from "../lib/gmail.js";
import { logger } from "../lib/errors.js";

const STAGE_NAME = "Ali to Reject";

export async function aliToReject(payload: Record<string, string>) {
  const dealId = payload.deal_record_id ?? "";
  const dealName = payload.deal_name ?? "Unknown";
  const email = payload.attendee_email ?? "";
  const name = payload.attendee_name ?? "";
  const company = payload.company_name ?? "";

  const crm = createAttioCRM();
  const results: string[] = [];
  let overallSuccess = true;

  // 1. Update deal stage
  try {
    await crm.updateDealStage(dealId, STAGE_NAME);
    results.push(`Deal stage \u2192 *${STAGE_NAME}*`);
    logger.info(`Deal ${dealId} (${dealName}) stage updated to '${STAGE_NAME}'`);
  } catch (err) {
    results.push(`Failed to update deal stage: ${err}`);
    logger.error(`Failed to update deal ${dealId} stage: ${err}`);
    overallSuccess = false;
  }

  // 2. Create Gmail rejection draft
  if (email) {
    try {
      const allEmails = await crm.getAllPersonEmails(email);
      const draftId = await createRejectionDraft(email, name, company, allEmails);
      results.push(`Gmail draft created (id: ${draftId})`);
      logger.info(`Rejection draft created for ${email} (${company})`);
    } catch (err) {
      results.push(`Failed to create Gmail draft: ${err}`);
      logger.error(`Failed to create rejection draft for ${email}: ${err}`);
      overallSuccess = false;
    }
  } else {
    results.push("No attendee email — skipped Gmail draft");
    logger.warn(`No attendee email for deal ${dealId}, skipping Gmail draft`);
  }

  return { success: overallSuccess, message: results.join("\n") };
}
