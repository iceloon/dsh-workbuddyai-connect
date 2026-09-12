/**
 * WorkBuddy AI (international) upstream client: chat streaming, token refresh,
 * model catalog, and credit balance.
 *
 * Two deployment-specific facts drive this module, and both are the reason the
 * plugin exists rather than reusing a domestic-configured route:
 *
 * 1. **The catalog path differs by region.** The overseas deployment serves the
 *    personal model catalog at `/v2/enterprises/personal/models`; the domestic
 *    one serves it at `/console/enterprises/personal/models`. Calling the wrong
 *    one against `www.workbuddy.ai` is not a 404 — the edge answers HTTP 500.
 *    {@link WorkBuddyAiUpstreamClient.fetchModels} therefore picks the path from
 *    the credential's own `domain`, so a `.ai` sign-in can never be sent to the
 *    domestic path.
 * 2. **The catalog is not the authority on price.** It lists `hy4-preview` at
 *    `x0.00` while the app's product configuration prices it `x0.29`, and it
 *    omits two genuinely free models entirely. Free/paid is therefore decided
 *    from the product configuration (see `product-config.ts`), never from this
 *    endpoint's `credits` field alone.
 *
 * The wire behavior is ported from Sliverkiss/workbuddy2api (MIT), whose Go
 * implementation is battle-tested against the real endpoint.
 *
 * @module dsh-workbuddyai-connect/upstream
 */

import type { WorkBuddyAiCredential } from './auth.ts'
import type { ProbeAttempt } from './probe.ts'
import { PROBE_MAX_TOKENS, PROBE_PROMPT } from './probe.ts'

/** WorkBuddy region selected by the credential's login domain. */
export type WorkBuddyAiRegion = 'cn' | 'global'

/** Upstream failure classes the shim maps onto distinct HTTP answers. */
export type UpstreamErrorKind =
  | 'hard_credit'
  | 'soft_rate'
  | 'session_dead'
  | 'not_found'
  | 'server'
  | 'client'

/** One CLI-usable model as the upstream catalog describes it. */
export interface WorkBuddyAiUpstreamModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  /**
   * Upstream-declared image input capability. Missing or false upstream data
   * resolves to false, so an unknown model stays text-only: over-claiming
   * admits an image the provider then rejects after the message is durable.
   */
  supportsImages: boolean
  /**
   * Reasoning metadata the upstream catalog declares per model. The wire effort
   * values (`low`, `medium`, `high`, `xhigh`, `max`) map directly onto pi-ai's
   * thinking levels, and the supported set decides which levels the DSH model
   * selector offers.
   */
  reasoning?: WorkBuddyAiModelReasoning
  /**
   * Billing convenience metadata: the credits multiplier the upstream reports
   * (e.g. `"x0.00"` for free) and promotional badges like
   * `badge:限时免费:#FF0000`.
   *
   * The multiplier reaches the browser through the host LLM seam, which has no
   * locale service, so {@link normalizeCredits} trims it to a language-neutral
   * display form (`x0.79`) that reads the same in every UI language.
   */
  billing?: WorkBuddyAiModelBilling
}

/** Reasoning metadata the upstream catalog declares for one model. */
export interface WorkBuddyAiModelReasoning {
  /** Whether the model does any reasoning at all (upstream `supportsReasoning`). */
  supports: boolean
  /** Whether the model can only think (upstream `onlyReasoning`). */
  onlyReasoning: boolean
  /** Selectable effort values; absent means the model has no explicit set. */
  supportedEfforts?: readonly WorkBuddyAiEffort[]
  /** Default effort the upstream uses when none is chosen. */
  defaultEffort?: WorkBuddyAiEffort
  /** Whether thinking can be switched off; false means it is always on. */
  canDisableThinking: boolean
}

/** The concrete effort spellings WorkBuddy exposes on the wire. */
export type WorkBuddyAiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Billing convenience metadata reported for one model. */
export interface WorkBuddyAiModelBilling {
  /** Credits multiplier, e.g. `"x0.00"` (free) or `"x0.79"`. */
  credits?: string
  /** Promotional tags, e.g. `"限时免费"`, `"夜间折扣"`. */
  badges?: readonly string[]
  /** Whether the model is currently free (`x0.00` credits). */
  free: boolean
}

