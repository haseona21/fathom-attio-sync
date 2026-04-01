import { createAttioCRM } from "../lib/attio.js";
import { AttioError, logger } from "../lib/errors.js";

const STAGE_NAME = "Deal Review";

export async function dealReview(payload: Record<string, string>) {
  const dealId = payload.deal_record_id ?? "";
  const dealName = payload.deal_name ?? "Unknown";
  const crm = createAttioCRM();

  try {
    await crm.updateDealStage(dealId, STAGE_NAME);
    logger.info(`Deal ${dealId} (${dealName}) stage updated to '${STAGE_NAME}'`);
    return { success: true, message: `Deal stage \u2192 *${STAGE_NAME}*` };
  } catch (err) {
    const msg = err instanceof AttioError ? err.message : String(err);
    logger.error(`Failed to update deal ${dealId} stage: ${msg}`);
    return { success: false, message: `Failed to update deal stage: ${msg}` };
  }
}
