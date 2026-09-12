import z from "@deepseek-ai/schemastery";
import { ThinkingLevelMap } from "@earendil-works/pi-ai";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { Context } from "@deepseek-ai/cordis";
import { SettingsNamespace } from "@deepseek-ai/dsh-settings";
import { AttachmentStore } from "@deepseek-ai/dsh-attachment";
//#region src/auth.d.ts
/** Normalized WorkBuddy credential, timestamps in epoch milliseconds. */
interface WorkBuddyAiCredential {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
  refreshExpiresAtMs?: number;
  domain: string;
  uid: string;
  enterpriseId?: string;
  nickname?: string;
  /** Which storage the credential was read from; refreshes are always `dsh`. */
  source: 'desktop' | 'dsh';
}
/** Read-only sign-in summary for status and doctor output. */
interface WorkBuddyAiAuthStatus {
  state: 'signed-in' | 'signed-out';
  expiresAtMs?: number;
  refreshExpiresAtMs?: number;
  nickname?: string;
  domain?: string;
  source?: 'desktop' | 'dsh';
}
/** Constructor options; only {@link refresh} is required. */
interface WorkBuddyAiStoreOptions {
  /** Explicit desktop auth-file path, overriding env and platform defaults. */
  desktopPath?: string;
  /** Explicit plugin-owned copy path, defaulting under `$DSH_HOME`. */
  ownPath?: string;
  /** Performs the upstream token refresh. */
  refresh: (credential: WorkBuddyAiCredential) => Promise<WorkBuddyAiRefreshOutcome>;
  /** Refresh this long before actual expiry; default five minutes. */
  refreshMarginMs?: number;
}
/** Basename of the plugin-owned credential copy inside the Harness home. */
declare const WORKBUDDYAI_AUTH_FILENAME = ".workbuddyai-auth.json";
/** Env variable that overrides the desktop auth-file location. */
declare const WORKBUDDYAI_AUTH_FILE_ENV = "WORKBUDDYAI_AUTH_FILE";
/**
 * Basename of the WorkBuddy **international** desktop auth document.
 *
 * The domestic build writes `workbuddy-desktop.info` in the same directory;
 * only the `.ai` suffix names the overseas sign-in this plugin is built for.
 */
declare const WORKBUDDYAI_DESKTOP_AUTH_BASENAME = "workbuddy-desktop-ai.info";
/** Plugin-owned copy path inside the Harness home. */
declare function workbuddyAiOwnAuthPath(): string;
/**
 * Platform-default candidates for the WorkBuddy **international** desktop
 * app's auth file, in probe order. Windows probes both AppData roots: current
 * builds write under `%LOCALAPPDATA%` (Local), older ones under `%APPDATA%`
 * (Roaming). WSL probes those same Windows locations through its mounted
 * Windows profile before the native Linux location.
 */
declare function defaultDesktopAuthCandidates(): string[];
/** First platform-default candidate; see {@link defaultDesktopAuthCandidates}. */
declare function defaultDesktopAuthPath(): string | undefined;
/**
 * Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
 * nested form `{"auth":{...},"account":{...}}` and the flat panel form.
 * Returns undefined when the document carries no access token.
 */
declare function parseWorkBuddyAiAuth(text: string): WorkBuddyAiCredential | undefined;
/**
 * Turn the official CLI `/v2/plugin/auth/token` payload into a credential.
 * Identity fields come from the access-token JWT; the desktop file is not used.
 */
declare function credentialFromPluginToken(data: Record<string, unknown>): WorkBuddyAiCredential;
/**
 * Read-only credential store with demand-driven refresh.
 *
 * Refresh policy: refresh only when the access token is inside the margin (or
 * already expired), keep the refreshed credential in the plugin-owned copy,
 * and never write the desktop app's file. A failed refresh still returns a
 * not-yet-expired token, so an unreachable refresh endpoint does not take down
 * a working session.
 */
declare class WorkBuddyAiCredentialStore {
  private readonly refresh;
  private readonly refreshMarginMs;
  private readonly ownPath;
  private desktopPathOverride;
  private inflight;
  constructor(options: WorkBuddyAiStoreOptions);
  /**
   * Configuration precedence for the desktop file: the plugin's configured
   * path, then the environment variable, then the platform defaults. An
   * explicit path is used verbatim; the defaults are a probe order.
   */
  private resolveDesktopCandidates;
  private resolveDesktopPath;
  /** Repoint the desktop file; a settings change applies on the next read. */
  setDesktopPath(path: string | undefined): void;
  /** The resolved desktop auth-file path, for diagnostics. */
  desktopAuthPath(): string | undefined;
  /** The plugin-owned copy path, for diagnostics. */
  ownAuthPath(): string;
  /** Read the freshest stored credential without refreshing anything. */
  current(): Promise<WorkBuddyAiCredential | undefined>;
  /**
   * The credential to send upstream: {@link current}, refreshed on demand.
   * Single-flight, so parallel requests share one refresh.
   */
  resolve(): Promise<WorkBuddyAiCredential>;
  /** Read-only sign-in summary; never refreshes and never throws. */
  status(): Promise<WorkBuddyAiAuthStatus>;
  /** Remove the plugin-owned copy; the desktop file is untouched. */
  logout(): Promise<void>;
  /** Persist a browser-OAuth credential into the plugin-owned copy. */
  importCredential(credential: WorkBuddyAiCredential): Promise<WorkBuddyAiCredential>;
  private needsRefresh;
  private refreshNow;
  private saveOwn;
  /**
   * Read the first desktop candidate that exists. Only an absent file (ENOENT)
   * falls through to the next candidate; a file that is present but unparsable
   * is authoritative for its slot, so a stale older-version file never silently
   * wins over a broken newer one.
   */
  private readDesktop;
  private readOwn;
  /** Whether any desktop-file candidate exists as a regular file; diagnostics only. */
  desktopFilePresent(): Promise<boolean>;
}
//#endregion
//#region src/probe.d.ts
/**
 * The canonical values a probe tests, in a fixed order.
 *
 * `minimal` is absent: it appears in no upstream vocabulary. `off` is absent
 * by policy — disabling thinking is a separate capability the upstream must
 * declare through `canDisableThinking`, never something probing may infer.
 */
