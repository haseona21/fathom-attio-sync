import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY } from "./config.js";
import { logger } from "./errors.js";

export async function summarizeTranscript(
  fullText: string,
  companyName: string,
): Promise<string> {
  if (!fullText) return "";

  const apiKey = ANTHROPIC_API_KEY();
  if (!apiKey) {
    logger.warn("ANTHROPIC_API_KEY not set — skipping AI summary");
    return "";
  }

  const client = new Anthropic({ apiKey });

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      messages: [
        {
          role: "user",
          content: `Summarize this call summary about ${companyName} in one sentence, focusing on what they're building. Reply with only the sentence, no headers or labels.\n\n${fullText}`,
        },
      ],
    });

    const block = response.content[0];
    const summary = block.type === "text" ? block.text.trim() : "";
    logger.info(`AI summary generated for ${companyName}: ${summary}`);
    return summary;
  } catch (err) {
    logger.error(`Failed to generate AI summary: ${err}`);
    return "";
  }
}
