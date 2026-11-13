// Render + interactivity smoke test for the bridge-driven settings panel.
//
// v1.5.0 replaced the framework config form with the plugin's own Host bridge,
// and replaced every free-text input with a choice. This test therefore pins:
//   - the panel renders from a Host state payload (no form service needed)
//   - NOTHING in the tree is a text input or textarea (choices only)
//   - one <select> per curated field, and the model chain is a checkbox list
//   - the model chain is built from the LIVE catalog the Host returned
//   - saving POSTs the dirty ops to the bridge
import fs from "node:fs";
import vm from "node:vm";

const BUNDLE = "C:/Users/23529/Documents/deepseek-harness/default-workspace/dsh-auto-continue";
const src = fs.readFileSync(BUNDLE + "/client.js", "utf8");

// ---- mock React ----------------------------------------------------------
// Per-component hook slots, mirroring React's per-fiber hook ordering so
// sibling components do not share state.
let hookStore = new Map();
let currentComponent = null;
let hookIndex = 0;
function withHooks(fn, props) {
	const prevComponent = currentComponent, prevIndex = hookIndex;
	currentComponent = fn;
	hookIndex = 0;
	if (!hookStore.has(fn)) hookStore.set(fn, []);
	try {
		return fn(props);
	} finally {
		currentComponent = prevComponent;
		hookIndex = prevIndex;
	}
}
const React = {
	createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
	useState: (init) => {
		const slots = hookStore.get(currentComponent);
		const i = hookIndex++;
		if (slots[i] === undefined) slots[i] = typeof init === "function" ? init() : init;
		return [slots[i], (v) => { if (typeof v === "function") slots[i] = v(slots[i]); else slots[i] = v; }];
	},
	useEffect: () => { hookIndex++; },
	useMemo: (fn) => { hookIndex++; return fn(); },
	useCallback: (fn) => { hookIndex++; return fn; },
	useRef: (init) => {
		const slots = hookStore.get(currentComponent);
		const i = hookIndex++;
		if (slots[i] === undefined) slots[i] = { current: init };
		return slots[i];
	}
};

// ---- mock fetch (the bridge) --------------------------------------------
const CONFIG = {
	enabled: true,
	fallbackChain: ["trae-vision/glm-5.3", "our-free-model/combo:recommended-free"],
	ignoreCodes: ["ABORTED"],
	maxSwitchesPerTurn: 0,
	maxProbeCandidates: 0,
	maxIdleResumes: 0,
	probe: true
};
const MODELS = [
	{ route: "our-free-model/combo:recommended-free", provider: "our-free-model", model: "combo:recommended-free" },
	{ route: "our-free-model/glm-5.3-flash-free", provider: "our-free-model", model: "glm-5.3-flash-free" },
	{ route: "trae-vision/glm-5.3", provider: "trae-vision", model: "glm-5.3" }
];
const fetchCalls = [];
function fakeFetch(url, init) {
	fetchCalls.push({ url: String(url), init });
	if (String(url).endsWith("/state")) {
		return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, writable: true, config: CONFIG, models: MODELS }) });
	}
	if (String(url).endsWith("/save")) {
		return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, saved: 1 }) });
	}
	return Promise.resolve({ ok: false, status: 404, json: async () => ({ ok: false }) });
}

// ---- mock module loader --------------------------------------------------
let plugin = null;
const sandbox = {
	window: { __ModuleLoader__: { load: (def) => { plugin = def; } } },
	React, console, fetch: fakeFetch,
	setTimeout: (fn) => { void fn; return 0; },
	clearTimeout: () => {}
};
vm.runInNewContext(src, sandbox, { filename: "client.js" });
if (!plugin) throw new Error("client.js did not register a module");

const requireStub = (name) => {
	if (name === "react") return React;
	throw new Error("unexpected require: " + name);
};
const built = plugin.factory(requireStub);

