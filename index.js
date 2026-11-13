/**
 * @local/auto-continue — auto-continue interrupted sessions by switching models.
 *
 * Hooks the agent loop's `agent/request-error` waterfall. When a request fails
 * with a switchable failure (quota exhausted, rate limit, reset windows,
 * credential problems, context overflow, ...), the plugin:
 *
 *   1. enumerates fallback candidates (explicit chain first, then every
 *      provider/model route advertised by the llm registry),
 *   2. probes each candidate with a tiny real request (configurable) and keeps
 *      a cooldown map so recently-failed routes are not retried blindly,
 *   3. durably switches the session via `agent.model.select()` (a
 *      `model/selection` session event — the same mechanism as the UI), which
 *      makes the next step render an automatic "[model changed: ...]" notice,
 *   4. aborts the dead turn with a hook cause (keeping any queued input) and
 *      queues a continuation message into the next-turn inbox; the loop's wake
 *      latch restarts the driver, the next turn claims the continuation and
 *      runs on the new model.
 *
 * Short same-model backoff retries remain the job of the bundled
 * dsh-llm-retry plugin: it registers its `agent/request-error` listener before
 * this bundle, retries transient codes with backoff, and only defers
 * (`next()`) to this plugin once its budget is exhausted or the code is not
 * retryable. Switching via select() + inbox is the only way to change models,
 * because a request waterfall cannot mutate the fixed step selection.
 *
 * Host packages are loaded defensively: bare imports first (they resolve when
 * the bundle ships its own node_modules), then absolute file URLs into the
 * Electron host tree (asar-patched fs serves the archive), and a plain-object
 * degradation if both fail, so the plugin never blocks activation.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const name = "auto-continue";

const inject = ["llm"];

/** Fallback values used when no Config schema row exists. */
const DEFAULTS = {
	enabled: true,
	continuationText: "继续",
	fallbackChain: [],
	ignoreCodes: ["ABORTED", "IMAGE_OFFLOAD_REQUIRED"],
	// 0 means "no cap": try every candidate model. A single turn's pool is
	// finite (all registered routes), so unbounded per-turn is still safe.
	maxSwitchesPerTurn: 0,
	probe: true,
	probeTimeoutMs: 20000,
	probeMaxTokens: 16,
	maxProbeCandidates: 0,
	switchAfterMs: 120000,
	cooldownQuotaMs: 1800000,
	cooldownRateLimitMs: 300000,
	cooldownAuthMs: 21600000,
	cooldownTransientMs: 120000,
	healthyTtlMs: 600000,
	resumeOnErrorIdle: true,
	// 0 = unlimited idle resumes, but a hard ceiling still bounds the loop so a
	// permanently-dead model can never spin forever (see IDLE_RESUME_HARD_CAP).
	maxIdleResumes: 0,
	cooldownModelFaultMs: 1800000,
	preferLargeContext: true,
	minContextWindow: 0
};

/** Candidate host node_modules roots (Electron app tree, newest first). */
function hostModuleRoots() {
	const roots = [];
	try {
		if (process.resourcesPath) roots.push(path.join(process.resourcesPath, "app.asar", "dsh", "node_modules"));
	} catch {}
	try {
		roots.push(path.join(path.dirname(process.execPath), "resources", "app.asar", "dsh", "node_modules"));
	} catch {}
	return roots;
}

/** Import one host package: bare specifier first, then absolute asar URLs. */
async function importHost(name) {
	try {
		return await import(name);
	} catch {}
	for (const root of hostModuleRoots()) {
		const segments = name.split("/");
		const manifestPath = path.join(root, ...segments, "package.json");
		let entry;
		try {
			const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
			const main = manifest.exports?.["."]?.default ?? manifest.main ?? "lib/index.js";
			entry = path.join(root, ...segments, main);
		} catch {
			entry = path.join(root, ...segments, "lib", "index.js");
		}
		try {
			return await import(pathToFileURL(entry).href);
		} catch {}
	}
	return undefined;
}

let z;
let createUserMessage;
try {
	({ createUserMessage } = (await importHost("@deepseek-ai/dsh-llm")) ?? {});
	z = (await importHost("@deepseek-ai/schemastery"))?.default;
} catch {}