/** One billing package and its remaining credit. */
export interface WorkBuddyAiCreditAccount {
  packageName: string
  remain: number
  size: number
}

/** Aggregated credit answer for one credential. */
export interface WorkBuddyAiCredits {
  total: number
  accounts: readonly WorkBuddyAiCreditAccount[]
}

/** Token refresh answer; fields the upstream omits stay absent. */
export interface WorkBuddyAiRefreshOutcome {
  accessToken: string
  refreshToken?: string
  expiresInSec?: number
  domain?: string
}

/** Chat answer: either a live SSE response or a classified failure. */
export type WorkBuddyAiChatResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; kind: UpstreamErrorKind; message: string }

const CN_CHAT_BASE = 'https://copilot.tencent.com'
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
const GLOBAL_BASE = 'https://www.workbuddy.ai'

/**
 * Personal model-catalog path per region.
 *
 * The overseas deployment answers the domestic path with HTTP 500 rather than
 * a 404, so this is a hard routing decision, not a cosmetic one.
 */
const CATALOG_PATH: Readonly<Record<WorkBuddyAiRegion, string>> = {
  global: '/v2/enterprises/personal/models',
  cn: '/console/enterprises/personal/models',
}

const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2'
const JSON_TIMEOUT_MS = 30_000
const ERROR_BODY_LIMIT = 4096

/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS: readonly string[] = [
  'insufficient credit', 'no credit', 'credit exhausted', 'out of credit',
  'quota exceeded', 'quota exhaust', 'payment required', 'credit not enough',
  'not enough credit',
  '积分不足', '额度不足', '余额不足', '积分用完', '额度用尽', '没有积分',
]

/** The concrete effort spellings WorkBuddy exposes on the wire. */
const EFFORT_VALUES: readonly WorkBuddyAiEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Promotional badge keys the upstream tags carry, minus their color suffix. */
const BADGE_PREFIX = 'badge:'

/** Session-invalidation markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS: readonly string[] = ['Offline user session not found', '12153']

/** Parse the upstream `reasoning` object into {@link WorkBuddyAiModelReasoning}. */
function resolveUpstreamReasoning(wrapped: Record<string, unknown>): { reasoning: WorkBuddyAiModelReasoning } {
  const supports = wrapped['supportsReasoning'] === true
  const onlyReasoning = wrapped['onlyReasoning'] === true
  const rawReasoning = wrapped['reasoning']
  let supportedEfforts: WorkBuddyAiEffort[] | undefined
  let defaultEffort: WorkBuddyAiEffort | undefined
  let canDisableThinking = true
  if (typeof rawReasoning === 'object' && rawReasoning !== null && !Array.isArray(rawReasoning)) {
    const reasoning = rawReasoning as Record<string, unknown>
    const rawEfforts = reasoning['supportedEfforts']
    if (Array.isArray(rawEfforts)) {
      const efforts = rawEfforts.filter((value): value is WorkBuddyAiEffort =>
        typeof value === 'string' && (EFFORT_VALUES as readonly string[]).includes(value))
      if (efforts.length > 0) supportedEfforts = efforts
    }
    if (typeof reasoning['defaultEffort'] === 'string'
      && (EFFORT_VALUES as readonly string[]).includes(reasoning['defaultEffort'] as string)) {
      defaultEffort = reasoning['defaultEffort'] as WorkBuddyAiEffort
    } else if (typeof reasoning['effort'] === 'string'
      && (EFFORT_VALUES as readonly string[]).includes(reasoning['effort'] as string)) {
      defaultEffort = reasoning['effort'] as WorkBuddyAiEffort
    }
    // Only an explicit `canDisableThinking: true` offers "thinking off"; older
    // rows omit the field and several of them reject `off` on the wire, so the
    // conservative default is "cannot be disabled".
    canDisableThinking = reasoning['canDisableThinking'] === true
  }
  return {
    reasoning: {
      supports,
      onlyReasoning,
      ...supportedEfforts === undefined ? {} : { supportedEfforts },
      ...defaultEffort === undefined ? {} : { defaultEffort },
      canDisableThinking,
    },
  }
}