// ---- mock ctx (baseline services only) -----------------------------------
let registered = null;
const ctx = {
	get: () => undefined, // no configForms in this build — the point of v1.5.0
	on: () => () => {},
	effect: () => () => {},
	logger: { warn: () => {}, info: () => {} },
	slots: {
		inject: (key, cb) => cb(),
		register: (opts, render) => { if (!registered) registered = { opts, render }; return () => {}; }
	}
};
built.apply(ctx);
if (!registered) throw new Error("no slot registration happened");
if (JSON.stringify(built.inject) !== JSON.stringify(["slots", "locale"])) {
	throw new Error("inject must stay on baseline keys only, got " + JSON.stringify(built.inject));
}

// ---- tree helpers --------------------------------------------------------
function resolveTree(el) {
	if (el == null || typeof el !== "object") return el;
	if (typeof el.type === "function") return resolveTree(withHooks(el.type, { ...el.props, children: el.children }));
	if (Array.isArray(el.children)) return { ...el, children: el.children.map(resolveTree) };
	return el;
}
function findAll(el, pred, acc = []) {
	if (!el || typeof el !== "object") return acc;
	if (pred(el)) acc.push(el);
	for (const c of el.children ?? []) findAll(c, pred, acc);
	return acc;
}
const textOf = (el) => (el.children ?? []).flat(Infinity).filter((x) => typeof x === "string" || typeof x === "number").join("");

// The panel's first paint is a loading state; pre-seed its hook slot with a
// resolved Host payload so the full form renders in one pass.
const shell = registered.render();
if (typeof shell.type !== "function") throw new Error("settings cell must render a component");
const Loading = shell.type;
hookStore.set(Loading, [{ phase: "ready", config: CONFIG, writable: true, models: MODELS }]);

const tree = resolveTree(registered.render());

const selects = findAll(tree, (e) => e.type === "select");
const buttons = findAll(tree, (e) => e.type === "button");
const textareas = findAll(tree, (e) => e.type === "textarea");
const textInputs = findAll(tree, (e) => e.type === "input" && String(e.props.type ?? "text") !== "checkbox");
const checkboxes = findAll(tree, (e) => e.type === "input" && e.props.type === "checkbox");

console.log("selects:", selects.length, "buttons:", buttons.length,
	"textareas:", textareas.length, "textInputs:", textInputs.length, "checkboxes:", checkboxes.length);

// 1. No free-text entry anywhere: the whole panel is choices.
if (textareas.length !== 0) throw new Error("panel must not contain a textarea (choices only)");
if (textInputs.length !== 0) throw new Error("panel must not contain a text input (choices only)");

// 2. One <select> per curated field (every field except the model chain), plus
//    the chain's provider filter — so 20 selects and 19 of them are fields.
const optionTexts = (sel) => (sel.children ?? []).filter((o) => o.type === "option").map((o) => textOf(o));
const fieldSelects = selects.filter((sel) => optionTexts(sel).some((t) => t.includes("★推荐")));
const filterSelects = selects.filter((sel) => optionTexts(sel).some((t) => t.startsWith("全部厂商")));
console.log("fieldSelects:", fieldSelects.length, "filterSelects:", filterSelects.length);
if (fieldSelects.length !== 19) throw new Error(`expected 19 field selects, got ${fieldSelects.length}`);
if (filterSelects.length !== 1) throw new Error(`expected 1 provider filter select, got ${filterSelects.length}`);
if (!optionTexts(filterSelects[0]).some((t) => t.includes(`（${MODELS.length} 个模型）`))) {
	throw new Error("provider filter must report the live catalog size, got " + optionTexts(filterSelects[0]).join(" | "));
}

// 3. The model chain is a checkbox list over the LIVE catalog, grouped by
//    provider, nothing else.
if (checkboxes.length !== MODELS.length) {
	throw new Error(`chain list must offer every live route: expected ${MODELS.length} checkboxes, got ${checkboxes.length}`);
}
if (!selects.length) throw new Error("no field rendered");

// 4. Every curated field leads with its ★推荐 option and defaults to it.
for (const sel of fieldSelects) {
	const opts = optionTexts(sel);
	if (opts.length < 2) throw new Error("every select needs at least two choices");
	if (!opts.some((t) => t.includes("★推荐"))) throw new Error("a select is missing its ★推荐 marker: " + opts[0]);
}