/**
 * Host dsh-session, loaded defensively. Its appendPluginRecord() commits a
 * plugin record: an event envelope with ignorable:true whose type follows the
 * "plugin:" grammar. Plain session.append() would write a type outside the
 * harness vocabulary WITHOUT that marker, and the persistence read path then
 * refuses the whole session log at load time (SessionFormatError).
 */
let dshSession;
try {
	dshSession = (await importHost("@deepseek-ai/dsh-session")) ?? {};
} catch {}

/** Hand-rolled last-resort user message when dsh-llm is unavailable. */
let handRolledCounter = 0;
function anyUserMessage(text) {
	if (createUserMessage) return createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text }] });
	handRolledCounter += 1;
	return {
		id: `auto-continue-${Date.now().toString(36)}-${handRolledCounter}`,
		role: "user",
		source: { kind: "user" },
		content: [{ type: "text", text }]
	};
}

/** Config schema when schemastery is reachable; the plugin merges DEFAULTS regardless. */
let Config;
if (z) {
	Config = z.object({
		enabled: z.boolean().default(DEFAULTS.enabled).description("总开关：关闭后不介入任何失败"),
		continuationText: z.string().default(DEFAULTS.continuationText).description("切换模型后自动补发的续接消息文本"),
		fallbackChain: z.array(z.string()).default(DEFAULTS.fallbackChain).description("优先尝试的备选模型（provider/model），按顺序优先；留空则自动枚举全部已注册模型"),
		ignoreCodes: z.array(z.string()).default(DEFAULTS.ignoreCodes).description("出现这些错误码时不切换（把错误原样抛出）"),
		maxSwitchesPerTurn: z.number().default(DEFAULTS.maxSwitchesPerTurn).description("同一回合内最多自动切换次数，防止循环切换"),
		probe: z.boolean().default(DEFAULTS.probe).description("切换前发送极小真实请求验证候选模型可用"),
		probeTimeoutMs: z.number().default(DEFAULTS.probeTimeoutMs).description("单个探测请求的超时（毫秒）"),
		probeMaxTokens: z.number().default(DEFAULTS.probeMaxTokens).description("探测请求的最大输出 token"),
		maxProbeCandidates: z.number().default(DEFAULTS.maxProbeCandidates).description("单次故障最多探测的候选数量"),
		switchAfterMs: z.number().default(DEFAULTS.switchAfterMs).description("限流提示等待超过该毫秒数时不再等待、直接切换"),
		cooldownQuotaMs: z.number().default(DEFAULTS.cooldownQuotaMs).description("配额耗尽路由的冷却时间（毫秒）"),
		cooldownRateLimitMs: z.number().default(DEFAULTS.cooldownRateLimitMs).description("限流路由的冷却时间（毫秒）"),
		cooldownAuthMs: z.number().default(DEFAULTS.cooldownAuthMs).description("鉴权/凭证错误路由的冷却时间（毫秒）"),
		cooldownTransientMs: z.number().default(DEFAULTS.cooldownTransientMs).description("其他临时错误路由的冷却时间（毫秒）"),
		healthyTtlMs: z.number().default(DEFAULTS.healthyTtlMs).description("探测成功结果的缓存时长（毫秒）"),
		resumeOnErrorIdle: z.boolean().default(DEFAULTS.resumeOnErrorIdle).description("回合以错误收尾且没有排定续接时，空闲后自动兜底续接（覆盖 request-error 之外的失败）"),
		maxIdleResumes: z.number().default(DEFAULTS.maxIdleResumes).description("每个会话在每个宿主生命周期内兜底续接的最大次数"),
		cooldownModelFaultMs: z.number().default(DEFAULTS.cooldownModelFaultMs).description("模型级持续故障（PI_AI_ERROR/MODEL_SWITCH_COMPACTION_FAILED 等）的冷却时间（毫秒）"),
		preferLargeContext: z.boolean().default(DEFAULTS.preferLargeContext).description("切换时优先选择上下文窗口足够大的模型，避免切过去触发历史压缩（压缩摘要仍用旧模型，旧模型限流时会失败）"),
		minContextWindow: z.number().default(DEFAULTS.minContextWindow).description("候选模型的最小上下文窗口（token，0=不限制）；低于此值的模型不作为切换目标"),
	});
}

