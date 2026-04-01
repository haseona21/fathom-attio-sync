import { toDeals } from "./to-deals.js";
import { aliToReject } from "./ali-to-reject.js";
import { dealReview } from "./deal-review.js";

export type ActionHandler = (
  payload: Record<string, string>,
) => Promise<{ success: boolean; message: string }>;

export const ACTION_HANDLERS: Record<string, ActionHandler> = {
  to_deals: toDeals,
  ali_to_reject: aliToReject,
  deal_review: dealReview,
};
