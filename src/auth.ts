/**
 * WorkBuddy AI (international) credential resolution.
 *
 * The primary source is the WorkBuddy **international** desktop app's own auth
 * file, read-only; a plugin-owned copy under `$DSH_HOME` holds token refreshes
 * so the desktop file is never written. The effective credential is whichever
 * of the two expires later, so a refresh by either side wins.
 *
 * International vs domestic: the two deployments write different auth files in
 * the same directory — `workbuddy-desktop-ai.info` (domain `www.workbuddy.ai`,
 * the overseas product) and `workbuddy-desktop.info` (domain `www.workbuddy.cn`,
 * the domestic one). This plugin reads the `.ai` file, because the overseas
 * deployment is the one it serves. The credential's own `domain` field is what
 * actually selects the upstream host, so a mis-pointed file degrades into a
 * region mismatch rather than silent cross-region traffic.
 *
 * @module dsh-workbuddyai-connect/auth
 */

import { readFile, rm, stat } from 'node:fs/promises'
import { homedir, release } from 'node:os'
import { basename, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { WorkBuddyAiRefreshOutcome } from './upstream.ts'

/** Normalized WorkBuddy credential, timestamps in epoch milliseconds. */
export interface WorkBuddyAiCredential {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
  refreshExpiresAtMs?: number
  domain: string
  uid: string
  enterpriseId?: string
  nickname?: string
  /** Which storage the credential was read from; refreshes are always `dsh`. */
  source: 'desktop' | 'dsh'
}

/** Read-only sign-in summary for status and doctor output. */
export interface WorkBuddyAiAuthStatus {
  state: 'signed-in' | 'signed-out'
  expiresAtMs?: number
  refreshExpiresAtMs?: number
  nickname?: string
  domain?: string
  source?: 'desktop' | 'dsh'
}

/** Constructor options; only {@link refresh} is required. */
export interface WorkBuddyAiStoreOptions {
  /** Explicit desktop auth-file path, overriding env and platform defaults. */
  desktopPath?: string
  /** Explicit plugin-owned copy path, defaulting under `$DSH_HOME`. */
  ownPath?: string
  /** Performs the upstream token refresh. */
  refresh: (credential: WorkBuddyAiCredential) => Promise<WorkBuddyAiRefreshOutcome>
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number
}

/** Basename of the plugin-owned credential copy inside the Harness home. */
export const WORKBUDDYAI_AUTH_FILENAME = '.workbuddyai-auth.json'

/** Env variable that overrides the desktop auth-file location. */
export const WORKBUDDYAI_AUTH_FILE_ENV = 'WORKBUDDYAI_AUTH_FILE'

/**
 * Basename of the WorkBuddy **international** desktop auth document.
 *
 * The domestic build writes `workbuddy-desktop.info` in the same directory;
 * only the `.ai` suffix names the overseas sign-in this plugin is built for.
 */
export const WORKBUDDYAI_DESKTOP_AUTH_BASENAME = 'workbuddy-desktop-ai.info'

/** Current on-disk format of the plugin-owned copy; readers reject others. */
const OWN_FORMAT_VERSION = 1

interface OwnDocument {
  version: typeof OWN_FORMAT_VERSION
  credential: WorkBuddyAiCredential
}

/** Plugin-owned copy path inside the Harness home. */
export function workbuddyAiOwnAuthPath(): string {
  return join(resolveDshHome(), WORKBUDDYAI_AUTH_FILENAME)
}

const DESKTOP_AUTH_DIRECTORY = ['CodeBuddyExtension', 'Data', 'Public', 'auth'] as const

/** Whether this Linux process is running inside Windows Subsystem for Linux. */
function isWsl(): boolean {
  if (process.platform !== 'linux') return false
  if (process.env['WSL_DISTRO_NAME'] !== undefined || process.env['WSL_INTEROP'] !== undefined) return true
  return release().toLowerCase().includes('microsoft')
}

/** Convert a Windows drive path to WSL's conventional `/mnt/<drive>` form. */
function windowsPathForWsl(value: string | undefined): string | undefined {
  const path = value?.trim()
  if (!path) return undefined
  if (path.startsWith('/')) return path
  const drivePath = /^([a-z]):[\\/](.*)$/iu.exec(path)
  if (drivePath === null) return undefined
  return join('/mnt', drivePath[1]!.toLowerCase(), ...drivePath[2]!.split(/[\\/]+/u))
}

/** Windows desktop credential candidates visible from a WSL process. */
function wslDesktopAuthCandidates(home: string): string[] {
  const profile = windowsPathForWsl(process.env['USERPROFILE'])
    ?? join('/mnt/c/Users', basename(home))
  const localAppData = windowsPathForWsl(process.env['LOCALAPPDATA'])
    ?? join(profile, 'AppData', 'Local')
  const roamingAppData = windowsPathForWsl(process.env['APPDATA'])
    ?? join(profile, 'AppData', 'Roaming')
  return [
    join(localAppData, ...DESKTOP_AUTH_DIRECTORY, WORKBUDDYAI_DESKTOP_AUTH_BASENAME),
    join(roamingAppData, ...DESKTOP_AUTH_DIRECTORY, WORKBUDDYAI_DESKTOP_AUTH_BASENAME),
  ]
}

/**
 * Platform-default candidates for the WorkBuddy **international** desktop
 * app's auth file, in probe order. Windows probes both AppData roots: current
 * builds write under `%LOCALAPPDATA%` (Local), older ones under `%APPDATA%`
 * (Roaming). WSL probes those same Windows locations through its mounted
 * Windows profile before the native Linux location.
 */
export function defaultDesktopAuthCandidates(): string[] {
  const home = homedir()
  const name = WORKBUDDYAI_DESKTOP_AUTH_BASENAME
  if (process.platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', ...DESKTOP_AUTH_DIRECTORY, name)]
  }
  if (process.platform === 'win32') {
    return [
      join(home, 'AppData', 'Local', ...DESKTOP_AUTH_DIRECTORY, name),
      join(home, 'AppData', 'Roaming', ...DESKTOP_AUTH_DIRECTORY, name),
    ]
  }
  if (process.platform === 'linux') {
    const linux = join(home, '.config', ...DESKTOP_AUTH_DIRECTORY, name)
    return isWsl() ? [...wslDesktopAuthCandidates(home), linux] : [linux]
  }
  return []
}

/** First platform-default candidate; see {@link defaultDesktopAuthCandidates}. */
export function defaultDesktopAuthPath(): string | undefined {
  return defaultDesktopAuthCandidates()[0]
}

/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value: number): number {
  if (value <= 0) return 0
  return value > 1e12 ? value : value * 1000
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
 * nested form `{"auth":{...},"account":{...}}` and the flat panel form.
 * Returns undefined when the document carries no access token.
 */
export function parseWorkBuddyAiAuth(text: string): WorkBuddyAiCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  let auth: Record<string, unknown>
  let identity: Record<string, unknown>
  if (typeof document['auth'] === 'object' && document['auth'] !== null) {
    auth = document['auth'] as Record<string, unknown>
    identity = typeof document['account'] === 'object' && document['account'] !== null
      ? document['account'] as Record<string, unknown>
      : {}
  } else {
    auth = document
    identity = document
  }
  const accessToken = typeof auth['accessToken'] === 'string' ? auth['accessToken'] : ''
  if (accessToken === '') return undefined
  const expiresAtMs = typeof auth['expiresAt'] === 'number' ? expiryToMs(auth['expiresAt']) : 0
  const refreshExpiresAtMs = typeof auth['refreshExpiresAt'] === 'number' ? expiryToMs(auth['refreshExpiresAt']) : undefined
  const enterpriseId = optionalString(identity['enterpriseId'])
  const nickname = optionalString(identity['nickname'])
  return {
    accessToken,
    refreshToken: typeof auth['refreshToken'] === 'string' ? auth['refreshToken'] : '',
    expiresAtMs,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: optionalString(auth['domain']) ?? '',
    uid: optionalString(identity['uid']) ?? '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    source: 'desktop',
  }
}