/**
 * Reduce an upstream credits string to its language-neutral display form.
 *
 * The host LLM seam carries this text to the browser, and the host has no
 * locale service — whatever string is produced here is shown verbatim in every
 * UI language. The upstream is inconsistent in a way that matters: some rows
 * report a bare multiplier (`x0.79`) and others append a unit word
 * (`x0.79 credits`), and the unit word would pin the display to English.
 * Dropping a trailing `credits` (case-insensitive, singular or plural) yields
 * the one spelling that reads identically in every language.
 *
 * @param credits - raw upstream credits string, e.g. `"x0.79 credits"`.
 * @returns the bare multiplier, or undefined when nothing displayable remains.
 */
export function normalizeCredits(credits: string | undefined): string | undefined {
  if (credits === undefined) return undefined
  const trimmed = credits.trim()
  if (trimmed === '') return undefined
  // A string that is only the unit word (`credits`) carries no multiplier.
  if (/^credits?$/iu.test(trimmed)) return undefined
  const bare = trimmed.replace(/\s+credits?$/iu, '').trim()
  return bare === '' ? undefined : bare
}

/**
 * Whether a credits multiplier means "free".
 *
 * Only an explicit `x0.00` (with or without the `x`, any number of decimals)
 * counts. An absent multiplier is *not* free: the upstream omits the field for
 * some rows and treating absence as free would advertise a paid model.
 */
export function isFreeCredits(credits: string | undefined): boolean {
  if (credits === undefined) return false
  return /^x?0(?:\.0+)?$/u.test(credits.trim())
}

/** Parse the upstream `tags` / `credits` fields into billing metadata. */
function resolveUpstreamBilling(wrapped: Record<string, unknown>): { billing: WorkBuddyAiModelBilling } {
  const rawCredits = wrapped['credits']
  const credits = typeof rawCredits === 'string' && rawCredits.trim() !== '' ? rawCredits.trim() : undefined
  const badges: string[] = []
  const rawTags = wrapped['tags']
  if (Array.isArray(rawTags)) {
    for (const tag of rawTags) {
      if (typeof tag !== 'string') continue
      const lowered = tag.toLowerCase()
      if (!lowered.startsWith(BADGE_PREFIX)) continue
      const label = tag.slice(BADGE_PREFIX.length).split(':')[0] ?? tag.slice(BADGE_PREFIX.length)
      if (label !== '') badges.push(label)
    }
  }
  return {
    billing: {
      ...credits === undefined ? {} : { credits },
      ...badges.length === 0 ? {} : { badges },
      free: isFreeCredits(credits),
    },
  }
}

/** Classify an upstream failure from its HTTP status and body excerpt. */
export function classifyUpstreamError(status: number, body: string): UpstreamErrorKind {
  if (status === 402) return 'hard_credit'
  const lower = body.toLowerCase()
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return 'hard_credit'
  }
  for (const marker of SESSION_DEAD_MARKERS) {
    if (body.includes(marker)) return 'session_dead'
  }
  if (status === 429) return 'soft_rate'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'server'
  if (status >= 400) return 'client'
  return 'client'
}

/**
 * Region for a login domain.
 *
 * An empty domain resolves to `global`, not `cn`: this plugin is the
 * international one, so an unlabelled credential is treated as belonging to the
 * deployment it was configured for. A credential that names the domestic domain
 * still routes domestic, because the `domain` field is the upstream's own
 * routing fact and second-guessing it would send a `.cn` token to `.ai`.
 */
export function regionOf(domain: string): WorkBuddyAiRegion {
  const lowered = domain.trim().toLowerCase()
  if (lowered === '' || lowered.endsWith('workbuddy.ai') || lowered.endsWith('codebuddy.ai')) return 'global'
  return 'cn'
}

function chatBase(credential: WorkBuddyAiCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_CHAT_BASE
}

function billingBase(credential: WorkBuddyAiCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

function originReferer(credential: WorkBuddyAiCredential): string {
  return regionOf(credential.domain) === 'global' ? GLOBAL_BASE : CN_BILLING_BASE
}

/** Headers every upstream request shares. */
function commonHeaders(credential: WorkBuddyAiCredential): Record<string, string> {
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': originReferer(credential),
    'Referer': `${originReferer(credential)}/`,
    'User-Agent': CLIENT_UA,
  }
}

