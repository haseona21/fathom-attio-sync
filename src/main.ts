import "dotenv/config";
import { createServer } from "node:http";
import cron from "node-cron";
import { startBot } from "./bot.js";
import { runSync } from "./fathom-sync.js";
import { runNotify } from "./notify.js";
import { logger } from "./lib/errors.js";

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
});

// Fathom sync — every hour
cron.schedule("0 * * * *", async () => {
  logger.info("Cron: starting fathom sync");
  try {
    await runSync();
  } catch (err) {
    logger.error("Cron: fathom sync failed:", err);
  }
});

// Notify — every 10 min during PT business hours
cron.schedule("*/10 * * * *", async () => {
  if (!isPTBusinessHours()) return;
  logger.info("Cron: starting notify check");
  try {
    await runNotify(false, 10);
  } catch (err) {
    logger.error("Cron: notify failed:", err);
  }
});

logger.info("Main process started — bot + cron schedules active");
