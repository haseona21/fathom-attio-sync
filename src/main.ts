import "dotenv/config";
import { createServer } from "node:http";
import cron from "node-cron";
import { startBot } from "./bot.js";
import { runSync } from "./fathom-sync.js";
import { logger } from "./lib/errors.js";
import { sendAlertDM } from "./lib/slack.js";

function isPTBusinessHours(): boolean {
  const now = new Date();
  const pt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(now);

  const hour = parseInt(pt.find((p) => p.type === "hour")!.value, 10);
  const weekday = pt.find((p) => p.type === "weekday")!.value;
  const isWeekday = !["Sat", "Sun"].includes(weekday);

  return isWeekday && hour >= 5 && hour < 21;
}

// Health check for Railway
const PORT = parseInt(process.env.PORT ?? "3000", 10);
createServer((_, res) => {
  res.writeHead(200);
  res.end("ok");
}).listen(PORT, () => {
  logger.info(`Health check listening on port ${PORT}`);
});

// Start Slack bot
startBot().catch((err) => {
  logger.error("Failed to start bot:", err);
  sendAlertDM(`Bot failed to start: ${err}`);
});

// Fathom sync + notify — every 10 min during PT business hours
cron.schedule("*/10 * * * *", async () => {
  if (!isPTBusinessHours()) return;
  logger.info("Cron: starting fathom sync + notify");
  try {
    await runSync();
  } catch (err) {
    logger.error("Cron: fathom sync failed:", err);
    await sendAlertDM(`Fathom sync failed: ${err}`);
  }
});

logger.info("Main process started — bot + cron schedule active");
