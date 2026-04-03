import "dotenv/config";
import { google } from "googleapis";

function env(key: string, required = true): string {
  const val = process.env[key] ?? "";
  if (required && !val) throw new Error(`Missing env var: ${key}`);
  return val;
}

// Attio
export const ATTIO_API_KEY = () => env("ATTIO_API_KEY");

// Fathom
export const FATHOM_API_KEY = () => env("FATHOM_API_KEY");

// Slack
export const SLACK_BOT_TOKEN = () => env("SLACK_BOT_TOKEN");
export const SLACK_CHANNEL = () => env("SLACK_CHANNEL");
export const SLACK_SIGNING_SECRET = () => env("SLACK_SIGNING_SECRET");
export const SLACK_DEALS_CHANNEL = () =>
  env("SLACK_DEALS_CHANNEL", false) || "C01LF71QDND";

// Anthropic
export const ANTHROPIC_API_KEY = () => env("ANTHROPIC_API_KEY", false);

// Google OAuth — shared by gcal + gmail
let _googleAuth: InstanceType<typeof google.auth.OAuth2> | null = null;

export function getGoogleAuth() {
  if (_googleAuth) return _googleAuth;

  const raw = env("GOOGLE_CREDENTIALS_JSON");
  // Strip control characters that can sneak in during copy/paste or env injection
  const sanitized = raw.replace(/[\x00-\x1f\x7f]/g, (ch) => ch === " " ? " " : "");
  const creds = JSON.parse(sanitized);

  const auth = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
  );
  auth.setCredentials({
    refresh_token: creds.refresh_token,
    access_token: creds.access_token,
    token_type: creds.token_type,
  });

  _googleAuth = auth;
  return auth;
}