/** Chat request headers, including the X-No-* conventions the official CLI uses. */
function chatHeaders(credential: WorkBuddyAiCredential): Record<string, string> {
  return {
    ...commonHeaders(credential),
    'Content-Type': 'application/json',
    // Security boundary: a chat request never carries the refresh token.
    ...credential.uid === '' ? { 'X-No-User-Id': '1' } : { 'X-User-Id': credential.uid },
    ...credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId },
    ...credential.domain === '' ? { 'X-No-Department-Info': '1' } : { 'X-Domain': credential.domain },
    'X-Product': 'SaaS',
  }
}

/** Unauthenticated CLI-login headers; no Bearer, no refresh token. */
function pluginAuthHeaders(): Record<string, string> {
  return {
    'Accept': '*/*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': GLOBAL_BASE,
    'Referer': `${GLOBAL_BASE}/`,
    'User-Agent': CLIENT_UA,
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true',
  }
}

/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential: WorkBuddyAiCredential): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(credential),
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  }
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
  }
  return headers
}

/** Billing request headers. */
function billingHeaders(credential: WorkBuddyAiCredential): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${credential.accessToken}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId
    headers['X-Tenant-Id'] = credential.enterpriseId
  }
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  return headers
}

/**
 * Normalize an OpenAI chat-completions body for the WorkBuddy upstream.
 *
 * Three rewrites, each fixing a measured rejection:
 *
 * 1. `stream` is forced true — the upstream refuses a non-streaming chat call.
 * 2. `role: "developer"` becomes `role: "system"` — pi-ai emits the system
 *    prompt with the OpenAI `developer` role, which this upstream answers with
 *    HTTP 400 code 11128.
 * 3. `tool_choice` is flattened to the string form the upstream expects; an
 *    object form returns 400.
 *
 * It additionally guarantees the upstream's "first message is system prompt"
 * rule: a request whose first message is not a system message is answered with
 * code 11128 and never reaches a model. DSH normally supplies a system prompt,
 * but a session with an empty instruction set would otherwise fail every call,
 * so a minimal one is prepended rather than letting the request die.
 *
 * @param source - the JSON request body pi-ai produced.
 * @returns the rewritten body, or the input unchanged when it is not a JSON object.
 */
export function prepareChatBody(source: string): string {
  let body: unknown
  try {
    body = JSON.parse(source)
  } catch {
    return source
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return source
  const obj = body as Record<string, unknown>
  obj['stream'] = true
  normalizeDeveloperRole(obj)
  normalizeToolChoice(obj)
  ensureLeadingSystemMessage(obj)
  return JSON.stringify(obj)
}

/** Rewrite `role: "developer"` messages to `role: "system"` (upstream rejects developer). */
function normalizeDeveloperRole(obj: Record<string, unknown>): void {
  const messages = obj['messages']
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (typeof message !== 'object' || message === null || Array.isArray(message)) continue
    const wrapped = message as Record<string, unknown>
    if (wrapped['role'] === 'developer') wrapped['role'] = 'system'
  }
}

/**
 * Guarantee the upstream's requirement that the first message is a system
 * prompt. Only an actually-missing leading system message is repaired; a body
 * with no `messages` array at all is left alone, because the upstream's own
 * validation is the better error for a malformed request.
 */
function ensureLeadingSystemMessage(obj: Record<string, unknown>): void {
  const messages = obj['messages']
  if (!Array.isArray(messages) || messages.length === 0) return
  const first = messages[0]
  if (typeof first === 'object' && first !== null && !Array.isArray(first)
    && (first as Record<string, unknown>)['role'] === 'system') {
    return
  }
  messages.unshift({ role: 'system', content: 'You are a helpful assistant.' })
}

/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj: Record<string, unknown>): void {
  const suppress = (): void => {
    delete obj['tools']
    delete obj['functions']
  }
  const present = 'tool_choice' in obj
  if (!present) return
  const choice: unknown = obj['tool_choice']
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete obj['tool_choice']
      suppress()
    }
    return
  }
  if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
    const wrapped = choice as Record<string, unknown>
    const type = typeof wrapped['type'] === 'string' ? wrapped['type'].trim().toLowerCase() : ''
    if (type === 'none') {
      delete obj['tool_choice']
      suppress()
    } else if (type === 'auto' || type === 'required') {
      obj['tool_choice'] = type
    } else if (type === 'function') {
      const fn = typeof wrapped['function'] === 'object' && wrapped['function'] !== null
        ? (wrapped['function'] as Record<string, unknown>)
        : undefined
      let name = typeof fn?.['name'] === 'string' ? fn['name'] : ''
      if (name === '' && typeof wrapped['name'] === 'string') name = wrapped['name']
      name = name.trim()
      obj['tool_choice'] = name !== '' ? name : 'auto'
    } else {
      delete obj['tool_choice']
    }
    return
  }
  delete obj['tool_choice']
}

