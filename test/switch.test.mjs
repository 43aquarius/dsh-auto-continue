/**
 * Deterministic unit test for @local/auto-continue's switching logic.
 * Mocks the llm registry + agent surface, drives the real plugin code
 * through a request-error, and asserts the full switch chain.
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import assert from "node:assert";

const BUNDLE = "C:/Users/23529/Documents/deepseek-harness/default-workspace/dsh-auto-continue";

/** Build a fake provider catalog. raccoon-vision is storming (429), others healthy. */
function makeLlm({ stormRaccoon = true } = {}) {
	const catalog = {
		"raccoon-vision": ["sn-glm-5-3"],
		"trae-vision": ["glm-5.3"],
		loomy: ["GLM-5.3-Flash"]
	};
	const probeLog = [];
	return {
		probeLog,
		listProviders() {
			return Object.keys(catalog).map((id) => ({ id, name: id }));
		},
		async listModels(provider) {
			return (catalog[provider] ?? []).map((id) => ({ id, name: id }));
		},
		async *stream(options) {
			probeLog.push(`${options.provider}/${options.model}`);
			const storming = stormRaccoon && options.provider === "raccoon-vision";
			if (storming) {
				yield { type: "finish", reason: { kind: "error", failure: { message: "429", code: "RATE_LIMIT", status: 429 } } };
				return;
			}
			yield { type: "text-delta", index: 0, text: "ok" };
			yield { type: "finish", reason: { kind: "stop" } };
		}
	};
}

function makeAgent(overrides = {}) {
	const record = { selects: [], cancels: [], followups: [], sessionEvents: [], appendEvents: [] };
	const agent = {
		id: "session-test",
		model: {
			current() {
				return { provider: "raccoon-vision", model: "sn-glm-5-3" };
			},
			select(selection) {
				record.selects.push(selection);
			}
		},
		session: {
			append(type, data) {
				record.appendEvents.push({ type, data });
				return { seq: record.appendEvents.length };
			},
			appendPluginRecord(type, data) {
				record.sessionEvents.push({ type, data });
				return record.sessionEvents.length;
			}
		},
		cancel(cause, options) {
			record.cancels.push({ cause, options });
		},
		followup(message) {
			record.followups.push(message);
		},
		...overrides
	};
	return { agent, record };
}

