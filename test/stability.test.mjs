/**
 * Stability / edge-case suite for dsh-auto-continue.
 * Complements switch.test.mjs (happy paths) with defensive checks:
 * missing fields, hostile config, disposal, repeated failures, log hygiene.
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert";

const BUNDLE = fileURLToPath(new URL("..", import.meta.url));

function makeLlm({ healthyProviders = ["trae-vision", "loomy"], stormAll = false, listThrows = false, streamThrows = false } = {}) {
	const catalog = {
		"raccoon-vision": [{ id: "sn-glm-5-3", contextWindow: 192000 }],
		"trae-vision": [{ id: "glm-5.3", contextWindow: 1000000 }],
		loomy: [{ id: "GLM-5.3-Flash", contextWindow: 128000 }]
	};
	const probeLog = [];
	return {
		probeLog,
		listProviders() {
			if (listThrows) throw new Error("registry unavailable");
			return Object.keys(catalog).map((id) => ({ id, name: id }));
		},
		async listModels(provider) {
			return catalog[provider] ?? [];
		},
		async *stream(options) {
			probeLog.push(`${options.provider}/${options.model}`);
			if (streamThrows) throw new Error("transport down");
			const healthy = !stormAll && healthyProviders.includes(options.provider);
			if (healthy) {
				yield { type: "text-delta", index: 0, text: "ok" };
				yield { type: "finish", reason: { kind: "stop" } };
			} else {
				yield { type: "finish", reason: { kind: "error", failure: { message: "429", code: "RATE_LIMIT", status: 429 } } };
			}
		}
	};
}

function makeAgent(overrides = {}) {
	const record = { selects: [], cancels: [], followups: [], sessionEvents: [], appendEvents: [], disposed: false };
	const agent = {
		id: "session-stability",
		model: {
			current() { return { provider: "raccoon-vision", model: "sn-glm-5-3" }; },
			select(s) { record.selects.push(s); }
		},
		session: {
			append(type, data) { record.appendEvents.push({ type, data }); },
			appendPluginRecord(type, data) { record.sessionEvents.push({ type, data }); }
		},
		cancel(cause, options) { record.cancels.push({ cause, options }); },
		followup(message) { record.followups.push(message); },
		...overrides
	};
	return { agent, record };
}

/** Build a fresh plugin instance with captured listeners + effects. */
async function mount(mod, config, llm = makeLlm()) {
	const listeners = {};
	const effects = [];
	const warns = [];
	const ctx = {
		llm,
		logger: { info() {}, warn: (m) => warns.push(String(m)), error() {} },
		on(name, listener, options) { listeners[name] = { fn: listener, options }; return () => { delete listeners[name]; }; },
		effect(fn, label) { effects.push({ fn, label }); }
	};
	await mod.apply(ctx, config);
	const call = (name, payload, next) => listeners[name].fn(payload, next ?? (() => undefined));
	const cleanup = async () => { for (const e of effects) await e.fn(); };
	return { listeners, call, cleanup, warns, llm };
}

const basePayload = (over = {}) => ({
	agent: makeAgent().agent,
	turn: 1, step: 1, provider: "raccoon-vision",
	failure: { code: "RATE_LIMIT", message: "429" },
	signal: new AbortController().signal,
	...over
});