declare const PROBE_EFFORT_CANDIDATES: readonly WorkBuddyAiEffort[];
/** Sentinel generator; injectable so tests get deterministic values. */
type SentinelFactory = () => string;
/** Default sentinel: unmistakably non-canonical, different on every call. */
declare function randomSentinel(): string;
/**
 * One response as the probe sees it, split into the only distinctions the
 * attribution rule needs.
 */
interface ProbeAttempt {
  /** HTTP status, or 0 for a transport failure. */
  status: number;
  /** True when a parseable SSE event arrived. */
  streamed: boolean;
  /** `extError.code` from a JSON error body, when present. */
  errorCode?: string;
  /** Free-form detail for logs; never shown as a capability claim. */
  detail?: string;
}
/** How one attempt is performed; the caller owns credentials and HTTP. */
type ProbeSender = (effort: string | undefined, signal: AbortSignal) => Promise<ProbeAttempt>;
/** The outcome of probing one model. */
type ProbeOutcome = {
  validation: 'validating';
  efforts: readonly WorkBuddyAiEffort[];
  requests: number;
} | {
  validation: 'non-validating';
  efforts: readonly [];
  requests: number;
} | {
  validation: 'unknown';
  efforts: readonly [];
  requests: number;
  reason: string;
};
/**
 * Probe one model.
 *
 * `options.candidates` exists so tests can shorten the sweep; production always
 * uses {@link PROBE_EFFORT_CANDIDATES}.
 */
declare function probeModel(options: {
  send: ProbeSender;
  sentinel?: SentinelFactory;
  candidates?: readonly WorkBuddyAiEffort[];
  timeoutMs?: number;
}): Promise<ProbeOutcome>;
//#endregion
//#region src/upstream.d.ts
/** WorkBuddy region selected by the credential's login domain. */
type WorkBuddyAiRegion = 'cn' | 'global';
/** Upstream failure classes the shim maps onto distinct HTTP answers. */
type UpstreamErrorKind = 'hard_credit' | 'soft_rate' | 'session_dead' | 'not_found' | 'server' | 'client';
/** One CLI-usable model as the upstream catalog describes it. */
interface WorkBuddyAiUpstreamModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  /**
   * Upstream-declared image input capability. Missing or false upstream data
   * resolves to false, so an unknown model stays text-only: over-claiming
   * admits an image the provider then rejects after the message is durable.
   */
  supportsImages: boolean;
  /**
   * Reasoning metadata the upstream catalog declares per model. The wire effort
   * values (`low`, `medium`, `high`, `xhigh`, `max`) map directly onto pi-ai's
   * thinking levels, and the supported set decides which levels the DSH model
   * selector offers.
   */
  reasoning?: WorkBuddyAiModelReasoning;
  /**
   * Billing convenience metadata: the credits multiplier the upstream reports
   * (e.g. `"x0.00"` for free) and promotional badges like
   * `badge:限时免费:#FF0000`.
   *
   * The multiplier reaches the browser through the host LLM seam, which has no
   * locale service, so {@link normalizeCredits} trims it to a language-neutral
   * display form (`x0.79`) that reads the same in every UI language.
   */
  billing?: WorkBuddyAiModelBilling;
}
/** Reasoning metadata the upstream catalog declares for one model. */
interface WorkBuddyAiModelReasoning {
  /** Whether the model does any reasoning at all (upstream `supportsReasoning`). */
  supports: boolean;
  /** Whether the model can only think (upstream `onlyReasoning`). */
  onlyReasoning: boolean;
  /** Selectable effort values; absent means the model has no explicit set. */
  supportedEfforts?: readonly WorkBuddyAiEffort[];
  /** Default effort the upstream uses when none is chosen. */
  defaultEffort?: WorkBuddyAiEffort;
  /** Whether thinking can be switched off; false means it is always on. */
  canDisableThinking: boolean;
}
/** The concrete effort spellings WorkBuddy exposes on the wire. */
type WorkBuddyAiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
/** Billing convenience metadata reported for one model. */
interface WorkBuddyAiModelBilling {
  /** Credits multiplier, e.g. `"x0.00"` (free) or `"x0.79"`. */
  credits?: string;
  /** Promotional tags, e.g. `"限时免费"`, `"夜间折扣"`. */
  badges?: readonly string[];
  /** Whether the model is currently free (`x0.00` credits). */
  free: boolean;
}
/** One billing package and its remaining credit. */
interface WorkBuddyAiCreditAccount {
  packageName: string;
  remain: number;
  size: number;
}
/** Aggregated credit answer for one credential. */
interface WorkBuddyAiCredits {
  total: number;
  accounts: readonly WorkBuddyAiCreditAccount[];
}
/** Token refresh answer; fields the upstream omits stay absent. */
interface WorkBuddyAiRefreshOutcome {
  accessToken: string;
  refreshToken?: string;
  expiresInSec?: number;
  domain?: string;
}
/** Chat answer: either a live SSE response or a classified failure. */
type WorkBuddyAiChatResult = {
  ok: true;
  response: Response;
} | {
  ok: false;
  status: number;
  kind: UpstreamErrorKind;
  message: string;
};
/**
 * Reduce an upstream credits string to its language-neutral display form.
 *
 * The host LLM seam carries this text to the browser, and the host has no
 * locale service — whatever string is produced here is shown verbatim in every
 * UI language. The upstream is inconsistent in a way that matters: some rows
 * report a bare multiplier (`x0.79`) and others append a unit word
 * (`x0.79 credits`), and the unit word would pin the display to English.
 * Dropping a trailing `credits` (case-insensitive, singular or plural) yields
 * the one spelling that reads identically in every language.
 *
 * @param credits - raw upstream credits string, e.g. `"x0.79 credits"`.
 * @returns the bare multiplier, or undefined when nothing displayable remains.
 */