/** Serialize the plugin-owned copy. */
function ownDocument(credential: WorkBuddyAiCredential): OwnDocument {
  return { version: OWN_FORMAT_VERSION, credential }
}

/**
 * Parse the plugin-owned copy; other versions and shapes are rejected.
 *
 * The owned copy stores the normalized credential itself (camelCase
 * `expiresAtMs`, identity fields at the top level), not the desktop document
 * shape, so it is read field by field rather than through
 * {@link parseWorkBuddyAiAuth} — round-tripping would read `expiresAt` and an
 * `account` object, find neither, zero the expiry, and drop the identity
 * headers.
 */
function parseOwnDocument(text: string): WorkBuddyAiCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const document = parsed as Record<string, unknown>
  if (document['version'] !== OWN_FORMAT_VERSION) return undefined
  if (typeof document['credential'] !== 'object' || document['credential'] === null) return undefined
  const stored = document['credential'] as Record<string, unknown>
  const accessToken = typeof stored['accessToken'] === 'string' ? stored['accessToken'] : ''
  if (accessToken === '') return undefined
  const refreshExpiresAtMs = typeof stored['refreshExpiresAtMs'] === 'number' ? stored['refreshExpiresAtMs'] : undefined
  const enterpriseId = optionalString(stored['enterpriseId'])
  const nickname = optionalString(stored['nickname'])
  return {
    accessToken,
    refreshToken: typeof stored['refreshToken'] === 'string' ? stored['refreshToken'] : '',
    expiresAtMs: typeof stored['expiresAtMs'] === 'number' ? stored['expiresAtMs'] : 0,
    ...refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs },
    domain: optionalString(stored['domain']) ?? '',
    uid: optionalString(stored['uid']) ?? '',
    ...enterpriseId === undefined ? {} : { enterpriseId },
    ...nickname === undefined ? {} : { nickname },
    source: 'dsh',
  }
}

