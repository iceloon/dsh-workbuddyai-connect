import { A as randomSentinel, C as classifyUpstreamError, D as regionOf, E as prepareChatBody, F as credentialFromPluginToken, I as defaultDesktopAuthCandidates, L as defaultDesktopAuthPath, M as WORKBUDDYAI_AUTH_FILE_ENV, N as WORKBUDDYAI_DESKTOP_AUTH_BASENAME, O as PROBE_EFFORT_CANDIDATES, P as WorkBuddyAiCredentialStore, R as parseWorkBuddyAiAuth, S as WorkBuddyAiUpstreamClient, T as normalizeCredits, _ as FALLBACK_FREE_MODEL_IDS, a as readHostHeartbeat, b as parseProductConfig, c as WORKBUDDYAI_CONNECT_VERSION, d as FALLBACK_WORKBUDDYAI_MODELS, f as WorkBuddyAiCatalog, g as FALLBACK_EXTRA_MODELS, h as BUILTIN_FREE_MODELS, i as processStartTimeMs, j as WORKBUDDYAI_AUTH_FILENAME, k as probeModel, l as LOGIN_TIMEOUT_MS, m as BUILTIN_CREDITS, n as clearHostHeartbeat, o as workbuddyAiHostHeartbeatPath, p as composeCatalog, r as isHeartbeatProcessAlive, s as writeHostHeartbeat, t as WORKBUDDYAI_HOST_HEARTBEAT_FILENAME, u as WorkBuddyAiOAuthLogin, v as freeModelIds, w as isFreeCredits, x as workbuddyAiProductConfigPath, y as loadProductConfig, z as workbuddyAiOwnAuthPath } from "./host-heartbeat-gsHma-QV.js";
import z from "@deepseek-ai/schemastery";
import { dirname, join, resolve } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createServer } from "node:http";
import { Readable } from "node:stream";
//#region src/adapter.ts
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
/**
* Provider route this bundle owns.
*
* Distinct from the domestic plugin's `workbuddy` on purpose: both routes may be
* mounted in one profile, and the LLM registry rejects a second adapter claiming
* a route another already serves.
*/
const WORKBUDDYAI_PROVIDER = "workbuddyai";
/** Display name shown by the model picker and configuration surfaces. */
const WORKBUDDYAI_DISPLAY_NAME = "WorkBuddy AI";
/** Provider idle ceiling while one stream read is outstanding. */
const WORKBUDDYAI_STREAM_IDLE_TIMEOUT_MS = 3e5;
/**
* Maximum base64-encoded image payload per request, at the dsh-llm-pi-ai
* default. It bounds requests to models whose catalog entry declares
* `supportsImages`; text-only models never receive images.
*/
const MAX_REQUEST_IMAGE_BYTES = 20971520;
/**
* Inert pi-ai ambient auth.
*
* The route authenticates only through the shim shared secret resolved per
* request by `resolveApiKey`, so pi-ai's own credential lifecycle and ambient
* discovery must never manufacture a credential for it. This provider declares
* no auth at all, which is what makes `resolveApiKey` authoritative.
*/
/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/**
* Separator between a model's name and its billing rate.
*
* A middle dot rather than a hyphen or colon: model names already contain
* hyphens (`Deepseek-V4.1-Flash`), so a hyphen separator would be ambiguous
* about where the name ends and the rate begins.
*/
const RATE_SEPARATOR = " · ";
/** The catalog display suffix: the billing rate, then any promo badges. */
function displaySuffix(info) {
	const parts = [normalizeCredits(info.billing?.credits), ...info.billing?.badges ?? []].filter((part) => part !== void 0 && part !== "");
	return parts.length === 0 ? void 0 : parts.join(" · ");
}
/**
* Append the catalog display suffix to one model's display name.
*
* Display-only, and it cannot affect routing: the wire request is built from
* `model.id`, the selection a picker submits is `{provider, model: id,
* reasoningEffort}`, and `dsh-llm` validates `name` as a non-empty string
* without comparing its contents. Nothing in the host resolves a model *by* name.
*/
function withCatalogDisplay(name, info) {
	const suffix = displaySuffix(info);
	return suffix === void 0 ? name : `${name}${RATE_SEPARATOR}${suffix}`;
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
function reasoningFields(info, observed) {
	const reasoning = info.reasoning;
	if (reasoning === void 0 || reasoning.supports !== true) return { reasoning: false };
	const declared = reasoning.supportedEfforts;
	const efforts = declared !== void 0 && declared.length > 0 ? declared : observed?.validation === "validating" && observed.efforts.length > 0 ? observed.efforts : void 0;
	if (efforts === void 0) return { reasoning: false };
	return {
		reasoning: true,
		thinkingLevelMap: {
			off: reasoning.canDisableThinking === true && declared !== void 0 && declared.length > 0 ? "off" : null,
			minimal: null,
			low: efforts.includes("low") ? "low" : null,
			medium: efforts.includes("medium") ? "medium" : null,
			high: efforts.includes("high") ? "high" : null,
			xhigh: efforts.includes("xhigh") ? "xhigh" : null,
			max: efforts.includes("max") ? "max" : null
		}
	};
}
/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info, baseUrl, observed) {
	return {
		id: info.id,
		name: info.name,
		api: "openai-completions",
		provider: WORKBUDDYAI_PROVIDER,
		baseUrl,
		input: info.supportsImages === true ? ["text", "image"] : ["text"],
		...reasoningFields(info, observed),
		cost: NO_COST,
		contextWindow: info.contextWindow,
		maxTokens: info.maxTokens
	};
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
function createWorkBuddyAiAdapter(options) {
	const { shim, catalog, resolveAttachments, observe } = options;
	const buildModels = () => {
		const baseUrl = `${shim.baseUrl()}/v1`;
		return catalog.current().map((info) => toPiModel(info, baseUrl, observe?.(info.id)));
	};
	const provider = {
		...createProvider({
			id: WORKBUDDYAI_PROVIDER,
			name: WORKBUDDYAI_DISPLAY_NAME,
			auth: { apiKey: {
				name: "WorkBuddy AI OAuth bearer token",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "WorkBuddy AI"
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: WORKBUDDYAI_PROVIDER,
		displayName: WORKBUDDYAI_DISPLAY_NAME,
		streamIdleTimeoutMs: WORKBUDDYAI_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-workbuddyai-connect retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		maxRequestImageBytes: MAX_REQUEST_IMAGE_BYTES,
		piProvider: provider,
		modelErrors: /* @__PURE__ */ new Map(),
		requestImagePixelBudget: 4194304,
		requestImageMaxBytes: 1048576
	};
	let profiles = /* @__PURE__ */ new Map([[WORKBUDDYAI_PROVIDER, profile]]);
	return {
		adapter: new WorkBuddyAiPiAiAdapter(catalog, {
			profiles: () => profiles,
			resolveApiKey: async () => shim.token(),
			...resolveAttachments === void 0 ? {} : { resolveAttachments },
			auth: {
				credentials: {
					async read() {},
					async list() {
						return [];
					},
					async modify() {
						throw new Error("dsh-workbuddyai-connect: the workbuddyai route has no pi-ai credential lifecycle");
					},
					async delete() {}
				},
				authContext: {
					async env() {},
					async fileExists() {
						return false;
					}
				}
			}
		}),
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[WORKBUDDYAI_PROVIDER, profile]]);
		}
	};
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
var WorkBuddyAiPiAiAdapter = class extends PiAiAdapter {
	catalog;
	constructor(catalog, options) {
		super(options);
		this.catalog = catalog;
	}
	/** Catalog entry for one model id, or undefined when the catalog omits it. */
	infoFor(model) {
		return this.catalog.current().find((entry) => entry.id === model);
	}
	async listModels(provider) {
		return (await super.listModels(provider)).map((model) => {
			const info = this.infoFor(model.id);
			if (info === void 0) return model;
			return {
				...model,
				name: withCatalogDisplay(model.name, info)
			};
		});
	}
	async resolveModel(provider, model, signal) {
		const resolved = await super.resolveModel(provider, model, signal);
		const info = this.infoFor(model);
		if (info === void 0) return resolved;
		return {
			...resolved,
			name: withCatalogDisplay(resolved.name, info)
		};
	}
};
//#endregion
//#region src/loopback.ts
/**
* Shared loopback gates for the plugin's local HTTP surfaces: the loopback shim
* and the same-origin web-status route. Both are only ever meant to be addressed
* through the machine's loopback interface.
*
* @module dsh-workbuddyai-connect/loopback
*/
/** Loopback hostnames a local plugin surface may be addressed by. */
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
function hostnameOfHost(host) {
	let hostname = host.trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && !hostname.slice(0, colon).includes(":") && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/**
* The request's Host header must name the loopback interface. A DNS-rebinding
* page (attacker domain re-resolved to 127.0.0.1) sends its own domain in Host,
* so this check drops those before any routing happens.
*/
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
/**
* A browser-sent Origin (present header) must be loopback. Non-browser clients
* (the plugin's own fetch calls) send no Origin at all and pass.
*/
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
//#endregion
//#region src/shim.ts
/**
* Loopback OpenAI-compatible endpoint.
*
* The pi-ai provider points here; the shim applies the WorkBuddy wire quirks
* (forced streaming, string `tool_choice`, CLI-shaped headers, a leading system
* message) and forwards to the real upstream. It binds 127.0.0.1 only and never
* serves another interface.
*
* Inbound hardening: the loopback bind alone is not a trust boundary (any local
* process or a DNS-rebinding page can reach 127.0.0.1), so every request must
* carry a loopback Host header, browser-sent Origins must be loopback, chat
* POSTs must be application/json, and the Authorization header must carry the
* shim's per-process shared secret. The plugin's own client satisfies all four
* by construction; local attackers cannot read the secret out of the plugin
* process's memory.
*
* @module dsh-workbuddyai-connect/shim
*/
const REQUEST_BODY_LIMIT = 67108864;
/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS = {
	hard_credit: 402,
	soft_rate: 429,
	session_dead: 401,
	not_found: 502,
	server: 502,
	client: 400
};
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
function writeOpenAIError(res, status, kind, message) {
	writeJson(res, status, { error: {
		message,
		type: kind,
		code: kind
	} });
}
/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody$1(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > REQUEST_BODY_LIMIT) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
/**
* Start the loopback endpoint. Requests carry the shim's own bearer; the
* upstream credential comes from the store alone and never reaches the caller.
*/
function createWorkBuddyAiShim(options) {
	const { store, client, catalog } = options;
	const logger = options.logger;
	const SHARED_SECRET = randomBytes(32).toString("base64url");
	/** Constant-time bearer check; absent or mismatched bearers are rejected. */
	function bearerOk(req) {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (match === null) return false;
		const presented = match[1];
		const a = Buffer.from(presented);
		const b = Buffer.from(SHARED_SECRET);
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}
	const server = createServer((req, res) => {
		handle(req, res);
	});
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(0, "127.0.0.1");
	const baseUrl = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("workbuddyai shim has no listening address");
		return `http://127.0.0.1:${address.port}`;
	};
	async function handle(req, res) {
		try {
			if (!hostIsLoopback(req.headers.host)) {
				writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
				return;
			}
			if (!originIsLoopback(req.headers.origin)) {
				writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
				return;
			}
			if (!bearerOk(req)) {
				writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
				return;
			}
			const url = req.url ?? "/";
			if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
				writeJson(res, 200, { ok: true });
				return;
			}
			if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
				writeJson(res, 200, {
					object: "list",
					data: catalog.current().map((model) => ({
						id: model.id,
						object: "model",
						created: 0,
						owned_by: "workbuddyai"
					}))
				});
				return;
			}
			if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
				await chatCompletions(req, res);
				return;
			}
			writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
		} catch (error) {
			if (!res.headersSent) writeOpenAIError(res, 500, "internal", String(error));
			else res.end();
		}
	}
	async function chatCompletions(req, res) {
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}
		let credential;
		try {
			credential = await store.resolve();
		} catch (error) {
			writeOpenAIError(res, 401, "not_signed_in", String(error));
			return;
		}
		const raw = (await readBody$1(req)).toString("utf8");
		const prepared = prepareChatBody(raw);
		const controller = new AbortController();
		req.on("close", () => controller.abort());
		const result = await client.chatStream(credential, prepared, controller.signal);
		if (!result.ok) {
			writeOpenAIError(res, KIND_STATUS[result.kind], result.kind, `workbuddyai upstream ${result.kind} (http ${result.status}): ${result.message.slice(0, 400)}`);
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no"
		});
		let sawDone = false;
		const body = Readable.fromWeb(result.response.body);
		body.on("data", (chunk) => {
			if (chunk.includes("[DONE]")) sawDone = true;
		});
		body.on("error", (error) => {
			logger?.warn("dsh-workbuddyai-connect: upstream stream failed mid-flight", error);
			if (!sawDone && res.writable) res.end("data: [DONE]\n\n");
		});
		body.pipe(res);
	}
	return {
		ready,
		baseUrl,
		token: () => SHARED_SECRET,
		close: () => new Promise((resolve, reject) => {
			server.close(() => resolve());
			server.closeAllConnections();
			server.once("error", reject);
		})
	};
}
//#endregion
//#region src/probe-store.ts
/**
* Local record of reasoning-effort probes.
*
* What this stores is an *observation*, never a claim about the upstream: a
* model's row is only consulted when the catalog carries no explicit
* `supportedEfforts` set, and it always loses to a declared set. A result is
* invalidated whenever the model's catalog row changes, so every record carries
* a fingerprint of the fields the probe depended on.
*
* The file lives beside the plugin's own credential copy under `$DSH_HOME`,
* never in the desktop app's files, and carries no token, prompt, or response
* body — only model ids, effort spellings, and timestamps.
*
* @module dsh-workbuddyai-connect/probe-store
*/
/** Basename of the probe record inside the Harness home. */
const WORKBUDDYAI_PROBE_FILENAME = ".workbuddyai-probe.json";
/** On-disk format this reader accepts; other versions are discarded. */
const PROBE_FORMAT_VERSION = 1;
/**
* How long an observation stays usable. Conservative on purpose: upstream
* metadata moves fast, so a result that has outlived its fingerprint's
* usefulness should not quietly keep granting a picker entry.
*/
const DEFAULT_TTL_MS = 12096e5;
/** Plugin-owned probe record path inside the Harness home. */
function workbuddyAiProbePath() {
	return join(resolveDshHome(), WORKBUDDYAI_PROBE_FILENAME);
}
/**
* Fingerprint the catalog fields a probe depends on.
*
* Deliberately excludes display-only fields (`name`, `billing`, `contextWindow`)
* so a rename or a promo badge does not throw away a valid observation, and
* deliberately includes the whole reasoning object so any change to the
* declared shape re-probes.
*/
function fingerprintModel(info) {
	const basis = JSON.stringify({
		id: info.id,
		reasoning: info.reasoning ?? null,
		supportsImages: info.supportsImages ?? null
	});
	return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}
