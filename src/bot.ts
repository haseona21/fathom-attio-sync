import "dotenv/config";
import { App } from "@slack/bolt";
import { ACTION_HANDLERS } from "./actions/registry.js";
import { updateMessageWithResult } from "./lib/slack.js";
import { logger } from "./lib/errors.js";

const appToken = process.env.SLACK_APP_TOKEN;
if (!appToken) {
  logger.error("SLACK_APP_TOKEN not set — required for Socket Mode");
  process.exit(1);
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN!,
  appToken,
  socketMode: true,
});

app.action(/.*/, async ({ ack, body, action }) => {
  await ack();

  const act = action as { action_id?: string; value?: string; text?: { text?: string } };
  const actionId = act.action_id ?? "";
  const handler = ACTION_HANDLERS[actionId];
  if (!handler) {
    logger.warn(`No handler for action: ${actionId}`);
    return;
  }

  const userId = (body as { user?: { id?: string } }).user?.id ?? "unknown";
  const userName = (body as { user?: { username?: string } }).user?.username ?? "unknown";
  const channel = (body as { channel?: { id?: string } }).channel?.id ?? "";
  const messageTs = (body as { message?: { ts?: string } }).message?.ts ?? "";
  const originalBlocks = (body as { message?: { blocks?: unknown[] } }).message?.blocks ?? [];

  logger.info(`Slack interaction: action=${actionId} user=${userName} channel=${channel}`);

  let payload: Record<string, string>;
  try {
    payload = JSON.parse(act.value ?? "{}");
  } catch {
    logger.error(`Failed to parse button value for action ${actionId}`);
    return;
  }

  let result: { success: boolean; message: string };
  try {
    result = await handler(payload);
  } catch (err) {
    logger.error(`Action handler ${actionId} failed:`, err);
    result = { success: false, message: `Error: ${err}` };
  }

  const actionLabel = act.text?.text ?? actionId;
  const status = result.success ? "Done" : "Failed";

  try {
    await updateMessageWithResult(
      channel,
      messageTs,
      `${actionLabel} \u2014 ${status}`,
      userId,
      result.message,
      originalBlocks,
    );
  } catch (err) {
    logger.error(`Failed to update Slack message: ${err}`);
  }
});

app.start().then(() => {
  logger.info("Zoe bot running (Socket Mode)");
});