async function run() {
	const mod = await import(pathToFileURL(path.join(BUNDLE, "index.js")).href);
	assert.strictEqual(typeof mod.apply, "function", "apply export");
	assert.deepStrictEqual(mod.inject, ["llm"], "inject export");

	// ---- Scenario 1: storm on raccoon-vision, loomy & trae healthy -> switch happens
	{
		const llm = makeLlm({ stormRaccoon: true });
		const listeners = {};
		const effects = [];
		const ctx = {
			llm,
			logger: { info() {}, warn() {}, error() {} },
			on(name, listener) {
				listeners[name] = listener;
				return () => {};
			},
			effect(_fn, label) {
				effects.push(label);
			}
		};
		await mod.apply(ctx, {});
		assert.ok(listeners["agent/request-error"], "request-error listener registered");
		assert.ok(listeners["agent/disposed"], "disposed listener registered");

		const { agent, record } = makeAgent();
		const nextCalls = [];
		const result = await listeners["agent/request-error"](
			{ agent, turn: 4, step: 16, provider: "raccoon-vision", failure: { code: "RATE_LIMIT", message: "429", status: 429 }, signal: new AbortController().signal },
			async () => {
				nextCalls.push(1);
				return undefined;
			}
		);
		assert.strictEqual(result, undefined, "returns next() after switching");
		assert.strictEqual(nextCalls.length, 1, "deferred to downstream");
		assert.ok(llm.probeLog.length >= 1, "probed at least one candidate: " + JSON.stringify(llm.probeLog));
		assert.strictEqual(record.selects.length, 1, "select called once");
		assert.notStrictEqual(record.selects[0].provider, "raccoon-vision", "switched away from storming provider");
		assert.ok(["loomy", "trae-vision"].includes(record.selects[0].provider), "switched to a healthy provider: " + JSON.stringify(record.selects[0]));
		assert.strictEqual(record.cancels.length, 1, "cancel called once");
		assert.strictEqual(record.cancels[0].cause.kind, "hook", "cancel cause kind hook");
		assert.strictEqual(record.cancels[0].options.keepInbox, true, "cancel preserves inbox");
		assert.strictEqual(record.followups.length, 1, "followup called once");
		assert.strictEqual(record.followups[0].role, "user", "followup is a user message");
		const contText = record.followups[0].content[0].text;
		assert.ok(contText.includes("继续"), "continuation text present: " + contText);
		const switchEvent = record.sessionEvents.find((e) => e.type === "plugin:auto-continue/switch");
		assert.ok(switchEvent, "plugin:auto-continue/switch session event recorded");
		assert.deepStrictEqual(record.appendEvents, [], "no raw session.append() calls — ignorable plugin records only");
		assert.strictEqual(switchEvent.data.from.provider, "raccoon-vision");
		assert.strictEqual(switchEvent.data.to.provider, record.selects[0].provider);
		console.log("SCENARIO 1 PASS — switched to", record.selects[0].provider + "/" + record.selects[0].model, "| probes:", JSON.stringify(llm.probeLog));
	}

	// ---- Scenario 2: everything storming -> no switch, error surfaces
	{
		const llm = makeLlm({ stormRaccoon: true });
		// storm every provider
		llm.stream = async function* (options) {
			probeAll.push(`${options.provider}/${options.model}`);
			yield { type: "finish", reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "429", status: 429 } } };
		};
		const probeAll = [];
		const listeners = {};
		const ctx = {
			llm,
			logger: { info() {}, warn() {}, error() {} },
			on(name, listener) {
				listeners[name] = listener;
				return () => {};
			},
			effect() {}
		};
		await mod.apply(ctx, {});
		const { agent, record } = makeAgent();
		let nextResult = "SENTINEL";
		const result = await listeners["agent/request-error"](
			{ agent, turn: 1, step: 1, provider: "raccoon-vision", failure: { code: "RATE_LIMIT", message: "429", status: 429 }, signal: new AbortController().signal },
			async () => nextResult
		);
		assert.strictEqual(result, nextResult, "deferred decision when no candidate is healthy");
		assert.strictEqual(record.selects.length, 0, "no select when all candidates fail");
		assert.strictEqual(record.followups.length, 0, "no followup when all candidates fail");
		assert.ok(probeAll.length >= 1, "probes attempted: " + JSON.stringify(probeAll));
		console.log("SCENARIO 2 PASS — no usable fallback, error surfaced | probes:", JSON.stringify(probeAll));
	}

	// ---- Scenario 3: ignoreCodes -> no action, immediate defer
	{
		const llm = makeLlm({ stormRaccoon: false });
		const listeners = {};
		const ctx = {
			llm,
			logger: { info() {}, warn() {}, error() {} },
			on(name, listener) {
				listeners[name] = listener;
				return () => {};
			},
			effect() {}
		};
		await mod.apply(ctx, {});
		const { agent, record } = makeAgent();
		const marker = "DOWNSTREAM";
		const result = await listeners["agent/request-error"](
			{ agent, turn: 1, step: 1, provider: "raccoon-vision", failure: { code: "ABORTED", message: "user stopped" }, signal: new AbortController().signal },
			async () => marker
		);
		assert.strictEqual(result, marker, "ignored code defers untouched");
		assert.strictEqual(record.selects.length + record.cancels.length + record.followups.length, 0, "no switch actions for ignored code");
		assert.strictEqual(llm.probeLog.length, 0, "no probes for ignored code");
		console.log("SCENARIO 3 PASS — ABORTED ignored without probing");
	}

	// ---- Scenario 4: explicit fallbackChain order wins
	{
		const llm = makeLlm({ stormRaccoon: true });
		const listeners = {};
		const ctx = {
			llm,
			logger: { info() {}, warn() {}, error() {} },
			on(name, listener) {
				listeners[name] = listener;
				return () => {};
			},
			effect() {}
		};
		await mod.apply(ctx, { fallbackChain: ["loomy/GLM-5.3-Flash", "trae-vision/glm-5.3"] });
		const { agent, record } = makeAgent();
		await listeners["agent/request-error"](
			{ agent, turn: 2, step: 1, provider: "raccoon-vision", failure: { code: "QUOTA", message: "insufficient quota" }, signal: new AbortController().signal },
			async () => undefined
		);
		assert.strictEqual(record.selects.length, 1);
		assert.strictEqual(record.selects[0].provider, "loomy", "chain order honored: " + JSON.stringify(record.selects[0]));
		// QUOTA cooldown: quota code => QUOTA branch (30min)
		console.log("SCENARIO 4 PASS — explicit chain honored (loomy first)");
	}

	// ---- Scenario 5: all-storm request error -> idle resume once models recover
	{
		const llm = makeLlm({ stormRaccoon: false });
		const probeAll = [];
		llm.stream = async function* (options) {
			probeAll.push(options.provider + "/" + options.model);
			yield { type: "finish", reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "429", status: 429 } } };
		};
		const listeners = {};
		const ctx = {
			llm,
			logger: { info() {}, warn() {}, error() {} },
			on(name, listener) { listeners[name] = listener; return () => {}; },
			effect() {}
		};
		await mod.apply(ctx, {});
		const { agent, record } = makeAgent();
		await listeners["agent/request-error"](
			{ agent, turn: 1, step: 1, provider: "raccoon-vision", failure: { code: "RATE_LIMIT", message: "429" }, signal: new AbortController().signal },
			async () => undefined
		);
		assert.strictEqual(record.selects.length, 0, "no switch while every candidate storms");
		assert.strictEqual(record.followups.length, 0, "no followup while every candidate storms");
		// models recover
		llm.stream = async function* (options) {
			probeAll.push(options.provider + "/" + options.model);
			yield { type: "text-delta", index: 0, text: "ok" };
			yield { type: "finish", reason: { kind: "stop" } };
		};
		await listeners["agent/status"]({ agent, status: "idle" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.strictEqual(record.selects.length, 1, "idle resume switched once: " + JSON.stringify(record.selects));
		assert.notStrictEqual(record.selects[0].provider, "raccoon-vision", "idle resume left the failed provider");
		assert.strictEqual(record.followups.length, 1, "idle resume queued continuation");
		const swEv = record.sessionEvents.find((e) => e.type === "plugin:auto-continue/switch");
		assert.ok(swEv, "idle resume also records a plugin switch record");
		assert.strictEqual(swEv.data.source, "idle-resume", "switch record tagged as idle-resume");
		console.log("SCENARIO 5 PASS — idle resume switched to", record.selects[0].provider + "/" + record.selects[0].model);
	}

	// ---- Scenario 6: turn-stopping (normal end) cancels the pending resume
	{
		const llm = makeLlm({ stormRaccoon: false });
		llm.stream = async function* () {
			yield { type: "finish", reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "429" } } };
		};
		const listeners = {};
		const ctx = {
			llm,
			logger: { info() {}, warn() {}, error() {} },
			on(name, listener) { listeners[name] = listener; return () => {}; },
			effect() {}
		};
		await mod.apply(ctx, {});
		const { agent, record } = makeAgent();
		await listeners["agent/request-error"](
			{ agent, turn: 1, step: 1, provider: "raccoon-vision", failure: { code: "RATE_LIMIT", message: "429" }, signal: new AbortController().signal },
			async () => undefined
		);
		await listeners["agent/turn-stopping"]({ agent, turn: 1 });
		await listeners["agent/status"]({ agent, status: "idle" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.strictEqual(record.selects.length, 0, "turn-stopping cancelled the pending resume");
		assert.strictEqual(record.followups.length, 0, "no continuation after normal stop");
		console.log("SCENARIO 6 PASS — turn-stopping cancels pending resume");
	}

	// ---- Scenario 7: driver error -> idle resume continues without switching
	{
		const llm = makeLlm({ stormRaccoon: false });
		const listeners = {};
		const ctx = {
			llm,
			logger: { info() {}, warn() {}, error() {} },
			on(name, listener) { listeners[name] = listener; return () => {}; },
			effect() {}
		};
		await mod.apply(ctx, {});
		const { agent, record } = makeAgent();
		await listeners["agent/error"]({ agent, turn: 2, step: 3, error: new Error("tool batch exploded") });
		await listeners["agent/status"]({ agent, status: "idle" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.strictEqual(record.followups.length, 1, "driver error resumes with a continuation");
		assert.strictEqual(record.selects.length, 0, "driver error does not switch models");
		assert.strictEqual(record.followups[0].content[0].text.includes("继续"), true, "continuation text present");
		console.log("SCENARIO 7 PASS — driver error resumed without switching");
	}

	console.log("\nALL SCENARIOS PASS");
}

run().catch((error) => {
	console.error("TEST FAIL:", error);
	process.exit(1);
});