/** Whether a filesystem error reports an absent path. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Read-only credential store with demand-driven refresh.
 *
 * Refresh policy: refresh only when the access token is inside the margin (or
 * already expired), keep the refreshed credential in the plugin-owned copy,
 * and never write the desktop app's file. A failed refresh still returns a
 * not-yet-expired token, so an unreachable refresh endpoint does not take down
 * a working session.
 */
export class WorkBuddyAiCredentialStore {
  private readonly refresh: WorkBuddyAiStoreOptions['refresh']
  private readonly refreshMarginMs: number
  private readonly ownPath: string
  private desktopPathOverride: string | undefined
  private inflight: Promise<WorkBuddyAiCredential> | undefined

  constructor(options: WorkBuddyAiStoreOptions) {
    this.refresh = options.refresh
    this.refreshMarginMs = options.refreshMarginMs ?? 5 * 60 * 1000
    this.ownPath = options.ownPath ?? workbuddyAiOwnAuthPath()
    this.desktopPathOverride = options.desktopPath
  }

  /**
   * Configuration precedence for the desktop file: the plugin's configured
   * path, then the environment variable, then the platform defaults. An
   * explicit path is used verbatim; the defaults are a probe order.
   */
  private resolveDesktopCandidates(): string[] {
    const fromEnv = process.env[WORKBUDDYAI_AUTH_FILE_ENV]
    const explicit = this.desktopPathOverride
      ?? (fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : undefined)
    if (explicit !== undefined) return [explicit]
    return defaultDesktopAuthCandidates()
  }

  private resolveDesktopPath(): string | undefined {
    return this.resolveDesktopCandidates()[0]
  }

  /** Repoint the desktop file; a settings change applies on the next read. */
  setDesktopPath(path: string | undefined): void {
    this.desktopPathOverride = path
  }

  /** The resolved desktop auth-file path, for diagnostics. */
  desktopAuthPath(): string | undefined {
    return this.resolveDesktopPath()
  }

  /** The plugin-owned copy path, for diagnostics. */
  ownAuthPath(): string {
    return this.ownPath
  }

  /** Read the freshest stored credential without refreshing anything. */
  async current(): Promise<WorkBuddyAiCredential | undefined> {
    const [desktop, own] = await Promise.all([this.readDesktop(), this.readOwn()])
    if (desktop === undefined) return own
    if (own === undefined) return desktop
    return own.expiresAtMs > desktop.expiresAtMs ? own : desktop
  }

