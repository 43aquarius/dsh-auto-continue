/**
 * Settings-bridge suite for @local/auto-continue (v1.5.0).
 *
 * The settings page no longer uses a framework config form (this profile does
 * not mount one). It talks to two own Host routes instead. These tests pin the
 * contract the browser half depends on:
 *   - GET  /api/dsh-auto-continue-settings/state -> { ok, writable, config, models }
 *   - POST /api/dsh-auto-continue-settings/save  -> { ok } via settings.mutate
 *   - loopback-only, malformed bodies rejected, no expectedRevision (a stale
 *     revision must never turn a save into a conflict).
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert";

const BUNDLE = fileURLToPath(new URL("..", import.meta.url));
const STATE_PATH = "/api/dsh-auto-continue-settings/state";
const SAVE_PATH = "/api/dsh-auto-continue-settings/save";

const CATALOG = {
	"our-free-model": [
		{ id: "combo:recommended-free", contextWindow: 200000 },
		{ id: "glm-5.3-flash-free", contextWindow: 128000 }
	],
	"trae-vision": [{ id: "glm-5.3", contextWindow: 1000000 }]
};

/** Minimal ctx whose inject() calls the callback synchronously with a child ctx. */
function mount(mod, { settings, remoteAddress = "127.0.0.1" } = {}) {
	const registered = [];
	const mutated = [];
	const warns = [];
	const injectCalls = [];

	const webServer = {
		register(route) {
			registered.push(route);
			return () => {
				const at = registered.indexOf(route);
				if (at >= 0) registered.splice(at, 1);
			};
		}
	};

	const settingsService = settings ?? {
		writable: true,
		describe() {
			return [{ ns: "auto-continue", value: { enabled: true, maxSwitchesPerTurn: 0 }, writable: true }];
		},
		async mutate(ns, ops, revision) {
			mutated.push({ ns, ops, revision });
		}
	};

	const ctx = {
		llm: {
			listProviders: () => Object.keys(CATALOG).map((id) => ({ id, name: id })),
			async listModels(provider) {
				return CATALOG[provider] ?? [];
			},
			async *stream() {
				yield { type: "finish", reason: { kind: "stop" } };
			}
		},
		logger: { info() {}, warn: (m) => warns.push(String(m)), error() {} },
		on() { return () => {}; },
		effect() {},
		inject(keys, callback) {
			injectCalls.push(keys);
			const child = {
				get: (key) => (key === "settings" ? settingsService : undefined),
				logger: ctx.logger,
				effect(fn, label) { return { dispose: fn(), label }; },
				webServer
			};
			callback(child);
		}
	};

	return { ctx, registered, mutated, warns, injectCalls, remoteAddress, settingsService };
}

/** Route handler invocation with fake IncomingMessage/ServerResponse. */
async function call(route, { method = "GET", body, remoteAddress = "127.0.0.1" } = {}) {
	const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
	const listeners = {};
	const req = {
		method,
		socket: { remoteAddress },
		on(name, fn) { (listeners[name] ??= []).push(fn); return req; }
	};
	let ended = null;
	const res = {
		statusCode: 0,
		headers: {},
		setHeader(k, v) { this.headers[k] = v; },
		end(payload) { ended = payload; }
	};
	const result = route.handler(req, res);
	// Drain the request: data -> end (handlers awaiting readBody resolve here).
	for (const chunk of chunks) for (const fn of listeners.data ?? []) fn(chunk);
	for (const fn of listeners.end ?? []) fn();
	await result;
	return { status: res.statusCode, headers: res.headers, json: ended ? JSON.parse(ended) : undefined };
}