const QUOTA_CODES = new Set(["QUOTA", "ACCOUNT_QUOTA", "QUOTA_EXCEEDED", "QUOTA_EXHAUSTED"]);
/** Model-level persistent faults: the route stays broken across turns, so a long cooldown applies. */
const MODEL_FAULT_CODES = new Set(["PI_AI_ERROR"]);
/** Switch/compaction failures are transitions, not broken routes: short cooldown only, and always eligible for large-window selection. */
const SWITCH_TRANSITION_CODES = new Set(["MODEL_SWITCH_COMPACTION_FAILED"]);
const AUTH_CODES = new Set(["AUTH", "INVALID_CREDENTIAL", "MISSING_CREDENTIAL"]);

/**
 * Coerce every config field to the shape the runtime expects. A hand-edited
 * profile YAML, a partially written config, or a value from an older schema
 * can otherwise crash a request-error waterfall (e.g. `null.includes` or
 * `for...of 42`). Unknown keys are preserved; invalid known keys fall back to
 * DEFAULTS so the plugin degrades instead of taking the session down.
 */
function normalizeConfig(raw) {
	const out = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
	const bool = (key) => { if (typeof out[key] !== "boolean") out[key] = DEFAULTS[key]; };
	const num = (key) => { if (!Number.isFinite(out[key])) out[key] = DEFAULTS[key]; };
	const str = (key) => { if (typeof out[key] !== "string") out[key] = DEFAULTS[key]; };
	const strArray = (key) => {
		if (!Array.isArray(out[key]) || out[key].some((x) => typeof x !== "string")) out[key] = DEFAULTS[key];
	};
	for (const k of ["enabled", "probe", "resumeOnErrorIdle", "preferLargeContext"]) bool(k);
	for (const k of ["maxSwitchesPerTurn", "probeTimeoutMs", "probeMaxTokens", "maxProbeCandidates",
		"switchAfterMs", "cooldownQuotaMs", "cooldownRateLimitMs", "cooldownAuthMs",
		"cooldownTransientMs", "healthyTtlMs", "maxIdleResumes", "cooldownModelFaultMs",
		"minContextWindow"]) num(k);
	for (const k of ["continuationText"]) str(k);
	for (const k of ["fallbackChain", "ignoreCodes"]) strArray(k);
	return out;
}

