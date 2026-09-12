/**
 * Control route: the only state-changing endpoint the plugin exposes.
 *
 * Two guards, because they stop different things:
 *
 * 1. **Loopback Host + Origin**, shared with the status route. This drops
 *    DNS-rebinding pages, whose requests arrive addressed to the attacker's
 *    domain.
 * 2. **An in-process random key**, minted per process and handed only to the
 *    same-origin card. Loopback alone is *not* authentication — any local process
 *    can write `Host: 127.0.0.1` — so a route that can spend the user's credit
 *    (a probe) or expose paid models must prove the caller was told the key.
 *
 * The route never accepts a prompt, a model id outside the live catalog, or a
 * sentinel from the browser: a probe request is assembled entirely host-side.
 *
 * @module dsh-workbuddyai-connect/control-route
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { hostIsLoopback, originIsLoopback } from './loopback.ts'
import { WORKBUDDYAI_CONTROL_PATH } from './status-paths.ts'
import type { WorkBuddyAiControlAction, WorkBuddyAiModelScope } from './status-paths.ts'

/** Largest control body accepted; these payloads are a few dozen bytes. */
const MAX_BODY_BYTES = 4096

/** Constructor dependencies. */
export interface WorkBuddyAiControlRouteOptions {
  /**
   * Run a probe for one model. Resolves to a short status string, never a raw
   * upstream body.
   */
  probe: (modelId: string) => Promise<{ state: string; reason?: string }>
  /** Drop every recorded observation. */
  clearProbe: () => void
  /** Switch the billing policy; the caller re-registers the affected catalog. */
  setScope: (scope: WorkBuddyAiModelScope) => void
}

/** Mint the per-process control key. */
export function createControlKey(): string {
  return randomBytes(24).toString('hex')
}

/** Constant-time key comparison; a length mismatch is a failure, not a crash. */
function keyMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined || presented.length !== expected.length) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(presented)
  return a.length === b.length && timingSafeEqual(a, b)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

/** Read the request body with a hard ceiling. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Parse and shape-check an action; unknown fields are ignored, not trusted. */
function parseAction(text: string): WorkBuddyAiControlAction | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const wrapped = parsed as Record<string, unknown>
  const action = wrapped['action']
  if (action === 'clearProbe') return { action: 'clearProbe' }
  if (action === 'setScope') {
    const scope = wrapped['scope']
    // Only the two known spellings are accepted; a typo must not silently
    // resolve to the permissive branch.
    if (scope !== 'free' && scope !== 'all') return undefined
    return { action: 'setScope', scope }
  }
  if (action === 'probe') {
    const model = wrapped['model']
    if (typeof model !== 'string' || model.trim() === '') return undefined
    return { action: 'probe', model: model.trim() }
  }
  return undefined
}

/**
 * The control route's handler, extracted so tests can mount it on a bare server
 * with a known key.
 */
export function workBuddyAiControlHandler(
  deps: WorkBuddyAiControlRouteOptions,
  key: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    if (!keyMatches(key, req.headers['x-workbuddyai-control-key'] as string | undefined)) {
      json(res, 403, { error: 'invalid-control-key' })
      return
    }
    const body = await readBody(req)
    if (body === undefined) {
      json(res, 413, { error: 'body too large' })
      return
    }
    const action = parseAction(body)
    if (action === undefined) {
      json(res, 400, { error: 'invalid action' })
      return
    }
    try {
      switch (action.action) {
        case 'clearProbe':
          deps.clearProbe()
          json(res, 200, { state: 'cleared' })
          return
        case 'setScope':
          deps.setScope(action.scope)
          json(res, 200, { state: 'ok', scope: action.scope })
          return
        case 'probe':
          json(res, 200, await deps.probe(action.model))
          return
      }
    } catch (error: unknown) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** Mount the POST control route on an optional webServer context. */
export function registerWorkBuddyAiControlRoute(
  ctx: Context,
  deps: WorkBuddyAiControlRouteOptions,
  key: string,
): void {
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: WORKBUDDYAI_CONTROL_PATH,
      handler: workBuddyAiControlHandler(deps, key),
    })
    return () => {
      dispose()
    }
  }, 'dsh-workbuddyai-connect: control route')
}