declare function normalizeCredits(credits: string | undefined): string | undefined;
/**
 * Whether a credits multiplier means "free".
 *
 * Only an explicit `x0.00` (with or without the `x`, any number of decimals)
 * counts. An absent multiplier is *not* free: the upstream omits the field for
 * some rows and treating absence as free would advertise a paid model.
 */
declare function isFreeCredits(credits: string | undefined): boolean;
/** Classify an upstream failure from its HTTP status and body excerpt. */
declare function classifyUpstreamError(status: number, body: string): UpstreamErrorKind;
/**
 * Region for a login domain.
 *
 * An empty domain resolves to `global`, not `cn`: this plugin is the
 * international one, so an unlabelled credential is treated as belonging to the
 * deployment it was configured for. A credential that names the domestic domain
 * still routes domestic, because the `domain` field is the upstream's own
 * routing fact and second-guessing it would send a `.cn` token to `.ai`.
 */
declare function regionOf(domain: string): WorkBuddyAiRegion;
/**
 * Normalize an OpenAI chat-completions body for the WorkBuddy upstream.
 *
 * Three rewrites, each fixing a measured rejection:
 *
 * 1. `stream` is forced true — the upstream refuses a non-streaming chat call.
 * 2. `role: "developer"` becomes `role: "system"` — pi-ai emits the system
 *    prompt with the OpenAI `developer` role, which this upstream answers with
 *    HTTP 400 code 11128.
 * 3. `tool_choice` is flattened to the string form the upstream expects; an
 *    object form returns 400.
 *
 * It additionally guarantees the upstream's "first message is system prompt"
 * rule: a request whose first message is not a system message is answered with
 * code 11128 and never reaches a model. DSH normally supplies a system prompt,
 * but a session with an empty instruction set would otherwise fail every call,
 * so a minimal one is prepended rather than letting the request die.
 *
 * @param source - the JSON request body pi-ai produced.
 * @returns the rewritten body, or the input unchanged when it is not a JSON object.
 */
declare function prepareChatBody(source: string): string;
/**
 * Upstream HTTP client. One instance serves the whole plugin; requests take the
 * credential explicitly so token refreshes apply on the next call.
 */
declare class WorkBuddyAiUpstreamClient {
  /** POST the chat endpoint; a successful answer is the raw SSE response. */
  chatStream(credential: WorkBuddyAiCredential, bodyJson: string, signal?: AbortSignal): Promise<WorkBuddyAiChatResult>;
  /** POST the token-refresh endpoint; the caller merges the outcome. */
  refreshToken(credential: WorkBuddyAiCredential): Promise<WorkBuddyAiRefreshOutcome>;
  /** POST the official CLI login start; returns the browser `authUrl`. */
  startPluginLogin(nonce: string): Promise<{
    state: string;
    authUrl: string;
  }>;
  /**
   * GET the CLI login token. Envelope code `11217` means the browser has not
   * finished yet — returns `undefined` so the caller can poll again.
   */
  pollPluginToken(state: string): Promise<Record<string, unknown> | undefined>;
  /**
   * GET the personal model catalog from the region's own path and keep the
   * `cli` agent's models only.
   *
   * The path is chosen from the credential's domain (see {@link CATALOG_PATH}):
   * the overseas host answers the domestic path with HTTP 500, so this is what
   * makes an international sign-in work at all.
   */
  fetchModels(credential: WorkBuddyAiCredential): Promise<readonly WorkBuddyAiUpstreamModel[]>;
  /** POST the billing endpoint for the aggregated remaining credit. */
  fetchCredits(credential: WorkBuddyAiCredential): Promise<WorkBuddyAiCredits>;
  /**
   * One probe request: a real streaming chat call carrying the effort under
   * test.
   *
   * Shares {@link chatHeaders} with the normal chat path on purpose — a probe
   * must describe what a real message would experience, not a parallel code
   * path. The caller aborts as soon as a parseable event arrives; the body is
   * never assembled into an answer. `reasoning_effort` is omitted entirely
   * (rather than sent empty) when `effort` is undefined, so the baseline case is
   * a genuinely bare request.
   */
  probeEffort(credential: WorkBuddyAiCredential, model: string, effort: string | undefined, signal: AbortSignal): Promise<ProbeAttempt>;
}
//#endregion
//#region src/product-config.d.ts
/** Absolute path of the cached product configuration. */
declare function workbuddyAiProductConfigPath(): string;
/** One model row from the product configuration, narrowed to what is used. */
interface WorkBuddyAiProductModel {
  id: string;
  name: string;
  /** Credits multiplier, e.g. `"x0.00"`. Absent when the config states none. */
  credits?: string;
  contextWindow: number;
  maxTokens: number;
  supportsImages: boolean;
  supportsReasoning: boolean;
  onlyReasoning: boolean;
  supportedEfforts?: readonly WorkBuddyAiEffort[];
  defaultEffort?: WorkBuddyAiEffort;
  canDisableThinking: boolean;
}
/** The parsed slice of the product configuration this plugin consumes. */
interface WorkBuddyAiProductConfig {
  /** Where the data came from, for diagnostics and the settings card. */
  source: 'cache' | 'builtin';
  /** Path consulted for `cache`; absent for `builtin`. */
  path?: string;
  /** Application the config describes, e.g. `workbuddy-ai`. */
  applicationName?: string;
  /** Endpoint the config points at, e.g. `https://www.workbuddy.ai`. */
  endpoint?: string;
  /** Whether the config describes the overseas build. */
  isOversea?: boolean;
  /** Every model row, in configuration order. */
  models: readonly WorkBuddyAiProductModel[];
}
/**
 * Every model the international deployment prices `x0.00`, with the metadata
 * copied verbatim from the product configuration.
 *
 * This is the fallback the plugin uses when the app's cache cannot be read, and
 * it is deliberately a *whitelist of the free* rather than a blacklist of the
 * paid: a model absent from both this table and the cache is treated as paid, so
 * the failure mode is "a free model is missing" rather than "a paid model is
 * billed silently".
 *
 * `hy4-preview` (without the `-f`) is deliberately absent even though the
 * catalog endpoint reports it as `x0.00`: the product configuration prices it
 * `x0.29`, so it is paid, and it shares its display name with `hy4-preview-f` —
 * including both would show two identically-named rows, one of them billable.
 */
