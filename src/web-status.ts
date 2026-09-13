/**
 * Same-origin status route for the plugin card: sign-in state, token expiry, the
 * active billing policy, and remaining credit, fetched by the browser half. The
 * route answers loopback (or explicitly allowed LAN) browser requests only
 * and never carries token material.
 *
 * @module dsh-workbuddyai-connect/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { WorkBuddyAiCredentialStore } from './auth.ts'
import type { WorkBuddyAiUpstreamClient } from './upstream.ts'
import { normalizeCredits } from './upstream.ts'
import type { WorkBuddyAiCatalog } from './catalog.ts'
import { requestIsTrusted } from './loopback.ts'
import { WORKBUDDYAI_STATUS_PATH } from './status-paths.ts'
import type { WorkBuddyAiWebModelBadge, WorkBuddyAiWebProbeSection, WorkBuddyAiWebStatus } from './status-paths.ts'

export { WORKBUDDYAI_STATUS_PATH } from './status-paths.ts'
export type { WorkBuddyAiWebStatus } from './status-paths.ts'

/** Constructor dependencies. */
export interface WorkBuddyAiStatusRouteOptions {
  store: WorkBuddyAiCredentialStore
  client: Pick<WorkBuddyAiUpstreamClient, 'fetchCredits'>
  /** The live catalog; the card reads policy, prices, and provenance from it. */
  catalog: WorkBuddyAiCatalog
  /**
   * Compact probe state for the card. Optional so the status route keeps working
   * on its own in tests and headless profiles.
   */
  probe?: () => WorkBuddyAiWebProbeSection
  /** In-process key authorizing control writes. */
  controlKey?: string
  /**
   * Extra Host/Origin authorities for LAN DSH Web. Read live so a settings
   * edit applies without remounting the route. Default empty = loopback only.
   */
  allowedHosts?: () => readonly string[]
}

/** Redact token-like content before it crosses to the browser. */
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/**
 * The request must be addressed to the loopback interface, and a
 * browser-attached Origin must be loopback too. The Host check drops
 * DNS-rebinding pages (their Host is the attacker's domain, not loopback); the
 * card's same-origin fetches carry no Origin and pass on Host alone.
 */
function trustedRequest(req: IncomingMessage, allowedHosts: readonly string[]): boolean {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
  return requestIsTrusted({ headers: { host: req.headers.host, origin } }, allowedHosts)
}

/**
 * Assemble the card's status document. Sign-in state is read-only; credit is a
 * live billing answer whose failure degrades to `creditsError` rather than
 * failing the whole document.
 */
export async function workBuddyAiWebStatus(
  deps: WorkBuddyAiStatusRouteOptions,
): Promise<WorkBuddyAiWebStatus> {
  const authStatus = await deps.store.status()
  if (authStatus.state !== 'signed-in') {
    return {
      status: 'signed-out',
      ...deps.controlKey === undefined ? {} : { controlKey: deps.controlKey },
    }
  }

  const catalog = deps.catalog
  const product = catalog.product()
  const freeIds = catalog.freeIds()
  const free = new Set(freeIds)
  const selectable = new Set(catalog.current().map(model => model.id))

  // The card receives *every* model the product configuration knows about, not
  // just the free ones: context capacity and price are exactly the facts a user
  // wants before deciding whether to lift the free-only filter, and the models
  // where that matters most are the paid ones.
  const modelsField: readonly WorkBuddyAiWebModelBadge[] = product.models
    .map(row => {
      const rate = normalizeCredits(row.credits)
      const isFree = free.has(row.id)
      return {
        id: row.id,
        name: row.name,
        ...isFree ? { free: true as const } : {},
        ...rate === undefined ? {} : { credits: rate },
        ...row.contextWindow > 0 ? { contextWindow: row.contextWindow } : {},
        selectable: selectable.has(row.id),
      }
    })

  const status: WorkBuddyAiWebStatus = {
    status: 'signed-in',
    ...authStatus.nickname === undefined ? {} : { nickname: authStatus.nickname },
    ...authStatus.domain === undefined || authStatus.domain === '' ? {} : { domain: authStatus.domain },
    ...authStatus.source === undefined ? {} : { source: authStatus.source },
    ...authStatus.expiresAtMs === undefined ? {} : { expiresAt: authStatus.expiresAtMs },
    ...modelsField.length === 0 ? {} : { models: modelsField },
    scope: catalog.currentScope(),
    freeIds,
    priceSource: product.source,
    ...product.path === undefined ? {} : { priceSourcePath: product.path },
    ...product.endpoint === undefined ? {} : { endpoint: product.endpoint },
    // Probe state rides the signed-in document so the card can render the
    // consent switch and results without a second request. The control key
    // travels with it: this response already passed the loopback guard, and the
    // key authorizes only control writes, never credentials or completions.
    ...deps.probe === undefined ? {} : { probe: deps.probe() },
    ...deps.controlKey === undefined ? {} : { controlKey: deps.controlKey },
  }

  try {
    const credential = await deps.store.current()
    if (credential !== undefined) {
      const credits = await deps.client.fetchCredits(credential)
      return { ...status, credits }
    }
  } catch (error: unknown) {
    return { ...status, creditsError: safeMessage(error) }
  }
  return status
}

/** The status route's request handler, extracted so tests can mount it on a bare server. */
export function workBuddyAiStatusHandler(
  deps: WorkBuddyAiStatusRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!trustedRequest(req, deps.allowedHosts?.() ?? [])) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      json(res, 200, await workBuddyAiWebStatus(deps))
    } catch (error: unknown) {
      json(res, 500, { error: safeMessage(error) })
    }
  }
}

/** Mount the GET status route on an optional webServer context. */
export function registerWorkBuddyAiStatusRoute(ctx: Context, deps: WorkBuddyAiStatusRouteOptions): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDYAI_STATUS_PATH,
      handler: workBuddyAiStatusHandler(deps),
    })
    return () => {
      dispose()
    }
  }, 'dsh-workbuddyai-connect: Web status route')
}
