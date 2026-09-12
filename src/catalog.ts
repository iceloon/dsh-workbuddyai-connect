/**
 * The plugin's model catalog: what the DSH model picker is offered, and under
 * which billing policy.
 *
 * Three inputs meet here, in a strict order of authority:
 *
 * 1. **The upstream catalog** (`/v2/enterprises/personal/models`) — which models
 *    exist, their capacities, image support, and declared reasoning efforts.
 * 2. **The product configuration** (`product-config.ts`) — what each model
 *    costs, and the full rows for the models the catalog endpoint omits.
 * 3. **The billing policy** ({@link WorkBuddyAiCatalogOptions.freeOnly}) — which
 *    of those the picker is allowed to show.
 *
 * The product configuration outranks the catalog on price specifically because
 * the catalog was measured wrong about it: it lists `hy4-preview` as `x0.00`
 * while the app prices it `x0.29`.
 *
 * @module dsh-workbuddyai-connect/catalog
 */

import type { WorkBuddyAiUpstreamModel } from './upstream.ts'
import { normalizeCredits } from './upstream.ts'
import type { WorkBuddyAiProductConfig } from './product-config.ts'
import { BUILTIN_FREE_MODELS, freeModelIds, productModelById, productModelToCatalogRow } from './product-config.ts'

/** One model entry the adapter exposes. */
export type WorkBuddyAiModelInfo = WorkBuddyAiUpstreamModel

/** How the catalog decides which models the picker may show. */
export type WorkBuddyAiModelScope = 'free' | 'all'

/**
 * Static rows served before the first upstream answer arrives, and whenever the
 * upstream is unreachable.
 *
 * These are the two free models the international deployment does not list in
 * its catalog endpoint, plus `hy3` which it does. Serving a usable list from the
 * first moment means an offline upstream never leaves the provider empty.
 */
export const FALLBACK_WORKBUDDYAI_MODELS: readonly WorkBuddyAiModelInfo[] = BUILTIN_FREE_MODELS

/** Constructor dependencies for {@link WorkBuddyAiCatalog}. */
export interface WorkBuddyAiCatalogOptions {
  /** Product configuration supplying prices and the omitted-model rows. */
  productConfig: WorkBuddyAiProductConfig
  /** Which models the picker may show; see {@link WorkBuddyAiModelScope}. */
  scope?: WorkBuddyAiModelScope
}

/**
 * Merge the upstream catalog with the product configuration under one billing
 * policy.
 *
 * Order of operations, each step deliberate:
 *
 * 1. Start from the upstream rows (or the fallback when there are none yet).
 * 2. Add product-config rows for free models the upstream omitted — this is what
 *    brings `deepseek-v4.1-flash` and `hy4-preview-f` into the picker.
 * 3. Overwrite each row's billing with the product configuration's verdict when
 *    it has one, so the catalog's wrong `x0.00` on a paid model cannot survive.
 * 4. Drop everything outside the policy's allow-list, *last*, so no later step
 *    can reintroduce a model the policy excluded.
 *
 * @param upstream - rows from the live catalog; empty before the first fetch.
 * @param options - product configuration and the active billing policy.
 * @returns the effective model list, upstream order first.
 */
export function composeCatalog(
  upstream: readonly WorkBuddyAiModelInfo[],
  options: WorkBuddyAiCatalogOptions,
): readonly WorkBuddyAiModelInfo[] {
  const { productConfig, scope = 'free' } = options
  const free = new Set(freeModelIds(productConfig))
  const byId = new Map<string, WorkBuddyAiModelInfo>()

  const source = upstream.length > 0 ? upstream : FALLBACK_WORKBUDDYAI_MODELS
  for (const model of source) byId.set(model.id, model)

  // Step 2: models the catalog endpoint omits. Only added when the product
  // configuration actually describes them, so the fallback table is not the
  // authority once a real config is loaded.
  if (productConfig.source === 'cache') {
    for (const id of free) {
      if (byId.has(id)) continue
      const row = productModelById(productConfig, id)
      if (row === undefined) continue
      const built = productModelToCatalogRow(row)
      if (built !== undefined) byId.set(built.id, built)
    }
  }

  // Step 3: the product configuration owns the price verdict. Its rate
  // replaces the catalog's own, and `free` is taken from the policy's
  // allow-list so a row the config prices `x0.00` is marked free even when the
  // catalog reported a different rate for it.
  for (const [id, model] of byId) {
    const row = productModelById(productConfig, id)
    if (row === undefined) continue
    byId.set(id, {
      ...model,
      billing: {
        ...model.billing,
        ...row.credits === undefined ? {} : { credits: row.credits },
        free: free.has(id),
      },
    })
  }

  // Step 4: apply the policy last.
  const allowed = scope === 'all' ? [...byId.values()] : [...byId.values()].filter(model => free.has(model.id))
  return allowed
}

/**
 * The plugin's live catalog.
 *
 * `scope` is mutable because the settings card can flip between "free only" and
 * "all models" without a restart; the adapter rebuilds its snapshot from
 * {@link current} on every read, so a change lands on the next request.
 */
export class WorkBuddyAiCatalog {
  private upstream: readonly WorkBuddyAiModelInfo[] = []
  private scope: WorkBuddyAiModelScope
  private readonly productConfig: WorkBuddyAiProductConfig

  constructor(options: WorkBuddyAiCatalogOptions) {
    this.productConfig = options.productConfig
    this.scope = options.scope ?? 'free'
  }

  /** Replace the upstream rows; the effective list is recomposed immediately. */
  setUpstream(models: readonly WorkBuddyAiModelInfo[]): void {
    this.upstream = [...models]
  }

  /** The upstream rows as last received, before any policy is applied. */
  upstreamModels(): readonly WorkBuddyAiModelInfo[] {
    return this.upstream
  }

  /** Switch the billing policy; takes effect on the next {@link current} read. */
  setScope(scope: WorkBuddyAiModelScope): void {
    this.scope = scope
  }

  /** The active billing policy. */
  currentScope(): WorkBuddyAiModelScope {
    return this.scope
  }

  /** The product configuration this catalog prices against. */
  product(): WorkBuddyAiProductConfig {
    return this.productConfig
  }

  /** The effective entries; the fallback list until the upstream answer lands. */
  current(): readonly WorkBuddyAiModelInfo[] {
    return composeCatalog(this.upstream, { productConfig: this.productConfig, scope: this.scope })
  }

  /** Every model id the product configuration prices as free. */
  freeIds(): readonly string[] {
    return freeModelIds(this.productConfig)
  }

  /**
   * Whether a model is free according to the product configuration.
   *
   * The adapter consults this rather than the row's own `billing.free` so the
   * verdict survives a catalog refresh that momentarily reports a stale rate.
   */
  isFree(id: string): boolean {
    return this.freeIds().includes(id)
  }

  /** Display suffix for one row: the rate, then any promotional badges. */
  displaySuffix(id: string): string | undefined {
    const model = this.current().find(entry => entry.id === id)
    if (model === undefined) return undefined
    const parts = [
      normalizeCredits(model.billing?.credits),
      ...(model.billing?.badges ?? []),
    ].filter((part): part is string => part !== undefined && part !== '')
    return parts.length === 0 ? undefined : parts.join(' · ')
  }
}
