/**
 * The `workbuddyai` pi-ai provider: one loopback-backed adapter registered into
 * the Harness LLM seam, assembled from public `dsh-llm-pi-ai` extension points.
 *
 * The route is deliberately a *separate provider id* from any domestic
 * WorkBuddy route. Two providers would otherwise both claim `workbuddy` and the
 * registry would refuse the second one; more importantly, a user running both
 * the domestic and the international app needs both routes addressable at once,
 * and distinct ids is what makes that possible.
 *
 * @module dsh-workbuddyai-connect/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, Model, ModelThinkingLevel, Provider, ThinkingLevelMap } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { WorkBuddyAiCatalog, WorkBuddyAiModelInfo } from './catalog.ts'
import type { WorkBuddyAiCredentialStore } from './auth.ts'
import type { WorkBuddyAiProbeRecord } from './probe-store.ts'
import type { WorkBuddyAiShim } from './shim.ts'
import { normalizeCredits } from './upstream.ts'

/**
 * Provider route this bundle owns.
 *
 * Distinct from the domestic plugin's `workbuddy` on purpose: both routes may be
 * mounted in one profile, and the LLM registry rejects a second adapter claiming
 * a route another already serves.
 */
export const WORKBUDDYAI_PROVIDER = 'workbuddyai'

/** Display name shown by the model picker and configuration surfaces. */
export const WORKBUDDYAI_DISPLAY_NAME = 'WorkBuddy AI'

/** Provider idle ceiling while one stream read is outstanding. */
export const WORKBUDDYAI_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Maximum base64-encoded image payload per request, at the dsh-llm-pi-ai
 * default. It bounds requests to models whose catalog entry declares
 * `supportsImages`; text-only models never receive images.
 */
const MAX_REQUEST_IMAGE_BYTES = 20_971_520

/**
 * Inert pi-ai ambient auth.
 *
 * The route authenticates only through the shim shared secret resolved per
 * request by `resolveApiKey`, so pi-ai's own credential lifecycle and ambient
 * discovery must never manufacture a credential for it. This provider declares
 * no auth at all, which is what makes `resolveApiKey` authoritative.
 */
/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/**
 * Separator between a model's name and its billing rate.
 *
 * A middle dot rather than a hyphen or colon: model names already contain
 * hyphens (`Deepseek-V4.1-Flash`), so a hyphen separator would be ambiguous
 * about where the name ends and the rate begins.
 */
const RATE_SEPARATOR = ' · '

