/**
 * Chain-fidelity suite, driven by THIS deployment's real data.
 *
 * Fixtures (captured from the live Host bridge):
 *   fixtures/live-catalog.json — every provider/model route the Host reports
 *   fixtures/chain.json        — the exact fallbackChain saved in the settings page
 *
 * The point is not to test synthetic routes but the user's own chain: if the
 * plugin can walk off it under realistic failures, these tests fail.
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert";

const BUNDLE = fileURLToPath(new URL("..", import.meta.url));
const CATALOG = JSON.parse(fs.readFileSync(path.join(BUNDLE, "test/fixtures/live-catalog.json"), "utf8"));
const CHAIN = JSON.parse(fs.readFileSync(path.join(BUNDLE, "test/fixtures/chain.json"), "utf8"));
const CHAIN_SET = new Set(CHAIN);

const routeOf = (provider, model) => `${provider}/${model}`;
const split = (route) => {
	const at = route.indexOf("/");
	return { provider: route.slice(0, at), model: route.slice(at + 1) };
};

/** Catalog grouped by provider, exactly as the Host reports it. */
function catalogByProvider() {
	const map = new Map();
	for (const route of CATALOG) {
		const { provider, model } = split(route);
		if (!map.has(provider)) map.set(provider, []);
		map.get(provider).push(model);
	}
	return map;
}

/**
 * Mount the plugin with a controllable Host:
 *  - `failing` routes always fail a stream (probe or real request)
 *  - `settings.value` is what settings.describe returns (live chain)
 */