  /**
   * The credential to send upstream: {@link current}, refreshed on demand.
   * Single-flight, so parallel requests share one refresh.
   */
  async resolve(): Promise<WorkBuddyAiCredential> {
    const credential = await this.current()
    if (credential === undefined) {
      const candidates = this.resolveDesktopCandidates()
      const desktop = candidates.length > 0 ? candidates.join(' or ') : '(no desktop path on this platform)'
      throw new Error(
        'workbuddyai: no signed-in WorkBuddy AI (international) account found;'
        + ` sign in once in the WorkBuddy international desktop app (expected ${desktop}`
        + ` or ${WORKBUDDYAI_AUTH_FILE_ENV})`,
      )
    }
    if (!this.needsRefresh(credential)) return credential
    this.inflight ??= this.refreshNow(credential)
      .finally(() => {
        this.inflight = undefined
      })
    return this.inflight
  }

  /** Read-only sign-in summary; never refreshes and never throws. */
  async status(): Promise<WorkBuddyAiAuthStatus> {
    try {
      const credential = await this.current()
      if (credential === undefined) return { state: 'signed-out' }
      return {
        state: 'signed-in',
        expiresAtMs: credential.expiresAtMs,
        ...credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
        ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
        ...credential.domain === '' ? {} : { domain: credential.domain },
        source: credential.source,
      }
    } catch {
      return { state: 'signed-out' }
    }
  }

  /** Remove the plugin-owned copy; the desktop file is untouched. */
  async logout(): Promise<void> {
    await rm(this.ownPath, { force: true })
    await rm(`${this.ownPath}.lock`, { force: true })
  }

  private needsRefresh(credential: WorkBuddyAiCredential): boolean {
    if (credential.expiresAtMs <= 0) return true
    return Date.now() + this.refreshMarginMs >= credential.expiresAtMs
  }

  private async refreshNow(credential: WorkBuddyAiCredential): Promise<WorkBuddyAiCredential> {
    if (credential.refreshToken === '') {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(
        'workbuddyai: access token expired and no refresh token is stored;'
        + ' sign in again in the WorkBuddy international desktop app',
      )
    }
    try {
      const outcome = await this.refresh(credential)
      const refreshed: WorkBuddyAiCredential = {
        ...credential,
        accessToken: outcome.accessToken,
        ...outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken },
        expiresAtMs: outcome.expiresInSec !== undefined
          ? Date.now() + outcome.expiresInSec * 1000
          : credential.expiresAtMs,
        ...outcome.domain === undefined || outcome.domain === '' ? {} : { domain: outcome.domain },
        source: 'dsh',
      }
      await this.saveOwn(refreshed)
      return refreshed
    } catch (error: unknown) {
      if (credential.expiresAtMs > Date.now() + 30_000) return credential
      throw new Error(
        `workbuddyai: token refresh failed and the access token is expired (${String(error)});`
        + ' open the WorkBuddy international desktop app once to sign in again',
      )
    }
  }

  private async saveOwn(credential: WorkBuddyAiCredential): Promise<void> {
    await withFileLock(this.ownPath, async () => {
      await writeFileAtomic(this.ownPath, `${JSON.stringify(ownDocument(credential), null, 2)}\n`, {
        mode: 0o600,
        dirMode: 0o700,
      })
    })
  }

  /**
   * Read the first desktop candidate that exists. Only an absent file (ENOENT)
   * falls through to the next candidate; a file that is present but unparsable
   * is authoritative for its slot, so a stale older-version file never silently
   * wins over a broken newer one.
   */
  private async readDesktop(): Promise<WorkBuddyAiCredential | undefined> {
    for (const desktopPath of this.resolveDesktopCandidates()) {
      try {
        return parseWorkBuddyAiAuth(await readFile(desktopPath, 'utf8'))
      } catch (error: unknown) {
        if (!isENOENT(error)) throw error
      }
    }
    return undefined
  }

  private async readOwn(): Promise<WorkBuddyAiCredential | undefined> {
    try {
      return parseOwnDocument(await readFile(this.ownPath, 'utf8'))
    } catch (error: unknown) {
      if (isENOENT(error)) return undefined
      return undefined
    }
  }

  /** Whether any desktop-file candidate exists as a regular file; diagnostics only. */
  async desktopFilePresent(): Promise<boolean> {
    for (const desktopPath of this.resolveDesktopCandidates()) {
      try {
        if ((await stat(desktopPath)).isFile()) return true
      } catch {
        // absent or not a regular file — try the next candidate
      }
    }
    return false
  }
}
