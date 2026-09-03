import { ChatwootHttpError } from "./client.js";
import { log } from "../logger.js";

/** The fields of the Platform API user payload we use. */
export interface PlatformUser {
  id: number;
  name?: string;
  email?: string;
  /** The agent's personal access token — the whole reason this API exists for us. */
  access_token?: string;
}

/**
 * Chatwoot's Platform API, used for one thing: reading an agent's own access token so their
 * Slack replies can be posted as them without an admin pasting anything.
 *
 * Self-hosted only, and a platform app may only touch users it was granted. For agents that
 * already exist, grant the app once from a Rails console:
 *
 *   app = PlatformApp.find_by(name: 'slack-bridge')
 *   User.find_each { |u| PlatformAppPermissible.find_or_create_by!(platform_app: app, permissible: u) }
 */
export class ChatwootPlatformClient {
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    fetchFn: typeof fetch = fetch,
  ) {
    this.fetchFn = fetchFn;
  }

  async getUser(id: number): Promise<PlatformUser> {
    const url = `${this.baseUrl}/platform/api/v1/users/${id}`;
    log.debug("chatwoot platform request", { method: "GET", url });
    const res = await this.fetchFn(url, { method: "GET", headers: { accept: "application/json", api_access_token: this.token } });
    const text = await res.text();
    if (!res.ok) throw new ChatwootHttpError(res.status, url, text);
    try {
      return JSON.parse(text) as PlatformUser;
    } catch {
      throw new ChatwootHttpError(res.status, url, `non-JSON response: ${text.slice(0, 200)}`);
    }
  }

  /** The agent's access token, or undefined if the app has no permission for them. */
  async accessTokenFor(id: number): Promise<string | undefined> {
    const user = await this.getUser(id);
    return user.access_token?.trim() || undefined;
  }
}