/** The catalog display suffix: the billing rate, then any promo badges. */
function displaySuffix(info: WorkBuddyAiModelInfo): string | undefined {
  const parts = [
    normalizeCredits(info.billing?.credits),
    ...(info.billing?.badges ?? []),
  ].filter((part): part is string => part !== undefined && part !== '')
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/**
 * Append the catalog display suffix to one model's display name.
 *
 * Display-only, and it cannot affect routing: the wire request is built from
 * `model.id`, the selection a picker submits is `{provider, model: id,
 * reasoningEffort}`, and `dsh-llm` validates `name` as a non-empty string
 * without comparing its contents. Nothing in the host resolves a model *by* name.
 */
function withCatalogDisplay(name: string, info: WorkBuddyAiModelInfo): string {
  const suffix = displaySuffix(info)
  return suffix === undefined ? name : `${name}${RATE_SEPARATOR}${suffix}`
}

/** Constructor dependencies. */
export interface WorkBuddyAiAdapterOptions {
  shim: WorkBuddyAiShim
  store: WorkBuddyAiCredentialStore
  catalog: WorkBuddyAiCatalog
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined
  /**
   * Look up a local probe observation for a model. Consulted only for rows the
   * upstream left undeclared; absent means declared-set-only behavior.
   */
  observe?: (modelId: string) => WorkBuddyAiProbeRecord | undefined
}

/** What {@link createWorkBuddyAiAdapter} hands back. */
export interface WorkBuddyAiAdapter {
  adapter: PiAiAdapter
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void
}

/**
 * Resolve a model's reasoning capability into pi-ai's `thinkingLevelMap` (every
 * level pinned to its wire spelling or `null` for unsupported).
 *
 * Two sources, strictly ordered:
 *
 * 1. **The declared set.** When the row declares a non-empty `supportedEfforts`,
 *    exactly those values are offered and nothing else. This always wins: an
 *    observation never widens or narrows a declared set.
 * 2. **A local observation.** A row with no declared set normally gets no
 *    control at all — its selectable set is client-side knowledge the catalog
 *    does not carry. If the user authorized a probe and it established that the
 *    upstream *validates* the parameter, the verified spellings are offered.
 *
 * A `non-validating` observation deliberately yields no control: the upstream
 * accepts values that cannot exist, so every per-level acceptance it produced
 * would be a false positive.
 *
 * `off` is offered only when the row declares `canDisableThinking: true`. It is
 * never probed — disabling thinking is a separate capability that cannot be
 * inferred from per-level acceptance.
 */
export function reasoningFields(
  info: WorkBuddyAiModelInfo,
  observed?: WorkBuddyAiProbeRecord,
): { reasoning: boolean; thinkingLevelMap?: ThinkingLevelMap } {
  const reasoning = info.reasoning
  if (reasoning === undefined || reasoning.supports !== true) {
    // Not a reasoning model: pi-ai reads a falsy `reasoning` as "off only".
    return { reasoning: false }
  }
  const declared = reasoning.supportedEfforts
  const efforts = declared !== undefined && declared.length > 0
    ? declared
    : observed?.validation === 'validating' && observed.efforts.length > 0
      ? observed.efforts
      : undefined
  if (efforts === undefined) {
    // Undeclared and unobserved (or observed as non-validating): no thinking
    // control, and no `reasoning_effort` on the wire.
    return { reasoning: false }
  }
  const map: Record<ModelThinkingLevel, string | null> = {
    // Probing never grants `off`; only an explicit declaration does.
    off: reasoning.canDisableThinking === true && declared !== undefined && declared.length > 0 ? 'off' : null,
    // `minimal` is not in the upstream effort vocabulary, so no declared set —
    // and no probe candidate — can ever contain it.
    minimal: null,
    low: efforts.includes('low') ? 'low' : null,
    medium: efforts.includes('medium') ? 'medium' : null,
    high: efforts.includes('high') ? 'high' : null,
    xhigh: efforts.includes('xhigh') ? 'xhigh' : null,
    max: efforts.includes('max') ? 'max' : null,
  }
  return { reasoning: true, thinkingLevelMap: map as ThinkingLevelMap }
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info: WorkBuddyAiModelInfo, baseUrl: string, observed?: WorkBuddyAiProbeRecord): Model<Api> {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: WORKBUDDYAI_PROVIDER,
    baseUrl,
    input: info.supportsImages === true ? ['text', 'image'] : ['text'],
    ...reasoningFields(info, observed),
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
  } as unknown as Model<Api>
}

/**
 * Assemble the adapter.
 *
 * The provider's `getModels` reads the live catalog, and every model's `baseUrl`
 * is re-resolved per read so the shim's ephemeral port applies from the first
 * snapshot after startup. The profile is constructed by hand rather than through
 * dsh-llm-pi-ai's internal `resolveProfiles()`: that helper is not part of the
 * package's public export surface, so hand-assembly is the only supported path
 * and every required field must be adopted here explicitly.
 */
