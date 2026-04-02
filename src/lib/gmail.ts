import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { google } from "googleapis";
import { getGoogleAuth } from "./config.js";
import { GmailError, logger } from "./errors.js";

const TEMPLATE_DIR = resolve(import.meta.dirname, "../../templates");

function getGmailService() {
  return google.gmail({ version: "v1", auth: getGoogleAuth() });
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractTextFromPayload(payload: Record<string, unknown>): string {
  const mimeType = String(payload.mimeType ?? "");

  if (mimeType === "text/plain") {
    const body = payload.body as Record<string, unknown> | undefined;
    const data = String(body?.data ?? "");
    if (data) return Buffer.from(data, "base64url").toString("utf-8");
  }

  if (mimeType === "text/html") {
    const body = payload.body as Record<string, unknown> | undefined;
    const data = String(body?.data ?? "");
    if (data) return stripHtml(Buffer.from(data, "base64url").toString("utf-8"));
  }

  // Check multipart parts — prefer text/plain over text/html
  const parts = (payload.parts ?? []) as Record<string, unknown>[];
  for (const preferred of ["text/plain", "text/html"]) {
    for (const part of parts) {
      if (String(part.mimeType ?? "") === preferred) {
        const text = extractTextFromPayload(part);
        if (text) return text;
      }
    }
  }

  // Recurse into any remaining parts
  for (const part of parts) {
    const text = extractTextFromPayload(part);
    if (text) return text;
  }

  return "";
}

export async function getFathomSummary(
  meetingTitle: string,
  attendeeEmail = "",
  companyName = "",
): Promise<string> {
  const gmail = getGmailService();

  // Fathom email subjects are "Recap of your meeting with {company/email}"
  // Try multiple search strategies
  const queries = [
    companyName && `from:no-reply@fathom.video subject:"${companyName}"`,
    attendeeEmail && `from:no-reply@fathom.video subject:"${attendeeEmail}"`,
    `from:no-reply@fathom.video subject:"${meetingTitle}"`,
  ].filter(Boolean) as string[];

  for (const query of queries) {
    try {
      const res = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 1 });
      const messages = res.data.messages ?? [];
      if (!messages.length) continue;

      const msg = await gmail.users.messages.get({ userId: "me", id: messages[0].id!, format: "full" });
      const payload = msg.data.payload as Record<string, unknown> | undefined;
      if (!payload) continue;

      const body = extractTextFromPayload(payload);
      if (body) {
        logger.info(`Fathom summary found via query "${query}" (${body.length} chars)`);
        return body;
      }
    } catch (err) {
      logger.warn(`Fathom email search failed for query "${query}": ${err}`);
    }
  }

  logger.info(`No Fathom email found for meeting: ${meetingTitle}`);
  return "";
}

const CALENDAR_PATTERNS = [
  /^(Accepted|Declined|Tentative|Updated invitation|Canceled event):/i,
  /^Invitation:/i,
  /^.+ @ .+ \(.*\)$/,  // Google Calendar format: "Event @ Time (Timezone)"
];

const AUTOMATED_SENDERS = [
  "no-reply@fathom.video",
  "calendar-notification@google.com",
  "noreply@google.com",
];

function isCalendarOrAutomated(subject: string, from: string): boolean {
  const fromLower = from.toLowerCase();
  if (AUTOMATED_SENDERS.some((s) => fromLower.includes(s))) return true;
  if (CALENDAR_PATTERNS.some((p) => p.test(subject))) return true;
  return false;
}

