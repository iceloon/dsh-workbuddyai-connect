/**
 * Node-free constants and types shared by the Host and browser halves.
 *
 * @module dsh-workbuddyai-connect/status-paths
 */

/** Plugin-owned status endpoint consumed by its browser half. */
export const WORKBUDDYAI_STATUS_PATH = '/plugins/dsh-workbuddyai-connect/status'

/**
 * Plugin-owned control endpoint.
 *
 * Separate from the status route because it accepts writes: the status route's
 * loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
 * not the same as authorizing a state-changing action. This route therefore also
 * requires the in-process key the browser half receives with the status document.
 */
export const WORKBUDDYAI_CONTROL_PATH = '/plugins/dsh-workbuddyai-connect/control'

/** One model's recorded probe observation, as the card displays it. */
export interface WorkBuddyAiWebProbeModel {
  id: string
  name: string
  /** `validating` results carry efforts; the other states never do. */
  validation: 'validating' | 'non-validating' | 'unknown'
  efforts: readonly string[]
  probedAt: number
}

/** Probe section of the status document. */
export interface WorkBuddyAiWebProbeSection {
  /** Whether the user has authorized probing. */
  consent: boolean
  /** Whether a sweep is in flight right now. */
  running: boolean
  /** Models the user could probe by hand (undeclared yet reasoning-capable). */
  candidates: readonly string[]
  /** Recorded observations. */
  results: readonly WorkBuddyAiWebProbeModel[]
}

/** One billing package and its remaining credit. */
export interface WorkBuddyAiWebCreditAccount {
  packageName: string
  remain: number
  size: number
}

/** Aggregated credit answer rendered by the plugin card. */
export interface WorkBuddyAiWebCredits {
  total: number
  accounts: readonly WorkBuddyAiWebCreditAccount[]
}

/** Billing convenience facts for one model, rendered as card badges. */
export interface WorkBuddyAiWebModelBadge {
  id: string
  name: string
  /** Whether the model is currently free (`x0.00` credits). */
  free?: boolean
  /** Promotional badges, e.g. `限时免费`, `夜间折扣`. */
  badges?: readonly string[]
  /** Credits multiplier in display form, e.g. `x0.79`. */
  credits?: string
  /** Context capacity in tokens, taken verbatim from the upstream catalog. */
  contextWindow?: number
  /**
   * Whether the free-only policy currently admits this model into the picker.
   * A card needs this to explain why a listed model is not selectable.
   */
  selectable?: boolean
}

/**
 * Which models the picker is allowed to show.
 *
 * `free` is the default: only models the product configuration prices `x0.00`.
 * `all` lifts the filter and exposes every model the account can reach, which
 * means paid models become selectable and their credit cost is real.
 */
export type WorkBuddyAiModelScope = 'free' | 'all'

/** The JSON document the plugin card renders. */
export type WorkBuddyAiWebStatus =
  | { status: 'signed-out' }
  | {
    status: 'signed-in'
    nickname?: string
    domain?: string
    source?: 'desktop' | 'dsh'
    expiresAt?: number
    credits?: WorkBuddyAiWebCredits
    creditsError?: string
    /** Billing convenience facts for the models the plugin serves. */
    models?: readonly WorkBuddyAiWebModelBadge[]
    /** Reasoning-effort probe state, consent, and recorded observations. */
    probe?: WorkBuddyAiWebProbeSection
    /** The active billing policy. */
    scope?: WorkBuddyAiModelScope
    /** Model ids the product configuration prices free. */
    freeIds?: readonly string[]
    /** Where the price data came from, for the card's provenance line. */
    priceSource?: 'cache' | 'builtin'
    /** Path of the product configuration when one was read. */
    priceSourcePath?: string
    /** Endpoint the product configuration points at, e.g. `https://www.workbuddy.ai`. */
    endpoint?: string
    /**
     * In-process key authorizing control writes. Handed to the card with the
     * status document (the card is same-origin and already had to pass the
     * loopback guard); it is never persisted and rotates per process.
     */
    controlKey?: string
  }
  | { status: 'error'; message: string }

/** Action requested from the control route. */
export type WorkBuddyAiControlAction =
  | { action: 'probe'; model: string }
  | { action: 'clearProbe' }
  | { action: 'setScope'; scope: WorkBuddyAiModelScope }
