#!/usr/bin/env node
/** Standalone status/diagnostics CLI for the dsh-workbuddyai-connect bundle. */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WorkBuddyAiCredentialStore, workbuddyAiOwnAuthPath, WORKBUDDYAI_AUTH_FILE_ENV } from './auth.ts'
import { WorkBuddyAiUpstreamClient } from './upstream.ts'
import { FALLBACK_WORKBUDDYAI_MODELS } from './catalog.ts'
import { WORKBUDDYAI_CONNECT_VERSION } from './version.ts'
import { isHeartbeatProcessAlive, readHostHeartbeat, workbuddyAiHostHeartbeatPath } from './host-heartbeat.ts'
import { loadProductConfig, workbuddyAiProductConfigPath } from './product-config.ts'

type Action = 'doctor' | 'logout' | 'status'

const JSON_SCHEMA_VERSION = 1

/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
}

function printHelp(): void {
  process.stdout.write([
    'Usage: dsh-workbuddyai-connect <doctor|status|logout> [--json]',
    '',
    '  doctor   secret-free sign-in and environment diagnostics',
    '  status   sign-in state, remaining WorkBuddy AI credit, and host-bundle health',
    '  logout   remove the plugin-owned credential copy (the desktop app keeps its sign-in)',
    '  --json   emit one secret-free JSON document (doctor/status only)',
    '',
  ].join('\n'))
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function makeStore(): WorkBuddyAiCredentialStore {
  const client = new WorkBuddyAiUpstreamClient()
  return new WorkBuddyAiCredentialStore({ refresh: credential => client.refreshToken(credential) })
}

async function doctor(jsonOutput: boolean): Promise<number> {
  const store = makeStore()
  const status = await store.status()
  const desktopPresent = await store.desktopFilePresent()
  const heartbeat = await readHostHeartbeat()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  const product = loadProductConfig()
  const report = {
    schemaVersion: JSON_SCHEMA_VERSION,
    package: 'dsh-workbuddyai-connect',
    version: WORKBUDDYAI_CONNECT_VERSION,
    node: process.version,
    desktopAuthFile: {
      path: store.desktopAuthPath() ?? `(no platform default; set ${WORKBUDDYAI_AUTH_FILE_ENV})`,
      present: desktopPresent,
    },
    ownAuthFile: workbuddyAiOwnAuthPath(),
    productConfig: {
      path: product.path ?? workbuddyAiProductConfigPath(),
      source: product.source,
      freeModels: product.source === 'cache'
        ? product.models.filter(model => model.credits !== undefined && /^x?0(?:\.0+)?$/u.test(model.credits)).map(model => model.id)
        : FALLBACK_WORKBUDDYAI_MODELS.map(model => model.id),
    },
    hostHeartbeat: {
      path: workbuddyAiHostHeartbeatPath(),
      present: heartbeat !== undefined,
      ...heartbeat === undefined ? {} : { registeredAt: heartbeat.registeredAt, pid: heartbeat.pid },
      processAlive: hostAlive,
    },
    signIn: status.state,
    fallbackModels: FALLBACK_WORKBUDDYAI_MODELS.length,
    hints: [
      ...status.state === 'signed-in' ? [] : ['Sign in once in the WorkBuddy AI international desktop app, then run status again.'],
      ...desktopPresent ? [] : [`No WorkBuddy AI desktop auth file at the expected path; set ${WORKBUDDYAI_AUTH_FILE_ENV} if it lives elsewhere.`],
      ...hostAlive ? [] : ['Host bundle not running in this DSH profile (or the process exited). The browser card and provider are unavailable until DSH starts the plugin.'],
    ],
  }
  if (jsonOutput) {
    printJson(report)
  } else {
    process.stdout.write([
      `WorkBuddy AI Connect ${WORKBUDDYAI_CONNECT_VERSION} on ${process.version}`,
      `Desktop auth file: ${report.desktopAuthFile.present ? 'present' : 'missing'} (${report.desktopAuthFile.path})`,
      `Product config: ${report.productConfig.source} (${report.productConfig.path})`,
      `Free models: ${report.productConfig.freeModels.join(', ') || '(none)'}`,
      `Host bundle: ${hostAlive ? `running (pid ${heartbeat!.pid})` : heartbeat !== undefined ? 'stale heartbeat (process exited)' : 'not started'}`,
      `Sign-in state: ${report.signIn}`,
      `Static fallback models: ${report.fallbackModels}`,
      ...report.hints.map(hint => `Hint: ${hint}`),
      '',
    ].join('\n'))
  }
  return status.state === 'signed-in' && desktopPresent ? 0 : 1
}

async function status(jsonOutput: boolean): Promise<number> {
  const store = makeStore()
  const client = new WorkBuddyAiUpstreamClient()
  const authStatus = await store.status()
  const heartbeat = await readHostHeartbeat()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  const hostState = hostAlive ? 'running' : heartbeat !== undefined ? 'stale' : 'not-started'
  if (authStatus.state !== 'signed-in') {
    if (jsonOutput) {
      printJson({ schemaVersion: JSON_SCHEMA_VERSION, package: 'dsh-workbuddyai-connect', version: WORKBUDDYAI_CONNECT_VERSION, status: 'signed-out', hostBundle: hostState })
    } else {
      process.stdout.write(`WorkBuddy AI Connect: signed out\nHost bundle: ${hostState}\n`)
    }
    return 1
  }
  let credits: { total: number; error?: string } | undefined
  try {
    const credential = await store.current()
    if (credential !== undefined) credits = { total: (await client.fetchCredits(credential)).total }
  } catch (error: unknown) {
    credits = { total: 0, error: safeMessage(error) }
  }
  const expiresAt = authStatus.expiresAtMs !== undefined ? new Date(authStatus.expiresAtMs).toISOString() : undefined
  if (jsonOutput) {
    printJson({
      schemaVersion: JSON_SCHEMA_VERSION,
      package: 'dsh-workbuddyai-connect',
      version: WORKBUDDYAI_CONNECT_VERSION,
      status: 'signed-in',
      ...expiresAt === undefined ? {} : { accessTokenExpires: expiresAt },
      ...authStatus.nickname === undefined ? {} : { nickname: authStatus.nickname },
      ...authStatus.domain === undefined || authStatus.domain === '' ? {} : { domain: authStatus.domain },
      source: authStatus.source,
      credits: credits?.total,
      ...credits?.error === undefined ? {} : { creditsError: credits.error },
      hostBundle: hostState,
    })
    return 0
  }
  process.stdout.write([
    `WorkBuddy AI Connect: signed in${authStatus.nickname === undefined ? '' : ` as ${authStatus.nickname}`}`,
    ...expiresAt === undefined ? [] : [`Access token expires ${expiresAt} (refresh is automatic)`],
    credits?.error === undefined
      ? `Remaining credit: ${credits?.total ?? 'unknown'}`
      : `Remaining credit: unavailable (${credits.error})`,
    `Host bundle: ${hostAlive ? `running (pid ${heartbeat!.pid})` : hostState === 'stale' ? 'stale heartbeat (DSH process exited)' : 'not started in this profile'}`,
    'Client card: load failures are logged to the browser console only; the host provider is unaffected.',
    '',
  ].join('\n'))
  return 0
}

/** Execute one boot-free command. */
export async function run(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return 0
  }
  const [rawAction, ...flags] = argv
  const actions: readonly Action[] = ['doctor', 'logout', 'status']
  if (!actions.includes(rawAction as Action)) {
    process.stderr.write(`dsh-workbuddyai-connect: expected doctor, logout, or status; got ${JSON.stringify(rawAction)}\n`)
    return 1
  }
  const action = rawAction as Action
  const jsonOutput = flags.includes('--json')
  const unknown = flags.filter(flag => flag !== '--json')
  if (unknown.length > 0 || (jsonOutput && action === 'logout')) {
    process.stderr.write(`dsh-workbuddyai-connect: invalid options for ${action}: ${flags.join(' ')}\n`)
    return 1
  }
  try {
    switch (action) {
      case 'doctor':
        return await doctor(jsonOutput)
      case 'status':
        return await status(jsonOutput)
      case 'logout': {
        const store = makeStore()
        await store.logout()
        process.stdout.write(`WorkBuddy AI Connect: removed ${workbuddyAiOwnAuthPath()}; the desktop app's sign-in is untouched\n`)
        return 0
      }
    }
  } catch (error: unknown) {
    process.stderr.write(`dsh-workbuddyai-connect: ${action} failed: ${safeMessage(error)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2))
}
