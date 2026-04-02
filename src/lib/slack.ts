import { WebClient } from "@slack/web-api";
import { SLACK_BOT_TOKEN, SLACK_CHANNEL, SLACK_DEALS_CHANNEL } from "./config.js";
import { SlackError, logger } from "./errors.js";

let _client: WebClient | null = null;

function getClient(): WebClient {
  if (!_client) _client = new WebClient(SLACK_BOT_TOKEN());
  return _client;
}

function formatAttendees(
  emails: string[],
  linkedinMap: Record<string, { name: string; linkedin: string }>,
): string {
  return emails
    .map((email) => {
      const info = linkedinMap[email];
      if (info?.linkedin && info?.name) return `<${info.linkedin}|${info.name}>`;
      if (info?.name) return info.name;
      return email;
    })
    .join(", ");
}

export interface ZoeMessageData {
  dealRecordId: string;
  dealName: string;
  companyName: string;
  contactEmail: string;
  contactName: string;
  summary: string;
  fathomLink: string;
  attendeeEmails: string[];
  linkedinMap: Record<string, { name: string; linkedin: string }>;
  eventId: string;
  meetingTitle: string;
  endTime: string;
}

export async function sendZoeMessage(data: ZoeMessageData): Promise<string | null> {
  const client = getClient();
  const channel = SLACK_CHANNEL();

  const buttonPayload = JSON.stringify({
    deal_record_id: data.dealRecordId,
    event_id: data.eventId,
    attendee_email: data.contactEmail,
    attendee_name: data.contactName,
    company_name: data.companyName,
    deal_name: data.dealName,
    summary: data.summary,
    fathom_link: data.fathomLink,
  });

  const attendees = formatAttendees(data.attendeeEmails, data.linkedinMap);

  const sectionLines = [
    `*${data.companyName || "Unknown Company"}*`,
  ];
  if (data.summary) sectionLines.push(data.summary);
  if (attendees) sectionLines.push(attendees);
  if (data.fathomLink) sectionLines.push(`<${data.fathomLink}|Fathom Recording>`);

  const blocks = [
    {
      type: "section" as const,
      text: { type: "mrkdwn" as const, text: sectionLines.join("\n") },
    },
    {
      type: "actions" as const,
      elements: [
        {
          type: "button" as const,
          text: { type: "plain_text" as const, text: "To Deals" },
          action_id: "to_deals",
          value: buttonPayload,
        },
        {
          type: "button" as const,
          text: { type: "plain_text" as const, text: "Ali to Reject" },
          action_id: "ali_to_reject",
          value: buttonPayload,
          style: "danger" as const,
        },
        {
          type: "button" as const,
          text: { type: "plain_text" as const, text: "Deal Review" },
          action_id: "deal_review",
          value: buttonPayload,
          style: "primary" as const,
        },
      ],
    },
  ];

  try {
    const response = await client.chat.postMessage({
      channel,
      text: `${data.companyName}: ${data.summary || "Founder call ended"}`,
      blocks,
    });
    logger.info(`Zoe message sent for deal ${data.dealRecordId} (ts: ${response.ts})`);
    return response.ts ?? null;
  } catch (err) {
    throw new SlackError(`Failed to send Zoe message: ${err}`);
  }
}

export async function updateMessageWithResult(
  channel: string,
  ts: string,
  actionName: string,
  actor: string,
  details = "",
  originalBlocks?: unknown[],
) {
  const client = getClient();

  let resultText = `*${actionName}* — by <@${actor}>`;
  if (details) resultText += `\n${details}`;

  const resultBlock = { type: "section" as const, text: { type: "mrkdwn" as const, text: resultText } };

  const newBlocks = originalBlocks?.length
    ? [
        ...(originalBlocks as { type: string }[]).filter((b) => b.type !== "actions"),
        { type: "divider" as const },
        resultBlock,
      ]
    : [resultBlock];

  try {
    await client.chat.update({ channel, ts, blocks: newBlocks, text: resultText });
    logger.info(`Slack message ${ts} updated with action: ${actionName}`);
  } catch (err) {
    throw new SlackError(`Failed to update Slack message: ${err}`);
  }
}

export interface DealsPostData {
  companyName: string;
  summary: string;
  linkedinLinks: string[];
  fathomLink: string;
  dealLinks: { url: string; type: string; title: string }[];
  files: { name: string; downloadUrl: string }[];
}

const ALERT_USER_ID = "U03KBKQ28UF";

export async function sendAlertDM(message: string) {
  try {
    const client = getClient();
    await client.chat.postMessage({
      channel: ALERT_USER_ID,
      text: `*Zoe Alert*\n${message}`,
    });
  } catch (err) {
    logger.error(`Failed to send alert DM: ${err}`);
  }
}

export async function postToDealsChannel(data: DealsPostData): Promise<string | null> {
  const client = getClient();
  const channel = SLACK_DEALS_CHANNEL();

  const lines = [`*${data.companyName}*`];
  if (data.summary) lines.push(data.summary);
  if (data.linkedinLinks.length) lines.push(data.linkedinLinks.join(", "));
  if (data.fathomLink) lines.push(`<${data.fathomLink}|Fathom Recording>`);

  for (const link of data.dealLinks) {
    const label = link.title || link.url;
    lines.push(`${link.type}: <${link.url}|${label}>`);
  }

  if (data.files.length) {
    for (const file of data.files) {
      if (file.downloadUrl) {
        lines.push(`<${file.downloadUrl}|${file.name}>`);
      } else {
        lines.push(file.name);
      }
    }
  }

  const text = lines.join("\n");

  try {
    const response = await client.chat.postMessage({ channel, text });
    logger.info(`Deals channel post sent (ts: ${response.ts})`);
    return response.ts ?? null;
  } catch (err) {
    throw new SlackError(`Failed to post to deals channel: ${err}`);
  }
}