/** Read-and-validate the documents on disk; anything malformed reads as empty. */
function readDocument(path) {
	if (!existsSync(path)) return void 0;
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const wrapped = parsed;
	if (wrapped["version"] !== PROBE_FORMAT_VERSION) return void 0;
	const records = wrapped["records"];
	if (typeof records !== "object" || records === null || Array.isArray(records)) return void 0;
	return parsed;
}
/** One record's shape check; a bad row is dropped rather than trusted. */
function isRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const wrapped = value;
	const validation = wrapped["validation"];
	if (validation !== "validating" && validation !== "non-validating" && validation !== "unknown") return false;
	if (typeof wrapped["fingerprint"] !== "string") return false;
	if (typeof wrapped["probedAtMs"] !== "number" || !Number.isFinite(wrapped["probedAtMs"])) return false;
	if (typeof wrapped["pluginVersion"] !== "string") return false;
	const efforts = wrapped["efforts"];
	if (!Array.isArray(efforts) || efforts.some((effort) => typeof effort !== "string")) return false;
	return true;
}
/**
* The plugin's probe records: read once, written atomically, never trusted
* across a fingerprint change or past the TTL.
*/
var WorkBuddyAiProbeStore = class {
	path;
	ttlMs;
	pluginVersion;
	now;
	records;
	constructor(options) {
		const opts = typeof options === "string" ? {
			path: options,
			pluginVersion: "0.0.0"
		} : options;
		this.path = opts.path ?? workbuddyAiProbePath();
		this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
		this.pluginVersion = opts.pluginVersion;
		this.now = opts.now ?? (() => Date.now());
	}
	/** Resolved state-file path, for the CLI and tests. */
	filePath() {
		return this.path;
	}
	load() {
		if (this.records === void 0) {
			const document = readDocument(this.path);
			const records = {};
			for (const [id, record] of Object.entries(document?.records ?? {})) if (isRecord(record)) records[id] = record;
			this.records = records;
		}
		return this.records;
	}
	/**
	* The usable record for a model, or `undefined` when there is none, it is
	* expired, or it was taken against a different catalog row.
	*/
	get(modelId, fingerprint) {
		const record = this.load()[modelId];
		if (record === void 0) return void 0;
		if (record.fingerprint !== fingerprint) return void 0;
		if (this.now() - record.probedAtMs > this.ttlMs) return void 0;
		return record;
	}
	/**
	* Store one observation. Only a decisive answer (`validating` /
	* `non-validating`) replaces an existing decisive record: a transient
	* `unknown` must not erase knowledge the user already paid for.
	*/
	set(modelId, record) {
		const records = this.load();
		const existing = records[modelId];
		if (record.validation === "unknown" && existing !== void 0 && existing.fingerprint === record.fingerprint && existing.validation !== "unknown") return;
		records[modelId] = record;
		this.persist();
	}
	/** Drop every record; used by the card's explicit "clear" action. */
	clear() {
		this.records = {};
		this.persist();
	}
	/** Every record currently held, for status display. */
	all() {
		return { ...this.load() };
	}
	/** Build a record stamped with this store's clock and version. */
	record(fingerprint, validation, efforts) {
		return {
			fingerprint,
			validation,
			efforts: validation === "validating" ? [...efforts] : [],
			probedAtMs: this.now(),
			pluginVersion: this.pluginVersion
		};
	}
	/**
	* Write through a temporary file and rename, so a crash mid-write cannot
	* leave a half-parsed document that reads as "no records" and silently drops
	* every observation.
	*/
	persist() {
		const directory = dirname(this.path);
		try {
			if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
			const document = {
				version: PROBE_FORMAT_VERSION,
				records: this.load()
			};
			const temporary = resolve(`${this.path}.tmp`);
			writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 384 });
			renameSync(temporary, this.path);
		} catch {}
	}
};
/**
* Order observations newest-first for display.
*
* The store keeps insertion order so the file reads chronologically, but the
* card wants the most recent detection at the top: a sweep the user just ran
* should not appear below every earlier one, which is what appending to an
* insertion-ordered list does.
*/
function newestFirst(records) {
	return [...records].sort((a, b) => b.probedAt - a.probedAt);
}
//#endregion
//#region src/probe-service.ts
/**
* Serial probe runner. One instance is shared by the manual API and any
* future automatic trigger, so the two can never overlap.
*/
var WorkBuddyAiProbeService = class {
	options;
	queue = Promise.resolve();
	pending = /* @__PURE__ */ new Map();
	running = false;
	constructor(options) {
		this.options = options;
	}
	/** Whether a sweep is in flight right now. */
	isRunning() {
		return this.running;
	}
	/**
	* The record the adapter may use for this model, or `undefined`.
	*
	* A declared set always wins, so a model that declares `supportedEfforts` is
	* never answered from an observation.
	*/
	recordFor(modelId) {
		const info = this.options.catalog.current().find((model) => model.id === modelId);
		if (info === void 0) return void 0;
		if (info.reasoning?.supportedEfforts !== void 0 && info.reasoning.supportedEfforts.length > 0) return;
		return this.options.store.get(modelId, fingerprintModel(info));
	}
	/**
	* Probe one model, serially.
	*
	* The authenticated manual route supplies one-request consent after UI
	* confirmation. Other callers must pass the configured consent gate.
	* Manual consent never changes the automatic-probing configuration.
	* Explicit requests bypass historical results, but share an ongoing run.
	*/
	async probe(modelId, manualConsent = false) {
		if (!manualConsent && !this.options.consent()) return {
			state: "unavailable",
			reason: "probing is not authorized"
		};
		if (this.options.catalog.current().find((model) => model.id === modelId) === void 0) return {
			state: "unavailable",
			reason: `unknown model: ${modelId}`
		};
		const pending = this.pending.get(modelId);
		if (pending !== void 0) return pending;
		const run = this.queue.then(async () => {
			const current = this.options.catalog.current().find((model) => model.id === modelId);
			if (current === void 0) return {
				state: "unavailable",
				reason: `unknown model: ${modelId}`
			};
			if (!manualConsent && !this.options.consent()) return {
				state: "unavailable",
				reason: "probing is not authorized"
			};
			if (current.reasoning?.supports !== true || (current.reasoning.supportedEfforts?.length ?? 0) > 0) return {
				state: "unavailable",
				reason: "model does not need detection"
			};
			const cached = this.recordFor(modelId);
			if (!manualConsent && cached !== void 0 && cached.validation !== "unknown") return {
				state: "ok",
				validation: cached.validation,
				efforts: cached.efforts,
				requests: 0
			};
			const credential = await this.options.credentials.current();
			if (credential === void 0) return {
				state: "unavailable",
				reason: "no WorkBuddy AI credential"
			};
			const send = this.options.send === void 0 ? (effort, signal) => this.options.client.probeEffort(credential, modelId, effort, signal) : this.options.send(modelId);
			this.running = true;
			try {
				const outcome = await probeModel({
					send,
					...this.options.sentinel === void 0 ? {} : { sentinel: this.options.sentinel }
				});
				const record = this.options.store.record(fingerprintModel(current), outcome.validation, outcome.efforts);
				this.options.store.set(modelId, record);
				if (outcome.validation === "unknown") return {
					state: "unavailable",
					reason: outcome.reason
				};
				return {
					state: "ok",
					validation: outcome.validation,
					efforts: record.efforts,
					requests: outcome.requests
				};
			} finally {
				this.running = false;
			}
		});
		this.queue = run.catch(() => void 0);
		this.pending.set(modelId, run);
		try {
			return await run;
		} finally {
			this.pending.delete(modelId);
		}
	}
};
//#endregion
//#region src/status-paths.ts
/**
* Node-free constants and types shared by the Host and browser halves.
*
* @module dsh-workbuddyai-connect/status-paths
*/
/** Plugin-owned status endpoint consumed by its browser half. */
const WORKBUDDYAI_STATUS_PATH = "/plugins/dsh-workbuddyai-connect/status";
/**
* Plugin-owned control endpoint.
*
* Separate from the status route because it accepts writes: the status route's
* loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
* not the same as authorizing a state-changing action. This route therefore also
* requires the in-process key the browser half receives with the status document.
*/
const WORKBUDDYAI_CONTROL_PATH = "/plugins/dsh-workbuddyai-connect/control";
//#endregion
//#region src/web-status.ts
/** Redact token-like content before it crosses to the browser. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
function json$1(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/**
* The request must be addressed to the loopback interface, and a
* browser-attached Origin must be loopback too. The Host check drops
* DNS-rebinding pages (their Host is the attacker's domain, not loopback); the
* card's same-origin fetches carry no Origin and pass on Host alone.
*/
function loopbackRequest(req) {
	return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin);
}
/**
* Assemble the card's status document. Sign-in state is read-only; credit is a
* live billing answer whose failure degrades to `creditsError` rather than
* failing the whole document.
*/
async function workBuddyAiWebStatus(deps) {
	const authStatus = await deps.store.status();
	if (authStatus.state !== "signed-in") return {
		status: "signed-out",
		...deps.controlKey === void 0 ? {} : { controlKey: deps.controlKey }
	};
	const catalog = deps.catalog;
	const product = catalog.product();
	const freeIds = catalog.freeIds();
	const free = new Set(freeIds);
	const selectable = new Set(catalog.current().map((model) => model.id));
	const modelsField = product.models.map((row) => {
		const rate = normalizeCredits(row.credits);
		const isFree = free.has(row.id);
		return {
			id: row.id,
			name: row.name,
			...isFree ? { free: true } : {},
			...rate === void 0 ? {} : { credits: rate },
			...row.contextWindow > 0 ? { contextWindow: row.contextWindow } : {},
			selectable: selectable.has(row.id)
		};
	});
	const status = {
		status: "signed-in",
		...authStatus.nickname === void 0 ? {} : { nickname: authStatus.nickname },
		...authStatus.domain === void 0 || authStatus.domain === "" ? {} : { domain: authStatus.domain },
		...authStatus.source === void 0 ? {} : { source: authStatus.source },
		...authStatus.expiresAtMs === void 0 ? {} : { expiresAt: authStatus.expiresAtMs },
		...modelsField.length === 0 ? {} : { models: modelsField },
		scope: catalog.currentScope(),
		freeIds,
		priceSource: product.source,
		...product.path === void 0 ? {} : { priceSourcePath: product.path },
		...product.endpoint === void 0 ? {} : { endpoint: product.endpoint },
		...deps.probe === void 0 ? {} : { probe: deps.probe() },
		...deps.controlKey === void 0 ? {} : { controlKey: deps.controlKey }
	};
	try {
		const credential = await deps.store.current();
		if (credential !== void 0) {
			const credits = await deps.client.fetchCredits(credential);
			return {
				...status,
				credits
			};
		}
	} catch (error) {
		return {
			...status,
			creditsError: safeMessage(error)
		};
	}
	return status;
}
/** The status route's request handler, extracted so tests can mount it on a bare server. */
function workBuddyAiStatusHandler(deps) {
	return async (req, res) => {
		if (req.method !== "GET") {
			json$1(res, 405, { error: "method not allowed" });
			return;
		}
		if (!loopbackRequest(req)) {
			json$1(res, 403, { error: "request-not-trusted" });
			return;
		}
		try {
			json$1(res, 200, await workBuddyAiWebStatus(deps));
		} catch (error) {
			json$1(res, 500, { error: safeMessage(error) });
		}
	};
}
/** Mount the GET status route on an optional webServer context. */
function registerWorkBuddyAiStatusRoute(ctx, deps) {
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: WORKBUDDYAI_STATUS_PATH,
			handler: workBuddyAiStatusHandler(deps)
		});
		return () => {
			dispose();
		};
	}, "dsh-workbuddyai-connect: Web status route");
}
//#endregion
//#region src/control-route.ts
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
/** Largest control body accepted; these payloads are a few dozen bytes. */
const MAX_BODY_BYTES = 4096;
/** Mint the per-process control key. */
function createControlKey() {
	return randomBytes(24).toString("hex");
}
/** Constant-time key comparison; a length mismatch is a failure, not a crash. */
function keyMatches(expected, presented) {
	if (presented === void 0 || presented.length !== expected.length) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(presented);
	return a.length === b.length && timingSafeEqual(a, b);
}
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** Read the request body with a hard ceiling. */
async function readBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES) return void 0;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** Parse and shape-check an action; unknown fields are ignored, not trusted. */
function parseAction(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const wrapped = parsed;
	const action = wrapped["action"];
	if (action === "clearProbe") return { action: "clearProbe" };
	if (action === "setScope") {
		const scope = wrapped["scope"];
		if (scope !== "free" && scope !== "all") return void 0;
		return {
			action: "setScope",
			scope
		};
	}
	if (action === "probe") {
		const model = wrapped["model"];
		if (typeof model !== "string" || model.trim() === "") return void 0;
		return {
			action: "probe",
			model: model.trim()
		};
	}
	if (action === "loginStart") return { action: "loginStart" };
	if (action === "loginPoll") return { action: "loginPoll" };
	if (action === "logout") return { action: "logout" };
}
/**
* The control route's handler, extracted so tests can mount it on a bare server
* with a known key.
*/
function workBuddyAiControlHandler(deps, key) {
	return async (req, res) => {
		if (req.method !== "POST") {
			json(res, 405, { error: "method not allowed" });
			return;
		}
		if (!hostIsLoopback(req.headers.host) || !originIsLoopback(req.headers.origin)) {
			json(res, 403, { error: "request-not-trusted" });
			return;
		}
		if (!keyMatches(key, req.headers["x-workbuddyai-control-key"])) {
			json(res, 403, { error: "invalid-control-key" });
			return;
		}
		const body = await readBody(req);
		if (body === void 0) {
			json(res, 413, { error: "body too large" });
			return;
		}
		const action = parseAction(body);
		if (action === void 0) {
			json(res, 400, { error: "invalid action" });
			return;
		}
		try {
			switch (action.action) {
				case "clearProbe":
					deps.clearProbe();
					json(res, 200, { state: "cleared" });
					return;
				case "setScope":
					deps.setScope(action.scope);
					json(res, 200, {
						state: "ok",
						scope: action.scope
					});
					return;
				case "probe":
					json(res, 200, await deps.probe(action.model));
					return;
				case "loginStart":
					json(res, 200, {
						state: "ok",
						authUrl: (await deps.loginStart()).authUrl
					});
					return;
				case "loginPoll":
					if ("pending" in await deps.loginPoll()) {
						json(res, 200, {
							state: "ok",
							pending: true
						});
						return;
					}
					json(res, 200, { state: "ok" });
					return;
				case "logout":
					await deps.logout();
					json(res, 200, { state: "ok" });
					return;
			}
		} catch (error) {
			json(res, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	};
}
/** Mount the POST control route on an optional webServer context. */
function registerWorkBuddyAiControlRoute(ctx, deps, key) {
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: WORKBUDDYAI_CONTROL_PATH,
			handler: workBuddyAiControlHandler(deps, key)
		});
		return () => {
			dispose();
		};
	}, "dsh-workbuddyai-connect: control route");
}
//#endregion
//#region src/index.ts
/** Stable Cordis plugin name. */
const name = "llm-workbuddyai";
/** The model registry required before the provider can register. */
const inject = ["llm"];
/**
* Settings namespace owning the configuration card.
*
* A namespace is a nominal string, validated by the type system where it is used
* rather than at runtime. The cast is applied once here so the public constant
* carries the seam's type without pulling the brand helper into this package.
*/
const WORKBUDDYAI_SETTINGS_NS = "workbuddyai";
const Config = z.object({
	authFile: z.string().description("WorkBuddy AI desktop auth file (defaults to the app's own location)"),
	probeConsent: z.boolean().default(false).description("Authorize reasoning-effort probes (each probe sends real requests that may consume credit)"),
	modelScope: z.union([z.const("free"), z.const("all")]).default("free").description("Which models to offer: free only (default), or every model including paid ones"),
	productConfigFile: z.string().description("Product configuration supplying model prices (defaults to the app's own cache)")
});
/**
* Start the loopback endpoint, register the `workbuddyai` provider, and refresh
* the model catalog from the upstream once credentials allow it. The static
* fallback catalog serves from the first moment, so an offline upstream never
* leaves the provider empty.
*/
function apply(ctx, config) {
	const client = new WorkBuddyAiUpstreamClient();
	const store = new WorkBuddyAiCredentialStore({
		...config.authFile === void 0 ? {} : { desktopPath: config.authFile },
		refresh: (credential) => client.refreshToken(credential)
	});
	const oauth = new WorkBuddyAiOAuthLogin(client);
	const productConfig = loadProductConfig(config.productConfigFile !== void 0 && config.productConfigFile.trim() !== "" ? config.productConfigFile.trim() : void 0);
	const catalog = new WorkBuddyAiCatalog({
		productConfig,
		scope: config.modelScope ?? "free"
	});
	const shim = createWorkBuddyAiShim({
		store,
		client,
		catalog,
		logger: ctx.logger
	});
	let current = () => config;
	let persistScope;
	const probeStore = new WorkBuddyAiProbeStore({ pluginVersion: WORKBUDDYAI_CONNECT_VERSION });
	const probeService = new WorkBuddyAiProbeService({
		store: probeStore,
		catalog,
		credentials: store,
		client,
		consent: () => current().probeConsent === true
	});
	/**
	* Whether a model can be probed by hand: it reasons and the upstream declares
	* no effort set for it.
	*
	* Deliberately *not* filtered by whether a result already exists. Dropping a
	* model once it has been detected made the list shrink with use, so
	* re-detecting one model meant clearing every other result first. The list
	* stays stable and the card marks which entries already have an answer.
	*/
	const isProbeCandidate = (info) => {
		if (info.reasoning?.supports !== true) return false;
		return (info.reasoning.supportedEfforts?.length ?? 0) === 0;
	};
	/** Compact probe state for the card: consent, candidates, observations. */
	const probeSection = () => {
		const models = catalog.current();
		const results = models.flatMap((info) => {
			const record = probeService.recordFor(info.id);
			if (record === void 0) return [];
			return [{
				id: info.id,
				name: info.name,
				validation: record.validation,
				efforts: record.efforts,
				probedAt: record.probedAtMs
			}];
		});
		return {
			consent: current().probeConsent === true,
			running: probeService.isRunning(),
			candidates: models.filter(isProbeCandidate).map((info) => info.id),
			results: newestFirst(results)
		};
	};
	const controlKey = createControlKey();
	let refreshModels = () => {};
	ctx.inject(["webServer"], (webCtx) => {
		registerWorkBuddyAiStatusRoute(webCtx, {
			store,
			client,
			catalog,
			probe: () => probeSection(),
			controlKey
		});
		registerWorkBuddyAiControlRoute(webCtx, {
			probe: async (modelId) => {
				const result = await probeService.probe(modelId, true);
				if (result.state === "ok") refreshModels();
				return result;
			},
			clearProbe: () => {
				probeStore.clear();
				refreshModels();
			},
			setScope: (scope) => {
				catalog.setScope(scope);
				persistScope?.(scope);
				refreshModels();
			},
			loginStart: () => oauth.start(),
			loginPoll: async () => {
				const result = await oauth.poll();
				if ("pending" in result) return { pending: true };
				await store.importCredential(result.auth);
				try {
					catalog.setUpstream(await client.fetchModels(result.auth));
				} catch {}
				refreshModels();
				return { done: true };
			},
			logout: async () => {
				oauth.cancel();
				await store.logout();
				refreshModels();
			}
		}, controlKey);
	});
	ctx.inject(["settings"], (settingsCtx) => {
		const scope = settingsCtx.settings.register(WORKBUDDYAI_SETTINGS_NS, Config, { base: config });
		current = () => scope.get();
		const apply = () => {
			const next = current();
			store.setDesktopPath(next.authFile);
			catalog.setScope(next.modelScope ?? "free");
			refreshModels();
		};
		apply();
		persistScope = (next) => {
			scope.update({ modelScope: next }).catch((error) => {
				ctx.logger.warn("dsh-workbuddyai-connect: failed to persist modelScope", error);
			});
		};
		ctx.effect(() => scope.watch(apply), "dsh-workbuddyai-connect: settings observer");
	});
	let stopped = false;
	ctx.effect(() => () => {
		stopped = true;
		oauth.cancel();
		shim.close();
		clearHostHeartbeat();
	});
	shim.ready.then(() => {
		if (stopped) return;
		let invalidate;
		try {
			const workbuddyai = createWorkBuddyAiAdapter({
				shim,
				store,
				catalog,
				resolveAttachments: () => ctx.get("attachments"),
				observe: (modelId) => probeService.recordFor(modelId)
			});
			invalidate = workbuddyai.invalidate;
			refreshModels = () => {
				if (stopped) return;
				workbuddyai.invalidate();
				ctx.emit("llm/adapters-updated");
			};
			let releaseAdapter;
			let releaseDirectory;
			try {
				releaseAdapter = ctx.llm.registerAdapter([WORKBUDDYAI_PROVIDER], workbuddyai.adapter);
				releaseDirectory = ctx.llm.registerConfigurableProviders([{
					provider: WORKBUDDYAI_PROVIDER,
					displayName: "WorkBuddy AI",
					settingsNs: WORKBUDDYAI_SETTINGS_NS,
					settingsPath: [],
					declared: false
				}]);
			} finally {
				if (releaseAdapter === void 0 || releaseDirectory === void 0) {
					releaseAdapter?.();
					releaseDirectory?.();
				}
			}
			try {
				ctx.effect(() => () => {
					releaseAdapter?.();
					releaseDirectory?.();
				});
			} catch {
				releaseAdapter?.();
				releaseDirectory?.();
			}
			writeHostHeartbeat();
		} catch (error) {
			ctx.logger.error("dsh-workbuddyai-connect: provider registration failed", error);
			return;
		}
		(async () => {
			try {
				const credential = await store.current();
				if (credential === void 0 || stopped) return;
				const models = await client.fetchModels(credential);
				if (stopped) return;
				catalog.setUpstream(models);
				invalidate?.();
			} catch (error) {
				ctx.logger.warn("dsh-workbuddyai-connect: dynamic model catalog unavailable; serving the static fallback list", error);
			}
		})();
	}).catch((error) => {
		ctx.logger.error("dsh-workbuddyai-connect: loopback endpoint failed to start; provider not registered", error);
	});
}
//#endregion
export { BUILTIN_CREDITS, BUILTIN_FREE_MODELS, Config, FALLBACK_EXTRA_MODELS, FALLBACK_FREE_MODEL_IDS, FALLBACK_WORKBUDDYAI_MODELS, LOGIN_TIMEOUT_MS, PROBE_EFFORT_CANDIDATES, WORKBUDDYAI_AUTH_FILENAME, WORKBUDDYAI_AUTH_FILE_ENV, WORKBUDDYAI_CONTROL_PATH, WORKBUDDYAI_DESKTOP_AUTH_BASENAME, WORKBUDDYAI_DISPLAY_NAME, WORKBUDDYAI_HOST_HEARTBEAT_FILENAME, WORKBUDDYAI_PROBE_FILENAME, WORKBUDDYAI_PROVIDER, WORKBUDDYAI_SETTINGS_NS, WORKBUDDYAI_STATUS_PATH, WorkBuddyAiCatalog, WorkBuddyAiCredentialStore, WorkBuddyAiOAuthLogin, WorkBuddyAiProbeService, WorkBuddyAiProbeStore, WorkBuddyAiUpstreamClient, apply, classifyUpstreamError, clearHostHeartbeat, composeCatalog, createWorkBuddyAiAdapter, createWorkBuddyAiShim, credentialFromPluginToken, defaultDesktopAuthCandidates, defaultDesktopAuthPath, fingerprintModel, freeModelIds, inject, isFreeCredits, isHeartbeatProcessAlive, loadProductConfig, name, normalizeCredits, parseProductConfig, parseWorkBuddyAiAuth, prepareChatBody, probeModel, processStartTimeMs, randomSentinel, readHostHeartbeat, reasoningFields, regionOf, workbuddyAiHostHeartbeatPath, workbuddyAiOwnAuthPath, workbuddyAiProbePath, workbuddyAiProductConfigPath };
