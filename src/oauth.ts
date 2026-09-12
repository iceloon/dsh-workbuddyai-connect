/**
 * Browser OAuth for the official WorkBuddy AI CLI login endpoints.
 *
 * Starts a CLI login at `/v2/plugin/auth/state`, opens `authUrl`, then polls
 * `/v2/plugin/auth/token` until the user finishes in the browser (envelope
 * code `11217` means still waiting). The resulting tokens are saved through
 * {@link WorkBuddyAiCredentialStore.importCredential} — the desktop auth file
 * is never written.
 *
 * Login `state` stays in process memory so a same-origin card cannot resume a
 * poll it did not start.
 *
 * @module dsh-workbuddyai-connect/oauth
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { credentialFromPluginToken, type WorkBuddyAiCredential } from './auth.ts'
import type { WorkBuddyAiUpstreamClient } from './upstream.ts'

/** Give up if the browser never finishes. */
export const LOGIN_TIMEOUT_MS = 15 * 60 * 1000

/** Upstream client surface this helper needs. */
export type WorkBuddyAiOAuthClient = Pick<WorkBuddyAiUpstreamClient, 'startPluginLogin' | 'pollPluginToken'>

/** One poll tick: still waiting, or a credential ready to import. */
export type WorkBuddyAiOAuthPoll =
  | { pending: true }
  | { auth: WorkBuddyAiCredential }

/**
 * Open `url` with the platform browser helper. Failures are non-fatal: the
 * caller still returns the URL so the UI can offer a link.
 */
export function openAuthUrl(url: string): boolean {
  try {
    const command = process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch {
    return false
  }
}

/**
 * In-process CLI login. One instance per plugin; overlapping `start()` calls
 * replace the previous wait.
 */
export class WorkBuddyAiOAuthLogin {
  private waiting: { state: string; authUrl: string; startedAt: number } | undefined

  constructor(
    private readonly client: WorkBuddyAiOAuthClient,
    private readonly open: (url: string) => boolean = openAuthUrl,
  ) {}

  /** Begin a login and try to open the browser. */
  async start(): Promise<{ authUrl: string; opened: boolean }> {
    const nonce = randomBytes(16).toString('hex')
    const started = await this.client.startPluginLogin(nonce)
    this.waiting = { state: started.state, authUrl: started.authUrl, startedAt: Date.now() }
    return { authUrl: started.authUrl, opened: this.open(started.authUrl) }
  }

  /**
   * One poll of the login `state`. `pending` means the user has not finished;
   * otherwise the caller must persist {@link WorkBuddyAiOAuthPoll.auth}.
   */
  async poll(): Promise<WorkBuddyAiOAuthPoll> {
    const waiting = this.waiting
    if (waiting === undefined) throw new Error('workbuddyai: no login in progress')
    if (Date.now() - waiting.startedAt > LOGIN_TIMEOUT_MS) {
      this.waiting = undefined
      throw new Error('workbuddyai: login timed out')
    }
    const data = await this.client.pollPluginToken(waiting.state)
    if (data === undefined) return { pending: true }
    this.waiting = undefined
    return { auth: credentialFromPluginToken(data) }
  }

  /** Drop an in-flight login without touching stored credentials. */
  cancel(): void {
    this.waiting = undefined
  }
}