/** One JSON-envelope response from the upstream, already unwrapped. */
interface Envelope {
  code: number
  msg: string
  data: unknown
}

async function readEnvelope(response: Response): Promise<Envelope> {
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`workbuddyai upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`workbuddyai upstream returned an unexpected document (http ${response.status})`)
  }
  const document = parsed as Record<string, unknown>
  return {
    code: typeof document['code'] === 'number' ? document['code'] : 0,
    msg: typeof document['msg'] === 'string' ? document['msg'] : '',
    data: 'data' in document ? document['data'] : undefined,
  }
}

/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status: number, envelope: Envelope): Error {
  const kind = classifyUpstreamError(status, envelope.msg)
  return new Error(`workbuddyai upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`)
}

/**
 * Upstream HTTP client. One instance serves the whole plugin; requests take the
 * credential explicitly so token refreshes apply on the next call.
 */
export class WorkBuddyAiUpstreamClient {
  /** POST the chat endpoint; a successful answer is the raw SSE response. */
  async chatStream(
    credential: WorkBuddyAiCredential,
    bodyJson: string,
    signal?: AbortSignal,
  ): Promise<WorkBuddyAiChatResult> {
    let response: Response
    try {
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: { ...chatHeaders(credential), 'Authorization': `Bearer ${credential.accessToken}` },
        body: bodyJson,
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      return { ok: false, status: 0, kind: 'server', message: `transport error: ${String(error)}` }
    }
    if (response.ok) return { ok: true, response }
    const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
    return {
      ok: false,
      status: response.status,
      kind: classifyUpstreamError(response.status, text),
      message: text,
    }
  }

  /** POST the token-refresh endpoint; the caller merges the outcome. */
  async refreshToken(credential: WorkBuddyAiCredential): Promise<WorkBuddyAiRefreshOutcome> {
    const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: refreshHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const accessToken = typeof data['accessToken'] === 'string' ? data['accessToken'] : ''
    if (accessToken === '') {
      throw new Error('workbuddyai token refresh returned no accessToken; sign in again in the WorkBuddy app')
    }
    const outcome: WorkBuddyAiRefreshOutcome = { accessToken }
    if (typeof data['refreshToken'] === 'string' && data['refreshToken'] !== '') outcome.refreshToken = data['refreshToken']
    if (typeof data['expiresIn'] === 'number' && data['expiresIn'] > 0) outcome.expiresInSec = data['expiresIn']
    if (typeof data['domain'] === 'string' && data['domain'] !== '') outcome.domain = data['domain']
    return outcome
  }

  /** POST the official CLI login start; returns the browser `authUrl`. */
  async startPluginLogin(nonce: string): Promise<{ state: string; authUrl: string }> {
    const response = await fetch(
      `${GLOBAL_BASE}/v2/plugin/auth/state?platform=CLI&nonce=${encodeURIComponent(nonce)}`,
      {
        method: 'POST',
        headers: pluginAuthHeaders(),
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      },
    )
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const state = typeof data['state'] === 'string' ? data['state'] : ''
    const authUrl = typeof data['authUrl'] === 'string' ? data['authUrl'] : ''
    if (state === '' || authUrl === '') {
      throw new Error('workbuddyai login start missing state/authUrl')
    }
    return { state, authUrl }
  }

  /**
   * GET the CLI login token. Envelope code `11217` means the browser has not
   * finished yet — returns `undefined` so the caller can poll again.
   */
  async pollPluginToken(state: string): Promise<Record<string, unknown> | undefined> {
    const response = await fetch(
      `${GLOBAL_BASE}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`,
      {
        headers: pluginAuthHeaders(),
        signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
      },
    )
    const envelope = await readEnvelope(response)
    if (envelope.code === 11217) return undefined
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    if (typeof envelope.data !== 'object' || envelope.data === null) {
      throw new Error('workbuddyai login token returned no data')
    }
    return envelope.data as Record<string, unknown>
  }

  /**
   * GET the personal model catalog from the region's own path and keep the
   * `cli` agent's models only.
   *
   * The path is chosen from the credential's domain (see {@link CATALOG_PATH}):
   * the overseas host answers the domestic path with HTTP 500, so this is what
   * makes an international sign-in work at all.
   */
  async fetchModels(credential: WorkBuddyAiCredential): Promise<readonly WorkBuddyAiUpstreamModel[]> {
    const path = CATALOG_PATH[regionOf(credential.domain)]
    const response = await fetch(`${chatBase(credential)}${path}`, {
      headers: {
        'Authorization': `Bearer ${credential.accessToken}`,
        'Accept': 'application/json',
        'Origin': originReferer(credential),
        'Referer': `${originReferer(credential)}/`,
        'User-Agent': CLIENT_UA,
      },
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const data = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const rawModels = Array.isArray(data['models']) ? data['models'] : []
    const agents = Array.isArray(data['agents']) ? data['agents'] : []
    let cliIds: readonly string[] | undefined
    for (const agent of agents) {
      if (typeof agent === 'object' && agent !== null) {
        const wrapped = agent as Record<string, unknown>
        if (wrapped['name'] === 'cli' && Array.isArray(wrapped['models'])) {
          cliIds = wrapped['models'].filter((id): id is string => typeof id === 'string')
          break
        }
      }
    }
    if (cliIds === undefined || cliIds.length === 0) {
      throw new Error('workbuddyai model catalog lists no cli agent models')
    }
    const byId = new Map<string, WorkBuddyAiUpstreamModel>()
    for (const model of rawModels) {
      if (typeof model !== 'object' || model === null) continue
      const wrapped = model as Record<string, unknown>
      const id = typeof wrapped['id'] === 'string' ? wrapped['id'] : ''
      if (id === '' || wrapped['disabled'] === true) continue
      const input = typeof wrapped['maxInputTokens'] === 'number' ? wrapped['maxInputTokens'] : 0
      const output = typeof wrapped['maxOutputTokens'] === 'number' ? wrapped['maxOutputTokens'] : 0
      if (input <= 0 || output <= 0) continue
      byId.set(id, {
        id,
        name: typeof wrapped['name'] === 'string' && wrapped['name'] !== '' ? wrapped['name'] : id,
        contextWindow: input,
        maxTokens: output,
        supportsImages: wrapped['supportsImages'] === true && wrapped['disabledMultimodal'] !== true,
        ...resolveUpstreamReasoning(wrapped),
        ...resolveUpstreamBilling(wrapped),
      })
    }
    const models = cliIds
      .map(id => byId.get(id))
      .filter((model): model is WorkBuddyAiUpstreamModel => model !== undefined)
    if (models.length === 0) throw new Error('workbuddyai model catalog resolved to an empty list')
    return models
  }

  /** POST the billing endpoint for the aggregated remaining credit. */
  async fetchCredits(credential: WorkBuddyAiCredential): Promise<WorkBuddyAiCredits> {
    const now = new Date()
    const format = (date: Date): string => [
      date.getFullYear().toString().padStart(4, '0'),
      (date.getMonth() + 1).toString().padStart(2, '0'),
      date.getDate().toString().padStart(2, '0'),
    ].join('-') + ' ' + [
      date.getHours().toString().padStart(2, '0'),
      date.getMinutes().toString().padStart(2, '0'),
      date.getSeconds().toString().padStart(2, '0'),
    ].join(':')
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
      method: 'POST',
      headers: billingHeaders(credential),
      body: JSON.stringify({
        PageNumber: 1,
        PageSize: 100,
        ProductCode: 'p_tcaca',
        Status: [0, 3],
        PackageEndTimeRangeBegin: format(now),
        PackageEndTimeRangeEnd: format(new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000)),
      }),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
    const envelope = await readEnvelope(response)
    if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope)
    const responseWrapper = typeof envelope.data === 'object' && envelope.data !== null
      ? envelope.data as Record<string, unknown>
      : {}
    const data = typeof responseWrapper['Response'] === 'object' && responseWrapper['Response'] !== null
      ? responseWrapper['Response'] as Record<string, unknown>
      : {}
    const inner = typeof data['Data'] === 'object' && data['Data'] !== null
      ? data['Data'] as Record<string, unknown>
      : {}
    const rawAccounts = Array.isArray(inner['Accounts']) ? inner['Accounts'] : []
    const accounts: WorkBuddyAiCreditAccount[] = []
    let total = 0
    for (const raw of rawAccounts) {
      if (typeof raw !== 'object' || raw === null) continue
      const account = raw as Record<string, unknown>
      const numberField = (key: string): number => (typeof account[key] === 'number' ? account[key] as number : 0)
      const size = numberField('CycleCapacitySize')
      const cycleRemain = numberField('CycleCapacityRemain')
      const cycleUsed = numberField('CycleCapacityUsed')
      const capacityRemain = numberField('CapacityRemain')
      let remain: number
      if (size > 0) remain = cycleRemain
      else if (cycleRemain > 0 || cycleUsed > 0) remain = cycleRemain
      else remain = capacityRemain
      if (remain < 0) remain = 0
      total += remain
      accounts.push({
        packageName: typeof account['PackageName'] === 'string' ? account['PackageName'] : '(unnamed)',
        remain,
        size: size > 0 ? size : numberField('CapacitySize'),
      })
    }
    return { total, accounts }
  }

  /**
   * One probe request: a real streaming chat call carrying the effort under
   * test.
   *
   * Shares {@link chatHeaders} with the normal chat path on purpose — a probe
   * must describe what a real message would experience, not a parallel code
   * path. The caller aborts as soon as a parseable event arrives; the body is
   * never assembled into an answer. `reasoning_effort` is omitted entirely
   * (rather than sent empty) when `effort` is undefined, so the baseline case is
   * a genuinely bare request.
   */
  async probeEffort(
    credential: WorkBuddyAiCredential,
    model: string,
    effort: string | undefined,
    signal: AbortSignal,
  ): Promise<ProbeAttempt> {
    const payload: Record<string, unknown> = {
      model,
      stream: true,
      messages: [
        { role: 'system', content: PROBE_PROMPT },
        { role: 'user', content: PROBE_PROMPT },
      ],
      max_tokens: PROBE_MAX_TOKENS,
    }
    if (effort !== undefined) payload['reasoning_effort'] = effort

    let response: Response
    try {
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: 'POST',
        headers: { ...chatHeaders(credential), 'Authorization': `Bearer ${credential.accessToken}` },
        body: JSON.stringify(payload),
        signal,
      })
    } catch (error: unknown) {
      return { status: 0, streamed: false, detail: `transport error: ${String(error)}` }
    }

    if (!response.ok) {
      const text = (await response.text()).slice(0, ERROR_BODY_LIMIT)
      return { status: response.status, streamed: false, ...errorCodeOf(text) }
    }

    // Read until the first parseable event, then hang up: the probe wants the
    // acceptance signal, not a completion.
    const streamed = await readFirstEvent(response)
    return { status: response.status, streamed }
  }
}

/** Pull `extError.code` out of an upstream error body, if it is shaped that way. */
function errorCodeOf(text: string): { errorCode?: string; detail?: string } {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const wrapped = parsed as Record<string, unknown>
      const extError = wrapped['extError']
      if (typeof extError === 'object' && extError !== null && !Array.isArray(extError)) {
        const code = (extError as Record<string, unknown>)['code']
        if (typeof code === 'string') return { errorCode: code, detail: code }
      }
    }
  } catch {
    // Not JSON: fall through to a plain detail line.
  }
  return { detail: text.slice(0, 200) }
}

/**
 * Consume just enough of a streaming response to know it really streams.
 *
 * Returns true on the first chunk containing a data line. Cancels the body
 * afterwards; a stream that ends or errors before that counts as not streamed,
 * because an empty 200 is not evidence the effort was accepted.
 */
async function readFirstEvent(response: Response): Promise<boolean> {
  const body = response.body
  if (body === null) return false
  const reader = body.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return false
      const text = decoder.decode(value, { stream: true })
      if (text.includes('data:')) return true
    }
  } catch {
    return false
  } finally {
    await reader.cancel().catch(() => {})
  }
}