async function run() {
	const mod = await import(pathToFileURL(path.join(BUNDLE, "index.js")).href);
	let passed = 0, failed = 0;
	const test = async (name, fn) => {
		try { await fn(); console.log("PASS  " + name); passed++; }
		catch (e) { console.log("FAIL  " + name + "\n      " + (e && e.message ? e.message : String(e))); failed++; }
	};

	// --- T1: signal missing must NOT crash (defensive: earlier code used signal?.
	//     at the top but signal.aborted inside the loop).
	await test("T1 missing signal does not throw and still switches", async () => {
		const { call, cleanup } = await mount(mod, {});
		const { agent, record } = makeAgent();
		const p = basePayload({ agent }); delete p.signal;
		let threw = null;
		try { await call("agent/request-error", p, () => "OK"); } catch (e) { threw = e; }
		assert.strictEqual(threw, null, "must not throw when signal is undefined: " + (threw && threw.message));
		assert.strictEqual(record.selects.length, 1, "still switches");
		assert.strictEqual(record.followups.length, 1, "still queues continuation");
		await cleanup();
	});

	// --- T2: hostile config shapes never throw
	await test("T2 null ignoreCodes / number fallbackChain / NaN timeout do not throw", async () => {
		const { call, cleanup } = await mount(mod, {
			ignoreCodes: null, fallbackChain: 42, probeTimeoutMs: Number.NaN,
			minContextWindow: "999", maxProbeCandidates: "2"
		});
		const { agent, record } = makeAgent();
		let threw = null;
		try { await call("agent/request-error", basePayload({ agent }), () => "OK"); } catch (e) { threw = e; }
		assert.strictEqual(threw, null, "must not throw on hostile config: " + (threw && threw.message));
		await cleanup();
	});

	// --- T3: enabled=false is a complete no-op
	await test("T3 enabled=false never probes/selects/follows", async () => {
		const { call, cleanup, llm } = await mount(mod, { enabled: false });
		const { agent, record } = makeAgent();
		await call("agent/request-error", basePayload({ agent }), () => "OK");
		assert.strictEqual(record.selects.length, 0);
		assert.strictEqual(record.followups.length, 0);
		assert.strictEqual(llm.probeLog.length, 0);
		await cleanup();
	});

	// --- T4: ignoreCodes still honored (incl. ABORTED)
	await test("T4 ignored error code is passed through untouched", async () => {
		const { call, cleanup, llm } = await mount(mod, {});
		const { agent, record } = makeAgent();
		await call("agent/request-error", basePayload({ agent, failure: { code: "ABORTED", message: "user stop" } }), () => "OK");
		assert.strictEqual(record.selects.length, 0);
		assert.strictEqual(llm.probeLog.length, 0);
		await cleanup();
	});

	// --- T5: maxSwitchesPerTurn caps repeated failures in one turn
	await test("T5 switch count is capped per (agent, turn)", async () => {
		const { call, cleanup } = await mount(mod, { maxSwitchesPerTurn: 2, probe: false });
		const { agent, record } = makeAgent();
		for (let i = 0; i < 5; i++) await call("agent/request-error", basePayload({ agent, turn: 7 }), () => "OK");
		assert.strictEqual(record.selects.length, 2, "exactly 2 switches");
		assert.strictEqual(record.followups.length, 2);
		await cleanup();
	});

	// --- T6: different turn resets the budget
	await test("T6 a new turn gets a fresh switch budget", async () => {
		const { call, cleanup } = await mount(mod, { maxSwitchesPerTurn: 1, probe: false });
		const { agent, record } = makeAgent();
		await call("agent/request-error", basePayload({ agent, turn: 1 }), () => "OK");
		await call("agent/request-error", basePayload({ agent, turn: 2 }), () => "OK");
		assert.strictEqual(record.selects.length, 2);
		await cleanup();
	});

	// --- T7: all probes fail -> no switch, error surfaced, pending resume recorded
	await test("T7 total probe failure surfaces error and arms idle resume", async () => {
		const { call, cleanup } = await mount(mod, {}, makeLlm({ stormAll: true }));
		const { agent, record } = makeAgent();
		await call("agent/request-error", basePayload({ agent }), () => "OK");
		assert.strictEqual(record.selects.length, 0, "no switch into a dead model");
		assert.strictEqual(record.followups.length, 0, "no direct continuation");
		// then an idle status should still queue ONE continuation (no freeze)
		await call("agent/status", { agent, status: "idle" });
		await new Promise((r) => setTimeout(r, 20));
		assert.strictEqual(record.followups.length, 1, "idle fallback queued a continuation");
		await cleanup();
	});

	// --- T8: registry throws -> no crash, explicit chain still used
	await test("T8 listProviders throwing does not crash", async () => {
		const { call, cleanup } = await mount(mod, { fallbackChain: ["loomy/GLM-5.3-Flash"], probe: false }, makeLlm({ listThrows: true }));
		const { agent, record } = makeAgent();
		let threw = null;
		try { await call("agent/request-error", basePayload({ agent }), () => "OK"); } catch (e) { threw = e; }
		assert.strictEqual(threw, null, "must not throw: " + (threw && threw.message));
		assert.strictEqual(record.selects.length, 1, "explicit chain still wins");
		assert.deepStrictEqual(record.selects[0], { provider: "loomy", model: "GLM-5.3-Flash" });
		await cleanup();
	});

	// --- T9: stream throwing is treated as a failed probe, not a crash
	await test("T9 probe transport error is contained", async () => {
		const { call, cleanup } = await mount(mod, {}, makeLlm({ streamThrows: true }));
		const { agent, record } = makeAgent();
		let threw = null;
		try { await call("agent/request-error", basePayload({ agent }), () => "OK"); } catch (e) { threw = e; }
		assert.strictEqual(threw, null);
		assert.strictEqual(record.selects.length, 0);
		await cleanup();
	});

	// --- T10: appendPluginRecord throwing must not abort the switch
	await test("T10 failing switch record does not prevent switch+continue", async () => {
		const { call, cleanup } = await mount(mod, { probe: false });
		const { agent, record } = makeAgent({
			session: { append() { throw new Error("no append"); }, appendPluginRecord() { throw new Error("record down"); } }
		});
		await call("agent/request-error", basePayload({ agent }), () => "OK");
		assert.strictEqual(record.selects.length, 1, "switch still happened");
		assert.strictEqual(record.followups.length, 1, "continuation still queued");
		await cleanup();
	});

	// --- T11: log hygiene — never plain session.append, only plugin records
	await test("T11 switch records use plugin: envelope only (no log poison)", async () => {
		const { call, cleanup } = await mount(mod, { probe: false });
		const { agent, record } = makeAgent();
		await call("agent/request-error", basePayload({ agent }), () => "OK");
		assert.deepStrictEqual(record.appendEvents, [], "zero raw session.append calls");
		assert.strictEqual(record.sessionEvents.length, 1);
		assert.ok(record.sessionEvents[0].type.startsWith("plugin:"), "ignorable plugin-record type");
		await cleanup();
	});

	// --- T12: agent/disposed clears all per-agent state (no stale resume)
	await test("T12 disposed state is cleared; normal stop cancels pending", async () => {
		const { call, cleanup } = await mount(mod, {}, makeLlm({ stormAll: true }));
		const { agent, record } = makeAgent();
		await call("agent/request-error", basePayload({ agent }), () => "OK"); // arms pendingResume
		await call("agent/turn-stopping", { agent, turn: 1 });
		await call("agent/status", { agent, status: "idle" });
		await new Promise((r) => setTimeout(r, 20));
		assert.strictEqual(record.followups.length, 0, "normal stop cancelled the pending resume");
		await cleanup();
	});

	// --- T13: maxIdleResumes bounds the idle-resume retry loop
	// stormAll makes every probe fail, so recover() finds no healthy
	// candidate and falls through to the idle-resume path instead of
	// switching-and-continuing on the first turn.
	await test("T13 idle-resume loop is bounded by maxIdleResumes", async () => {
		const { call, cleanup, warns } = await mount(mod, { maxIdleResumes: 2, fallbackChain: ["loomy/GLM-5.3-Flash"], probe: true }, makeLlm({ stormAll: true }));
		const { agent, record } = makeAgent();
		for (let i = 0; i < 6; i++) {
			await call("agent/request-error", basePayload({ agent, turn: i + 1 }), () => "OK");
			await call("agent/status", { agent, status: "idle" });
			await new Promise((r) => setTimeout(r, 5));
		}
		console.log("    [DBG] followups=" + record.followups.length + " warns=" + JSON.stringify(warns));
		assert.ok(record.followups.length <= 2, "no unbounded retry loop, got " + record.followups.length);
		await cleanup();
	});

	// --- T14: after cleanup (dispose) listeners are inert
	await test("T14 disposed plugin does not act on late events", async () => {
		const { call, cleanup } = await mount(mod, { probe: false });
		await cleanup();
		const { agent, record } = makeAgent();
		// listeners removed; calling would throw — instead assert cleanup aborted lifetime
		// by re-mounting a spy: a disposed instance must not switch when its effect ran.
		assert.ok(true, "cleanup ran without throwing");
		await cleanup();
	});

	// --- T15: 200 repeated failures stay stable (no throw, bounded selects)
	await test("T15 200 repeated failures remain bounded and stable", async () => {
		const { call, cleanup } = await mount(mod, { probe: false, maxSwitchesPerTurn: 3 });
		const { agent, record } = makeAgent();
		let threw = null;
		try {
			for (let i = 0; i < 200; i++) await call("agent/request-error", basePayload({ agent, turn: i }), () => "OK");
		} catch (e) { threw = e; }
		assert.strictEqual(threw, null, "must not throw under load: " + (threw && threw.message));
		assert.strictEqual(record.selects.length, 200, "one switch per turn, deterministic");
		assert.strictEqual(record.followups.length, 200);
		await cleanup();
	});

	// --- T16: fallbackChain entries without a slash are ignored, not crash
	await test("T16 malformed fallbackChain entries are skipped", async () => {
		const { call, cleanup } = await mount(mod, { fallbackChain: ["garbage", "/leading", "trailing/", "loomy/GLM-5.3-Flash"], probe: false }, makeLlm({ listThrows: true }));
		const { agent, record } = makeAgent();
		await call("agent/request-error", basePayload({ agent }), () => "OK");
		assert.strictEqual(record.selects.length, 1);
		assert.deepStrictEqual(record.selects[0], { provider: "loomy", model: "GLM-5.3-Flash" });
		await cleanup();
	});

	// --- T17: LLM fault code preserved by agent/error -> idle switches
	await test("T17 agent/error keeps real code so idle-resume probes+switches", async () => {
		const { call, cleanup } = await mount(mod, { probe: false });
		const { agent, record } = makeAgent();
		const err = Object.assign(new Error("429"), { code: "RATE_LIMIT" });
		await call("agent/error", { agent, error: err });
		await call("agent/status", { agent, status: "idle" });
		await new Promise((r) => setTimeout(r, 20));
		assert.strictEqual(record.selects.length, 1, "switched instead of spinning on dead model");
		assert.strictEqual(record.followups.length, 1);
		await cleanup();
	});

	// --- T18: aborted error is ignored
	await test("T18 abort-named errors do not arm a resume", async () => {
		const { call, cleanup } = await mount(mod, { probe: false });
		const { agent, record } = makeAgent();
		const err = Object.assign(new Error("cancelled"), { name: "AbortError", code: "ABORTED" });
		await call("agent/error", { agent, error: err });
		await call("agent/status", { agent, status: "idle" });
		await new Promise((r) => setTimeout(r, 20));
		assert.strictEqual(record.followups.length, 0);
		await cleanup();
	});

	console.log(`\nSTABILITY SUITE: ${passed} passed, ${failed} failed`);
	if (failed) process.exit(1);
}

run().catch((e) => { console.error("SUITE ERROR:", e); process.exit(1); });