declare const BUILTIN_FREE_MODELS: readonly WorkBuddyAiUpstreamModel[];
/** Ids of the models the product configuration prices free. */
declare const FALLBACK_FREE_MODEL_IDS: readonly string[];
/**
 * Last-known international `credits` multipliers, used when the app cache is
 * absent. Catalog `x0.00` is not trusted (`hy4-preview` is x0.29 here).
 */
declare const BUILTIN_CREDITS: Readonly<Record<string, string>>;
/**
 * The subset the catalog endpoint does not return, so they must be injected.
 *
 * `hy3` is absent from this list because the endpoint does list it; the other
 * two are missing from the live catalog entirely.
 */
declare const FALLBACK_EXTRA_MODELS: readonly WorkBuddyAiUpstreamModel[];
/** Parse a product-configuration document; undefined when it is not usable. */
declare function parseProductConfig(text: string): WorkBuddyAiProductConfig | undefined;
/**
 * Load the product configuration, falling back to the built-in table.
 *
 * A missing or malformed cache is never an error: the plugin must still offer
 * its free models on a machine where the app has not run yet.
 */
declare function loadProductConfig(path?: string): WorkBuddyAiProductConfig;
/**
 * The free model ids a configuration declares.
 *
 * Only an explicit `x0.00` counts. When the cache is absent the built-in
 * whitelist applies, so the answer is never "every model" — a mis-read must not
 * be able to turn the free-only filter into a no-op.
 */
declare function freeModelIds(config: WorkBuddyAiProductConfig): readonly string[];
//#endregion
//#region src/catalog.d.ts
/** One model entry the adapter exposes. */
type WorkBuddyAiModelInfo = WorkBuddyAiUpstreamModel;
/** How the catalog decides which models the picker may show. */
type WorkBuddyAiModelScope = 'free' | 'all';
/**
 * Static rows served before the first upstream answer arrives, and whenever the
 * upstream is unreachable.
 *
 * These are the two free models the international deployment does not list in
 * its catalog endpoint, plus `hy3` which it does. Serving a usable list from the
 * first moment means an offline upstream never leaves the provider empty.
 */
