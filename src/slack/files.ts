import type { ChatwootAttachment } from "../chatwoot/client.js";
import { log } from "../logger.js";

export interface SlackFileRef {
  id: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
}

/** Chatwoot's default attachment limit is 40 MB. */
const MAX_BYTES = 40 * 1024 * 1024;

/**
 * Download Slack files with the bot token so they can be re-uploaded to Chatwoot.
 * Files that can't be fetched are skipped; the caller notes them in the message body.
 */
export async function downloadSlackFiles(
  botToken: string,
  files: SlackFileRef[],
  fetchFn: typeof fetch = fetch,
): Promise<{ attachments: ChatwootAttachment[]; skipped: SlackFileRef[] }> {
  const attachments: ChatwootAttachment[] = [];
  const skipped: SlackFileRef[] = [];
  for (const f of files) {
    const url = f.url_private_download ?? f.url_private;
    if (!url || (f.size ?? 0) > MAX_BYTES) {
      skipped.push(f);
      continue;
    }
    try {
      const res = await fetchFn(url, { headers: { authorization: `Bearer ${botToken}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      attachments.push({ filename: f.name ?? f.id, contentType: f.mimetype ?? "application/octet-stream", data });
    } catch (err) {
      log.warn("failed to download slack file", { file: f.id, error: err instanceof Error ? err.message : String(err) });
      skipped.push(f);
    }
  }
  return { attachments, skipped };
}
