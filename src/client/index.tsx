/**
 * Browser half: the WorkBuddy AI account and model-policy card inside Plugin
 * configuration.
 *
 * @module dsh-workbuddyai-connect/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { WorkBuddyAiPluginCard } from './WorkBuddyAiPluginCard.tsx'
import type { WorkBuddyAiPluginCardInjected } from './WorkBuddyAiPluginCard.tsx'
import { en, zh } from './locales.ts'

/** Stable browser-plugin name. */
export const name = 'dsh-workbuddyai-connect-client'

/**
 * Client services required by the Plugin configuration contribution.
 *
 * The `settings.plugin.item` slot is declared by
 * `@deepseek-ai/dsh-client-ui-settings-plugins`, and the card's copy registers
 * through `@deepseek-ai/dsh-client-locale`; both are named in the package's
 * `dsh.client.inject` list, so cordis has activated them before this plugin's
 * fiber starts.
 */
export const inject = ['slots', 'locale']

/**
 * Register the card copy and the WorkBuddy AI card under Plugin configuration.
 *
 * The body is wrapped so that a slot-API breaking change degrades to a
 * `console.error` instead of throwing into the DSH loader and raising the
 * "Failed to load plugins" banner. The host provider keeps working: the
 * `workbuddyai` model channel is unaffected, and
 * `dsh-workbuddyai-connect status` reports host health via the heartbeat file.
 */
export function apply(ctx: ClientContext): void {
  try {
    const namespace = 'settings.workbuddyai'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-workbuddyai-connect: settings copy')
    const t = ctx.locale.bind(namespace) as WorkBuddyAiPluginCardInjected['t']
    // Keyed by the settings namespace the card edits: the configurable-plugins
    // tab dispatches `settings.plugin.item` by namespace, so this key is what
    // pairs the browser card with the host's registered section. Without a
    // matching host namespace the card is never dispatched.
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item',
      key: 'workbuddyai',
      locale: namespace,
      inject: (): WorkBuddyAiPluginCardInjected => ({ t }),
    }, WorkBuddyAiPluginCard))
  } catch (error: unknown) {
    // Degrade silently on the page: the host provider still serves models.
    // Developers see the full cause in the browser console; users see no banner.
    console.error('[dsh-workbuddyai-connect] client card failed to load (host provider unaffected):', error)
  }
}