declare const FALLBACK_WORKBUDDYAI_MODELS: readonly WorkBuddyAiModelInfo[];
/** Constructor dependencies for {@link WorkBuddyAiCatalog}. */
interface WorkBuddyAiCatalogOptions {
  /** Product configuration supplying prices and the omitted-model rows. */
  productConfig: WorkBuddyAiProductConfig;
  /** Which models the picker may show; see {@link WorkBuddyAiModelScope}. */
  scope?: WorkBuddyAiModelScope;
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
declare function composeCatalog(upstream: readonly WorkBuddyAiModelInfo[], options: WorkBuddyAiCatalogOptions): readonly WorkBuddyAiModelInfo[];
/**
 * The plugin's live catalog.
 *
 * `scope` is mutable because the settings card can flip between "free only" and
 * "all models" without a restart; the adapter rebuilds its snapshot from
 * {@link current} on every read, so a change lands on the next request.
 */
declare class WorkBuddyAiCatalog {
  private upstream;
  private scope;
  private readonly productConfig;
  constructor(options: WorkBuddyAiCatalogOptions);
  /** Replace the upstream rows; the effective list is recomposed immediately. */
  setUpstream(models: readonly WorkBuddyAiModelInfo[]): void;
  /** The upstream rows as last received, before any policy is applied. */
  upstreamModels(): readonly WorkBuddyAiModelInfo[];
  /** Switch the billing policy; takes effect on the next {@link current} read. */
  setScope(scope: WorkBuddyAiModelScope): void;
  /** The active billing policy. */
  currentScope(): WorkBuddyAiModelScope;
  /** The product configuration this catalog prices against. */
  product(): WorkBuddyAiProductConfig;
  /** The effective entries; the fallback list until the upstream answer lands. */
  current(): readonly WorkBuddyAiModelInfo[];
  /** Every model id the product configuration prices as free. */
  freeIds(): readonly string[];
  /**
   * Whether a model is free according to the product configuration.
   *
   * The adapter consults this rather than the row's own `billing.free` so the
   * verdict survives a catalog refresh that momentarily reports a stale rate.
   */
  isFree(id: string): boolean;
  /** Display suffix for one row: the rate, then any promotional badges. */
  displaySuffix(id: string): string | undefined;
}
//#endregion
//#region src/probe-store.d.ts
/** Basename of the probe record inside the Harness home. */
declare const WORKBUDDYAI_PROBE_FILENAME = ".workbuddyai-probe.json";
/**
 * Whether the model's effort parameter is actually validated.
 *
 * - `validating`: the upstream rejected an unknown sentinel value, so a
 *   per-level answer is meaningful.
 * - `non-validating`: the upstream accepted the sentinel, so it ignores or
 *   loosely coerces the parameter and no per-level answer can be trusted.
 * - `unknown`: baseline or sentinel failed for an unrelated reason (auth,
 *   rate limit, transport, ambiguous error body). Not a negative claim.
 */
type WorkBuddyAiProbeValidation = 'validating' | 'non-validating' | 'unknown';
/** One model's recorded observation. */
interface WorkBuddyAiProbeRecord {
  /** Fingerprint of the catalog row this observation was made against. */
  fingerprint: string;
  validation: WorkBuddyAiProbeValidation;
  /** Efforts verified as accepted; only ever non-empty for `validating`. */
  efforts: readonly WorkBuddyAiEffort[];
  /** When the probe ran, epoch milliseconds. */
  probedAtMs: number;
  /** Plugin version that produced the record. */
  pluginVersion: string;
}
/** Plugin-owned probe record path inside the Harness home. */
declare function workbuddyAiProbePath(): string;
/**
 * Fingerprint the catalog fields a probe depends on.
 *
 * Deliberately excludes display-only fields (`name`, `billing`, `contextWindow`)
 * so a rename or a promo badge does not throw away a valid observation, and
 * deliberately includes the whole reasoning object so any change to the
 * declared shape re-probes.
 */
declare function fingerprintModel(info: WorkBuddyAiModelInfo): string;
/** Options for {@link WorkBuddyAiProbeStore}. */
interface WorkBuddyAiProbeStoreOptions {
  /** Explicit state-file path, overriding the `$DSH_HOME` default. */
  path?: string;
  /** Observation lifetime; defaults to 14 days. */
  ttlMs?: number;
  /** Plugin version stamped into new records. */
  pluginVersion: string;
  /** Clock injection for tests. */
  now?: () => number;
}
/**
 * The plugin's probe records: read once, written atomically, never trusted
 * across a fingerprint change or past the TTL.
 */
declare class WorkBuddyAiProbeStore {
  private readonly path;
  private readonly ttlMs;
  private readonly pluginVersion;
  private readonly now;
  private records;
  constructor(options: WorkBuddyAiProbeStoreOptions | string);
  /** Resolved state-file path, for the CLI and tests. */
  filePath(): string;
  private load;
  /**
   * The usable record for a model, or `undefined` when there is none, it is
   * expired, or it was taken against a different catalog row.
   */
  get(modelId: string, fingerprint: string): WorkBuddyAiProbeRecord | undefined;
  /**
   * Store one observation. Only a decisive answer (`validating` /
   * `non-validating`) replaces an existing decisive record: a transient
   * `unknown` must not erase knowledge the user already paid for.
   */
  set(modelId: string, record: WorkBuddyAiProbeRecord): void;
  /** Drop every record; used by the card's explicit "clear" action. */
  clear(): void;
  /** Every record currently held, for status display. */
  all(): Readonly<Record<string, WorkBuddyAiProbeRecord>>;
  /** Build a record stamped with this store's clock and version. */
  record(fingerprint: string, validation: WorkBuddyAiProbeValidation, efforts: readonly WorkBuddyAiEffort[]): WorkBuddyAiProbeRecord;
  /**
   * Write through a temporary file and rename, so a crash mid-write cannot
   * leave a half-parsed document that reads as "no records" and silently drops
   * every observation.
   */
  private persist;
}
//#endregion
//#region src/shim.d.ts
/** Minimal logger surface the plugin context already provides. */
interface ShimLogger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
/** What the plugin needs from a running shim. */
interface WorkBuddyAiShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>;
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string;
  /**
   * The per-process shared secret the plugin's own client must carry as
   * `Authorization: Bearer <token>`. Lives only in memory; the adapter resolves
   * this instead of the upstream access token, because the shim resolves the
   * real credential itself via the store.
   */
  token(): string;
  /** Stop serving and destroy open connections. */
  close(): Promise<void>;
}
/** Constructor dependencies. */
interface WorkBuddyAiShimOptions {
  store: WorkBuddyAiCredentialStore;
  client: Pick<WorkBuddyAiUpstreamClient, 'chatStream'>;
  catalog: WorkBuddyAiCatalog;
  logger?: ShimLogger;
}
/**
 * Start the loopback endpoint. Requests carry the shim's own bearer; the
 * upstream credential comes from the store alone and never reaches the caller.
 */
declare function createWorkBuddyAiShim(options: WorkBuddyAiShimOptions): WorkBuddyAiShim;
//#endregion
//#region src/adapter.d.ts
/**
 * Provider route this bundle owns.
 *
 * Distinct from the domestic plugin's `workbuddy` on purpose: both routes may be
 * mounted in one profile, and the LLM registry rejects a second adapter claiming
 * a route another already serves.
 */
