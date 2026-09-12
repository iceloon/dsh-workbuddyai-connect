import { describe, expect, it } from 'vitest'
import { composeCatalog } from '../src/catalog.ts'
import { BUILTIN_FREE_MODELS, parseProductConfig } from '../src/product-config.ts'
import type { WorkBuddyAiUpstreamModel } from '../src/upstream.ts'

const paidHy4Preview: WorkBuddyAiUpstreamModel = {
  id: 'hy4-preview',
  name: 'Hy4 preview',
  contextWindow: 1_000_000,
  maxTokens: 64_000,
  supportsImages: true,
  billing: { credits: 'x0.00', free: true },
}

const hy3: WorkBuddyAiUpstreamModel = {
  id: 'hy3',
  name: 'Hy3',
  contextWindow: 192_000,
  maxTokens: 64_000,
  supportsImages: true,
  billing: { credits: 'x0.00', free: true },
}

describe('composeCatalog', () => {
  it('serves the three built-in free models before any upstream answer', () => {
    const ids = composeCatalog([], {
      productConfig: { source: 'builtin', models: [] },
      scope: 'free',
    }).map(model => model.id)
    expect(ids).toEqual(['deepseek-v4.1-flash', 'hy4-preview-f', 'hy3'])
  })

  it('does not treat the catalog\'s x0.00 on hy4-preview as free when the product config prices it x0.29', () => {
    const productConfig = parseProductConfig(JSON.stringify({
      models: [
        { id: 'hy4-preview', name: 'Hy4 preview', credits: 'x0.29', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, supportsImages: true },
        { id: 'hy4-preview-f', name: 'Hy4 preview', credits: 'x0.00', maxInputTokens: 1_000_000, maxOutputTokens: 64_000, supportsImages: true },
        { id: 'hy3', name: 'Hy3', credits: 'x0.00', maxInputTokens: 192_000, maxOutputTokens: 64_000, supportsImages: true },
        { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', credits: 'x0.00', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, supportsImages: true },
      ],
    }))
    expect(productConfig).toBeDefined()
    const ids = composeCatalog([paidHy4Preview, hy3], {
      productConfig: productConfig!,
      scope: 'free',
    }).map(model => model.id)
    expect(ids).toContain('deepseek-v4.1-flash')
    expect(ids).toContain('hy4-preview-f')
    expect(ids).toContain('hy3')
    expect(ids).not.toContain('hy4-preview')
  })

  it('lists paid models when the policy is all', () => {
    const productConfig = parseProductConfig(JSON.stringify({
      models: [
        { id: 'hy4-preview', name: 'Hy4 preview', credits: 'x0.29', maxInputTokens: 1_000_000, maxOutputTokens: 64_000 },
        { id: 'hy3', name: 'Hy3', credits: 'x0.00', maxInputTokens: 192_000, maxOutputTokens: 64_000 },
      ],
    }))
    const ids = composeCatalog([paidHy4Preview, hy3], {
      productConfig: productConfig!,
      scope: 'all',
    }).map(model => model.id)
    expect(ids).toContain('hy4-preview')
    expect(ids).toContain('hy3')
  })

  it('keeps the built-in free whitelist as a safety net', () => {
    expect(BUILTIN_FREE_MODELS.map(model => model.id)).toEqual([
      'deepseek-v4.1-flash',
      'hy4-preview-f',
      'hy3',
    ])
  })
})
