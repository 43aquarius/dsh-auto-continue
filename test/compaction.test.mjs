/**
 * Compaction-deadlock suite (the real path: idle resume).
 *
 * Observed in session-fa1d0bdb: every switch was INSIDE the configured chain
 * ("switches outside chain: 0"), yet the session bounced A <-> B every ~30 s.
 * Those switches had `turn: undefined` — they came from the idle-resume path,
 * which deliberately ignores cooldowns ("a low-frequency retry window"). So
 * cooling never stopped the bounce, and nothing remembered that the destination
 * had just been rejected with MODEL_SWITCH_COMPACTION_FAILED: the transcript
 * cannot be compacted while the summarizer still runs on the previous,
 * rate-limited model.
 *
 * Guards pinned here:
 *   D1 recover path: never bounce straight back to the failing model
 *   D2 idle resume: the first strike still moves forward
 *   D3 idle resume: the second strike pauses switching (the reported loop)
 *   D4 while paused: no probing, no switching, no turn aborts
 *   D5 the destination block is global: another session skips it too
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert";

const BUNDLE = fileURLToPath(new URL("..", import.meta.url));

const A = "trae/deepseek-v4.1-flash";
const B = "trae/glm-5.3";
const C = "loomy/GLM-5.3-Flash";
const split = (route) => {
	const at = route.indexOf("/");
	return { provider: route.slice(0, at), model: route.slice(at + 1) };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function mount(mod, { chain = [A, B, C] } = {}) {
	const probed = [];
	const selected = [];
	const aborted = [];
	const warns = [];
	const listeners = {};
	const state = new Map(); // agentId -> current route

	const llm = {
		listProviders: () => [...new Set(chain.map((r) => split(r).provider))].map((id) => ({ id, name: id })),
		async listModels(provider) {
			return chain.filter((r) => split(r).provider === provider).map((r) => ({ id: split(r).model, contextWindow: 0 }));
		},
		async *stream(options) {
			probed.push(`${options.provider}/${options.model}`);
			yield { type: "finish", reason: { kind: "stop" } };
		}
	};

	function makeAgent(id, current) {
		state.set(id, current);
		return {
			id,
			model: {
				current: () => split(state.get(id)),
				select: (s) => {
					const route = `${s.provider}/${s.model}`;
					selected.push(route);
					state.set(id, route);
				}
			},
			session: { appendPluginRecord: () => {} },
			cancel: (cause) => aborted.push(cause?.reason ?? ""),
			followup: () => {}
		};
	}

	const ctx = {
		llm,
		logger: { info() {}, warn: (m) => warns.push(String(m)), error() {} },
		on(name, fn) { listeners[name] = fn; return () => {}; },
		effect() {},
		inject(keys, cb) { cb({ get: () => undefined, logger: ctx.logger, effect: (fn) => ({ dispose: fn() }), webServer: { register: () => () => {} } }); }
	};

	await mod.apply(ctx, { fallbackChain: chain, probe: true });

	/** request-error waterfall (turn-scoped path). */
	async function requestErrorFor(agent, code = "RATE_LIMIT") {
		const handler = listeners["agent/request-error"];
		if (!handler) throw new Error("agent/request-error listener missing");
		const { provider, model } = split(state.get(agent.id));
		await handler({
			agent, turn: 1, step: 1, provider, model,
			failure: { code, message: code },
			signal: new AbortController().signal
		}, () => undefined);
	}

	/** Arm the pending resume via agent/error, then let the idle status fire it. */
	async function idleCycleFor(agent, code = "MODEL_SWITCH_COMPACTION_FAILED") {
		const onError = listeners["agent/error"];
		const onStatus = listeners["agent/status"];
		if (!onError || !onStatus) throw new Error("agent/error or agent/status listener missing");
		await onError({ agent, error: { code, message: `${code} (compaction)` } }, () => undefined);
		await onStatus({ agent, status: "idle" }, () => undefined);
		await tick();
		await tick();
	}

	return { makeAgent, requestErrorFor, idleCycleFor, probed, selected, aborted, warns };
}

async function run() {
	const mod = await import(pathToFileURL(path.join(BUNDLE, "index.js")).href);
	let passed = 0;
	let failed = 0;
	const test = async (name, fn) => {
		try { await fn(); console.log("PASS  " + name); passed++; }
		catch (e) { console.log("FAIL  " + name + "\n      " + (e && e.message ? e.message : String(e))); failed++; }
	};

	await test("D1 recover path never bounces back to the failing model", async () => {
		const { makeAgent, requestErrorFor, selected } = await mount(mod);
		const agent = makeAgent("a1", A);
		await requestErrorFor(agent, "MODEL_SWITCH_COMPACTION_FAILED");
		assert.deepStrictEqual(selected, [B], "must move forward, got " + JSON.stringify(selected));
		selected.length = 0;
		await requestErrorFor(agent, "RATE_LIMIT");
		assert.ok(!selected.includes(A), "must not return to the model that just failed, got " + JSON.stringify(selected));
	});

	await test("D2 idle resume: the first compaction strike still moves forward", async () => {
		const { makeAgent, idleCycleFor, selected } = await mount(mod);
		const agent = makeAgent("a1", A);
		await idleCycleFor(agent);
		assert.deepStrictEqual(selected, [B], "first idle cycle moves forward, got " + JSON.stringify(selected));
	});

	await test("D3 idle resume: the bounce is stopped (second strike pauses switching)", async () => {
		// This is the reported loop: cycle 1 -> B, cycle 2 would switch straight back to A.
		const { makeAgent, idleCycleFor, selected, warns } = await mount(mod);
		const agent = makeAgent("a1", A);
		await idleCycleFor(agent);
		selected.length = 0;
		await idleCycleFor(agent);
		assert.deepStrictEqual(selected, [], "the second cycle must not switch at all (that is the bounce), got " + JSON.stringify(selected));
		assert.ok(warns.some((w) => w.includes("pausing automatic switching")),
			"must log the pause: " + JSON.stringify(warns.slice(-3)));
	});

	await test("D4 while paused nothing is probed and no turn is aborted", async () => {
		const { makeAgent, idleCycleFor, requestErrorFor, selected, probed, aborted } = await mount(mod);
		const agent = makeAgent("a1", A);
		await idleCycleFor(agent);
		await idleCycleFor(agent); // now paused
		selected.length = 0;
		probed.length = 0;
		aborted.length = 0;
		for (let i = 0; i < 3; i++) {
			await requestErrorFor(agent, "RATE_LIMIT");
			await idleCycleFor(agent);
		}
		assert.deepStrictEqual(selected, [], "no switch while paused");
		assert.deepStrictEqual(probed, [], "no probing while paused");
		assert.deepStrictEqual(aborted, [], "no turn abort while paused");
	});

	await test("D5 the destination block is global: another session skips it too", async () => {
		// Agent a1's failed switch to A blocks A for the whole host; a different
		// session must not pick A either (compaction would fail the same way).
		const { makeAgent, idleCycleFor, requestErrorFor, selected } = await mount(mod);
		const first = makeAgent("a1", A);
		const second = makeAgent("a2", C);
		await idleCycleFor(first); // blocks A, moves to B
		selected.length = 0;
		await requestErrorFor(second, "RATE_LIMIT");
		assert.ok(!selected.includes(A), "the second session must skip the blocked route, got " + JSON.stringify(selected));
		assert.deepStrictEqual(selected, [B], "it should fall through to the next usable entry, got " + JSON.stringify(selected));
	});

	console.log(`\nCOMPACTION SUITE: ${passed} passed, ${failed} failed`);
	if (failed > 0) process.exitCode = 1;
}

await run();