async function run() {
	const mod = await import(pathToFileURL(path.join(BUNDLE, "index.js")).href);
	let passed = 0;
	let failed = 0;
	const test = async (name, fn) => {
		try {
			await fn();
			console.log("PASS  " + name);
			passed++;
		} catch (e) {
			console.log("FAIL  " + name + "\n      " + (e && e.message ? e.message : String(e)));
			failed++;
		}
	};

	await test("B1 bridge is requested through optional inject(webServer)", async () => {
		const { ctx, injectCalls } = mount(mod);
		await mod.apply(ctx, {});
		assert.ok(
			injectCalls.some((keys) => Array.isArray(keys) && keys.includes("webServer")),
			"apply() must inject webServer"
		);
	});

	await test("B2 both routes register with the documented paths", async () => {
		const { ctx, registered } = mount(mod);
		await mod.apply(ctx, {});
		const paths = registered.map((r) => r.path);
		assert.ok(paths.includes(STATE_PATH), `missing ${STATE_PATH} in ${JSON.stringify(paths)}`);
		assert.ok(paths.includes(SAVE_PATH), `missing ${SAVE_PATH} in ${JSON.stringify(paths)}`);
		for (const route of registered) assert.strictEqual(route.kind, "exact", "routes must be exact matches");
	});

	await test("B3 state returns the live catalog and current config", async () => {
		const { ctx, registered } = mount(mod);
		await mod.apply(ctx, {});
		const route = registered.find((r) => r.path === STATE_PATH);
		const { status, json } = await call(route);
		assert.strictEqual(status, 200);
		assert.strictEqual(json.ok, true);
		assert.strictEqual(json.writable, true);
		assert.strictEqual(json.config.enabled, true, "config comes from settings.describe");
		assert.strictEqual(json.config.maxSwitchesPerTurn, 0, "0 = unlimited survives normalization");
		const routes = (json.models ?? []).map((m) => m.route).sort();
		assert.deepStrictEqual(routes, [
			"our-free-model/combo:recommended-free",
			"our-free-model/glm-5.3-flash-free",
			"trae-vision/glm-5.3"
		], "picker must list every live provider/model route");
	});

	await test("B4 state is loopback-only", async () => {
		const { ctx, registered } = mount(mod);
		await mod.apply(ctx, {});
		const route = registered.find((r) => r.path === STATE_PATH);
		const { status, json } = await call(route, { remoteAddress: "10.0.0.7" });
		assert.strictEqual(status, 403);
		assert.strictEqual(json.ok, false);
	});

	await test("B5 save applies ops with settings.mutate and no expectedRevision", async () => {
		const { ctx, registered, mutated } = mount(mod);
		await mod.apply(ctx, {});
		const route = registered.find((r) => r.path === SAVE_PATH);
		const { status, json } = await call(route, {
			method: "POST",
			body: { ops: [{ op: "set", path: ["maxSwitchesPerTurn"], value: 0 }] }
		});
		assert.strictEqual(status, 200);
		assert.strictEqual(json.ok, true);
		assert.strictEqual(mutated.length, 1);
		assert.strictEqual(mutated[0].ns, "auto-continue");
		assert.deepStrictEqual(mutated[0].ops, [{ op: "set", path: ["maxSwitchesPerTurn"], value: 0 }]);
		assert.strictEqual(mutated[0].revision, undefined, "no revision => no revision conflict");
	});

	await test("B6 save rejects malformed and empty ops", async () => {
		const { ctx, registered, mutated } = mount(mod);
		await mod.apply(ctx, {});
		const route = registered.find((r) => r.path === SAVE_PATH);
		const empty = await call(route, { method: "POST", body: { ops: [] } });
		assert.strictEqual(empty.json.ok, false);
		const junk = await call(route, { method: "POST", body: { ops: [{ nope: true }] } });
		assert.strictEqual(junk.json.ok, false);
		assert.strictEqual(mutated.length, 0, "nothing may be written for rejected bodies");
	});

	await test("B7 a throwing mutate surfaces ok:false instead of crashing", async () => {
		const { ctx, registered } = mount(mod, {
			settings: {
				writable: true,
				describe: () => [{ ns: "auto-continue", value: {}, writable: true }],
				async mutate() { throw new Error("settings backend exploded"); }
			}
		});
		await mod.apply(ctx, {});
		const route = registered.find((r) => r.path === SAVE_PATH);
		const { status, json } = await call(route, { method: "POST", body: { ops: [{ op: "set", path: ["enabled"], value: true }] } });
		assert.strictEqual(status, 200);
		assert.strictEqual(json.ok, false);
		assert.match(String(json.message), /exploded/);
	});

	await test("B8 without a settings service the state is read-only and save refuses", async () => {
		const { ctx, registered } = mount(mod, {
			settings: { writable: false, describe: () => [{ ns: "auto-continue", value: { enabled: false }, writable: false }] }
		});
		await mod.apply(ctx, {});
		const state = await call(registered.find((r) => r.path === STATE_PATH));
		assert.strictEqual(state.json.writable, false, "no mutate() => writable false");
		assert.strictEqual(state.json.config.enabled, false);
		const save = await call(registered.find((r) => r.path === SAVE_PATH), {
			method: "POST",
			body: { ops: [{ op: "set", path: ["enabled"], value: true }] }
		});
		assert.strictEqual(save.json.ok, false);
		assert.strictEqual(save.json.code, "settings-unavailable");
	});

	console.log(`\nBRIDGE SUITE: ${passed} passed, ${failed} failed`);
	if (failed > 0) process.exitCode = 1;
}

await run();
