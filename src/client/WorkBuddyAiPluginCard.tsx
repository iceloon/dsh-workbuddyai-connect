/**
 * WorkBuddy AI status and policy card, contributed to Harness Plugin
 * configuration.
 *
 * The card is the plugin's only interactive surface. It reports the account and
 * remaining credit, and it owns the two decisions a user actually makes here:
 * which models the picker may show (the free-only filter), and whether reasoning
 * effort may be probed.
 *
 * Every action goes through the host's control route, which re-validates the
 * loopback origin and the in-process key. The card holds no credential and
 * cannot reach the upstream directly.
 *
 * @module dsh-workbuddyai-connect/client/WorkBuddyAiPluginCard
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { WORKBUDDYAI_CONTROL_PATH, WORKBUDDYAI_STATUS_PATH } from '../status-paths.ts'
import type { WorkBuddyAiModelScope, WorkBuddyAiWebModelBadge, WorkBuddyAiWebStatus } from '../status-paths.ts'
import type { WorkBuddyAiSettingsKey } from './locales.ts'

/** Localized copy injected by the browser-plugin registration. */
export interface WorkBuddyAiPluginCardInjected {
  t: (key: WorkBuddyAiSettingsKey, params?: Record<string, unknown>) => string
}

/**
 * Props delivered by the Plugin configuration item slot.
 *
 * The slot's owner share is empty (`children` is never supplied). The card
 * reads its copy from the injected `t` rather than from owner props, so the
 * type is only the injected face plus the usual React children prohibition.
 */
export type WorkBuddyAiPluginCardProps = Partial<WorkBuddyAiPluginCardInjected>

/** How often the card re-reads the status document while it is open. */
const POLL_INTERVAL_MS = 60_000

const cardStyle: CSSProperties = {
  overflow: 'hidden',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-module-platform)',
}
const headerStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  border: 0,
  padding: '13px 14px',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}
const headTextStyle: CSSProperties = { display: 'flex', minWidth: 0, flexDirection: 'column', gap: 3 }
const nameStyle: CSSProperties = { fontSize: 14, lineHeight: '20px', fontWeight: 600 }
const descriptionStyle: CSSProperties = { fontSize: 13, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const chevronStyle: CSSProperties = {
  flex: 'none',
  color: 'var(--dsw-alias-label-tertiary)',
  transition: 'transform 160ms ease',
}

/**
 * Official DSH settings-card chevron (`IconChevronDownOutline14`).
 *
 * Inlined so the plugin card does not depend on `dsh-client-ui-primitives`
 * being in the ModuleLoader table. The path is the same 14×14 glyph the
 * built-in PluginCard uses.
 */
function ChevronDownOutline14(props: { open: boolean }): ReactElement {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 14 14"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ ...chevronStyle, transform: props.open ? 'rotate(180deg)' : 'none' }}
    >
      <path
        d="M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z"
        fill="currentColor"
      />
    </svg>
  )
}
const cardBodyStyle: CSSProperties = { borderTop: '1px solid var(--dsw-alias-border-l2)', padding: '16px 14px 18px' }
const bodyStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }
const statusStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, fontSize: 15, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }
const buttonStyle: CSSProperties = { boxSizing: 'border-box', minHeight: 34, padding: '6px 14px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 18, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 14, cursor: 'pointer' }
const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }
const sectionStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 16 }
const sectionTitleStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const quotaGroupStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }
const quotaLabelStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }
const modelRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '6px 0' }
const modelBadgeStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }
const modelRateStyle: CSSProperties = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }
const chipStyle: CSSProperties = {
  padding: '1px 8px', borderRadius: 999, fontSize: 11, lineHeight: '18px',
  background: 'var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))',
  color: 'var(--dsw-alias-state-success-primary, #22a06b)',
}
const mutedChipStyle: CSSProperties = {
  padding: '1px 8px', borderRadius: 999, fontSize: 11, lineHeight: '18px',
  background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.06))',
  color: 'var(--dsw-alias-label-tertiary)',
}
const progressTrackStyle: CSSProperties = { height: 8, overflow: 'hidden', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))' }
const tabBarStyle: CSSProperties = {
  display: 'flex',
  gap: 4,
  marginTop: 4,
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
}
const tabStyle: CSSProperties = {
  padding: '6px 12px',
  border: 0,
  borderBottom: '2px solid transparent',
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary)',
  font: 'inherit',
  fontSize: 13,
  lineHeight: '20px',
  cursor: 'pointer',
}
const tabActiveStyle: CSSProperties = {
  borderBottom: '2px solid var(--dsw-alias-brand-primary)',
  color: 'var(--dsw-alias-label-primary)',
}