export async function apply(ctx, rawConfig) {
	const config = normalizeConfig(rawConfig);
	const lifetime = new AbortController();
	/** route key -> { until, code } — recently failed routes are skipped as fallbacks. */
	const cooldown = new Map();
	/** route key -> { until } — recently probed-healthy routes are preferred. */
	const healthy = new Map();
	/** agent id -> Map<turn, count> — bounds switching within one turn. */
	const switches = new Map();
	/** agent id -> { code, message, at, attempts } — error-ended turns awaiting an idle resume. */
	const pendingResume = new Map();
	/** agent id -> idle-resume attempts consumed this host lifetime. */
	const idleResumes = new Map();

	const SWITCH_RECORD_TYPE = "plugin:auto-continue/switch";
	/** Record a model switch via the plugin-record path; never via plain append(). */
	function recordSwitch(agent, record) {
		try {
			if (typeof dshSession?.appendPluginRecord === "function") {
				dshSession.appendPluginRecord(agent.session, SWITCH_RECORD_TYPE, record);
				return;
			}
			if (agent.session && typeof agent.session.appendPluginRecord === "function") {
				agent.session.appendPluginRecord(SWITCH_RECORD_TYPE, record);
				return;
			}
		} catch (error) {
			ctx.logger.warn(`auto-continue: switch record failed; skipped (${error instanceof Error ? error.message : String(error)})`);
			return;
		}
		ctx.logger.warn("auto-continue: appendPluginRecord unavailable in this host; switch record skipped");
	}

	const routeKey = (provider, model) => `${provider}/${model}`;

	/**
	 * Even when `maxIdleResumes` is 0 (unlimited), the idle-resume loop iterates
	 * the finite candidate pool, so it cannot spin forever. This hard ceiling is
	 * a belt-and-suspenders guard against a permanently-dead model eating CPU.
	 */
	const IDLE_RESUME_HARD_CAP = 20;


	function cooldownMsFor(code, providerRetryAfterMs) {
		if (SWITCH_TRANSITION_CODES.has(code)) return Math.min(config.cooldownTransientMs, 60000);
		if (MODEL_FAULT_CODES.has(code)) return config.cooldownModelFaultMs;
		if (QUOTA_CODES.has(code)) return config.cooldownQuotaMs;
		if (AUTH_CODES.has(code)) return config.cooldownAuthMs;
		if (code === "RATE_LIMIT") {
			const hinted = Number.isFinite(providerRetryAfterMs) && providerRetryAfterMs > 0 ? providerRetryAfterMs : 0;
			return Math.max(config.cooldownRateLimitMs, hinted + 30000);
		}
		return config.cooldownTransientMs;
	}

	function markRoute(provider, model, code, providerRetryAfterMs) {
		cooldown.set(routeKey(provider, model), {
			until: Date.now() + cooldownMsFor(code, providerRetryAfterMs),
			code
		});
	}

	function isCooling(provider, model, now = Date.now()) {
		const entry = cooldown.get(routeKey(provider, model));
		return entry !== undefined && entry.until > now;
	}

	/** Enumerate fallback candidates: explicit chain first, then the full registry. */
	async function listCandidates(excludeProvider, excludeModel, failureCode, currentWindow) {
		const ordered = [];
		const seen = new Set();
		const push = (provider, model, contextWindow) => {
			const key = routeKey(provider, model);
			if (seen.has(key)) return;
			seen.add(key);
			ordered.push({ provider, model, contextWindow });
		};
		for (const raw of config.fallbackChain ?? []) {
			const cut = raw.indexOf("/");
			const model = cut > 0 ? raw.slice(cut + 1) : "";
			if (cut <= 0 || model === "") continue; // skip "garbage", "/leading", "trailing/"
			push(raw.slice(0, cut), model);
		}
		try {
			for (const provider of ctx.llm.listProviders()) {
				let models = [];
				try {
					models = await ctx.llm.listModels(provider.id);
				} catch {
					continue;
				}
				for (const model of models) push(provider.id, model.id, model.contextWindow);
			}
		} catch {
			// registry unavailable; the explicit chain still applies
		}
		let list = ordered.filter((candidate) => !(candidate.provider === excludeProvider && candidate.model === excludeModel));
		const minWindow = Math.max(0, Number(config.minContextWindow) || 0);
		if (minWindow > 0) {
			list = list.filter((candidate) => (candidate.contextWindow ?? 0) >= minWindow);
		}
		// A model switch may trigger context compaction, whose summary uses the
		// PREVIOUS routed model. If the previous model is the one that is failing,
		// compaction fails and the harness refuses the switch with
		// MODEL_SWITCH_COMPACTION_FAILED, so prefer a destination whose window is
		// at least as large as the current one (no compaction needed at all).
		const wantLarge = config.preferLargeContext === true || failureCode === "CONTEXT_WINDOW_EXCEEDED" || MODEL_FAULT_CODES.has(failureCode) || SWITCH_TRANSITION_CODES.has(failureCode);
		if (wantLarge && Number.isFinite(currentWindow) && currentWindow > 0) {
			// Destinations smaller than the current window force compaction, whose
			// summary uses the failing previous model — a guaranteed dead end.
			const largeEnough = list.filter((c) => (c.contextWindow ?? 0) >= currentWindow);
			// Never empty the pool: if no candidate is large enough, keep the
			// sorted full list so the session can still move forward.
			list = largeEnough.length > 0 ? largeEnough : list;
			// Explicit fallbackChain keeps its order (user's priority wins); only
			// registry-derived candidates are sorted by descending window.
			const pinned = new Set((config.fallbackChain ?? []).map((raw) => {
				const cut = raw.indexOf("/");
				return cut > 0 ? routeKey(raw.slice(0, cut), raw.slice(cut + 1)) : null;
			}).filter(Boolean));
			const sortable = list.filter((c) => !pinned.has(routeKey(c.provider, c.model)));
			const fixed = list.filter((c) => pinned.has(routeKey(c.provider, c.model)));
			sortable.sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));
			list = [...fixed, ...sortable];
		}
		return list;
	}

	/** Look up a model's context window from the live registry (best effort). */
	async function currentModelWindow(provider, model) {
		if (!provider || !model) return undefined;
		try {
			const models = await ctx.llm.listModels(provider);
			return models.find((m) => m.id === model)?.contextWindow;
		} catch {
			return undefined;
		}
	}

	/** One tiny real request to verify a candidate actually works right now. */
	async function probeRoute(candidate, signal) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(new Error("auto-continue: probe timeout")), config.probeTimeoutMs);
		const fused = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
		try {
			const stream = ctx.llm.stream({
				provider: candidate.provider,
				model: candidate.model,
				messages: [anyUserMessage("ping")],
				maxTokens: config.probeMaxTokens,
				signal: fused
			});
			for await (const chunk of stream) {
				if (chunk.type !== "finish") continue;
				const reason = chunk.reason;
				if (reason === undefined || reason.kind === "stop") return { ok: true };
				return {
					ok: false,
					code: reason.failure?.code ?? "UNKNOWN",
					providerRetryAfterMs: reason.failure?.providerRetryAfterMs
				};
			}
			return { ok: true };
		} catch {
			return { ok: false, code: "PROBE_TRANSPORT" };
		} finally {
			clearTimeout(timer);
		}
	}

	async function recover({ agent, turn, step, provider, failure, signal }, next) {
		if (lifetime.signal.aborted || config.enabled === false) return next();
		if (signal?.aborted) return next();
		const code = failure?.code;
		if (typeof code !== "string" || config.ignoreCodes.includes(code)) return next();

		const current = agent.model.current();
		const failedProvider = provider ?? current?.provider;
		const failedModel = current?.model;
		if (!failedProvider || !failedModel) return next();
		if (typeof agent.model.select !== "function" || typeof agent.followup !== "function" || typeof agent.cancel !== "function") {
			ctx.logger.warn(`auto-continue: agent "${agent.id}" lacks the select/cancel/followup surface; skipping`);
			return next();
		}

		const turns = switches.get(agent.id) ?? new Map();
		switches.set(agent.id, turns);
		const used = turns.get(turn) ?? 0;
		if (config.maxSwitchesPerTurn > 0 && used >= config.maxSwitchesPerTurn) {
			ctx.logger.warn(`auto-continue: session "${agent.id}" turn ${turn} already switched ${used} times; surfacing the error`);
			return next();
		}

		// Remember the failing route before anything else, so it is not picked as its own fallback.
		markRoute(failedProvider, failedModel, code, failure.providerRetryAfterMs);

		const currentWindow = await currentModelWindow(failedProvider, failedModel);
		const pool = (await listCandidates(failedProvider, failedModel, code, currentWindow)).filter((candidate) => !isCooling(candidate.provider, candidate.model));
		let chosen;
		let probed = 0;
		for (const candidate of pool) {
			if (config.maxProbeCandidates > 0 && probed >= config.maxProbeCandidates) break;
			if (signal?.aborted || lifetime.signal.aborted) return next();
			probed += 1;
			const cached = healthy.get(routeKey(candidate.provider, candidate.model));
			if (cached !== undefined && cached.until > Date.now()) {
				chosen = candidate;
				break;
			}
			if (config.probe === false) {
				chosen = candidate;
				break;
			}
			const verdict = await probeRoute(candidate, signal);
			if (signal?.aborted || lifetime.signal.aborted) return next();
			if (verdict.ok) {
				healthy.set(routeKey(candidate.provider, candidate.model), { until: Date.now() + config.healthyTtlMs });
				chosen = candidate;
				break;
			}
			markRoute(candidate.provider, candidate.model, verdict.code, verdict.providerRetryAfterMs);
			ctx.logger.warn(`auto-continue: probe "${routeKey(candidate.provider, candidate.model)}" failed (${verdict.code}); trying next candidate`);
		}
		if (!chosen) {
			ctx.logger.warn(`auto-continue: no usable fallback for "${failedProvider}/${failedModel}" (${code}); surfacing the error`);
			if (config.resumeOnErrorIdle) {
				const prior = pendingResume.get(agent.id);
				pendingResume.set(agent.id, { code, message: failure.message, at: Date.now(), attempts: prior?.attempts ?? 0 });
			}
			return next();
		}

		// 1. Durable model switch — the next step picks it up and the loop renders
		//    its own "[model changed: ...]" notice.
		agent.model.select({ provider: chosen.provider, model: chosen.model });
		// 2. Durable observability record — plugin-record path only (ignorable:true).
		recordSwitch(agent, {
			turn,
			step,
			from: { provider: failedProvider, model: failedModel },
			to: { provider: chosen.provider, model: chosen.model },
			failure: { code, message: failure.message }
		});
		// 3. Abort the dead turn with a hook cause while preserving queued input;
		//    the abort makes the loop latch the next wake.
		agent.cancel({ kind: "hook", reason: `auto-continue: switched to ${chosen.provider}/${chosen.model}` }, { keepInbox: true });
		// 4. Queue the continuation message; the latched wake restarts the driver
		//    and the new turn claims it on the new model.
		agent.followup(anyUserMessage(config.continuationText));
		pendingResume.delete(agent.id);
		turns.set(turn, used + 1);
		ctx.logger.info(`auto-continue: "${failedProvider}/${failedModel}" failed (${code}); switched to "${chosen.provider}/${chosen.model}" and queued continuation for turn ${turn}`);
		return next();
	}

	/**
	 * Idle-resume a turn that ended in error without a queued continuation:
	 * driver-level failures and exhausted-fallback request errors both land
	 * here. LLM-side faults first probe-and-switch; driver faults only
	 * continue (the model itself was never the problem).
	 */
	async function resumeIdle(agent, pending) {
		// Hard cap, checked here (not only in the status listener) so a re-armed
		// pending record from a later agent/error cannot bypass the budget.
		const used = idleResumes.get(agent.id) ?? 0;
		// Soft budget: 0 = unlimited. Hard ceiling: never spin forever on a dead model.
		const cap = config.maxIdleResumes > 0 ? config.maxIdleResumes : IDLE_RESUME_HARD_CAP;
		if (used >= cap) {
			ctx.logger.warn(`auto-continue: session "${agent.id}" idle-resumed ${used} times this lifetime (cap ${cap}); giving up`);
			pendingResume.delete(agent.id);
			return;
		}
		if (typeof agent.model?.select !== "function" || typeof agent.followup !== "function") {
			pendingResume.delete(agent.id);
			return;
		}
		if (pending.code === "DRIVER_ERROR") {
			agent.followup(anyUserMessage(config.continuationText));
			idleResumes.set(agent.id, used + 1);
			ctx.logger.info(`auto-continue: idle resume after driver error (${pending.message}); queued continuation`);
			pendingResume.delete(agent.id);
			return;
		}
		const current = agent.model.current();
		// Idle resume probes ignore cooldowns: it is a low-frequency retry window,
		// and cooldown-blocked candidates would leave the session stranded forever.
		const currentWindow = await currentModelWindow(current?.provider, current?.model);
		const pool = await listCandidates(current?.provider, current?.model, pending.code, currentWindow);
		for (const candidate of pool) {
			if (lifetime.signal.aborted) { pendingResume.delete(agent.id); return; }
			const verdict = await probeRoute(candidate, undefined);
			if (lifetime.signal.aborted) { pendingResume.delete(agent.id); return; }
			if (verdict.ok) {
				healthy.set(routeKey(candidate.provider, candidate.model), { until: Date.now() + config.healthyTtlMs });
				if (current?.provider && current?.model) {
					agent.model.select({ provider: candidate.provider, model: candidate.model });
					recordSwitch(agent, { source: "idle-resume", from: { provider: current.provider, model: current.model }, to: { provider: candidate.provider, model: candidate.model }, failure: { code: pending.code, message: pending.message } });
				}
				agent.followup(anyUserMessage(config.continuationText));
				idleResumes.set(agent.id, used + 1);
				ctx.logger.info(`auto-continue: idle resume switched to "${candidate.provider}/${candidate.model}" (was ${pending.code})`);
				pendingResume.delete(agent.id);
				return;
			}
			// MODEL_SWITCH_COMPACTION_FAILED is a destination-window problem, not
			// a broken route: do not blacklist the model for the long fault window.
			if (verdict.code !== "MODEL_SWITCH_COMPACTION_FAILED") {
				markRoute(candidate.provider, candidate.model, verdict.code, verdict.providerRetryAfterMs);
			}
			ctx.logger.warn(`auto-continue: idle-resume probe "${routeKey(candidate.provider, candidate.model)}" failed (${verdict.code}); trying next candidate`);
		}
		// No healthy destination right now. Still queue ONE continuation so the
		// loop retries on the current model (which may have recovered by then)
		// instead of freezing the session. maxIdleResumes bounds this loop.
		idleResumes.set(agent.id, used + 1);
		agent.followup(anyUserMessage(config.continuationText));
		ctx.logger.warn(`auto-continue: idle resume found no healthy model (${pending.code}); queued continuation on current model (attempt ${used + 1})`);
		pendingResume.delete(agent.id);
	}

	const disposeRequestError = ctx.on("agent/request-error", (payload, next) => recover(payload, next));
	// A normally-ending turn (completed / user stop / queued followup) cancels any pending resume.
	const disposeTurnStopping = ctx.on("agent/turn-stopping", (payload, next) => {
		const agentId = payload?.agent?.id;
		if (agentId) pendingResume.delete(agentId);
		return typeof next === "function" ? next() : undefined;
	});
	const GLOBAL = { global: true };
	// Driver-level failures (tool explosions, loop crashes) also deserve a resume.
	// IMPORTANT: keep the real failure code when the error is an LLM-side fault
	// (rate limit, quota, auth, ...). The request-error waterfall already records
	// such failures; agent/error is the turn-end echo of the same error. Labelling
	// it DRIVER_ERROR would make idle-resume only re-send "继续" on the SAME dead
	// model, spinning for several turns instead of probing and switching.
	const disposeAgentError = ctx.on("agent/error", (payload, next) => {
		const agent = payload?.agent;
		const error = payload?.error;
		if (!agent || config.resumeOnErrorIdle === false) return typeof next === "function" ? next() : undefined;
		if (/abort/i.test(String(error?.name ?? ""))) return typeof next === "function" ? next() : undefined;
		const code = typeof error?.code === "string" && error.code.length > 0
			? error.code
			: (typeof error?.failure?.code === "string" ? error.failure.code : "DRIVER_ERROR");
		const prior = pendingResume.get(agent.id);
		// A switchable LLM fault must not override a pending record that already
		// knows the failing route; first writer wins for this error tail.
		if (!prior || prior.at < Date.now() - 30000) {
			pendingResume.set(agent.id, { code, message: String(error?.message ?? error).slice(0, 200), at: Date.now(), attempts: prior?.attempts ?? 0 });
		}
		return typeof next === "function" ? next() : undefined;
	}, GLOBAL);
	// When the agent goes idle with an unresolved error tail, resume it once.
	const disposeStatus = ctx.on("agent/status", (payload, next) => {
		const agent = payload?.agent;
		if (!agent || payload.status !== "idle" || config.resumeOnErrorIdle === false) return typeof next === "function" ? next() : undefined;
		const pending = pendingResume.get(agent.id);
		if (!pending) return typeof next === "function" ? next() : undefined;
		const used = idleResumes.get(agent.id) ?? 0;
		const cap = config.maxIdleResumes > 0 ? config.maxIdleResumes : IDLE_RESUME_HARD_CAP;
		if (used >= cap) {
			ctx.logger.warn(`auto-continue: session "${agent.id}" idle-resumed ${used} times this lifetime (cap ${cap}); giving up`);
			pendingResume.delete(agent.id);
			return typeof next === "function" ? next() : undefined;
		}
		pendingResume.delete(agent.id);
		void resumeIdle(agent, pending).catch((error) => {
			ctx.logger.warn(`auto-continue: idle resume failed: ${error instanceof Error ? error.message : String(error)}`);
		});
		return typeof next === "function" ? next() : undefined;
	}, GLOBAL);
	const disposeDisposed = ctx.on("agent/disposed", ({ agent }) => {
		switches.delete(agent.id);
		pendingResume.delete(agent.id);
		idleResumes.delete(agent.id);
	}, GLOBAL);
	ctx.effect(() => async () => {
		disposeRequestError();
		disposeTurnStopping();
		disposeAgentError();
		disposeStatus();
		disposeDisposed();
		lifetime.abort(new Error("auto-continue plugin disposed"));
	}, "auto-continue: dispose listeners");
}

export { Config, inject, name };
