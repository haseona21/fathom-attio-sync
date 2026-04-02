import { google } from "googleapis";
import { getGoogleAuth } from "./config.js";
import { CalendarError, logger } from "./errors.js";

export interface CalendarMeeting {
  eventId: string;
  title: string;
  endTime: string;
  attendeeEmails: string[];
}

export async function getRecentlyEndedMeetings(minutesAgo = 10): Promise<CalendarMeeting[]> {
  const auth = getGoogleAuth();
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const timeMin = new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  const timeMax = now.toISOString();

  logger.info(`Checking calendar for events ending between ${timeMin} and ${timeMax}`);

  let events;
  try {
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
    });
    events = res.data.items ?? [];
  } catch (err) {
    throw new CalendarError(`Failed to list calendar events: ${err}`);
  }

  logger.info(`Found ${events.length} calendar events in window`);

  const results: CalendarMeeting[] = [];

  for (const event of events) {
    // Skip all-day events
    if (!event.end?.dateTime) continue;
    // Skip cancelled
    if (event.status === "cancelled") continue;
    // Only include events that have actually ended
    if (new Date(event.end.dateTime) > now) continue;

    const attendeeEmails = (event.attendees ?? [])
      .filter((a) => !a.self && a.email)
      .map((a) => a.email!);

    results.push({
      eventId: event.id!,
      title: event.summary ?? "Untitled",
      endTime: event.end.dateTime,
      attendeeEmails,
    });
  }

  logger.info(`Returning ${results.length} ended meetings with attendees`);
  return results;
}