async function mount(mod, { chain, failing = new Set(), enabled = true, probe = true, failAllProbes = false }) {
	const byProvider = catalogByProvider();
	const probed = [];
	const selected = [];
	const augmented = [];
	const warns = [];
	let closed = false;

	const settings = {
		writable: true,
		describe: () => [{ ns: "auto-continue", value: { enabled, fallbackChain: chain, probe, preferLargeContext: true, minContextWindow: 0, ignoreCodes: ["ABORTED"] }, writable: true }],
		mutate: async () => {}
	};

	const llm = {
		listProviders: () => [...byProvider.keys()].map((id) => ({ id, name: id })),
		async listModels(provider) { return (byProvider.get(provider) ?? []).map((id) => ({ id, contextWindow: 0 })); },
		async *stream(options) {
			const route = routeOf(options.provider, options.model);
			probed.push(route);
			if (failAllProbes || failing.has(route)) {
				yield { type: "finish", reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "429" } } };
				return;
			}
			yield { type: "finish", reason: { kind: "stop" } };
		}
	};

	const agent = {
		id: "session-chain",
		model: {
			current: () => split(chain[0] ?? CATALOG[0]),
			select: (s) => selected.push(routeOf(s.provider, s.model))
		},
		session: { appendPluginRecord: () => {}, append: () => {} },
		cancel: () => { closed = true; },
		followup: () => {}
	};

	const listeners = {};
	const ctx = {
		llm,
		logger: { info() {}, warn: (m) => warns.push(String(m)), error() {} },
		on(name, fn) { listeners[name] = fn; return () => { delete listeners[name]; }; },
		effect() {},
		inject(keys, cb) {
			cb({
				get: (key) => (key === "settings" ? settings : undefined),
				logger: ctx.logger,
				effect: (fn) => ({ dispose: fn() }),
				webServer: { register: () => () => {} }
			});
		}
	};
	// `augmented` exists so a test can prove the plugin never uses ctx on the
	// switching path in a way we did not expect.
	void augmented;

	await mod.apply(ctx, { enabled, fallbackChain: chain });

	async function requestError(turn = 1, provider = split(chain[0] ?? CATALOG[0]).provider, model = split(chain[0] ?? CATALOG[0]).model) {
		const handler = listeners["agent/request-error"];
		if (!handler) throw new Error("agent/request-error listener missing");
		await handler({
			agent, turn, step: 1, provider, model,
			failure: { code: "RATE_LIMIT", message: "429" },
			signal: new AbortController().signal
		}, () => undefined);
	}

	return { requestError, probed, selected, warns, isClosed: () => closed, agent, settings };
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

	await test("C1 every configured chain entry exists in the live catalog", () => {
		const missing = CHAIN.filter((route) => !CATALOG.includes(route));
		assert.deepStrictEqual(missing, [], "chain references routes the Host does not expose: " + missing.join(", "));
	});

	await test("C2 partial failures: switches to the first WORKING chain entry", async () => {
		// First three chain entries reject; the fourth must be chosen, and nothing
		// outside the chain may even be probed.
		const failing = new Set(CHAIN.slice(0, 3));
		const { requestError, probed, selected } = await mount(mod, { chain: CHAIN, failing });
		await requestError();
		assert.deepStrictEqual(selected, [CHAIN[3]], "expected the first healthy chain entry");
		const outside = probed.filter((route) => !CHAIN_SET.has(route));
		assert.deepStrictEqual(outside, [], "probed routes outside the chain: " + outside.join(", "));
	});

	await test("C3 every chain entry fails: no switch at all, no wandering", async () => {
		const { requestError, probed, selected, isClosed } = await mount(mod, { chain: CHAIN, failAllProbes: true });
		await requestError();
		assert.deepStrictEqual(selected, [], "must not switch when the whole chain is unusable");
		assert.strictEqual(isClosed(), false, "must not abort the turn either");
		const outside = probed.filter((route) => !CHAIN_SET.has(route));
		assert.deepStrictEqual(outside, [], "probed routes outside the chain: " + outside.join(", "));
		assert.ok(probed.length <= CHAIN.length, "probing must stop within the chain");
	});

	await test("C4 a chain of one entry (the current model) never widens to the registry", async () => {
		const single = [CHAIN[0]];
		const { requestError, probed, selected } = await mount(mod, { chain: single });
		await requestError();
		assert.deepStrictEqual(selected, [], "no other model may be chosen");
		assert.deepStrictEqual(probed.filter((r) => !CHAIN_SET.has(r) || single.indexOf(r) < 0), [],
			"probed outside the single-entry chain: " + probed.join(", "));
	});

	await test("C5 switching follows the chain ORDER, not catalog order", async () => {
		// Fail the first five entries so the sixth is chosen; assert it is exactly
		// CHAIN[5] and that the probes came in chain order.
		const failing = new Set(CHAIN.slice(0, 5));
		const { requestError, probed, selected } = await mount(mod, { chain: CHAIN, failing });
		await requestError();
		assert.deepStrictEqual(selected, [CHAIN[5]]);
		// The current model (CHAIN[0]) is excluded from its own fallback list, so
		// probes start at CHAIN[1] and stop at the first healthy entry.
		assert.deepStrictEqual(probed, CHAIN.slice(1, 6), "probe order must mirror the chain");
	});

	await test("C6 a chain saved at runtime takes effect without a restart", async () => {
		// The plugin used to snapshot its config at load. Saving a new chain must be
		// visible to the very next failure.
		const initial = [CHAIN[0], CHAIN[1]];
		const { requestError, selected, settings } = await mount(mod, { chain: initial, failing: new Set([CHAIN[0], CHAIN[1]]) });
		await requestError(1);
		assert.deepStrictEqual(selected, [], "nothing healthy in the initial chain");
		// User edits the chain in the settings page: a brand-new healthy route.
		const replacement = [CHAIN[2], CHAIN[3]];
		settings.describe = () => [{ ns: "auto-continue", value: { enabled: true, fallbackChain: replacement, probe: true, preferLargeContext: true, minContextWindow: 0, ignoreCodes: ["ABORTED"] }, writable: true }];
		await requestError(2);
		assert.deepStrictEqual(selected, [CHAIN[2]], "the runtime-saved chain must be used immediately, got " + JSON.stringify(selected));
	});

	await test("C7 an empty chain keeps the automatic behaviour (registry enumeration)", async () => {
		// With no chain the user opted into "try everything", so a switch is correct —
		// and it still must not pick account slots or image engines.
		const { requestError, selected, probed } = await mount(mod, { chain: [] });
		await requestError(1, "trae", "glm-5.3");
		assert.strictEqual(selected.length, 1, "an automatic switch is expected without a chain");
		assert.ok(!selected.some((r) => /\/(\d+|.*image-gen.*)$/i.test(r)), "picked a non-chat route: " + JSON.stringify(selected));
		assert.ok(probed.length > 0);
	});

	await test("C8 small-window chain entries are still used: the chain beats window heuristics", async () => {
		// Providers that DO report windows must not let preferLargeContext /
		// minContextWindow rewrite the user's order. Here the current model has a
		// huge window and the chain entries have tiny ones; the chain still wins.
		const routeA = CHAIN[2];
		const routeB = CHAIN[3];
		const mod2 = await import(pathToFileURL(path.join(BUNDLE, "index.js")).href + "?v=windows");
		const probed = [];
		const selected = [];
		const llm = {
			listProviders: () => [{ id: "big" }, { id: "small" }],
			async listModels(provider) {
				if (provider === "big") return [{ id: "huge", contextWindow: 4000000 }];
				return [{ id: "tiny", contextWindow: 8000 }];
			},
			async *stream(options) {
				probed.push(routeOf(options.provider, options.model));
				yield { type: "finish", reason: { kind: "stop" } };
			}
		};
		const agent = {
			id: "session-windows",
			model: { current: () => ({ provider: "big", model: "huge" }), select: (s) => selected.push(routeOf(s.provider, s.model)) },
			session: { appendPluginRecord: () => {} },
			cancel: () => {},
			followup: () => {}
		};
		const listeners = {};
		const ctx = {
			llm,
			logger: { info() {}, warn() {}, error() {} },
			on(name, fn) { listeners[name] = fn; return () => {}; },
			effect() {},
			inject(keys, cb) { cb({ get: () => undefined, logger: ctx.logger, effect: (fn) => ({ dispose: fn() }), webServer: { register: () => () => {} } }); }
		};
		await mod2.apply(ctx, { fallbackChain: [routeA, routeB], preferLargeContext: true, minContextWindow: 200000 });
		await listeners["agent/request-error"]({
			agent, turn: 1, step: 1, provider: "big", model: "huge",
			failure: { code: "RATE_LIMIT", message: "429" },
			signal: new AbortController().signal
		}, () => undefined);
		assert.deepStrictEqual(selected, [routeA],
			"the chain's first entry must be chosen even though its window is tiny, got " + JSON.stringify(selected) + " probes=" + JSON.stringify(probed));
		assert.deepStrictEqual(probed, [routeA]);
	});

	console.log(`\nCHAIN SUITE: ${passed} passed, ${failed} failed`);
	if (failed > 0) process.exitCode = 1;
}

await run();