// 5. The three retry caps default to the unlimited option, per the user's ask.
// The row is a flex div whose first child is the label cell, so match on the
// label text owned directly by that cell rather than on a subtree scan.
const labelCells = findAll(tree, (e) => e.type === "div" && textOf(e).trim() === "每回合最大切换数"
	|| e.type === "div" && textOf(e).trim() === "最多探测候选数"
	|| e.type === "div" && textOf(e).trim() === "兜底续接上限");
if (labelCells.length !== 3) throw new Error("expected the three retry-cap label cells, got " + labelCells.length);
for (const label of ["每回合最大切换数", "最多探测候选数", "兜底续接上限"]) {
	const row = findAll(tree, (e) => e.type === "div"
		&& Array.isArray(e.children)
		&& e.children.some((c) => c && c.type === "div" && textOf(c).trim() === label))[0];
	if (!row) throw new Error(`field row not found: ${label}`);
	const sel = findAll(row, (e) => e.type === "select")[0];
	if (!sel) throw new Error(`select not found in row: ${label}`);
	const opts = (sel.children ?? []).filter((o) => o.type === "option");
	const idx = Number(sel.props.value);
	if (!textOf(opts[idx]).includes("不限制")) {
		throw new Error(`${label} must default to 不限制, selected: ${textOf(opts[idx])}`);
	}
}

// 6. The save control exists and starts disabled (nothing dirty yet).
const saveBtn = buttons.find((b) => textOf(b) === "保存");
if (!saveBtn) throw new Error("save button missing");
if (!saveBtn.props.disabled) throw new Error("save must start disabled when nothing is dirty");

console.log("PANEL SMOKE TEST PASS (choices only, live chain catalog, save control)");

// ---- save path: dirty an option, then POST to the bridge -----------------
// Flip one select through its onChange, re-render, and click 保存.
const panelHost = shell.type;
const panelProps = { initial: CONFIG, models: MODELS, writable: true };
const PanelComp = (function findPanel() {
	const el = withHooks(panelHost, panelProps);
	return el.type;
})();
const firstSelectRow = (function () {
	const rendered = resolveTree(withHooks(PanelComp, panelProps));
	const sel = findAll(rendered, (e) => e.type === "select")[0];
	const onChange = sel.props.onChange;
	onChange({ target: { value: String((sel.children.length > 1) ? 1 : 0) } });
	return { sel, onChange };
})();
// Draft changed -> re-render sees dirty=true and an enabled save button.
const dirtyTree = resolveTree(withHooks(PanelComp, panelProps));
const dirtySave = findAll(dirtyTree, (e) => e.type === "button" && textOf(e) === "保存")[0];
if (!dirtySave) throw new Error("save button vanished after edit");
if (dirtySave.props.disabled) throw new Error("save must enable once a field is dirty");

fetchCalls.length = 0;
await dirtySave.props.onClick();
const saveCall = fetchCalls.find((c) => c.url.endsWith("/save"));
if (!saveCall) throw new Error("save did not POST to the bridge");
const payload = JSON.parse(saveCall.init.body);
if (!Array.isArray(payload.ops) || payload.ops.length !== 1) {
	throw new Error("save must send exactly the dirty ops, got " + JSON.stringify(payload));
}
const op = payload.ops[0];
if (op.op !== "set" || !Array.isArray(op.path) || op.path.length !== 1) {
	throw new Error("ops must be {op:'set', path:[key], value}, got " + JSON.stringify(op));
}
if (op.path[0] === "fallbackChain") throw new Error("the chain was not edited; another field should be dirty");
// No revision is ever sent: that is what made saving fail before v1.5.0.
if ("expectedRevision" in payload || "revision" in payload) {
	throw new Error("save must not send a revision (stale revisions caused the conflict)");
}
console.log("BRIDGE SAVE PASS (op:", op.path[0] + "=" + JSON.stringify(op.value) + ", no revision sent)");
