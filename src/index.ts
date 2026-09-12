/**
 * WorkBuddy AI (international) models for DeepSeek Harness, reusing the
 * WorkBuddy international desktop app's sign-in.
 *
 * Registers the `workbuddyai` provider; streaming, tool calls, compaction, and
 * permissions stay Harness-owned. The plugin exists because the overseas
 * deployment differs from the domestic one in three ways that a
 * domestically-configured route cannot absorb:
 *
 * 1. It signs in through its own auth file (`workbuddy-desktop-ai.info`) with
 *    domain `www.workbuddy.ai`.
 * 2. Its personal model catalog lives at `/v2/enterprises/...` — the domestic
 *    `/console/...` path answers HTTP 500 there.
 * 3. Two of its free models are absent from that catalog entirely and must be
 *    added from the app's product configuration.
 *
 * @module dsh-workbuddyai-connect
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-attachment'
import { WorkBuddyAiCredentialStore } from './auth.ts'
import { WorkBuddyAiCatalog, type WorkBuddyAiModelScope } from './catalog.ts'
import { createWorkBuddyAiAdapter, WORKBUDDYAI_PROVIDER } from './adapter.ts'
import { createWorkBuddyAiShim } from './shim.ts'
import { WorkBuddyAiProbeService } from './probe-service.ts'
import { newestFirst, WorkBuddyAiProbeStore } from './probe-store.ts'
import { WorkBuddyAiUpstreamClient } from './upstream.ts'
import { loadProductConfig } from './product-config.ts'
import { registerWorkBuddyAiStatusRoute } from './web-status.ts'
import { createControlKey, registerWorkBuddyAiControlRoute } from './control-route.ts'
import type { WorkBuddyAiModelInfo } from './catalog.ts'
import type { WorkBuddyAiWebProbeSection } from './status-paths.ts'
import { clearHostHeartbeat, writeHostHeartbeat } from './host-heartbeat.ts'
import { WORKBUDDYAI_CONNECT_VERSION } from './version.ts'

export { WORKBUDDYAI_PROVIDER, WORKBUDDYAI_DISPLAY_NAME, createWorkBuddyAiAdapter, reasoningFields, type WorkBuddyAiAdapter } from './adapter.ts'
export { createWorkBuddyAiShim, type WorkBuddyAiShim } from './shim.ts'
export {
  composeCatalog,
  FALLBACK_WORKBUDDYAI_MODELS,
  WorkBuddyAiCatalog,
  type WorkBuddyAiModelInfo,
  type WorkBuddyAiModelScope,
} from './catalog.ts'
export {
  BUILTIN_FREE_MODELS,
  FALLBACK_EXTRA_MODELS,
  FALLBACK_FREE_MODEL_IDS,
  freeModelIds,
  loadProductConfig,
  parseProductConfig,
  workbuddyAiProductConfigPath,
  type WorkBuddyAiProductConfig,
  type WorkBuddyAiProductModel,
} from './product-config.ts'
export {
  fingerprintModel,
  WorkBuddyAiProbeStore,
  workbuddyAiProbePath,
  WORKBUDDYAI_PROBE_FILENAME,
  type WorkBuddyAiProbeRecord,
  type WorkBuddyAiProbeValidation,
} from './probe-store.ts'
export {
  PROBE_EFFORT_CANDIDATES,
  randomSentinel,
  probeModel,
  type ProbeAttempt,
  type ProbeOutcome,
  type ProbeSender,
} from './probe.ts'
export { WorkBuddyAiProbeService, type WorkBuddyAiProbeStatus } from './probe-service.ts'
export {
  defaultDesktopAuthCandidates,
  defaultDesktopAuthPath,
  parseWorkBuddyAiAuth,
  WORKBUDDYAI_AUTH_FILE_ENV,
  WORKBUDDYAI_AUTH_FILENAME,
  WORKBUDDYAI_DESKTOP_AUTH_BASENAME,
  WorkBuddyAiCredentialStore,
  workbuddyAiOwnAuthPath,
  type WorkBuddyAiAuthStatus,
  type WorkBuddyAiCredential,
} from './auth.ts'
export {
  classifyUpstreamError,
  isFreeCredits,
  normalizeCredits,
  prepareChatBody,
  regionOf,
  WorkBuddyAiUpstreamClient,
  type UpstreamErrorKind,
  type WorkBuddyAiChatResult,
  type WorkBuddyAiCredits,
  type WorkBuddyAiEffort,
  type WorkBuddyAiModelBilling,
  type WorkBuddyAiModelReasoning,
  type WorkBuddyAiRefreshOutcome,
  type WorkBuddyAiRegion,
  type WorkBuddyAiUpstreamModel,
} from './upstream.ts'
export {
  WORKBUDDYAI_HOST_HEARTBEAT_FILENAME,
  clearHostHeartbeat,
  isHeartbeatProcessAlive,
  processStartTimeMs,
  readHostHeartbeat,
  workbuddyAiHostHeartbeatPath,
  type WorkBuddyAiHostHeartbeat,
} from './host-heartbeat.ts'
export {
  WORKBUDDYAI_CONTROL_PATH,
  WORKBUDDYAI_STATUS_PATH,
  type WorkBuddyAiControlAction,
  type WorkBuddyAiWebModelBadge,
  type WorkBuddyAiWebProbeModel,
  type WorkBuddyAiWebProbeSection,
  type WorkBuddyAiWebStatus,
} from './status-paths.ts'

/** Stable Cordis plugin name. */
export const name = 'llm-workbuddyai'

