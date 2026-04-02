/**
 * Re-authorize Google OAuth with Calendar + Gmail scopes.
 *
 * Usage:
 *   npx tsx scripts/reauth-google.ts
 *
 * 1. Opens a URL — sign in and grant permissions
 * 2. Paste the authorization code back here
 * 3. Prints the updated GOOGLE_CREDENTIALS_JSON to put in .env
 */
import "dotenv/config";
import { google } from "googleapis";
import * as readline from "readline";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

async function main() {
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON || "{}");
  if (!creds.client_id || !creds.client_secret) {
    console.error("Missing client_id or client_secret in GOOGLE_CREDENTIALS_JSON");
    process.exit(1);
  }

  const oauth2 = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    "urn:ietf:wg:oauth:2.0:oob",
  );

  const authUrl = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // Force re-consent to get new refresh token with updated scopes
  });

  console.log("\nOpen this URL in your browser:\n");
  console.log(authUrl);
  console.log();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise<string>((resolve) => {
    rl.question("Paste the authorization code here: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  const { tokens } = await oauth2.getToken(code);

  const updated = {
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: tokens.refresh_token ?? creds.refresh_token,
    type: "authorized_user",
  };

  console.log("\n✅ Updated credentials. Replace GOOGLE_CREDENTIALS_JSON in .env with:\n");
  console.log(JSON.stringify(updated));
  console.log();

  if (!tokens.refresh_token) {
    console.log("⚠️  No new refresh_token returned — kept the existing one.");
    console.log("   If Gmail still fails, revoke access at https://myaccount.google.com/permissions");
    console.log("   and re-run this script.\n");
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
