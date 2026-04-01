export interface Meeting {
  id: string;
  title: string;
  shareUrl: string;
  scheduledStartTime: string | null;
  createdAt: string;
  invitees: MeetingInvitee[];
  defaultSummary: string | null;
  transcript: string | null;
}

export interface MeetingInvitee {
  email: string;
  isExternal: boolean;
}

export interface Recording {
  fetchMeetings(since: string | null): Promise<Meeting[]>;
  getTranscript(meetingId: string): Promise<string>;
  getShareUrl(meetingId: string): Promise<string>;
}