declare const WORKBUDDYAI_PROVIDER = "workbuddyai";
/** Display name shown by the model picker and configuration surfaces. */
declare const WORKBUDDYAI_DISPLAY_NAME = "WorkBuddy AI";
/** Constructor dependencies. */
interface WorkBuddyAiAdapterOptions {
  shim: WorkBuddyAiShim;
  store: WorkBuddyAiCredentialStore;
  catalog: WorkBuddyAiCatalog;
  /** Resolve the durable attachment service at request time, when present. */
  resolveAttachments?: () => AttachmentStore | undefined;
  /**
   * Look up a local probe observation for a model. Consulted only for rows the
   * upstream left undeclared; absent means declared-set-only behavior.
   */
  observe?: (modelId: string) => WorkBuddyAiProbeRecord | undefined;
}
/** What {@link createWorkBuddyAiAdapter} hands back. */
interface WorkBuddyAiAdapter {
  adapter: PiAiAdapter;
  /** Rebuild the adapter's provider snapshot; call after a catalog update. */
  invalidate: () => void;
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
declare function reasoningFields(info: WorkBuddyAiModelInfo, observed?: WorkBuddyAiProbeRecord): {
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
};
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
declare function createWorkBuddyAiAdapter(options: WorkBuddyAiAdapterOptions): WorkBuddyAiAdapter;
//#endregion
//#region src/probe-service.d.ts
/** What the caller learns about a completed probe. */
type WorkBuddyAiProbeStatus = {
  state: 'ok';
  validation: WorkBuddyAiProbeRecord['validation'];
  efforts: readonly string[];
  requests: number;
} | {
  state: 'unavailable';
  reason: string;
};
/** Options for {@link WorkBuddyAiProbeService}. */
interface WorkBuddyAiProbeServiceOptions {
  store: WorkBuddyAiProbeStore;
  catalog: WorkBuddyAiCatalog;
  credentials: WorkBuddyAiCredentialStore;
  client: WorkBuddyAiUpstreamClient;
  /** Whether probing is permitted at all; consulted before every sweep. */
  consent: () => boolean;
  sentinel?: SentinelFactory;
  /** Injectable for tests; defaults to the live upstream sender. */
  send?: (modelId: string) => ProbeSender;
}
/**
 * Serial probe runner. One instance is shared by the manual API and any
 * future automatic trigger, so the two can never overlap.
 */
declare class WorkBuddyAiProbeService {
  private readonly options;
  private queue;
  private readonly pending;
  private running;
  constructor(options: WorkBuddyAiProbeServiceOptions);
  /** Whether a sweep is in flight right now. */
  isRunning(): boolean;
  /**
   * The record the adapter may use for this model, or `undefined`.
   *
   * A declared set always wins, so a model that declares `supportedEfforts` is
   * never answered from an observation.
   */
  recordFor(modelId: string): WorkBuddyAiProbeRecord | undefined;
  /**
   * Probe one model, serially.
   *
   * The authenticated manual route supplies one-request consent after UI
   * confirmation. Other callers must pass the configured consent gate.
   * Manual consent never changes the automatic-probing configuration.
   * Explicit requests bypass historical results, but share an ongoing run.
   */
  probe(modelId: string, manualConsent?: boolean): Promise<WorkBuddyAiProbeStatus>;
}
//#endregion
//#region src/oauth.d.ts
/** Give up if the browser never finishes. */
declare const LOGIN_TIMEOUT_MS: number;
/** Upstream client surface this helper needs. */
type WorkBuddyAiOAuthClient = Pick<WorkBuddyAiUpstreamClient, 'startPluginLogin' | 'pollPluginToken'>;
/** One poll tick: still waiting, or a credential ready to import. */
type WorkBuddyAiOAuthPoll = {
  pending: true;
} | {
  auth: WorkBuddyAiCredential;
};
/**
 * In-process CLI login. One instance per plugin; overlapping `start()` calls
 * replace the previous wait.
 */
declare class WorkBuddyAiOAuthLogin {
  private readonly client;
  private readonly open;
  private waiting;
  constructor(client: WorkBuddyAiOAuthClient, open?: (url: string) => boolean);
  /** Begin a login and try to open the browser. */
  start(): Promise<{
    authUrl: string;
    opened: boolean;
  }>;
  /**
   * One poll of the login `state`. `pending` means the user has not finished;
   * otherwise the caller must persist {@link WorkBuddyAiOAuthPoll.auth}.
   */
  poll(): Promise<WorkBuddyAiOAuthPoll>;
  /** Drop an in-flight login without touching stored credentials. */
  cancel(): void;
}
//#endregion
//#region src/host-heartbeat.d.ts
/**
 * Host-side heartbeat: a small JSON file written under `$DSH_HOME` once the
 * `workbuddyai` provider is registered. The status CLI reads it to report
 * whether the host bundle is alive, independent of the browser card.
 *
 * The browser (client) bundle cannot write files; its health is reported only
 * through `console.error` on failure. This asymmetry is intentional: the host is
 * the load-bearing half, and a missing heartbeat unambiguously means the host
 * never started.
 *
 * @module dsh-workbuddyai-connect/host-heartbeat
 */
/** Basename of the host heartbeat file inside the Harness home. */
declare const WORKBUDDYAI_HOST_HEARTBEAT_FILENAME = ".workbuddyai-host-heartbeat.json";
/** Package name stamped into the heartbeat, so readers can tell the two plugins apart. */
declare const HEARTBEAT_PACKAGE = "dsh-workbuddyai-connect";
/** Current on-disk heartbeat format; readers reject others. */
declare const HEARTBEAT_FORMAT_VERSION = 1;
/** On-disk shape of the heartbeat. */
interface WorkBuddyAiHostHeartbeat {
  version: typeof HEARTBEAT_FORMAT_VERSION;
  package: typeof HEARTBEAT_PACKAGE;
  pluginVersion: string;
  /** Epoch milliseconds when the host registered the provider. */
  registeredAt: number;
  /** Host process PID, to distinguish a stale heartbeat after a crash. */
  pid: number;
}
/** Absolute path of the host heartbeat file. */
declare function workbuddyAiHostHeartbeatPath(): string;
/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
declare function clearHostHeartbeat(): Promise<void>;
/** Read and validate the heartbeat; returns `undefined` when absent or malformed. */
declare function readHostHeartbeat(): Promise<WorkBuddyAiHostHeartbeat | undefined>;
/**
 * Absolute start time (epoch ms) of the process holding `pid`, or `undefined`
 * when it cannot be determined (no such PID, platform lacks a readable source).
 *
 * - macOS / Linux: `ps -o lstart=` prints a local-time "EEE MMM DD HH:MM:SS YYYY";
 *   `Date.parse` resolves it against the local clock, which matches how
 *   `registeredAt` (a `Date.now()` absolute value) is expressed.
 * - Windows: WMI `CreationDate` is UTC (`YYYYMMDDHHMMSS.mmm+zzzz`); parsed with
 *   `Date.UTC`, again comparable to `registeredAt`.
 *
 * Failures return `undefined` so callers can fall back to plain PID liveness
 * rather than mis-report a running host as dead.
 */
declare function processStartTimeMs(pid: number): number | undefined;
/**
 * Whether the heartbeat's PID is still alive *and* still the same process that
 * registered it. A stale heartbeat (host crashed without clearing the file) is
 * distinguished from a live host by two checks:
 *
 * 1. `process.kill(pid, 0)` — the PID exists (signal 0 tests existence).
 * 2. The process holding that PID started at or before `registeredAt`. A host
 *    that registered the heartbeat must have been started before writing it, so
 *    `start <= registeredAt`; a recycled PID belongs to an unrelated process
 *    started after the host died, so `start > registeredAt` correctly reads dead.
 *
 * PID-only detection is not enough: after a crash the OS may hand the same PID to
 * an unrelated process, and the un-cleared stale heartbeat would otherwise
 * produce a false "Host running". When the process start time cannot be read
 * (e.g. unsupported platform) the check degrades to plain PID liveness.
 */
declare function isHeartbeatProcessAlive(heartbeat: WorkBuddyAiHostHeartbeat): boolean;
//#endregion
//#region src/status-paths.d.ts
/**
 * Node-free constants and types shared by the Host and browser halves.
 *
 * @module dsh-workbuddyai-connect/status-paths
 */
/** Plugin-owned status endpoint consumed by its browser half. */
declare const WORKBUDDYAI_STATUS_PATH = "/plugins/dsh-workbuddyai-connect/status";
/**
 * Plugin-owned control endpoint.
 *
 * Separate from the status route because it accepts writes: the status route's
 * loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
 * not the same as authorizing a state-changing action. This route therefore also
 * requires the in-process key the browser half receives with the status document.
 */
declare const WORKBUDDYAI_CONTROL_PATH = "/plugins/dsh-workbuddyai-connect/control";
/** One model's recorded probe observation, as the card displays it. */
interface WorkBuddyAiWebProbeModel {
  id: string;
  name: string;
  /** `validating` results carry efforts; the other states never do. */
  validation: 'validating' | 'non-validating' | 'unknown';
  efforts: readonly string[];
  probedAt: number;
}
/** Probe section of the status document. */
interface WorkBuddyAiWebProbeSection {
  /** Whether the user has authorized probing. */
  consent: boolean;
  /** Whether a sweep is in flight right now. */
  running: boolean;
  /** Models the user could probe by hand (undeclared yet reasoning-capable). */
  candidates: readonly string[];
  /** Recorded observations. */
  results: readonly WorkBuddyAiWebProbeModel[];
}
/** One billing package and its remaining credit. */
interface WorkBuddyAiWebCreditAccount {
  packageName: string;
  remain: number;
  size: number;
}
/** Aggregated credit answer rendered by the plugin card. */
interface WorkBuddyAiWebCredits {
  total: number;
  accounts: readonly WorkBuddyAiWebCreditAccount[];
}
/** Billing convenience facts for one model, rendered as card badges. */
interface WorkBuddyAiWebModelBadge {
  id: string;
  name: string;
  /** Whether the model is currently free (`x0.00` credits). */
  free?: boolean;
  /** Promotional badges, e.g. `限时免费`, `夜间折扣`. */
  badges?: readonly string[];
  /** Credits multiplier in display form, e.g. `x0.79`. */
  credits?: string;
  /** Context capacity in tokens, taken verbatim from the upstream catalog. */
  contextWindow?: number;
  /**
   * Whether the free-only policy currently admits this model into the picker.
   * A card needs this to explain why a listed model is not selectable.
   */
  selectable?: boolean;
}
/**
 * Which models the picker is allowed to show.
 *
 * `free` is the default: only models the product configuration prices `x0.00`.
 * `all` lifts the filter and exposes every model the account can reach, which
 * means paid models become selectable and their credit cost is real.
 */
type WorkBuddyAiModelScope$1 = 'free' | 'all';
/** The JSON document the plugin card renders. */
type WorkBuddyAiWebStatus = {
  status: 'signed-out';
  controlKey?: string;
} | {
  status: 'signed-in';
  nickname?: string;
  domain?: string;
  source?: 'desktop' | 'dsh';
  expiresAt?: number;
  credits?: WorkBuddyAiWebCredits;
  creditsError?: string;
  /** Billing convenience facts for the models the plugin serves. */
  models?: readonly WorkBuddyAiWebModelBadge[];
  /** Reasoning-effort probe state, consent, and recorded observations. */
  probe?: WorkBuddyAiWebProbeSection;
  /** The active billing policy. */
  scope?: WorkBuddyAiModelScope$1;
  /** Model ids the product configuration prices free. */
  freeIds?: readonly string[];
  /** Where the price data came from, for the card's provenance line. */
  priceSource?: 'cache' | 'builtin';
  /** Path of the product configuration when one was read. */
  priceSourcePath?: string;
  /** Endpoint the product configuration points at, e.g. `https://www.workbuddy.ai`. */
  endpoint?: string;
  /**
   * In-process key authorizing control writes. Handed to the card with the
   * status document (the card is same-origin and already had to pass the
   * loopback guard); it is never persisted and rotates per process.
   */
  controlKey?: string;
} | {
  status: 'error';
  message: string;
};
/** Action requested from the control route. */
type WorkBuddyAiControlAction = {
  action: 'probe';
  model: string;
} | {
  action: 'clearProbe';
} | {
  action: 'setScope';
  scope: WorkBuddyAiModelScope$1;
} | {
  action: 'loginStart';
} | {
  action: 'loginPoll';
} | {
  action: 'logout';
};
//#endregion
//#region src/index.d.ts
/** Stable Cordis plugin name. */
declare const name = "llm-workbuddyai";
/** The model registry required before the provider can register. */
declare const inject: string[];
/**
 * Settings namespace owning the configuration card.
 *
 * A namespace is a nominal string, validated by the type system where it is used
 * rather than at runtime. The cast is applied once here so the public constant
 * carries the seam's type without pulling the brand helper into this package.
 */
declare const WORKBUDDYAI_SETTINGS_NS: SettingsNamespace;
/** Plugin configuration. */
interface Config {
  /** Explicit WorkBuddy AI desktop auth-file path, overriding env and platform defaults. */
  authFile?: string;
  /**
   * Whether the user has authorized sending probe requests about reasoning
   * efforts. Off by default: a probe spends real credit, so nothing is sent until
   * the user explicitly agrees.
   */
  probeConsent?: boolean;
  /**
   * Which models the picker may show. `free` (the default) lists only models the
   * product configuration prices `x0.00`; `all` lifts the filter and makes paid
   * models selectable, so their credit cost becomes real.
   */
  modelScope?: WorkBuddyAiModelScope;
  /**
   * Explicit product-configuration path, overriding the app's own cache
   * location. Only needed when the app keeps its state somewhere unusual.
   */
  productConfigFile?: string;
}
declare const Config: z<Config>;
/**
 * Start the loopback endpoint, register the `workbuddyai` provider, and refresh
 * the model catalog from the upstream once credentials allow it. The static
 * fallback catalog serves from the first moment, so an offline upstream never
 * leaves the provider empty.
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { BUILTIN_CREDITS, BUILTIN_FREE_MODELS, Config, FALLBACK_EXTRA_MODELS, FALLBACK_FREE_MODEL_IDS, FALLBACK_WORKBUDDYAI_MODELS, LOGIN_TIMEOUT_MS, PROBE_EFFORT_CANDIDATES, type ProbeAttempt, type ProbeOutcome, type ProbeSender, type UpstreamErrorKind, WORKBUDDYAI_AUTH_FILENAME, WORKBUDDYAI_AUTH_FILE_ENV, WORKBUDDYAI_CONTROL_PATH, WORKBUDDYAI_DESKTOP_AUTH_BASENAME, WORKBUDDYAI_DISPLAY_NAME, WORKBUDDYAI_HOST_HEARTBEAT_FILENAME, WORKBUDDYAI_PROBE_FILENAME, WORKBUDDYAI_PROVIDER, WORKBUDDYAI_SETTINGS_NS, WORKBUDDYAI_STATUS_PATH, type WorkBuddyAiAdapter, type WorkBuddyAiAuthStatus, WorkBuddyAiCatalog, type WorkBuddyAiChatResult, type WorkBuddyAiControlAction, type WorkBuddyAiCredential, WorkBuddyAiCredentialStore, type WorkBuddyAiCredits, type WorkBuddyAiEffort, type WorkBuddyAiHostHeartbeat, type WorkBuddyAiModelBilling, type WorkBuddyAiModelInfo, type WorkBuddyAiModelReasoning, type WorkBuddyAiModelScope, WorkBuddyAiOAuthLogin, type WorkBuddyAiProbeRecord, WorkBuddyAiProbeService, type WorkBuddyAiProbeStatus, WorkBuddyAiProbeStore, type WorkBuddyAiProbeValidation, type WorkBuddyAiProductConfig, type WorkBuddyAiProductModel, type WorkBuddyAiRefreshOutcome, type WorkBuddyAiRegion, type WorkBuddyAiShim, WorkBuddyAiUpstreamClient, type WorkBuddyAiUpstreamModel, type WorkBuddyAiWebModelBadge, type WorkBuddyAiWebProbeModel, type WorkBuddyAiWebProbeSection, type WorkBuddyAiWebStatus, apply, classifyUpstreamError, clearHostHeartbeat, composeCatalog, createWorkBuddyAiAdapter, createWorkBuddyAiShim, credentialFromPluginToken, defaultDesktopAuthCandidates, defaultDesktopAuthPath, fingerprintModel, freeModelIds, inject, isFreeCredits, isHeartbeatProcessAlive, loadProductConfig, name, normalizeCredits, parseProductConfig, parseWorkBuddyAiAuth, prepareChatBody, probeModel, processStartTimeMs, randomSentinel, readHostHeartbeat, reasoningFields, regionOf, workbuddyAiHostHeartbeatPath, workbuddyAiOwnAuthPath, workbuddyAiProbePath, workbuddyAiProductConfigPath };