async function findExistingThread(
  gmail: ReturnType<typeof getGmailService>,
  emails: string[],
): Promise<{ threadId: string; messageId: string; subject: string } | null> {
  // Build proper Gmail search: from: or to: for each email
  const emailFilters = emails
    .flatMap((e) => [`from:${e}`, `to:${e}`])
    .join(" OR ");
  const query = `(${emailFilters})`;

  let messages: { id: string }[] = [];
  try {
    const res = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 10 });
    messages = (res.data.messages ?? []) as { id: string }[];
  } catch (err) {
    logger.warn(`Thread search failed: ${err}`);
    return null;
  }

  if (!messages.length) {
    logger.info(`No emails found for ${emails.join(", ")}`);
    return null;
  }

  // Fetch headers for each message and score them
  type Candidate = { threadId: string; messageId: string; subject: string; isReal: boolean };
  const candidates: Candidate[] = [];

  for (const m of messages) {
    try {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: m.id,
        format: "metadata",
        metadataHeaders: ["Message-ID", "Subject", "From"],
      });

      const headers: Record<string, string> = {};
      for (const h of msg.data.payload?.headers ?? []) {
        headers[h.name!] = h.value!;
      }

      const subject = headers["Subject"] ?? "";
      const from = headers["From"] ?? "";
      const isReal = !isCalendarOrAutomated(subject, from);

      candidates.push({
        threadId: msg.data.threadId!,
        messageId: headers["Message-ID"] ?? "",
        subject,
        isReal,
      });
    } catch (err) {
      logger.warn(`Failed to fetch message ${m.id}: ${err}`);
    }
  }

  // Pick the best: prefer real conversations (first = most recent), fall back to calendar
  const best = candidates.find((c) => c.isReal) ?? candidates[0] ?? null;

  if (best) {
    logger.info(
      `Thread match for ${emails[0]}: "${best.subject}" (${best.isReal ? "conversation" : "calendar/auto"})`,
    );
    return { threadId: best.threadId, messageId: best.messageId, subject: best.subject };
  }

  return null;
}

export async function createRejectionDraft(
  toEmail: string,
  toName: string,
  companyName: string,
  allEmails?: string[],
): Promise<string | null> {
  const gmail = getGmailService();

  const template = readFileSync(resolve(TEMPLATE_DIR, "rejection_email.txt"), "utf-8");

  // Parse subject from template
  const lines = template.trim().split("\n");
  let subject = "";
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("Subject:")) {
      subject = lines[i].slice("Subject:".length).trim();
      bodyStart = i + 1;
      break;
    }
  }

  let body = lines.slice(bodyStart).join("\n").trim();
  const firstName = toName ? toName.split(" ")[0] : "there";
  subject = subject.replace("{company_name}", companyName || "your company");
  body = body.replaceAll("{founder_name}", firstName);
  body = body.replaceAll("{company_name}", companyName || "your company");

  // Check for existing thread
  const existing = await findExistingThread(gmail, allEmails ?? [toEmail]);

  // Build MIME message
  const mimeLines = [
    `To: ${toEmail}`,
    `Content-Type: text/plain; charset=utf-8`,
  ];

  const draftBody: Record<string, unknown> = {};

  if (existing) {
    mimeLines.push(`Subject: Re: ${existing.subject || subject}`);
    if (existing.messageId) {
      mimeLines.push(`In-Reply-To: ${existing.messageId}`);
      mimeLines.push(`References: ${existing.messageId}`);
    }
    draftBody.message = { threadId: existing.threadId };
    logger.info(`Replying in existing thread ${existing.threadId} for ${toEmail}`);
  } else {
    mimeLines.push(`Subject: ${subject || "Following up"}`);
  }

  mimeLines.push("", body);
  const raw = Buffer.from(mimeLines.join("\r\n")).toString("base64url");

  const message = (draftBody.message ?? {}) as Record<string, unknown>;
  message.raw = raw;
  draftBody.message = message;

  try {
    const draft = await gmail.users.drafts.create({
      userId: "me",
      requestBody: draftBody as { message: { raw: string; threadId?: string } },
    });
    const draftId = draft.data.id!;
    logger.info(`Gmail draft created (id: ${draftId}) to ${toEmail}`);
    return draftId;
  } catch (err) {
    throw new GmailError(`Failed to create Gmail draft: ${err}`);
  }
}