export function createWorkBuddyAiAdapter(options: WorkBuddyAiAdapterOptions): WorkBuddyAiAdapter {
  const { shim, catalog, resolveAttachments, observe } = options

  const buildModels = (): Model<Api>[] => {
    // The OpenAI SDK pi-ai drives appends `/chat/completions` to baseURL, so the
    // shim's routes line up with the `/v1` prefix in place.
    const baseUrl = `${shim.baseUrl()}/v1`
    return catalog.current().map(info => toPiModel(info, baseUrl, observe?.(info.id)))
  }

  const base = createProvider({
    id: WORKBUDDYAI_PROVIDER,
    name: WORKBUDDYAI_DISPLAY_NAME,
    auth: {
      apiKey: {
        name: 'WorkBuddy AI OAuth bearer token',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'WorkBuddy AI' }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })

  // `getModels` is delegated to a live read, so the catalog answer tracks the
  // upstream refresh and a scope change while stream dispatch keeps running
  // through the constructed provider.
  const provider: Provider = { ...base, getModels: () => buildModels() }

  // Extra fields are required at runtime by dsh-llm-pi-ai 0.1.5 (`modelErrors.get`)
  // and ignored by 0.1.0. Cast so both type lines accept the same object.
  const profile = {
    provider: WORKBUDDYAI_PROVIDER,
    displayName: WORKBUDDYAI_DISPLAY_NAME,
    streamIdleTimeoutMs: WORKBUDDYAI_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-workbuddyai-connect retryPolicy'),
    configuredMaxTokens: new Map(),
    maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
    piProvider: provider,
    modelErrors: new Map<string, string>(),
    requestImagePixelBudget: 4_194_304,
    requestImageMaxBytes: 1_048_576,
  } as ResolvedPiAiProviderProfile

  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[WORKBUDDYAI_PROVIDER, profile]])

  const adapter = new WorkBuddyAiPiAiAdapter(catalog, {
    profiles: () => profiles,
    resolveApiKey: async () => shim.token(),
    ...resolveAttachments === undefined ? {} : { resolveAttachments },
    auth: {
      credentials: {
        async read() { return undefined },
        async list() { return [] },
        async modify() {
          throw new Error('dsh-workbuddyai-connect: the workbuddyai route has no pi-ai credential lifecycle')
        },
        async delete() {},
      },
      authContext: {
        async env() { return undefined },
        async fileExists() { return false },
      },
    },
  } as ConstructorParameters<typeof PiAiAdapter>[0])

  return {
    adapter,
    invalidate: () => {
      profiles = new Map<string, ResolvedPiAiProviderProfile>([[WORKBUDDYAI_PROVIDER, profile]])
    },
  }
}

/**
 * The route's adapter: `PiAiAdapter` with the billing rate folded into the
 * catalog answers it returns to the DSH model pickers.
 *
 * `listModels()` and `resolveModel()` build their answers straight from the
 * pi-ai descriptors, which carry no billing fact, so the rate is layered on here
 * by looking the model up in the live catalog. Both overrides delegate to
 * `super` and then rewrite only the display fields, so streaming, capability
 * resolution, and effort mapping stay exactly as `dsh-llm-pi-ai` implements them.
 *
 * A model missing from the catalog falls through with its name untouched rather
 * than being dropped: catalog membership is advisory, and the seam tolerates
 * serving an unlisted id.
 */
class WorkBuddyAiPiAiAdapter extends PiAiAdapter {
  constructor(
    private readonly catalog: WorkBuddyAiCatalog,
    options: ConstructorParameters<typeof PiAiAdapter>[0],
  ) {
    super(options)
  }

  /** Catalog entry for one model id, or undefined when the catalog omits it. */
  private infoFor(model: string): WorkBuddyAiModelInfo | undefined {
    return this.catalog.current().find(entry => entry.id === model)
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await super.listModels(provider)
    return models.map(model => {
      const info = this.infoFor(model.id)
      if (info === undefined) return model
      return { ...model, name: withCatalogDisplay(model.name, info) }
    })
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const resolved = await super.resolveModel(provider, model, signal)
    const info = this.infoFor(model)
    if (info === undefined) return resolved
    return { ...resolved, name: withCatalogDisplay(resolved.name, info) }
  }
}
