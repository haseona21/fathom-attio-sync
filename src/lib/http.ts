import { logger } from "./errors.js";

interface FetchOptions extends RequestInit {
  retryOn429?: boolean;
  maxRetries?: number;
}

export async function fetchWithRetry(
  url: string,
  opts: FetchOptions = {},
): Promise<Response> {
  const { retryOn429 = true, maxRetries = 3, ...fetchOpts } = opts;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(url, fetchOpts);

    if (resp.status === 429 && retryOn429 && attempt < maxRetries) {
      logger.warn(`Rate limited (429) on ${url} — waiting 60s (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, 60_000));
      continue;
    }

    return resp;
  }

  // Should never reach here, but TypeScript needs it
  throw new Error(`Max retries exceeded for ${url}`);
}