/** The model registry required before the provider can register. */
export const inject = ['llm']

/**
 * Settings namespace owning the configuration card.
 *
 * A namespace is a nominal string, validated by the type system where it is used
 * rather than at runtime. The cast is applied once here so the public constant
 * carries the seam's type without pulling the brand helper into this package.
 */
export const WORKBUDDYAI_SETTINGS_NS = 'workbuddyai' as SettingsNamespace

/** Plugin configuration. */
export interface Config {
  /** Explicit WorkBuddy AI desktop auth-file path, overriding env and platform defaults. */
  authFile?: string
  /**
   * Whether the user has authorized sending probe requests about reasoning
   * efforts. Off by default: a probe spends real credit, so nothing is sent until
   * the user explicitly agrees.
   */
  probeConsent?: boolean
  /**
   * Which models the picker may show. `free` (the default) lists only models the
   * product configuration prices `x0.00`; `all` lifts the filter and makes paid
   * models selectable, so their credit cost becomes real.
   */
  modelScope?: WorkBuddyAiModelScope
  /**
   * Explicit product-configuration path, overriding the app's own cache
   * location. Only needed when the app keeps its state somewhere unusual.
   */
  productConfigFile?: string
}

export const Config: z<Config> = z.object({
  authFile: z.string().description('WorkBuddy AI desktop auth file (defaults to the app\'s own location)'),
  probeConsent: z.boolean().default(false)
    .description('Authorize reasoning-effort probes (each probe sends real requests that may consume credit)'),
  modelScope: z.union([z.const('free'), z.const('all')]).default('free')
    .description('Which models to offer: free only (default), or every model including paid ones'),
  productConfigFile: z.string()
    .description('Product configuration supplying model prices (defaults to the app\'s own cache)'),
})

/**
 * Start the loopback endpoint, register the `workbuddyai` provider, and refresh
 * the model catalog from the upstream once credentials allow it. The static
 * fallback catalog serves from the first moment, so an offline upstream never
 * leaves the provider empty.
 */
