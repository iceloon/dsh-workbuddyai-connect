import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, release } from "node:os";
import { basename, join } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
//#region src/auth.ts
/**
* WorkBuddy AI (international) credential resolution.
*
* Credentials come from either:
* 1. Browser OAuth (official CLI login), saved as a plugin-owned copy under
*    `$DSH_HOME` — this is the path that does not need the desktop app.
* 2. The WorkBuddy **international** desktop app's own auth file, read-only;
*    the same plugin-owned copy also holds token refreshes so the desktop file
*    is never written.
* The effective credential is whichever of the two expires later, so a refresh
* by either side wins.
*
* International vs domestic: the two deployments write different auth files in
* the same directory — `workbuddy-desktop-ai.info` (domain `www.workbuddy.ai`,
* the overseas product) and `workbuddy-desktop.info` (domain `www.workbuddy.cn`,
* the domestic one). This plugin reads the `.ai` file, because the overseas
* deployment is the one it serves. The credential's own `domain` field is what
* actually selects the upstream host, so a mis-pointed file degrades into a
* region mismatch rather than silent cross-region traffic.
*
* @module dsh-workbuddyai-connect/auth
*/
/** Basename of the plugin-owned credential copy inside the Harness home. */
const WORKBUDDYAI_AUTH_FILENAME = ".workbuddyai-auth.json";
/** Env variable that overrides the desktop auth-file location. */
const WORKBUDDYAI_AUTH_FILE_ENV = "WORKBUDDYAI_AUTH_FILE";
/**
* Basename of the WorkBuddy **international** desktop auth document.
*
* The domestic build writes `workbuddy-desktop.info` in the same directory;
* only the `.ai` suffix names the overseas sign-in this plugin is built for.
*/
const WORKBUDDYAI_DESKTOP_AUTH_BASENAME = "workbuddy-desktop-ai.info";
/** Current on-disk format of the plugin-owned copy; readers reject others. */
const OWN_FORMAT_VERSION = 1;
/** Plugin-owned copy path inside the Harness home. */
function workbuddyAiOwnAuthPath() {
	return join(resolveDshHome(), WORKBUDDYAI_AUTH_FILENAME);
}
const DESKTOP_AUTH_DIRECTORY = [
	"CodeBuddyExtension",
	"Data",
	"Public",
	"auth"
];
/** Whether this Linux process is running inside Windows Subsystem for Linux. */
function isWsl() {
	if (process.platform !== "linux") return false;
	if (process.env["WSL_DISTRO_NAME"] !== void 0 || process.env["WSL_INTEROP"] !== void 0) return true;
	return release().toLowerCase().includes("microsoft");
}
/** Convert a Windows drive path to WSL's conventional `/mnt/<drive>` form. */
function windowsPathForWsl(value) {
	const path = value?.trim();
	if (!path) return void 0;
	if (path.startsWith("/")) return path;
	const drivePath = /^([a-z]):[\\/](.*)$/iu.exec(path);
	if (drivePath === null) return void 0;
	return join("/mnt", drivePath[1].toLowerCase(), ...drivePath[2].split(/[\\/]+/u));
}
/** Windows desktop credential candidates visible from a WSL process. */
function wslDesktopAuthCandidates(home) {
	const profile = windowsPathForWsl(process.env["USERPROFILE"]) ?? join("/mnt/c/Users", basename(home));
	const localAppData = windowsPathForWsl(process.env["LOCALAPPDATA"]) ?? join(profile, "AppData", "Local");
	const roamingAppData = windowsPathForWsl(process.env["APPDATA"]) ?? join(profile, "AppData", "Roaming");
	return [join(localAppData, ...DESKTOP_AUTH_DIRECTORY, WORKBUDDYAI_DESKTOP_AUTH_BASENAME), join(roamingAppData, ...DESKTOP_AUTH_DIRECTORY, WORKBUDDYAI_DESKTOP_AUTH_BASENAME)];
}
/**
* Platform-default candidates for the WorkBuddy **international** desktop
* app's auth file, in probe order. Windows probes both AppData roots: current
* builds write under `%LOCALAPPDATA%` (Local), older ones under `%APPDATA%`
* (Roaming). WSL probes those same Windows locations through its mounted
* Windows profile before the native Linux location.
*/
function defaultDesktopAuthCandidates() {
	const home = homedir();
	const name = WORKBUDDYAI_DESKTOP_AUTH_BASENAME;
	if (process.platform === "darwin") return [join(home, "Library", "Application Support", ...DESKTOP_AUTH_DIRECTORY, name)];
	if (process.platform === "win32") return [join(home, "AppData", "Local", ...DESKTOP_AUTH_DIRECTORY, name), join(home, "AppData", "Roaming", ...DESKTOP_AUTH_DIRECTORY, name)];
	if (process.platform === "linux") {
		const linux = join(home, ".config", ...DESKTOP_AUTH_DIRECTORY, name);
		return isWsl() ? [...wslDesktopAuthCandidates(home), linux] : [linux];
	}
	return [];
}
/** First platform-default candidate; see {@link defaultDesktopAuthCandidates}. */
function defaultDesktopAuthPath() {
	return defaultDesktopAuthCandidates()[0];
}
/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value) {
	if (value <= 0) return 0;
	return value > 0xe8d4a51000 ? value : value * 1e3;
}
function optionalString(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
/**
* Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
* nested form `{"auth":{...},"account":{...}}` and the flat panel form.
* Returns undefined when the document carries no access token.
*/
function parseWorkBuddyAiAuth(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	let auth;
	let identity;
	if (typeof document["auth"] === "object" && document["auth"] !== null) {
		auth = document["auth"];
		identity = typeof document["account"] === "object" && document["account"] !== null ? document["account"] : {};
	} else {
		auth = document;
		identity = document;
	}
	const accessToken = typeof auth["accessToken"] === "string" ? auth["accessToken"] : "";
	if (accessToken === "") return void 0;
	const expiresAtMs = typeof auth["expiresAt"] === "number" ? expiryToMs(auth["expiresAt"]) : 0;
	const refreshExpiresAtMs = typeof auth["refreshExpiresAt"] === "number" ? expiryToMs(auth["refreshExpiresAt"]) : void 0;
	const enterpriseId = optionalString(identity["enterpriseId"]);
	const nickname = optionalString(identity["nickname"]);
	return {
		accessToken,
		refreshToken: typeof auth["refreshToken"] === "string" ? auth["refreshToken"] : "",
		expiresAtMs,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		domain: optionalString(auth["domain"]) ?? "",
		uid: optionalString(identity["uid"]) ?? "",
		...enterpriseId === void 0 ? {} : { enterpriseId },
		...nickname === void 0 ? {} : { nickname },
		source: "desktop"
	};
}
/** Decode a JWT payload without verifying the signature (identity claims only). */
function jwtPayload(token) {
	const parts = token.split(".");
	if (parts.length < 2 || parts[1] === void 0 || parts[1] === "") return void 0;
	try {
		const json = Buffer.from(parts[1], "base64url").toString("utf8");
		const parsed = JSON.parse(json);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
		return parsed;
	} catch {
		return;
	}
}
/**
* Turn the official CLI `/v2/plugin/auth/token` payload into a credential.
* Identity fields come from the access-token JWT; the desktop file is not used.
*/
function credentialFromPluginToken(data) {
	const accessToken = typeof data["accessToken"] === "string" ? data["accessToken"] : "";
	if (accessToken === "") throw new Error("workbuddyai plugin token missing accessToken");
	const payload = jwtPayload(accessToken) ?? {};
	const expiresIn = typeof data["expiresIn"] === "number" ? data["expiresIn"] : 0;
	const uid = optionalString(payload["userId"]) ?? optionalString(payload["uid"]) ?? optionalString(payload["sub"]) ?? "";
	const enterpriseId = optionalString(payload["enterpriseId"]) ?? optionalString(data["enterpriseId"]);
	const nickname = optionalString(payload["nickname"]) ?? optionalString(payload["name"]) ?? optionalString(data["nickname"]);
	return {
		accessToken,
		refreshToken: typeof data["refreshToken"] === "string" ? data["refreshToken"] : "",
		expiresAtMs: expiresIn > 0 ? Date.now() + expiresIn * 1e3 : 0,
		domain: optionalString(data["domain"]) ?? "www.workbuddy.ai",
		uid,
		...enterpriseId === void 0 ? {} : { enterpriseId },
		...nickname === void 0 ? {} : { nickname },
		source: "dsh"
	};
}
/** Serialize the plugin-owned copy. */
function ownDocument(credential) {
	return {
		version: OWN_FORMAT_VERSION,
		credential
	};
}
/**
* Parse the plugin-owned copy; other versions and shapes are rejected.
*
* The owned copy stores the normalized credential itself (camelCase
* `expiresAtMs`, identity fields at the top level), not the desktop document
* shape, so it is read field by field rather than through
* {@link parseWorkBuddyAiAuth} — round-tripping would read `expiresAt` and an
* `account` object, find neither, zero the expiry, and drop the identity
* headers.
*/
function parseOwnDocument(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	if (document["version"] !== OWN_FORMAT_VERSION) return void 0;
	if (typeof document["credential"] !== "object" || document["credential"] === null) return void 0;
	const stored = document["credential"];
	const accessToken = typeof stored["accessToken"] === "string" ? stored["accessToken"] : "";
	if (accessToken === "") return void 0;
	const refreshExpiresAtMs = typeof stored["refreshExpiresAtMs"] === "number" ? stored["refreshExpiresAtMs"] : void 0;
	const enterpriseId = optionalString(stored["enterpriseId"]);
	const nickname = optionalString(stored["nickname"]);
	return {
		accessToken,
		refreshToken: typeof stored["refreshToken"] === "string" ? stored["refreshToken"] : "",
		expiresAtMs: typeof stored["expiresAtMs"] === "number" ? stored["expiresAtMs"] : 0,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		domain: optionalString(stored["domain"]) ?? "",
		uid: optionalString(stored["uid"]) ?? "",
		...enterpriseId === void 0 ? {} : { enterpriseId },
		...nickname === void 0 ? {} : { nickname },
		source: "dsh"
	};
}
/** Whether a filesystem error reports an absent path. */
function isENOENT(error) {
	return error?.code === "ENOENT";
}
/**
* Read-only credential store with demand-driven refresh.
*
* Refresh policy: refresh only when the access token is inside the margin (or
* already expired), keep the refreshed credential in the plugin-owned copy,
* and never write the desktop app's file. A failed refresh still returns a
* not-yet-expired token, so an unreachable refresh endpoint does not take down
* a working session.
*/
var WorkBuddyAiCredentialStore = class {
	refresh;
	refreshMarginMs;
	ownPath;
	desktopPathOverride;
	inflight;
	constructor(options) {
		this.refresh = options.refresh;
		this.refreshMarginMs = options.refreshMarginMs ?? 3e5;
		this.ownPath = options.ownPath ?? workbuddyAiOwnAuthPath();
		this.desktopPathOverride = options.desktopPath;
	}
	/**
	* Configuration precedence for the desktop file: the plugin's configured
	* path, then the environment variable, then the platform defaults. An
	* explicit path is used verbatim; the defaults are a probe order.
	*/
	resolveDesktopCandidates() {
		const fromEnv = process.env[WORKBUDDYAI_AUTH_FILE_ENV];
		const explicit = this.desktopPathOverride ?? (fromEnv !== void 0 && fromEnv.trim() !== "" ? fromEnv : void 0);
		if (explicit !== void 0) return [explicit];
		return defaultDesktopAuthCandidates();
	}
	resolveDesktopPath() {
		return this.resolveDesktopCandidates()[0];
	}
	/** Repoint the desktop file; a settings change applies on the next read. */
	setDesktopPath(path) {
		this.desktopPathOverride = path;
	}
	/** The resolved desktop auth-file path, for diagnostics. */
	desktopAuthPath() {
		return this.resolveDesktopPath();
	}
	/** The plugin-owned copy path, for diagnostics. */
	ownAuthPath() {
		return this.ownPath;
	}
	/** Read the freshest stored credential without refreshing anything. */
	async current() {
		const [desktop, own] = await Promise.all([this.readDesktop(), this.readOwn()]);
		if (desktop === void 0) return own;
		if (own === void 0) return desktop;
		return own.expiresAtMs > desktop.expiresAtMs ? own : desktop;
	}
	/**
	* The credential to send upstream: {@link current}, refreshed on demand.
	* Single-flight, so parallel requests share one refresh.
	*/
	async resolve() {
		const credential = await this.current();
		if (credential === void 0) {
			const candidates = this.resolveDesktopCandidates();
			const desktop = candidates.length > 0 ? candidates.join(" or ") : "(no desktop path on this platform)";
			throw new Error(`workbuddyai: no signed-in WorkBuddy AI (international) account found; connect from the plugin card, run \`dsh-workbuddyai-connect login\`, or sign in once in the WorkBuddy international desktop app (expected ${desktop} or ${WORKBUDDYAI_AUTH_FILE_ENV})`);
		}
		if (!this.needsRefresh(credential)) return credential;
		this.inflight ??= this.refreshNow(credential).finally(() => {
			this.inflight = void 0;
		});
		return this.inflight;
	}
	/** Read-only sign-in summary; never refreshes and never throws. */
	async status() {
		try {
			const credential = await this.current();
			if (credential === void 0) return { state: "signed-out" };
			return {
				state: "signed-in",
				expiresAtMs: credential.expiresAtMs,
				...credential.refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
				...credential.nickname === void 0 ? {} : { nickname: credential.nickname },
				...credential.domain === "" ? {} : { domain: credential.domain },
				source: credential.source
			};
		} catch {
			return { state: "signed-out" };
		}
	}
	/** Remove the plugin-owned copy; the desktop file is untouched. */
	async logout() {
		await rm(this.ownPath, { force: true });
		await rm(`${this.ownPath}.lock`, { force: true });
	}
	/** Persist a browser-OAuth credential into the plugin-owned copy. */
	async importCredential(credential) {
		const next = {
			...credential,
			source: "dsh",
			domain: credential.domain === "" ? "www.workbuddy.ai" : credential.domain
		};
		await this.saveOwn(next);
		return next;
	}
	needsRefresh(credential) {
		if (credential.expiresAtMs <= 0) return true;
		return Date.now() + this.refreshMarginMs >= credential.expiresAtMs;
	}
	async refreshNow(credential) {
		if (credential.refreshToken === "") {
			if (credential.expiresAtMs > Date.now() + 3e4) return credential;
			throw new Error("workbuddyai: access token expired and no refresh token is stored; connect again from the plugin card or sign in in the WorkBuddy international desktop app");
		}
		try {
			const outcome = await this.refresh(credential);
			const refreshed = {
				...credential,
				accessToken: outcome.accessToken,
				...outcome.refreshToken === void 0 ? {} : { refreshToken: outcome.refreshToken },
				expiresAtMs: outcome.expiresInSec !== void 0 ? Date.now() + outcome.expiresInSec * 1e3 : credential.expiresAtMs,
				...outcome.domain === void 0 || outcome.domain === "" ? {} : { domain: outcome.domain },
				source: "dsh"
			};
			await this.saveOwn(refreshed);
			return refreshed;
		} catch (error) {
			if (credential.expiresAtMs > Date.now() + 3e4) return credential;
			throw new Error(`workbuddyai: token refresh failed and the access token is expired (${String(error)}); connect again from the plugin card or open the WorkBuddy international desktop app`);
		}
	}
	async saveOwn(credential) {
		await withFileLock(this.ownPath, async () => {
			await writeFileAtomic(this.ownPath, `${JSON.stringify(ownDocument(credential), null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
		});
	}
	/**
	* Read the first desktop candidate that exists. Only an absent file (ENOENT)
	* falls through to the next candidate; a file that is present but unparsable
	* is authoritative for its slot, so a stale older-version file never silently
	* wins over a broken newer one.
	*/
	async readDesktop() {
		for (const desktopPath of this.resolveDesktopCandidates()) try {
			return parseWorkBuddyAiAuth(await readFile(desktopPath, "utf8"));
		} catch (error) {
			if (!isENOENT(error)) throw error;
		}
	}
	async readOwn() {
		try {
			return parseOwnDocument(await readFile(this.ownPath, "utf8"));
		} catch (error) {
			if (isENOENT(error)) return void 0;
			return;
		}
	}
	/** Whether any desktop-file candidate exists as a regular file; diagnostics only. */
	async desktopFilePresent() {
		for (const desktopPath of this.resolveDesktopCandidates()) try {
			if ((await stat(desktopPath)).isFile()) return true;
		} catch {}
		return false;
	}
};
//#endregion
//#region src/probe.ts
/**
* The reasoning-effort probe: decide whether a model's `reasoning_effort`
* parameter is actually validated, and if so which canonical values it accepts.
*
* The order matters and is not an optimization:
*
* 1. **Baseline** (no `reasoning_effort`) proves the model, credential, and
*    request shape work at all, so a later rejection can be attributed.
* 2. **Sentinel** (a fresh random, impossible-to-collide value) answers the one
*    question a per-level sweep cannot: does the upstream validate the field?
*    A model that accepts the sentinel answers 200 to *everything*, so its
*    per-level results would be uniformly false positives.
* 3. **Levels**, only after the sentinel was refused.
*
* The result is an observation, never a capability claim. Even a fully
* successful sweep means "the upstream accepted these spellings", not "these
* spellings change how the model thinks".
*
* @module dsh-workbuddyai-connect/probe
*/
/**
* The canonical values a probe tests, in a fixed order.
*
* `minimal` is absent: it appears in no upstream vocabulary. `off` is absent
* by policy — disabling thinking is a separate capability the upstream must
* declare through `canDisableThinking`, never something probing may infer.
*/
const PROBE_EFFORT_CANDIDATES = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** Prompt body used by every probe request; carries nothing user-specific. */
const PROBE_PROMPT = "ping";
/** Default sentinel: unmistakably non-canonical, different on every call. */
function randomSentinel() {
	return `probe_sentinel_${randomBytes(12).toString("hex")}`;
}
/**
* The upstream's "this effort value is not supported" code, measured
* against the live upstream. It is *not* treated as a permanent protocol promise:
* anything unrecognized degrades to `unknown` rather than to a capability
* conclusion.
*/
const INVALID_EFFORT_CODE = "invalid_reasoning_effort";
/** Whether an attempt is an attributable rejection of the effort value. */
function isEffortRejection(attempt) {
	return attempt.status === 400 && attempt.errorCode === INVALID_EFFORT_CODE;
}
/** Whether an attempt shows the upstream accepted the request and streamed. */
function isAcceptance(attempt) {
	return attempt.status === 200 && attempt.streamed;
}
/** Why an attempt ended in `unknown`, phrased for a log line. */
function unknownReason(stage, attempt) {
	const code = attempt.errorCode === void 0 ? "" : ` (${attempt.errorCode})`;
	const detail = attempt.detail === void 0 ? "" : `: ${attempt.detail}`;
	return `${stage} status ${attempt.status}${code}${detail}`;
}
/**
* Probe one model.
*
* `options.candidates` exists so tests can shorten the sweep; production always
* uses {@link PROBE_EFFORT_CANDIDATES}.
*/
async function probeModel(options) {
	const sentinel = options.sentinel ?? randomSentinel;
	const candidates = options.candidates ?? PROBE_EFFORT_CANDIDATES;
	const timeoutMs = options.timeoutMs ?? 3e4;
	let requests = 0;
	const attempt = async (effort) => {
		requests += 1;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await options.send(effort, controller.signal);
		} catch (error) {
			return {
				status: 0,
				streamed: false,
				detail: `transport error: ${String(error)}`
			};
		} finally {
			clearTimeout(timer);
		}
	};
	const baseline = await attempt(void 0);
	if (!isAcceptance(baseline)) return {
		validation: "unknown",
		efforts: [],
		requests,
		reason: unknownReason("baseline", baseline)
	};
	const sentinelAttempt = await attempt(sentinel());
	if (isAcceptance(sentinelAttempt)) return {
		validation: "non-validating",
		efforts: [],
		requests
	};
	if (!isEffortRejection(sentinelAttempt)) return {
		validation: "unknown",
		efforts: [],
		requests,
		reason: unknownReason("sentinel", sentinelAttempt)
	};
	const accepted = [];
	for (const effort of candidates) {
		const levelAttempt = await attempt(effort);
		if (isAcceptance(levelAttempt)) {
			accepted.push(effort);
			continue;
		}
		if (isEffortRejection(levelAttempt)) continue;
		return {
			validation: "unknown",
			efforts: [],
			requests,
			reason: unknownReason(`level ${effort}`, levelAttempt)
		};
	}
	return {
		validation: "validating",
		efforts: accepted,
		requests
	};
}
//#endregion
//#region src/upstream.ts
const CN_CHAT_BASE = "https://copilot.tencent.com";
const CN_BILLING_BASE = "https://www.codebuddy.cn";
const GLOBAL_BASE = "https://www.workbuddy.ai";
/**
* Personal model-catalog path per region.
*
* The overseas deployment answers the domestic path with HTTP 500 rather than
* a 404, so this is a hard routing decision, not a cosmetic one.
*/
const CATALOG_PATH = {
	global: "/v2/enterprises/personal/models",
	cn: "/console/enterprises/personal/models"
};
const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
const JSON_TIMEOUT_MS = 3e4;
const ERROR_BODY_LIMIT = 4096;
/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS = [
	"insufficient credit",
	"no credit",
	"credit exhausted",
	"out of credit",
	"quota exceeded",
	"quota exhaust",
	"payment required",
	"credit not enough",
	"not enough credit",
	"积分不足",
	"额度不足",
	"余额不足",
	"积分用完",
	"额度用尽",
	"没有积分"
];
/** The concrete effort spellings WorkBuddy exposes on the wire. */
const EFFORT_VALUES$1 = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** Promotional badge keys the upstream tags carry, minus their color suffix. */
const BADGE_PREFIX = "badge:";
/** Session-invalidation markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS = ["Offline user session not found", "12153"];
/** Parse the upstream `reasoning` object into {@link WorkBuddyAiModelReasoning}. */
function resolveUpstreamReasoning(wrapped) {
	const supports = wrapped["supportsReasoning"] === true;
	const onlyReasoning = wrapped["onlyReasoning"] === true;
	const rawReasoning = wrapped["reasoning"];
	let supportedEfforts;
	let defaultEffort;
	let canDisableThinking = true;
	if (typeof rawReasoning === "object" && rawReasoning !== null && !Array.isArray(rawReasoning)) {
		const reasoning = rawReasoning;
		const rawEfforts = reasoning["supportedEfforts"];
		if (Array.isArray(rawEfforts)) {
			const efforts = rawEfforts.filter((value) => typeof value === "string" && EFFORT_VALUES$1.includes(value));
			if (efforts.length > 0) supportedEfforts = efforts;
		}
		if (typeof reasoning["defaultEffort"] === "string" && EFFORT_VALUES$1.includes(reasoning["defaultEffort"])) defaultEffort = reasoning["defaultEffort"];
		else if (typeof reasoning["effort"] === "string" && EFFORT_VALUES$1.includes(reasoning["effort"])) defaultEffort = reasoning["effort"];
		canDisableThinking = reasoning["canDisableThinking"] === true;
	}
	return { reasoning: {
		supports,
		onlyReasoning,
		...supportedEfforts === void 0 ? {} : { supportedEfforts },
		...defaultEffort === void 0 ? {} : { defaultEffort },
		canDisableThinking
	} };
}
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
function normalizeCredits(credits) {
	if (credits === void 0) return void 0;
	const trimmed = credits.trim();
	if (trimmed === "") return void 0;
	if (/^credits?$/iu.test(trimmed)) return void 0;
	const bare = trimmed.replace(/\s+credits?$/iu, "").trim();
	return bare === "" ? void 0 : bare;
}
/**
* Whether a credits multiplier means "free".
*
* Only an explicit `x0.00` (with or without the `x`, any number of decimals)
* counts. An absent multiplier is *not* free: the upstream omits the field for
* some rows and treating absence as free would advertise a paid model.
*/
function isFreeCredits(credits) {
	if (credits === void 0) return false;
	return /^x?0(?:\.0+)?$/u.test(credits.trim());
}
/** Parse the upstream `tags` / `credits` fields into billing metadata. */
function resolveUpstreamBilling(wrapped) {
	const rawCredits = wrapped["credits"];
	const credits = typeof rawCredits === "string" && rawCredits.trim() !== "" ? rawCredits.trim() : void 0;
	const badges = [];
	const rawTags = wrapped["tags"];
	if (Array.isArray(rawTags)) for (const tag of rawTags) {
		if (typeof tag !== "string") continue;
		if (!tag.toLowerCase().startsWith(BADGE_PREFIX)) continue;
		const label = tag.slice(6).split(":")[0] ?? tag.slice(6);
		if (label !== "") badges.push(label);
	}
	return { billing: {
		...credits === void 0 ? {} : { credits },
		...badges.length === 0 ? {} : { badges },
		free: isFreeCredits(credits)
	} };
}
/** Classify an upstream failure from its HTTP status and body excerpt. */
function classifyUpstreamError(status, body) {
	if (status === 402) return "hard_credit";
	const lower = body.toLowerCase();
	for (const marker of HARD_CREDIT_MARKERS) if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "hard_credit";
	for (const marker of SESSION_DEAD_MARKERS) if (body.includes(marker)) return "session_dead";
	if (status === 429) return "soft_rate";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	if (status >= 400) return "client";
	return "client";
}
/**
* Region for a login domain.
*
* An empty domain resolves to `global`, not `cn`: this plugin is the
* international one, so an unlabelled credential is treated as belonging to the
* deployment it was configured for. A credential that names the domestic domain
* still routes domestic, because the `domain` field is the upstream's own
* routing fact and second-guessing it would send a `.cn` token to `.ai`.
*/
function regionOf(domain) {
	const lowered = domain.trim().toLowerCase();
	if (lowered === "" || lowered.endsWith("workbuddy.ai") || lowered.endsWith("codebuddy.ai")) return "global";
	return "cn";
}
function chatBase(credential) {
	return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_CHAT_BASE;
}
function billingBase(credential) {
	return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
}
function originReferer(credential) {
	return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
}
/** Headers every upstream request shares. */
function commonHeaders(credential) {
	return {
		"Accept": "application/json, text/plain, */*",
		"X-Requested-With": "XMLHttpRequest",
		"Origin": originReferer(credential),
		"Referer": `${originReferer(credential)}/`,
		"User-Agent": CLIENT_UA
	};
}
/** Chat request headers, including the X-No-* conventions the official CLI uses. */
function chatHeaders(credential) {
	return {
		...commonHeaders(credential),
		"Content-Type": "application/json",
		...credential.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid },
		...credential.enterpriseId === void 0 || credential.enterpriseId === "" ? { "X-No-Enterprise-Id": "1" } : { "X-Enterprise-Id": credential.enterpriseId },
		...credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain },
		"X-Product": "SaaS"
	};
}
/** Unauthenticated CLI-login headers; no Bearer, no refresh token. */
function pluginAuthHeaders() {
	return {
		"Accept": "*/*",
		"Content-Type": "application/json",
		"X-Requested-With": "XMLHttpRequest",
		"Origin": GLOBAL_BASE,
		"Referer": `${GLOBAL_BASE}/`,
		"User-Agent": CLIENT_UA,
		"X-No-Authorization": "true",
		"X-No-User-Id": "true",
		"X-No-Enterprise-Id": "true",
		"X-No-Department-Info": "true"
	};
}
/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential) {
	const headers = {
		...commonHeaders(credential),
		"X-Refresh-Token": credential.refreshToken,
		"X-Auth-Refresh-Source": "workbuddy"
	};
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") headers["X-Enterprise-Id"] = credential.enterpriseId;
	return headers;
}
/** Billing request headers. */
function billingHeaders(credential) {
	const headers = {
		"Authorization": `Bearer ${credential.accessToken}`,
		"Accept": "application/json",
		"Content-Type": "application/json"
	};
	if (credential.uid !== "") headers["X-User-Id"] = credential.uid;
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") {
		headers["X-Enterprise-Id"] = credential.enterpriseId;
		headers["X-Tenant-Id"] = credential.enterpriseId;
	}
	if (credential.domain !== "") headers["X-Domain"] = credential.domain;
	return headers;
}
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
function prepareChatBody(source) {
	let body;
	try {
		body = JSON.parse(source);
	} catch {
		return source;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return source;
	const obj = body;
	obj["stream"] = true;
	normalizeDeveloperRole(obj);
	normalizeToolChoice(obj);
	ensureLeadingSystemMessage(obj);
	return JSON.stringify(obj);
}
/** Rewrite `role: "developer"` messages to `role: "system"` (upstream rejects developer). */
function normalizeDeveloperRole(obj) {
	const messages = obj["messages"];
	if (!Array.isArray(messages)) return;
	for (const message of messages) {
		if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
		const wrapped = message;
		if (wrapped["role"] === "developer") wrapped["role"] = "system";
	}
}
/**
* Guarantee the upstream's requirement that the first message is a system
* prompt. Only an actually-missing leading system message is repaired; a body
* with no `messages` array at all is left alone, because the upstream's own
* validation is the better error for a malformed request.
*/
function ensureLeadingSystemMessage(obj) {
	const messages = obj["messages"];
	if (!Array.isArray(messages) || messages.length === 0) return;
	const first = messages[0];
	if (typeof first === "object" && first !== null && !Array.isArray(first) && first["role"] === "system") return;
	messages.unshift({
		role: "system",
		content: "You are a helpful assistant."
	});
}
/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj) {
	const suppress = () => {
		delete obj["tools"];
		delete obj["functions"];
	};
	if (!("tool_choice" in obj)) return;
	const choice = obj["tool_choice"];
	if (typeof choice === "string") {
		if (choice.trim().toLowerCase() === "none") {
			delete obj["tool_choice"];
			suppress();
		}
		return;
	}
	if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
		const wrapped = choice;
		const type = typeof wrapped["type"] === "string" ? wrapped["type"].trim().toLowerCase() : "";
		if (type === "none") {
			delete obj["tool_choice"];
			suppress();
		} else if (type === "auto" || type === "required") obj["tool_choice"] = type;
		else if (type === "function") {
			const fn = typeof wrapped["function"] === "object" && wrapped["function"] !== null ? wrapped["function"] : void 0;
			let name = typeof fn?.["name"] === "string" ? fn["name"] : "";
			if (name === "" && typeof wrapped["name"] === "string") name = wrapped["name"];
			name = name.trim();
			obj["tool_choice"] = name !== "" ? name : "auto";
		} else delete obj["tool_choice"];
		return;
	}
	delete obj["tool_choice"];
}
async function readEnvelope(response) {
	const text = await response.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`workbuddyai upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`);
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error(`workbuddyai upstream returned an unexpected document (http ${response.status})`);
	const document = parsed;
	return {
		code: typeof document["code"] === "number" ? document["code"] : 0,
		msg: typeof document["msg"] === "string" ? document["msg"] : "",
		data: "data" in document ? document["data"] : void 0
	};
}
/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status, envelope) {
	const kind = classifyUpstreamError(status, envelope.msg);
	return /* @__PURE__ */ new Error(`workbuddyai upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`);
}
/**
* Upstream HTTP client. One instance serves the whole plugin; requests take the
* credential explicitly so token refreshes apply on the next call.
*/
var WorkBuddyAiUpstreamClient = class {
	/** POST the chat endpoint; a successful answer is the raw SSE response. */
	async chatStream(credential, bodyJson, signal) {
		let response;
		try {
			response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
				method: "POST",
				headers: {
					...chatHeaders(credential),
					"Authorization": `Bearer ${credential.accessToken}`
				},
				body: bodyJson,
				...signal === void 0 ? {} : { signal }
			});
		} catch (error) {
			return {
				ok: false,
				status: 0,
				kind: "server",
				message: `transport error: ${String(error)}`
			};
		}
		if (response.ok) return {
			ok: true,
			response
		};
		const text = (await response.text()).slice(0, ERROR_BODY_LIMIT);
		return {
			ok: false,
			status: response.status,
			kind: classifyUpstreamError(response.status, text),
			message: text
		};
	}
	/** POST the token-refresh endpoint; the caller merges the outcome. */
	async refreshToken(credential) {
		const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
			method: "POST",
			headers: refreshHeaders(credential),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const accessToken = typeof data["accessToken"] === "string" ? data["accessToken"] : "";
		if (accessToken === "") throw new Error("workbuddyai token refresh returned no accessToken; sign in again in the WorkBuddy app");
		const outcome = { accessToken };
		if (typeof data["refreshToken"] === "string" && data["refreshToken"] !== "") outcome.refreshToken = data["refreshToken"];
		if (typeof data["expiresIn"] === "number" && data["expiresIn"] > 0) outcome.expiresInSec = data["expiresIn"];
		if (typeof data["domain"] === "string" && data["domain"] !== "") outcome.domain = data["domain"];
		return outcome;
	}
	/** POST the official CLI login start; returns the browser `authUrl`. */
	async startPluginLogin(nonce) {
		const response = await fetch(`${GLOBAL_BASE}/v2/plugin/auth/state?platform=CLI&nonce=${encodeURIComponent(nonce)}`, {
			method: "POST",
			headers: pluginAuthHeaders(),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const state = typeof data["state"] === "string" ? data["state"] : "";
		const authUrl = typeof data["authUrl"] === "string" ? data["authUrl"] : "";
		if (state === "" || authUrl === "") throw new Error("workbuddyai login start missing state/authUrl");
		return {
			state,
			authUrl
		};
	}
	/**
	* GET the CLI login token. Envelope code `11217` means the browser has not
	* finished yet — returns `undefined` so the caller can poll again.
	*/
	async pollPluginToken(state) {
		const response = await fetch(`${GLOBAL_BASE}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
			headers: pluginAuthHeaders(),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (envelope.code === 11217) return void 0;
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		if (typeof envelope.data !== "object" || envelope.data === null) throw new Error("workbuddyai login token returned no data");
		return envelope.data;
	}
	/**
	* GET the personal model catalog from the region's own path and keep the
	* `cli` agent's models only.
	*
	* The path is chosen from the credential's domain (see {@link CATALOG_PATH}):
	* the overseas host answers the domestic path with HTTP 500, so this is what
	* makes an international sign-in work at all.
	*/
	async fetchModels(credential) {
		const path = CATALOG_PATH[regionOf(credential.domain)];
		const response = await fetch(`${chatBase(credential)}${path}`, {
			headers: {
				"Authorization": `Bearer ${credential.accessToken}`,
				"Accept": "application/json",
				"Origin": originReferer(credential),
				"Referer": `${originReferer(credential)}/`,
				"User-Agent": CLIENT_UA
			},
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const rawModels = Array.isArray(data["models"]) ? data["models"] : [];
		const agents = Array.isArray(data["agents"]) ? data["agents"] : [];
		let cliIds;
		for (const agent of agents) if (typeof agent === "object" && agent !== null) {
			const wrapped = agent;
			if (wrapped["name"] === "cli" && Array.isArray(wrapped["models"])) {
				cliIds = wrapped["models"].filter((id) => typeof id === "string");
				break;
			}
		}
		if (cliIds === void 0 || cliIds.length === 0) throw new Error("workbuddyai model catalog lists no cli agent models");
		const byId = /* @__PURE__ */ new Map();
		for (const model of rawModels) {
			if (typeof model !== "object" || model === null) continue;
			const wrapped = model;
			const id = typeof wrapped["id"] === "string" ? wrapped["id"] : "";
			if (id === "" || wrapped["disabled"] === true) continue;
			const input = typeof wrapped["maxInputTokens"] === "number" ? wrapped["maxInputTokens"] : 0;
			const output = typeof wrapped["maxOutputTokens"] === "number" ? wrapped["maxOutputTokens"] : 0;
			if (input <= 0 || output <= 0) continue;
			byId.set(id, {
				id,
				name: typeof wrapped["name"] === "string" && wrapped["name"] !== "" ? wrapped["name"] : id,
				contextWindow: input,
				maxTokens: output,
				supportsImages: wrapped["supportsImages"] === true && wrapped["disabledMultimodal"] !== true,
				...resolveUpstreamReasoning(wrapped),
				...resolveUpstreamBilling(wrapped)
			});
		}
		const models = cliIds.map((id) => byId.get(id)).filter((model) => model !== void 0);
		if (models.length === 0) throw new Error("workbuddyai model catalog resolved to an empty list");
		return models;
	}
	/** POST the billing endpoint for the aggregated remaining credit. */
	async fetchCredits(credential) {
		const now = /* @__PURE__ */ new Date();
		const format = (date) => [
			date.getFullYear().toString().padStart(4, "0"),
			(date.getMonth() + 1).toString().padStart(2, "0"),
			date.getDate().toString().padStart(2, "0")
		].join("-") + " " + [
			date.getHours().toString().padStart(2, "0"),
			date.getMinutes().toString().padStart(2, "0"),
			date.getSeconds().toString().padStart(2, "0")
		].join(":");
		const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: JSON.stringify({
				PageNumber: 1,
				PageSize: 100,
				ProductCode: "p_tcaca",
				Status: [0, 3],
				PackageEndTimeRangeBegin: format(now),
				PackageEndTimeRangeEnd: format(new Date(now.getTime() + 3185136e6))
			}),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const responseWrapper = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const data = typeof responseWrapper["Response"] === "object" && responseWrapper["Response"] !== null ? responseWrapper["Response"] : {};
		const inner = typeof data["Data"] === "object" && data["Data"] !== null ? data["Data"] : {};
		const rawAccounts = Array.isArray(inner["Accounts"]) ? inner["Accounts"] : [];
		const accounts = [];
		let total = 0;
		for (const raw of rawAccounts) {
			if (typeof raw !== "object" || raw === null) continue;
			const account = raw;
			const numberField = (key) => typeof account[key] === "number" ? account[key] : 0;
			const size = numberField("CycleCapacitySize");
			const cycleRemain = numberField("CycleCapacityRemain");
			const cycleUsed = numberField("CycleCapacityUsed");
			const capacityRemain = numberField("CapacityRemain");
			let remain;
			if (size > 0) remain = cycleRemain;
			else if (cycleRemain > 0 || cycleUsed > 0) remain = cycleRemain;
			else remain = capacityRemain;
			if (remain < 0) remain = 0;
			total += remain;
			accounts.push({
				packageName: typeof account["PackageName"] === "string" ? account["PackageName"] : "(unnamed)",
				remain,
				size: size > 0 ? size : numberField("CapacitySize")
			});
		}
		return {
			total,
			accounts
		};
	}
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
	async probeEffort(credential, model, effort, signal) {
		const payload = {
			model,
			stream: true,
			messages: [{
				role: "system",
				content: PROBE_PROMPT
			}, {
				role: "user",
				content: PROBE_PROMPT
			}],
			max_tokens: 1
		};
		if (effort !== void 0) payload["reasoning_effort"] = effort;
		let response;
		try {
			response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
				method: "POST",
				headers: {
					...chatHeaders(credential),
					"Authorization": `Bearer ${credential.accessToken}`
				},
				body: JSON.stringify(payload),
				signal
			});
		} catch (error) {
			return {
				status: 0,
				streamed: false,
				detail: `transport error: ${String(error)}`
			};
		}
		if (!response.ok) {
			const text = (await response.text()).slice(0, ERROR_BODY_LIMIT);
			return {
				status: response.status,
				streamed: false,
				...errorCodeOf(text)
			};
		}
		const streamed = await readFirstEvent(response);
		return {
			status: response.status,
			streamed
		};
	}
};
/** Pull `extError.code` out of an upstream error body, if it is shaped that way. */
function errorCodeOf(text) {
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			const extError = parsed["extError"];
			if (typeof extError === "object" && extError !== null && !Array.isArray(extError)) {
				const code = extError["code"];
				if (typeof code === "string") return {
					errorCode: code,
					detail: code
				};
			}
		}
	} catch {}
	return { detail: text.slice(0, 200) };
}
/**
* Consume just enough of a streaming response to know it really streams.
*
* Returns true on the first chunk containing a data line. Cancels the body
* afterwards; a stream that ends or errors before that counts as not streamed,
* because an empty 200 is not evidence the effort was accepted.
*/
async function readFirstEvent(response) {
	const body = response.body;
	if (body === null) return false;
	const reader = body.getReader();
	const decoder = new TextDecoder();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return false;
			if (decoder.decode(value, { stream: true }).includes("data:")) return true;
		}
	} catch {
		return false;
	} finally {
		await reader.cancel().catch(() => {});
	}
}
//#endregion
//#region src/product-config.ts
/**
* WorkBuddy AI product configuration: the authority on what a model costs, and
* the source of metadata for the models the catalog endpoint omits.
*
* Why this module exists at all — two measured defects in the catalog endpoint
* (`/v2/enterprises/personal/models`) that a naive plugin would inherit:
*
* 1. **It is not the price authority.** The catalog reports `hy4-preview` at
*    `x0.00` (free) while the app's own product configuration prices it
*    `x0.29`. Trusting the catalog would advertise a paid model as free and
*    spend the user's credit without warning.
* 2. **It omits genuinely free models.** `deepseek-v4.1-flash` and
*    `hy4-preview-f` are absent from the catalog entirely, yet both are
*    `x0.00` in the product configuration. Without this module the plugin could
*    not offer the one model this whole exercise is about.
*
* Where the data comes from: the WorkBuddy desktop app caches the configuration
* it is served at `~/.workbuddy-ai/cache/acc-product-config-v3.json` (the
* directory name comes from the config's own `dataFolderName` field, and its
* `applicationName` is `workbuddy-ai` — the international build). That file is
* read-only input here; this plugin never writes to the app's directory.
*
* When the cache is missing (fresh install, another machine, an app update that
* renames it) the built-in {@link FALLBACK_FREE_MODELS} table serves instead, so
* the free list never degrades to "nothing is free" or, worse, "everything is".
*
* @module dsh-workbuddyai-connect/product-config
*/
/** Directory the international WorkBuddy app keeps its state in. */
const WORKBUDDYAI_DATA_FOLDER = ".workbuddy-ai";
/** Cached product-configuration basename inside that directory. */
const WORKBUDDYAI_PRODUCT_CONFIG_BASENAME = "acc-product-config-v3.json";
/** Env variable overriding the product-config file location. */
const WORKBUDDYAI_PRODUCT_CONFIG_ENV = "WORKBUDDYAI_PRODUCT_CONFIG";
/** Absolute path of the cached product configuration. */
function workbuddyAiProductConfigPath() {
	const override = process.env[WORKBUDDYAI_PRODUCT_CONFIG_ENV];
	if (override !== void 0 && override.trim() !== "") return override.trim();
	return join(homedir(), WORKBUDDYAI_DATA_FOLDER, "cache", WORKBUDDYAI_PRODUCT_CONFIG_BASENAME);
}
const EFFORT_VALUES = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
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
const BUILTIN_FREE_MODELS = [
	{
		id: "deepseek-v4.1-flash",
		name: "Deepseek-V4.1-Flash",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh",
				"max"
			],
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.00",
			free: true
		}
	},
	{
		id: "hy4-preview-f",
		name: "Hy4 preview",
		contextWindow: 1e6,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: ["high"],
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.00",
			free: true
		}
	},
	{
		id: "hy3",
		name: "Hy3",
		contextWindow: 192e3,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: ["low", "high"],
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.00",
			free: true
		}
	}
];
/** Ids of the models the product configuration prices free. */
const FALLBACK_FREE_MODEL_IDS = BUILTIN_FREE_MODELS.map((model) => model.id);
/**
* The subset the catalog endpoint does not return, so they must be injected.
*
* `hy3` is absent from this list because the endpoint does list it; the other
* two are missing from the live catalog entirely.
*/
const FALLBACK_EXTRA_MODELS = BUILTIN_FREE_MODELS.filter((model) => model.id !== "hy3");
/** Effort set the international deployment accepts for a model it declares none for. */
const IMPLIED_EFFORTS = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function positiveNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
/** Narrow one `models[]` row; returns undefined for a row with no usable id. */
function parseProductModel(value) {
	const row = asRecord(value);
	if (row === void 0) return void 0;
	const id = typeof row["id"] === "string" ? row["id"].trim() : "";
	if (id === "") return void 0;
	const reasoning = asRecord(row["reasoning"]);
	const rawEfforts = reasoning?.["supportedEfforts"];
	let supportedEfforts;
	if (Array.isArray(rawEfforts)) {
		const efforts = rawEfforts.filter((effort) => typeof effort === "string" && EFFORT_VALUES.includes(effort));
		if (efforts.length > 0) supportedEfforts = efforts;
	}
	const rawDefault = reasoning?.["defaultEffort"] ?? reasoning?.["effort"];
	const defaultEffort = typeof rawDefault === "string" && EFFORT_VALUES.includes(rawDefault) ? rawDefault : void 0;
	const contextWindow = positiveNumber(row["maxInputTokens"]) ?? positiveNumber(row["maxAllowedSize"]) ?? 0;
	const maxTokens = positiveNumber(row["maxOutputTokens"]) ?? 0;
	return {
		id,
		name: typeof row["name"] === "string" && row["name"] !== "" ? row["name"] : id,
		...typeof row["credits"] === "string" && row["credits"].trim() !== "" ? { credits: row["credits"].trim() } : {},
		contextWindow,
		maxTokens,
		supportsImages: row["supportsImages"] === true && row["disabledMultimodal"] !== true,
		supportsReasoning: row["supportsReasoning"] === true,
		onlyReasoning: row["onlyReasoning"] === true,
		...supportedEfforts === void 0 ? {} : { supportedEfforts },
		...defaultEffort === void 0 ? {} : { defaultEffort },
		canDisableThinking: reasoning?.["canDisableThinking"] === true
	};
}
/** Parse a product-configuration document; undefined when it is not usable. */
function parseProductConfig(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	const document = asRecord(parsed);
	if (document === void 0) return void 0;
	const rawModels = document["models"];
	if (!Array.isArray(rawModels)) return void 0;
	const models = rawModels.map(parseProductModel).filter((model) => model !== void 0);
	if (models.length === 0) return void 0;
	return {
		source: "cache",
		...typeof document["applicationName"] === "string" ? { applicationName: document["applicationName"] } : {},
		...typeof document["endpoint"] === "string" ? { endpoint: document["endpoint"] } : {},
		isOversea: document["isOversea"] === true,
		models
	};
}
/** The built-in configuration: only the free rows, with no cache behind them. */
function builtinConfig() {
	return {
		source: "builtin",
		models: BUILTIN_FREE_MODELS.map((model) => ({
			id: model.id,
			name: model.name,
			credits: "x0.00",
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			supportsImages: model.supportsImages,
			supportsReasoning: model.reasoning?.supports === true,
			onlyReasoning: model.reasoning?.onlyReasoning === true,
			...model.reasoning?.supportedEfforts === void 0 ? {} : { supportedEfforts: model.reasoning.supportedEfforts },
			...model.reasoning?.defaultEffort === void 0 ? {} : { defaultEffort: model.reasoning.defaultEffort },
			canDisableThinking: model.reasoning?.canDisableThinking === true
		}))
	};
}
/**
* Load the product configuration, falling back to the built-in table.
*
* A missing or malformed cache is never an error: the plugin must still offer
* its free models on a machine where the app has not run yet.
*/
function loadProductConfig(path = workbuddyAiProductConfigPath()) {
	try {
		const parsed = parseProductConfig(readFileSync(path, "utf8"));
		if (parsed === void 0) return builtinConfig();
		return {
			...parsed,
			path
		};
	} catch {
		return builtinConfig();
	}
}
/** Whether a credits multiplier means free (`x0.00`). Absent is not free. */
function creditsAreFree(credits) {
	if (credits === void 0) return false;
	return /^x?0(?:\.0+)?$/u.test(credits.trim());
}
/**
* The free model ids a configuration declares.
*
* Only an explicit `x0.00` counts. When the cache is absent the built-in
* whitelist applies, so the answer is never "every model" — a mis-read must not
* be able to turn the free-only filter into a no-op.
*/
function freeModelIds(config) {
	if (config.source === "builtin") return FALLBACK_FREE_MODEL_IDS;
	const free = config.models.filter((model) => creditsAreFree(model.credits)).map((model) => model.id);
	return free.length > 0 ? free : FALLBACK_FREE_MODEL_IDS;
}
/** Reasoning metadata from a product-config row, in the catalog's own shape. */
function reasoningFromProduct(model) {
	const declared = model.supportedEfforts;
	const efforts = declared !== void 0 && declared.length > 0 ? declared : IMPLIED_EFFORTS;
	return {
		supports: model.supportsReasoning,
		onlyReasoning: model.onlyReasoning,
		supportedEfforts: efforts,
		...model.defaultEffort === void 0 ? {} : { defaultEffort: model.defaultEffort },
		canDisableThinking: model.canDisableThinking
	};
}
/** Billing metadata for a model the product configuration marks free. */
function billingFromProduct(model) {
	const credits = model.credits ?? "x0.00";
	return {
		credits,
		free: creditsAreFree(credits)
	};
}
/**
* Build a catalog row from a product-configuration model.
*
* Used for models the catalog endpoint omits. A row with no usable capacities is
* refused rather than guessed: an unlisted model with a fabricated context
* window would make the harness compact at the wrong point.
*/
function productModelToCatalogRow(model) {
	if (model.contextWindow <= 0 || model.maxTokens <= 0) return void 0;
	return {
		id: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		supportsImages: model.supportsImages,
		reasoning: reasoningFromProduct(model),
		billing: billingFromProduct(model)
	};
}
/** Look up one product-config row by id. */
function productModelById(config, id) {
	return config.models.find((model) => model.id === id);
}
//#endregion
//#region src/catalog.ts
/**
* Static rows served before the first upstream answer arrives, and whenever the
* upstream is unreachable.
*
* These are the two free models the international deployment does not list in
* its catalog endpoint, plus `hy3` which it does. Serving a usable list from the
* first moment means an offline upstream never leaves the provider empty.
*/
const FALLBACK_WORKBUDDYAI_MODELS = BUILTIN_FREE_MODELS;
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
function composeCatalog(upstream, options) {
	const { productConfig, scope = "free" } = options;
	const free = new Set(freeModelIds(productConfig));
	const byId = /* @__PURE__ */ new Map();
	const source = upstream.length > 0 ? upstream : FALLBACK_WORKBUDDYAI_MODELS;
	for (const model of source) byId.set(model.id, model);
	if (productConfig.source === "cache") for (const id of free) {
		if (byId.has(id)) continue;
		const row = productModelById(productConfig, id);
		if (row === void 0) continue;
		const built = productModelToCatalogRow(row);
		if (built !== void 0) byId.set(built.id, built);
	}
	for (const [id, model] of byId) {
		const row = productModelById(productConfig, id);
		if (row === void 0) continue;
		byId.set(id, {
			...model,
			billing: {
				...model.billing,
				...row.credits === void 0 ? {} : { credits: row.credits },
				free: free.has(id)
			}
		});
	}
	return scope === "all" ? [...byId.values()] : [...byId.values()].filter((model) => free.has(model.id));
}
/**
* The plugin's live catalog.
*
* `scope` is mutable because the settings card can flip between "free only" and
* "all models" without a restart; the adapter rebuilds its snapshot from
* {@link current} on every read, so a change lands on the next request.
*/
var WorkBuddyAiCatalog = class {
	upstream = [];
	scope;
	productConfig;
	constructor(options) {
		this.productConfig = options.productConfig;
		this.scope = options.scope ?? "free";
	}
	/** Replace the upstream rows; the effective list is recomposed immediately. */
	setUpstream(models) {
		this.upstream = [...models];
	}
	/** The upstream rows as last received, before any policy is applied. */
	upstreamModels() {
		return this.upstream;
	}
	/** Switch the billing policy; takes effect on the next {@link current} read. */
	setScope(scope) {
		this.scope = scope;
	}
	/** The active billing policy. */
	currentScope() {
		return this.scope;
	}
	/** The product configuration this catalog prices against. */
	product() {
		return this.productConfig;
	}
	/** The effective entries; the fallback list until the upstream answer lands. */
	current() {
		return composeCatalog(this.upstream, {
			productConfig: this.productConfig,
			scope: this.scope
		});
	}
	/** Every model id the product configuration prices as free. */
	freeIds() {
		return freeModelIds(this.productConfig);
	}
	/**
	* Whether a model is free according to the product configuration.
	*
	* The adapter consults this rather than the row's own `billing.free` so the
	* verdict survives a catalog refresh that momentarily reports a stale rate.
	*/
	isFree(id) {
		return this.freeIds().includes(id);
	}
	/** Display suffix for one row: the rate, then any promotional badges. */
	displaySuffix(id) {
		const model = this.current().find((entry) => entry.id === id);
		if (model === void 0) return void 0;
		const parts = [normalizeCredits(model.billing?.credits), ...model.billing?.badges ?? []].filter((part) => part !== void 0 && part !== "");
		return parts.length === 0 ? void 0 : parts.join(" · ");
	}
};
//#endregion
//#region src/oauth.ts
/**
* Browser OAuth for the official WorkBuddy AI CLI login endpoints.
*
* Starts a CLI login at `/v2/plugin/auth/state`, opens `authUrl`, then polls
* `/v2/plugin/auth/token` until the user finishes in the browser (envelope
* code `11217` means still waiting). The resulting tokens are saved through
* {@link WorkBuddyAiCredentialStore.importCredential} — the desktop auth file
* is never written.
*
* Login `state` stays in process memory so a same-origin card cannot resume a
* poll it did not start.
*
* @module dsh-workbuddyai-connect/oauth
*/
/** Give up if the browser never finishes. */
const LOGIN_TIMEOUT_MS = 9e5;
/**
* Open `url` with the platform browser helper. Failures are non-fatal: the
* caller still returns the URL so the UI can offer a link.
*/
function openAuthUrl(url) {
	try {
		const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
		const args = process.platform === "win32" ? [
			"/c",
			"start",
			"",
			url
		] : [url];
		spawn(command, args, {
			detached: true,
			stdio: "ignore"
		}).unref();
		return true;
	} catch {
		return false;
	}
}
/**
* In-process CLI login. One instance per plugin; overlapping `start()` calls
* replace the previous wait.
*/
var WorkBuddyAiOAuthLogin = class {
	client;
	open;
	waiting;
	constructor(client, open = openAuthUrl) {
		this.client = client;
		this.open = open;
	}
	/** Begin a login and try to open the browser. */
	async start() {
		const nonce = randomBytes(16).toString("hex");
		const started = await this.client.startPluginLogin(nonce);
		this.waiting = {
			state: started.state,
			authUrl: started.authUrl,
			startedAt: Date.now()
		};
		return {
			authUrl: started.authUrl,
			opened: this.open(started.authUrl)
		};
	}
	/**
	* One poll of the login `state`. `pending` means the user has not finished;
	* otherwise the caller must persist {@link WorkBuddyAiOAuthPoll.auth}.
	*/
	async poll() {
		const waiting = this.waiting;
		if (waiting === void 0) throw new Error("workbuddyai: no login in progress");
		if (Date.now() - waiting.startedAt > 9e5) {
			this.waiting = void 0;
			throw new Error("workbuddyai: login timed out");
		}
		const data = await this.client.pollPluginToken(waiting.state);
		if (data === void 0) return { pending: true };
		this.waiting = void 0;
		return { auth: credentialFromPluginToken(data) };
	}
	/** Drop an in-flight login without touching stored credentials. */
	cancel() {
		this.waiting = void 0;
	}
};
//#endregion
//#region src/version.ts
const WORKBUDDYAI_CONNECT_VERSION = "0.1.0";
//#endregion
//#region src/host-heartbeat.ts
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
const WORKBUDDYAI_HOST_HEARTBEAT_FILENAME = ".workbuddyai-host-heartbeat.json";
/** Package name stamped into the heartbeat, so readers can tell the two plugins apart. */
const HEARTBEAT_PACKAGE = "dsh-workbuddyai-connect";
/** Current on-disk heartbeat format; readers reject others. */
const HEARTBEAT_FORMAT_VERSION = 1;
/** Absolute path of the host heartbeat file. */
function workbuddyAiHostHeartbeatPath() {
	return join(resolveDshHome(), WORKBUDDYAI_HOST_HEARTBEAT_FILENAME);
}
/**
* Write (or overwrite) the heartbeat after the host bundle registered the
* provider. A failed write is non-fatal: the host is already running, and the
* status CLI will simply report "heartbeat missing" rather than failing.
*/
async function writeHostHeartbeat() {
	const document = {
		version: HEARTBEAT_FORMAT_VERSION,
		package: HEARTBEAT_PACKAGE,
		pluginVersion: WORKBUDDYAI_CONNECT_VERSION,
		registeredAt: Date.now(),
		pid: process.pid
	};
	try {
		await writeFile(workbuddyAiHostHeartbeatPath(), JSON.stringify(document), "utf8");
	} catch {}
}
/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
async function clearHostHeartbeat() {
	try {
		await rm(workbuddyAiHostHeartbeatPath(), { force: true });
	} catch {}
}
/** Read and validate the heartbeat; returns `undefined` when absent or malformed. */
async function readHostHeartbeat() {
	let raw;
	try {
		raw = await readFile(workbuddyAiHostHeartbeatPath(), "utf8");
	} catch {
		return;
	}
	try {
		const parsed = JSON.parse(raw);
		if (parsed.version === HEARTBEAT_FORMAT_VERSION && parsed.package === HEARTBEAT_PACKAGE && typeof parsed.registeredAt === "number" && typeof parsed.pid === "number") return {
			version: HEARTBEAT_FORMAT_VERSION,
			package: HEARTBEAT_PACKAGE,
			pluginVersion: typeof parsed.pluginVersion === "string" ? parsed.pluginVersion : "unknown",
			registeredAt: parsed.registeredAt,
			pid: parsed.pid
		};
	} catch {}
}
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
function processStartTimeMs(pid) {
	try {
		if (process.platform === "win32") {
			const m = execFileSync("wmic", [
				"process",
				"where",
				`processid=${pid}`,
				"get",
				"CreationDate"
			], {
				encoding: "utf8",
				windowsHide: true
			}).match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d+([+-]\d{4})/);
			if (m === null) return void 0;
			const [, y, mo, d, h, mi, s] = m;
			const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
			return Number.isFinite(ms) ? ms : void 0;
		}
		const out = execFileSync("ps", [
			"-o",
			"lstart=",
			"-p",
			String(pid)
		], {
			encoding: "utf8",
			env: {
				...process.env,
				LC_ALL: "C",
				LANG: "C"
			}
		}).trim();
		if (out === "") return void 0;
		const ms = Date.parse(out);
		return Number.isFinite(ms) ? ms : void 0;
	} catch {
		return;
	}
}
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
function isHeartbeatProcessAlive(heartbeat) {
	try {
		process.kill(heartbeat.pid, 0);
	} catch {
		return false;
	}
	const startAtMs = processStartTimeMs(heartbeat.pid);
	if (startAtMs === void 0) return true;
	return startAtMs <= heartbeat.registeredAt;
}
//#endregion
export { WORKBUDDYAI_AUTH_FILENAME as A, isFreeCredits as C, PROBE_EFFORT_CANDIDATES as D, regionOf as E, defaultDesktopAuthCandidates as F, defaultDesktopAuthPath as I, parseWorkBuddyAiAuth as L, WORKBUDDYAI_DESKTOP_AUTH_BASENAME as M, WorkBuddyAiCredentialStore as N, probeModel as O, credentialFromPluginToken as P, workbuddyAiOwnAuthPath as R, classifyUpstreamError as S, prepareChatBody as T, freeModelIds as _, readHostHeartbeat as a, workbuddyAiProductConfigPath as b, WORKBUDDYAI_CONNECT_VERSION as c, FALLBACK_WORKBUDDYAI_MODELS as d, WorkBuddyAiCatalog as f, FALLBACK_FREE_MODEL_IDS as g, FALLBACK_EXTRA_MODELS as h, processStartTimeMs as i, WORKBUDDYAI_AUTH_FILE_ENV as j, randomSentinel as k, LOGIN_TIMEOUT_MS as l, BUILTIN_FREE_MODELS as m, clearHostHeartbeat as n, workbuddyAiHostHeartbeatPath as o, composeCatalog as p, isHeartbeatProcessAlive as r, writeHostHeartbeat as s, WORKBUDDYAI_HOST_HEARTBEAT_FILENAME as t, WorkBuddyAiOAuthLogin as u, loadProductConfig as v, normalizeCredits as w, WorkBuddyAiUpstreamClient as x, parseProductConfig as y };
