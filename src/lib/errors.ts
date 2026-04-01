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

// -- GitHub Issues for unmatched calls / alerts --

const GITHUB_REPO = process.env.GITHUB_REPOSITORY ?? "haseona21/attio-sync";

export async function createGitHubIssue(title: string, body: string, labels: string[] = []) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    logger.warn("GITHUB_TOKEN not set — skipping GitHub issue creation");
    return;
  }

  try {
    const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title, body, labels }),
    });

    if (resp.ok) {
      const data = (await resp.json()) as { number: number; html_url: string };
      logger.info(`GitHub issue #${data.number} created: ${data.html_url}`);
    } else {
      logger.warn(`Failed to create GitHub issue: ${resp.status} ${await resp.text()}`);
    }
  } catch (err) {
    logger.warn(`Failed to create GitHub issue: ${err}`);
  }
}

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
