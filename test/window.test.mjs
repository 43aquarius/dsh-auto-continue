/**
 * Window-aware ordering suite.
 *
 * DSH only reports a model's context window through
 * `llm.resolveModelInfo(provider, model).context.contextWindow`;
 * `llm.listModels()` returns 0 for every entry in this deployment. Without the
 * real number the plugin could not tell "switching there needs transcript
 * compaction" from "switching there is free", so it kept picking 200k models
 * while the failing current model was 960k — every switch demanded compaction,
 * whose summarizer was the failing model itself. Result: the A<->B loop.
 *
 * These tests pin the ordering rule:
 *   E1 candidates that need NO compaction are tried first (chain order kept
 *      inside each group), even when a smaller entry sits earlier in the chain
 *   E2 unknown windows keep the plain chain order (never silently reordered)
 *   E3 nothing is dropped: a too-small entry is still a last resort
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert";

const BUNDLE = fileURLToPath(new URL("..", import.meta.url));

const BIG = "loomy/GLM-5.3-Flash"; // 1M
const SMALL = "trae/deepseek-v4.1-flash"; // 200k
const MID = "raccoon/sn-glm-5-3"; // 1M
const split = (route) => {
	const at = route.indexOf("/");
	return { provider: route.slice(0, at), model: route.slice(at + 1) };
};

async function mount(mod, { chain, windows, current }) {
	const probed = [];
	const selected = [];
	const listeners = {};
	let currentRoute = current;

	const llm = {
		listProviders: () => [...new Set([...chain, current].map((r) => split(r).provider))].map((id) => ({ id, name: id })),
		// Deliberately hides windows, exactly like the real adapter.
		async listModels(provider) {
			return [...new Set([...chain, current])].filter((r) => split(r).provider === provider).map((r) => ({ id: split(r).model, contextWindow: 0 }));
		},
		// The only place a window is available.
		async resolveModelInfo(provider, model) {
			const window = windows[`${provider}/${model}`];
			if (typeof window !== "number") throw new Error("unknown model");
			return { provider, id: model, name: model, context: { contextWindow: window } };
		},
		async *stream(options) {
			probed.push(`${options.provider}/${options.model}`);
			yield { type: "finish", reason: { kind: "stop" } };
		}
	};

	const agent = {
		id: "session-window",
		model: {
			current: () => split(currentRoute),
			select: (s) => {
				selected.push(`${s.provider}/${s.model}`);
				currentRoute = `${s.provider}/${s.model}`;
			}
		},
		session: { appendPluginRecord: () => {} },
		cancel: () => {},
		followup: () => {}
	};

	const ctx = {
		llm,
		logger: { info() {}, warn() {}, error() {} },
		on(name, fn) { listeners[name] = fn; return () => {}; },
		effect() {},
		inject(keys, cb) { cb({ get: () => undefined, logger: ctx.logger, effect: (fn) => ({ dispose: fn() }), webServer: { register: () => () => {} } }); }
	};

	await mod.apply(ctx, { fallbackChain: chain, probe: true, preferLargeContext: true });

	async function fail() {
		const { provider, model } = split(currentRoute);
		await listeners["agent/request-error"]({
			agent, turn: 1, step: 1, provider, model,
			failure: { code: "QUOTA", message: "quota" },
			signal: new AbortController().signal
		}, () => undefined);
	}

	return { fail, probed, selected };
}

async function run() {
	const mod = await import(pathToFileURL(path.join(BUNDLE, "index.js")).href);
	let passed = 0;
	let failed = 0;
	const test = async (name, fn) => {
		try { await fn(); console.log("PASS  " + name); passed++; }
		catch (e) { console.log("FAIL  " + name + "\n      " + (e && e.message ? e.message : String(e))); failed++; }
	};

	await test("E1 no-compaction destinations are tried first", async () => {
		// Chain puts the 200k entry first, but the session is on a 960k model:
		// switching to 200k would need compaction, whose summarizer is the failing
		// model — so the 1M entry must be chosen instead.
		const windows = { [SMALL]: 200000, [BIG]: 1048576, [MID]: 1000000, "workbuddy/hy4free": 960000 };
		const { fail, selected } = await mount(mod, {
			chain: [SMALL, BIG],
			windows,
			current: "workbuddy/hy4free"
		});
		await fail();
		assert.deepStrictEqual(selected, [BIG], "must prefer the destination that needs no compaction, got " + JSON.stringify(selected));
	});

	await test("E2 unknown windows keep the chain order", async () => {
		// resolveModelInfo throws for these, so no window is known: the configured
		// order must be preserved rather than guessed at.
		const { fail, selected } = await mount(mod, {
			chain: [SMALL, BIG],
			windows: {},
			current: "workbuddy/hy4free"
		});
		await fail();
		assert.deepStrictEqual(selected, [SMALL], "unknown windows must not be reordered, got " + JSON.stringify(selected));
	});

	await test("E3 a too-small entry is kept as a last resort", async () => {
		// Only a 32k entry exists; it needs compaction but must still be usable when
		// nothing better is offered (and the guards will contain any loop).
		const TINY = "codearts/glm-5.3";
		const windows = { [TINY]: 32000, "workbuddy/hy4free": 960000 };
		const { fail, selected } = await mount(mod, {
			chain: [TINY],
			windows,
			current: "workbuddy/hy4free"
		});
		await fail();
		assert.deepStrictEqual(selected, [TINY], "must still fall back to the only entry, got " + JSON.stringify(selected));
	});

	console.log(`\nWINDOW SUITE: ${passed} passed, ${failed} failed`);
	if (failed > 0) process.exitCode = 1;
}

await run();