export function apply(ctx: Context, config: Config): void {
  const client = new WorkBuddyAiUpstreamClient()
  const store = new WorkBuddyAiCredentialStore({
    ...config.authFile === undefined ? {} : { desktopPath: config.authFile },
    refresh: credential => client.refreshToken(credential),
  })

  // Prices and the omitted-model rows come from the app's product configuration,
  // resolved once at startup: it is a cache the app rewrites on its own schedule,
  // and a mid-session change would silently alter what the picker offers.
  const productConfig = loadProductConfig(
    config.productConfigFile !== undefined && config.productConfigFile.trim() !== ''
      ? config.productConfigFile.trim()
      : undefined,
  )
  const catalog = new WorkBuddyAiCatalog({
    productConfig,
    scope: config.modelScope ?? 'free',
  })
  const shim = createWorkBuddyAiShim({ store, client, catalog, logger: ctx.logger })

  // Live configuration source: starts as the applied config and is replaced by
  // the settings section's source once one is installed, so edits reach the probe
  // consent gate and the billing policy without a restart. `persistScope` writes
  // a card-driven policy change into the user layer so it survives a restart.
  let current = (): Config => config
  let persistScope: ((scope: WorkBuddyAiModelScope) => void) | undefined

  // Probe state and the serial runner. Nothing here performs a request by
  // itself: `consent()` is consulted before every sweep, and the config default
  // is off, so an install that never opts in behaves exactly as before.
  const probeStore = new WorkBuddyAiProbeStore({ pluginVersion: WORKBUDDYAI_CONNECT_VERSION })
  const probeService = new WorkBuddyAiProbeService({
    store: probeStore,
    catalog,
    credentials: store,
    client,
    consent: () => current().probeConsent === true,
  })

  /**
   * Whether a model can be probed by hand: it reasons and the upstream declares
   * no effort set for it.
   *
   * Deliberately *not* filtered by whether a result already exists. Dropping a
   * model once it has been detected made the list shrink with use, so
   * re-detecting one model meant clearing every other result first. The list
   * stays stable and the card marks which entries already have an answer.
   */
  const isProbeCandidate = (info: WorkBuddyAiModelInfo): boolean => {
    if (info.reasoning?.supports !== true) return false
    return (info.reasoning.supportedEfforts?.length ?? 0) === 0
  }

  /** Compact probe state for the card: consent, candidates, observations. */
  const probeSection = (): WorkBuddyAiWebProbeSection => {
    const models = catalog.current()
    // Read results through the *same* judgement the adapter uses, rather than
    // straight from the store. A raw record can be stale in ways the adapter
    // already discounts — its catalog row changed, it aged past the TTL, or the
    // upstream has since declared an effort set (which always wins) — and showing
    // one would have the card promise levels the model picker does not offer.
    const results = models.flatMap(info => {
      const record = probeService.recordFor(info.id)
      if (record === undefined) return []
      return [{
        id: info.id,
        name: info.name,
        validation: record.validation,
        efforts: record.efforts,
        probedAt: record.probedAtMs,
      }]
    })
    return {
      consent: current().probeConsent === true,
      running: probeService.isRunning(),
      candidates: models.filter(isProbeCandidate).map(info => info.id),
      results: newestFirst(results),
    }
  }

  // Same-origin routes backing the Plugin-configuration card; the webServer
  // service is optional (a headless profile serves no browser).
  const controlKey = createControlKey()
  let refreshModels = () => {}
  ctx.inject(['webServer'], webCtx => {
    registerWorkBuddyAiStatusRoute(webCtx, {
      store,
      client,
      catalog,
      probe: () => probeSection(),
      controlKey,
    })
    registerWorkBuddyAiControlRoute(webCtx, {
      probe: async modelId => {
        // The authenticated manual endpoint is called only after per-model confirmation.
        const result = await probeService.probe(modelId, true)
        if (result.state === 'ok') refreshModels()
        return result
      },
      clearProbe: () => {
        probeStore.clear()
        refreshModels()
      },
      setScope: scope => {
        catalog.setScope(scope)
        persistScope?.(scope)
        refreshModels()
      },
    }, controlKey)
  })

  // The settings section is what makes the provider visible on the Models
  // settings page (settings.describe joins the provider directory), and it keeps
  // the configured auth-file path, billing policy, and probe consent live across
  // edits.
  //
  // The composition entry is the `base` layer and the resolved scope is the
  // live source, so an unedited install behaves exactly as composed while a
  // stored edit takes effect without a restart. `watch` runs after each commit,
  // which is where the derived state (desktop path, billing policy) is re-read.
  ctx.inject(['settings'], settingsCtx => {
    const scope = settingsCtx.settings.register(WORKBUDDYAI_SETTINGS_NS, Config, { base: config })
    current = () => scope.get()
    const apply = (): void => {
      const next = current()
      store.setDesktopPath(next.authFile)
      catalog.setScope(next.modelScope ?? 'free')
      refreshModels()
    }
    apply()
    persistScope = next => {
      void scope.update({ modelScope: next }).catch((error: unknown) => {
        ctx.logger.warn('dsh-workbuddyai-connect: failed to persist modelScope', error)
      })
    }
    ctx.effect(() => scope.watch(apply), 'dsh-workbuddyai-connect: settings observer')
  })

  let stopped = false
  ctx.effect(() => () => {
    stopped = true
    void shim.close()
    void clearHostHeartbeat()
  })

  void shim.ready
    .then(() => {
      if (stopped) return

      let invalidate: (() => void) | undefined
      try {
        // Constructed only once the listener holds a port: the provider's models
        // read the shim origin at construction time.
        const workbuddyai = createWorkBuddyAiAdapter({
          shim,
          store,
          catalog,
          resolveAttachments: () => ctx.get('attachments'),
          observe: modelId => probeService.recordFor(modelId),
        })
        invalidate = workbuddyai.invalidate
        refreshModels = () => {
          if (stopped) return
          workbuddyai.invalidate()
          ctx.emit('llm/adapters-updated')
        }

        let releaseAdapter: (() => void) | undefined
        let releaseDirectory: (() => void) | undefined
        try {
          releaseAdapter = ctx.llm.registerAdapter([WORKBUDDYAI_PROVIDER], workbuddyai.adapter)
          releaseDirectory = ctx.llm.registerConfigurableProviders([{
            provider: WORKBUDDYAI_PROVIDER,
            displayName: 'WorkBuddy AI',
            settingsNs: WORKBUDDYAI_SETTINGS_NS,
            settingsPath: [],
            declared: false,
          }])
        } finally {
          if (releaseAdapter === undefined || releaseDirectory === undefined) {
            // Registration threw; release whichever half landed.
            releaseAdapter?.()
            releaseDirectory?.()
          }
        }
        try {
          ctx.effect(() => () => {
            releaseAdapter?.()
            releaseDirectory?.()
          })
        } catch {
          // The plugin was disposed during registration; release immediately —
          // the plugin-level disposer already closed the shim.
          releaseAdapter?.()
          releaseDirectory?.()
        }

        // The host bundle is live: write a heartbeat so the status CLI can report
        // host health without a browser. Cleared on disposal; a stale heartbeat
        // after a crash is detected by PID in the reader.
        void writeHostHeartbeat()
      } catch (error: unknown) {
        ctx.logger.error('dsh-workbuddyai-connect: provider registration failed', error)
        return
      }

      void (async () => {
        try {
          const credential = await store.current()
          if (credential === undefined || stopped) return
          const models = await client.fetchModels(credential)
          if (stopped) return
          catalog.setUpstream(models)
          invalidate?.()
        } catch (error: unknown) {
          ctx.logger.warn(
            'dsh-workbuddyai-connect: dynamic model catalog unavailable; serving the static fallback list',
            error,
          )
        }
      })()
    })
    .catch((error: unknown) => {
      ctx.logger.error('dsh-workbuddyai-connect: loopback endpoint failed to start; provider not registered', error)
    })
}