/** One selectable policy option in the model-scope switch. */
interface ScopeOption {
  scope: WorkBuddyAiModelScope
  labelKey: WorkBuddyAiSettingsKey
  hintKey: WorkBuddyAiSettingsKey
}

const SCOPE_OPTIONS: readonly ScopeOption[] = [
  { scope: 'free', labelKey: 'scopeFree', hintKey: 'scopeFreeHint' },
  { scope: 'all', labelKey: 'scopeAll', hintKey: 'scopeAllHint' },
]

/** Format a credit count without a locale dependency the card cannot assume. */
function formatCount(value: number): string {
  return value.toLocaleString()
}

/** Format an epoch millisecond timestamp for display, degrading to a raw value. */
function formatTime(value: number | undefined): string {
  if (value === undefined) return ''
  try {
    return new Date(value).toLocaleString()
  } catch {
    return String(value)
  }
}

/** Format a context window as a compact token count (`1M`, `192K`). */
function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`
  return String(tokens)
}

/** Localize an upstream promotional badge label, with an unknown-badge fallback. */
function modelBadgeLabel(badge: string, t: WorkBuddyAiPluginCardInjected['t']): string {
  if (badge === '限时免费') return t('freeModel')
  return badge
}

/** Result of one control-route call. */
interface ControlResult {
  ok: boolean
  error?: string
}

/**
 * POST one control action with the in-process key.
 *
 * The key travels in a header rather than the body so it never lands in a log
 * line that records payloads, and the request carries no credential of its own.
 */
async function postControl(key: string, body: unknown): Promise<ControlResult> {
  try {
    const response = await fetch(WORKBUDDYAI_CONTROL_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-WorkBuddyAi-Control-Key': key,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { ok: false, error: text.slice(0, 200) || `HTTP ${response.status}` }
    }
    const payload = await response.json().catch(() => undefined) as { state?: string; reason?: string } | undefined
    // A probe can answer 200 with a non-`ok` state; that is a refusal the card
    // must show, not a success.
    if (payload !== undefined && payload.state !== undefined && payload.state !== 'ok' && payload.state !== 'cleared') {
      return { ok: false, error: payload.reason ?? payload.state }
    }
    return { ok: true }
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** One model row: name, badges, and why it is or is not selectable. */
function ModelRow(props: {
  model: WorkBuddyAiWebModelBadge
  t: WorkBuddyAiPluginCardInjected['t']
}): ReactElement {
  const { model, t } = props
  return (
    <li style={modelRowStyle}>
      <div style={{ display: 'flex', minWidth: 0, flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 14, color: 'var(--dsw-alias-label-primary)' }}>{model.name}</span>
        <span style={modelRateStyle}>
          {model.credits === undefined ? model.id : t('rate', { rate: model.credits })}
          {model.contextWindow === undefined ? '' : ` · ${t('contextWindow', { tokens: formatContext(model.contextWindow) })}`}
        </span>
      </div>
      <div style={modelBadgeStyle}>
        {(model.badges ?? []).map(badge => (
          <span key={badge} style={chipStyle}>{modelBadgeLabel(badge, t)}</span>
        ))}
        {model.free === true
          ? <span style={chipStyle}>{t('freeModel')}</span>
          : <span style={mutedChipStyle}>{t('scopePaid')}</span>}
        {model.selectable === true ? null : <span style={mutedChipStyle}>{t('scopeHidden')}</span>}
      </div>
    </li>
  )
}

/**
 * The plugin card.
 *
 * Everything it renders comes from one status document; the control route is
 * used only to change state, and a successful change triggers a re-read so the
 * card never shows an optimistic value the host did not accept.
 */
export function WorkBuddyAiPluginCard(props: WorkBuddyAiPluginCardProps): ReactElement {
  const t = props.t ?? ((key: WorkBuddyAiSettingsKey) => key)
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'status' | 'models'>('status')
  const [status, setStatus] = useState<WorkBuddyAiWebStatus | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const mounted = useRef(true)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const response = await fetch(WORKBUDDYAI_STATUS_PATH, { headers: { 'Accept': 'application/json' } })
      if (!response.ok) {
        setError(`${t('requestFailed')} (HTTP ${response.status})`)
        return
      }
      const document = await response.json() as WorkBuddyAiWebStatus
      if (!mounted.current) return
      setStatus(document)
      setError(document.status === 'error' ? document.message : undefined)
    } catch (cause: unknown) {
      if (!mounted.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [t])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Poll only while the card is open: a collapsed card costs nothing, and the
  // status document performs a live billing call on the host.
  useEffect(() => {
    if (!open) return
    void load()
    const timer = setInterval(() => { void load() }, POLL_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [open, load])

  const signedIn = status !== undefined && status.status === 'signed-in'
  const controlKey = signedIn ? status.controlKey : undefined
  const scope: WorkBuddyAiModelScope = signedIn ? (status.scope ?? 'free') : 'free'
  const probe = signedIn ? status.probe : undefined
  const models = signedIn ? (status.models ?? []) : []

  /** Run one control action, then re-read so the card reflects host state only. */
  const runControl = useCallback(async (body: unknown): Promise<void> => {
    if (controlKey === undefined) return
    setBusy(true)
    try {
      const result = await postControl(controlKey, body)
      if (!result.ok) {
        setError(result.error ?? t('requestFailed'))
        return
      }
      setError(undefined)
      await load()
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [controlKey, load, t])

  const onScope = useCallback((next: WorkBuddyAiModelScope): void => {
    void runControl({ action: 'setScope', scope: next })
  }, [runControl])

  const onProbe = useCallback((model: string): void => {
    void runControl({ action: 'probe', model })
  }, [runControl])

  const onClearProbe = useCallback((): void => {
    void runControl({ action: 'clearProbe' })
  }, [runControl])

  const credits = signedIn ? status.credits : undefined
  const creditsError = signedIn ? status.creditsError : undefined
  const accountRows = useMemo(() => credits?.accounts ?? [], [credits])

  return (
    <li style={cardStyle}>
      <button
        type="button"
        style={headerStyle}
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <span style={headTextStyle}>
          <span style={nameStyle}>{t('title')}</span>
          <span style={descriptionStyle}>{t('intro')}</span>
        </span>
        <ChevronDownOutline14 open={open} />
      </button>

      {open
        ? (
          <div style={cardBodyStyle}>
            {loading && status === undefined ? <p style={bodyStyle}>{t('loading')}</p> : null}

            {status !== undefined && status.status === 'signed-out'
              ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div style={rowStyle}>
                    <span style={statusStyle}>{t('signedOut')}</span>
                    <button type="button" style={buttonStyle} onClick={() => { void load() }} disabled={loading}>
                      {loading ? t('refreshing') : t('refresh')}
                    </button>
                  </div>
                  <p style={bodyStyle}>{t('signedOutHint')}</p>
                </div>
              )
              : null}

            {status !== undefined && status.status === 'error'
              ? <p style={errorStyle}>{status.message}</p>
              : null}

            {signedIn
              ? (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <div style={tabBarStyle} role="tablist">
                    {(['status', 'models'] as const).map(key => (
                      <button
                        key={key}
                        type="button"
                        role="tab"
                        aria-selected={tab === key}
                        style={tab === key ? { ...tabStyle, ...tabActiveStyle } : tabStyle}
                        onClick={() => { setTab(key) }}
                      >
                        {key === 'status' ? t('tabStatus') : t('tabModels')}
                      </button>
                    ))}
                  </div>

                  {tab === 'status'
                    ? (
                      <div style={sectionStyle}>
                        <h4 style={sectionTitleStyle}>{t('accountHeading')}</h4>
                        <div style={rowStyle}>
                          <span style={statusStyle}>
                            {status.nickname === undefined ? t('signedInAs', { nickname: '—' }) : t('signedInAs', { nickname: status.nickname })}
                          </span>
                          <button type="button" style={buttonStyle} onClick={() => { void load() }} disabled={loading}>
                            {loading ? t('refreshing') : t('refresh')}
                          </button>
                        </div>
                        {status.expiresAt === undefined
                          ? null
                          : <p style={bodyStyle}>{t('accessTokenExpires', { time: formatTime(status.expiresAt) })}</p>}

                        <h4 style={sectionTitleStyle}>{t('creditsHeading')}</h4>
                        {creditsError === undefined ? null : <p style={errorStyle}>{t('creditsError', { message: creditsError })}</p>}
                        {credits === undefined
                          ? null
                          : (
                            <div style={quotaGroupStyle}>
                              <span style={bodyStyle}>{t('creditsTotal', { total: formatCount(credits.total) })}</span>
                              {accountRows.length === 0
                                ? null
                                : (
                                  <div style={quotaGroupStyle}>
                                    <span style={quotaLabelStyle}>{t('creditsDetailHeading')}</span>
                                    {accountRows.map(account => (
                                      <div key={account.packageName} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                        <span style={quotaLabelStyle}>
                                          <span>{account.packageName}</span>
                                          <span>
                                            {account.size > 0
                                              ? t('exactRemaining', { remain: formatCount(account.remain), size: formatCount(account.size) })
                                              : t('creditPackageUnknownSize', { remain: formatCount(account.remain) })}
                                          </span>
                                        </span>
                                        {account.size > 0
                                          ? (
                                            <div style={progressTrackStyle}>
                                              <div style={{
                                                width: `${Math.max(0, Math.min(100, Math.round((account.remain / account.size) * 100)))}%`,
                                                height: '100%',
                                                background: 'var(--dsw-alias-brand-primary)',
                                              }} />
                                            </div>
                                          )
                                          : null}
                                      </div>
                                    ))}
                                  </div>
                                )}
                            </div>
                          )}
                      </div>
                    )
                    : (
                      <div style={sectionStyle}>
                        <h4 style={sectionTitleStyle}>{t('scopeHeading')}</h4>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {SCOPE_OPTIONS.map(option => (
                            <label
                              key={option.scope}
                              style={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: 10,
                                padding: '8px 10px',
                                border: '1px solid var(--dsw-alias-border-l2)',
                                borderRadius: 8,
                                cursor: busy ? 'default' : 'pointer',
                              }}
                            >
                              <input
                                type="radio"
                                name="workbuddyai-model-scope"
                                checked={scope === option.scope}
                                disabled={busy || controlKey === undefined}
                                onChange={() => { onScope(option.scope) }}
                                style={{ marginTop: 3 }}
                              />
                              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                <span style={{ fontSize: 14, color: 'var(--dsw-alias-label-primary)' }}>
                                  {t(option.labelKey)}
                                  {scope === option.scope ? <span style={{ ...mutedChipStyle, marginLeft: 8 }}>{t('scopeActive')}</span> : null}
                                </span>
                                <span style={modelRateStyle}>{t(option.hintKey)}</span>
                              </span>
                            </label>
                          ))}
                        </div>
                        {busy ? <p style={bodyStyle}>{t('scopeSaving')}</p> : null}

                        <h4 style={sectionTitleStyle}>{t('modelsHeading')}</h4>
                        <p style={modelRateStyle}>{t('modelsIntro')}</p>
                        <p style={modelRateStyle}>
                          {status.priceSource === 'builtin' ? t('priceSourceBuiltin') : t('priceSourceCache')}
                        </p>
                        {status.priceSourcePath === undefined
                          ? null
                          : <p style={modelRateStyle}>{t('priceSourcePath', { path: status.priceSourcePath })}</p>}
                        {models.length === 0
                          ? <p style={bodyStyle}>{t('modelsEmpty')}</p>
                          : (
                            <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                              {models.map(model => <ModelRow key={model.id} model={model} t={t} />)}
                            </ul>
                          )}

                        {probe === undefined ? null : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <h4 style={sectionTitleStyle}>{t('probeHeading')}</h4>
                            <p style={modelRateStyle}>{t('probeIntro')}</p>
                            <p style={modelRateStyle}>{t('probeCandidates', { count: probe.candidates.length })}</p>
                            {probe.candidates.length === 0
                              ? <p style={bodyStyle}>{t('probeResultEmpty')}</p>
                              : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                  {probe.candidates.map(id => (
                                    <div key={id} style={rowStyle}>
                                      <span style={bodyStyle}>{id}</span>
                                      <button
                                        type="button"
                                        style={buttonStyle}
                                        disabled={busy || probe.running}
                                        onClick={() => { onProbe(id) }}
                                      >
                                        {probe.running ? t('probeRunning', { model: id }) : t('probeStart')}
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              )}
                            {probe.results.length === 0
                              ? null
                              : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                  {probe.results.map(result => (
                                    <span key={result.id} style={modelRateStyle}>
                                      {result.validation === 'validating'
                                        ? t('probeResultVerified', { levels: result.efforts.join(', ') || t('probeResultNoLevels') })
                                        : result.validation === 'non-validating'
                                          ? t('probeResultNotValidating')
                                          : t('probeResultUnknown')}
                                      {` · ${t('probeResultAt', { time: formatTime(result.probedAt) })}`}
                                    </span>
                                  ))}
                                  <button type="button" style={buttonStyle} disabled={busy} onClick={onClearProbe}>
                                    {t('probeClear')}
                                  </button>
                                </div>
                              )}
                          </div>
                        )}
                      </div>
                    )}

                  {error === undefined ? null : <p style={{ ...errorStyle, paddingTop: 12 }}>{error}</p>}
                </div>
              )
              : null}
          </div>
        )
        : null}
    </li>
  )
}
