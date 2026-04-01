import type { Meeting, Recording } from "../types/recording.js";
import { FATHOM_API_KEY } from "./config.js";
import { logger } from "./errors.js";
import { fetchWithRetry } from "./http.js";

const BASE = "https://api.fathom.ai/external/v1";

function headers() {
  return { "X-Api-Key": FATHOM_API_KEY() };
}

export function createFathomRecording(): Recording {
  return {
    async fetchMeetings(since) {
      const meetings: Meeting[] = [];
      let cursor: string | null = null;

      logger.info(`Fetching Fathom meetings${since ? ` since ${since}` : " (full history)"}...`);

      while (true) {
        const params = new URLSearchParams({ limit: "50" });
        if (cursor) params.set("cursor", cursor);
        if (since) params.set("created_after", since);

        const resp = await fetchWithRetry(`${BASE}/meetings?${params}`, {
          headers: headers(),
        });

        if (!resp.ok) {
          logger.warn(`Fathom error ${resp.status}: ${await resp.text()}`);
          break;
        }

        const data = (await resp.json()) as Record<string, unknown>;
        const items = (data.items as Record<string, unknown>[]) ?? [];

        for (const item of items) {
          const invitees = (item.calendar_invitees as Record<string, unknown>[]) ?? [];
          meetings.push({
            id: String(item.recording_id ?? ""),
            title: String(item.title ?? item.meeting_title ?? "Untitled"),
            shareUrl: String(item.share_url ?? ""),
            scheduledStartTime: item.scheduled_start_time
              ? String(item.scheduled_start_time)
              : null,
            createdAt: String(item.created_at ?? ""),
            defaultSummary: item.default_summary ? String(item.default_summary) : null,
            transcript: item.transcript ? String(item.transcript) : null,
            invitees: invitees.map((inv) => ({
              email: String(inv.email ?? ""),
              isExternal: inv.is_external !== false,
            })),
          });
        }

        logger.info(`  Got ${items.length} meetings (total: ${meetings.length})`);

        cursor = data.next_cursor ? String(data.next_cursor) : null;
        if (!cursor) break;

        // Small delay between pages
        await new Promise((r) => setTimeout(r, 1000));
      }

      logger.info(`  Done. ${meetings.length} meetings fetched.`);
      return meetings;
    },

    async getTranscript(meetingId) {
      const resp = await fetchWithRetry(`${BASE}/meetings/${meetingId}/transcript`, {
        headers: headers(),
      });
      if (!resp.ok) {
        logger.warn(`Fathom transcript fetch failed for ${meetingId}: ${resp.status}`);
        return "";
      }
      const data = (await resp.json()) as Record<string, unknown>;
      // The transcript may be in a "transcript" or "text" field depending on API version
      return String(data.transcript ?? data.text ?? "");
    },

    async getShareUrl(meetingId) {
      const resp = await fetchWithRetry(`${BASE}/meetings/${meetingId}`, {
        headers: headers(),
      });
      if (!resp.ok) return "";
      const data = (await resp.json()) as Record<string, unknown>;
      return String(data.share_url ?? "");
    },
  };
}
