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
	maxSwitchesPerTurn: 3,
	probe: true,
	probeTimeoutMs: 20000,
	probeMaxTokens: 16,
	maxProbeCandidates: 6,
	switchAfterMs: 120000,
	cooldownQuotaMs: 1800000,
	cooldownRateLimitMs: 300000,
	cooldownAuthMs: 21600000,
	cooldownTransientMs: 120000,
	healthyTtlMs: 600000
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
		healthyTtlMs: z.number().default(DEFAULTS.healthyTtlMs).description("探测成功结果的缓存时长（毫秒）")
	});
}

const QUOTA_CODES = new Set(["QUOTA", "ACCOUNT_QUOTA"]);
const AUTH_CODES = new Set(["AUTH", "INVALID_CREDENTIAL", "MISSING_CREDENTIAL"]);

export async function apply(ctx, rawConfig) {
	const config = { ...DEFAULTS, ...(rawConfig ?? {}) };
	const lifetime = new AbortController();
	/** route key -> { until, code } — recently failed routes are skipped as fallbacks. */
	const cooldown = new Map();
	/** route key -> { until } — recently probed-healthy routes are preferred. */
	const healthy = new Map();
	/** agent id -> Map<turn, count> — bounds switching within one turn. */
	const switches = new Map();

	const routeKey = (provider, model) => `${provider}/${model}`;

	function cooldownMsFor(code, providerRetryAfterMs) {
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
	async function listCandidates(excludeProvider, excludeModel, failureCode) {
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
			if (cut <= 0) continue;
			push(raw.slice(0, cut), raw.slice(cut + 1));
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
		if (failureCode === "CONTEXT_WINDOW_EXCEEDED") {
			list = [...list].sort((a, b) => (b.contextWindow ?? 0) - (a.contextWindow ?? 0));
		}
		return list;
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
		if (used >= config.maxSwitchesPerTurn) {
			ctx.logger.warn(`auto-continue: session "${agent.id}" turn ${turn} already switched ${used} times; surfacing the error`);
			return next();
		}

		// Remember the failing route before anything else, so it is not picked as its own fallback.
		markRoute(failedProvider, failedModel, code, failure.providerRetryAfterMs);

		const pool = (await listCandidates(failedProvider, failedModel, code)).filter((candidate) => !isCooling(candidate.provider, candidate.model));
		let chosen;
		let probed = 0;
		for (const candidate of pool) {
			if (probed >= config.maxProbeCandidates) break;
			if (signal.aborted || lifetime.signal.aborted) return next();
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
			if (signal.aborted || lifetime.signal.aborted) return next();
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
			return next();
		}

		// 1. Durable model switch — the next step picks it up and the loop renders
		//    its own "[model changed: ...]" notice.
		agent.model.select({ provider: chosen.provider, model: chosen.model });
		// 2. Durable observability record.
		agent.session.append("auto-continue/switch", {
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
		turns.set(turn, used + 1);
		ctx.logger.info(`auto-continue: "${failedProvider}/${failedModel}" failed (${code}); switched to "${chosen.provider}/${chosen.model}" and queued continuation for turn ${turn}`);
		return next();
	}

	const disposeRequestError = ctx.on("agent/request-error", (payload, next) => recover(payload, next));
	const disposeDisposed = ctx.on("agent/disposed", ({ agent }) => {
		switches.delete(agent.id);
	});
	ctx.effect(() => async () => {
		disposeRequestError();
		disposeDisposed();
		lifetime.abort(new Error("auto-continue plugin disposed"));
	}, "auto-continue: dispose listeners");
}

export { Config, inject, name };
