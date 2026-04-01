import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { google } from "googleapis";
import { getGoogleAuth } from "./config.js";
import { GmailError, logger } from "./errors.js";

const TEMPLATE_DIR = resolve(import.meta.dirname, "../../templates");

function getGmailService() {
  return google.gmail({ version: "v1", auth: getGoogleAuth() });
}

function extractTextFromPayload(payload: Record<string, unknown>): string {
  const mimeType = String(payload.mimeType ?? "");

  if (mimeType === "text/plain") {
    const body = payload.body as Record<string, unknown> | undefined;
    const data = String(body?.data ?? "");
    if (data) return Buffer.from(data, "base64url").toString("utf-8");
  }

  const parts = (payload.parts ?? []) as Record<string, unknown>[];
  for (const part of parts) {
    const text = extractTextFromPayload(part);
    if (text) return text;
  }

  return "";
}

export async function getFathomSummary(meetingTitle: string): Promise<string> {
  const gmail = getGmailService();
  const query = `from:no-reply@fathom.video subject:${meetingTitle}`;

  try {
    const res = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 1 });
    const messages = res.data.messages ?? [];
    if (!messages.length) {
      logger.info(`No Fathom email found for meeting: ${meetingTitle}`);
      return "";
    }

    const msg = await gmail.users.messages.get({ userId: "me", id: messages[0].id!, format: "full" });
    const payload = msg.data.payload as Record<string, unknown> | undefined;
    if (!payload) return "";

    const body = extractTextFromPayload(payload);
    logger.info(`Fathom summary found for '${meetingTitle}' (${body.length} chars)`);
    return body;
  } catch (err) {
    logger.warn(`Fathom email search failed: ${err}`);
    return "";
  }
}

async function findExistingThread(
  gmail: ReturnType<typeof getGmailService>,
  emails: string[],
): Promise<{ threadId: string; messageId: string; subject: string } | null> {
  const emailClause = emails.map((e) => `{${e}}`).join(" OR ");
  const queries = [`(${emailClause}) -subject:Invitation`, `(${emailClause})`];

  for (const q of queries) {
    try {
      const res = await gmail.users.messages.list({ userId: "me", q, maxResults: 1 });
      const messages = res.data.messages ?? [];
      if (!messages.length) continue;

      const msg = await gmail.users.messages.get({
        userId: "me",
        id: messages[0].id!,
        format: "metadata",
        metadataHeaders: ["Message-ID", "Subject"],
      });

      const headers: Record<string, string> = {};
      for (const h of msg.data.payload?.headers ?? []) {
        headers[h.name!] = h.value!;
      }

      logger.info(`Found existing thread via query: ${q}`);
      return {
        threadId: msg.data.threadId!,
        messageId: headers["Message-ID"] ?? "",
        subject: headers["Subject"] ?? "",
      };
    } catch (err) {
      logger.warn(`Thread search failed for query '${q}': ${err}`);
    }
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
    mimeLines.push(`Subject: ${subject}`);
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
