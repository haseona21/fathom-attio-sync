export class AttioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttioError";
  }
}

export class SlackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackError";
  }
}

export class GmailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GmailError";
  }
}

export class CalendarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarError";
  }
}

const LOG_LEVEL = (process.env.LOG_LEVEL ?? "INFO").toUpperCase();
const LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const;
const levelIndex = LEVELS.indexOf(LOG_LEVEL as (typeof LEVELS)[number]);

function ts() {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

export const logger = {
  debug(...args: unknown[]) {
    if (levelIndex <= 0) console.log(`${ts()}  DEBUG   `, ...args);
  },
  info(...args: unknown[]) {
    if (levelIndex <= 1) console.log(`${ts()}  INFO    `, ...args);
  },
  warn(...args: unknown[]) {
    if (levelIndex <= 2) console.warn(`${ts()}  WARN    `, ...args);
  },
  error(...args: unknown[]) {
    console.error(`${ts()}  ERROR   `, ...args);
  },
};

export class ErrorCollector {
  errors: { context: string; error: string }[] = [];

  add(context: string, error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    this.errors.push({ context, error: msg });
    logger.error(`Error in ${context}: ${msg}`);
  }

  get hasErrors() {
    return this.errors.length > 0;
  }

  summary(): string {
    if (!this.errors.length) return "No errors.";
    const lines = this.errors.map((e) => `  - [${e.context}] ${e.error}`);
    return `${this.errors.length} error(s):\n${lines.join("\n")}`;
  }
}
