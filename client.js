/**
 * dsh-auto-continue — browser half: the bundle's settings panel.
 *
 * Registers into BOTH plugin-detail slots the Plugins page declares:
 *   - `plugins.bundle.config` (key = bundle package name) — bundle detail page
 *   - `plugins.row.config`    (key = `<pkg>#<row id>`)     — row Configure page
 * The Host Config namespace is read through the optional `configForms` service.
 * We deliberately do NOT list `configForms` in `inject`: it is not a baseline
 * Client service key, so injecting it leaves the plugin pending forever and no
 * slot ever registers (the exact bug of v1.2.0). Only `slots` + `locale` are
 * baseline; everything else is obtained with ctx.get() and degrades gracefully.
 */
window.__ModuleLoader__.load({
	id: "dsh-auto-continue",
	factory: (require) => {
		const React = require("react");
		const h = React.createElement;

		const FIELDS = [
			["enabled", "bool", "总开关", "关闭后不介入任何失败", "basic"],
			["continuationText", "text", "续接消息文本", "切换模型后自动补发的消息", "basic"],
			["fallbackChain", "models", "优先切换模型链", "按顺序尝试（provider/model），一行一个；留空则自动枚举全部可用模型", "basic"],
			["ignoreCodes", "codes", "忽略的错误码", "这些错误码不切换，原样报错（逗号分隔）", "basic"],
			["probe", "bool", "切换前探测", "发送极小真实请求验证候选模型可用", "behavior"],
			["maxSwitchesPerTurn", "number", "每回合最大切换数", "防止循环切换", "behavior"],
			["maxProbeCandidates", "number", "最多探测候选数", "单次故障的探测上限", "behavior"],
			["switchAfterMs", "number", "等待上限（毫秒）", "限流重置提示超过该值时不再等待", "behavior"],
			["resumeOnErrorIdle", "bool", "空闲兜底续接", "回合以错误收尾且无排定续接时自动续接", "behavior"],
			["maxIdleResumes", "number", "兜底续接上限", "每会话每宿主生命周期的最大次数", "behavior"],
			["preferLargeContext", "bool", "优先选大窗口模型", "切换目标窗口不小于当前模型，避免触发历史压缩（压缩摘要用旧模型，旧模型限流时会失败）", "advanced"],
			["minContextWindow", "number", "最小上下文窗口", "低于该值（token）的模型不作为切换目标；0=不限制", "advanced"],
			["probeTimeoutMs", "number", "探测超时（毫秒）", "", "advanced"],
			["probeMaxTokens", "number", "探测最大 token", "", "advanced"],
			["cooldownQuotaMs", "number", "配额冷却（毫秒）", "", "advanced"],
			["cooldownRateLimitMs", "number", "限流冷却（毫秒）", "", "advanced"],
			["cooldownAuthMs", "number", "鉴权冷却（毫秒）", "", "advanced"],
			["cooldownTransientMs", "number", "临时错误冷却（毫秒）", "", "advanced"],
			["cooldownModelFaultMs", "number", "模型故障冷却（毫秒）", "", "advanced"],
			["healthyTtlMs", "number", "健康缓存时长（毫秒）", "", "advanced"]
		];
		const GROUPS = [["basic", "基础"], ["behavior", "切换行为"], ["advanced", "高级（探测与冷却）"]];
		const mono = { fontFamily: "var(--dsh-font-mono, monospace)", fontSize: 12 };

		const section = (title, children) =>
			h("section", { key: title, style: { margin: "16px 0" } },
				h("h3", { style: { fontSize: 13, margin: "0 0 8px", opacity: 0.85 } }, title), children);

		function FieldRow({ field, draft, setDraft, disabled }) {
			const [key, type, label, hint] = field;
			const value = draft[key];
			let control;
			if (type === "bool") {
				control = h("input", { type: "checkbox", checked: value === true, disabled, onChange: (e) => setDraft(key, e.target.checked) });
			} else if (type === "models" || type === "codes") {
				const joined = type === "models" ? "\n" : ", ";
				control = h("textarea", {
					value: Array.isArray(value) ? value.join(joined) : String(value ?? ""),
					disabled, rows: type === "models" ? 4 : 2,
					placeholder: type === "models" ? "例如：\ndoubao/9\nraccoon/sn-sensenova-6-8-flash" : "ABORTED, IMAGE_OFFLOAD_REQUIRED",
					style: { width: "100%", ...mono, resize: "vertical", boxSizing: "border-box" },
					onChange: (e) => setDraft(key, e.target.value)
				});
			} else {
				control = h("input", {
					type: type === "number" ? "number" : "text",
					value: value === undefined || value === null ? "" : String(value),
					disabled,
					style: { width: type === "number" ? 140 : "100%", boxSizing: "border-box" },
					onChange: (e) => setDraft(key, e.target.value)
				});
			}
			return h("div", { key, style: { display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 10 } },
				h("label", { style: { flex: "0 0 210px", fontSize: 13, lineHeight: "24px", opacity: 0.9 } }, label),
				h("div", { style: { flex: 1, minWidth: 0 } }, control,
					hint ? h("div", { style: { fontSize: 11, opacity: 0.55, marginTop: 2 } }, hint) : null));
		}

		const norm = (v, type) => {
			if (type === "models") return Array.isArray(v) ? v.join("\n") : String(v ?? "");
			if (type === "codes") return Array.isArray(v) ? v.join(", ") : String(v ?? "");
			if (type === "number") return Number(v);
			if (type === "bool") return Boolean(v);
			return String(v ?? "");
		};
		const coerce = (type, value) => {
			if (type === "models") return String(value ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
			if (type === "codes") return String(value ?? "").split(/[,，\n]/).map((s) => s.trim()).filter(Boolean);
			if (type === "number") { const n = Number(value); return Number.isFinite(n) ? n : 0; }
			if (type === "bool") return Boolean(value);
			return String(value ?? "");
		};

		function AutoContinueSettings({ scope }) {
			const [, setVersion] = React.useState(0);
			React.useEffect(() => {
				if (!scope || typeof scope.subscribe !== "function") return undefined;
				return scope.subscribe(() => setVersion((n) => n + 1));
			}, [scope]);

			const snap = scope && typeof scope.getSnapshot === "function" ? scope.getSnapshot() : undefined;
			if (!snap) {
				return h("div", { "data-plugin-config": true, style: { fontSize: 13, opacity: 0.7 } },
					"配置服务暂不可用；请确认 Host 侧 auto-continue 行已启用，或重启 DSH。");
			}
			const accepted = snap.value ?? {};
			const writable = snap.writable !== false;
			const revision = snap.revision ?? 0;

			const [draft, setDraftState] = React.useState(() => ({ ...accepted }));
			const [stagedRev, setStagedRev] = React.useState(revision);
			if (stagedRev !== revision) { setStagedRev(revision); setDraftState({ ...accepted }); }
			const [savedAt, setSavedAt] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [saving, setSaving] = React.useState(false);

			const setDraft = (key, value) => { setDraftState((prev) => ({ ...prev, [key]: value })); setError(null); };
			const dirty = FIELDS.some(([key, type]) => norm(draft[key], type) !== norm(accepted[key], type));

			const save = async () => {
				if (!dirty || saving || typeof scope.mutate !== "function") return;
				setSaving(true); setError(null);
				try {
					const ops = FIELDS.map(([key, type]) => ({ op: "set", path: [key], value: coerce(type, draft[key]) }));
					const result = await scope.mutate(ops, revision);
					if (result && result.ok === false) setError(`保存被拒绝：${result.error?.message ?? "revision 冲突，请重试"}`);
					else setSavedAt(Date.now());
				} catch (e) { setError(`保存失败：${e?.message ?? String(e)}`); }
				finally { setSaving(false); }
			};

			return h("div", { "data-plugin-config": true, style: { fontSize: 13 } },
				!writable && h("p", { style: { color: "#c33" } }, "当前配置不可写（可能被更高层覆盖）"),
				...GROUPS.map(([group, title]) => section(title,
					FIELDS.filter((f) => f[4] === group).map((f) =>
						h(FieldRow, { key: f[0], field: f, draft, setDraft, disabled: !writable })))),
				h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 16 } },
					h("button", { type: "button", disabled: !dirty || saving || !writable, onClick: save }, saving ? "保存中…" : "保存"),
					h("button", { type: "button", disabled: !dirty || saving, onClick: () => { setDraftState({ ...accepted }); setError(null); } }, "重置"),
					dirty && h("span", { style: { fontSize: 12, opacity: 0.6 } }, "有未保存的修改"),
					savedAt && !dirty && !error && h("span", { style: { fontSize: 12, opacity: 0.6 } }, "已保存"),
					error && h("span", { style: { fontSize: 12, color: "#c33" } }, error)));
		}

		return {
			// Baseline Client service keys only. Adding a non-baseline key here
			// leaves the plugin pending forever and no slot ever registers.
			inject: ["slots", "locale"],
			apply(ctx) {
				const forms = ctx.get ? ctx.get("configForms") : undefined;
				const scope = forms && typeof forms.get === "function" ? forms.get("auto-continue") : undefined;
				const render = () => h(AutoContinueSettings, { scope });
				const safe = (tag, fn) => {
					try { fn(); } catch (e) {
						if (ctx.logger && ctx.logger.warn) ctx.logger.warn(`auto-continue: ${tag} failed: ${e && e.message ? e.message : String(e)}`);
					}
				};
				// Bundle detail page (main entry the user asked for).
				safe("plugins.bundle.config", () =>
					ctx.slots.inject("plugins.bundle.config", () =>
						ctx.slots.register({ name: "plugins.bundle.config", key: "dsh-auto-continue" }, render)));
				// Row Configure page (second entry; shows a summary on the card).
				safe("plugins.row.config", () =>
					ctx.slots.inject("plugins.row.config", () =>
						ctx.slots.register({ name: "plugins.row.config", key: "dsh-auto-continue#auto-continue" },
							(slotProps) => slotProps && slotProps.view === "summary"
								? h("span", null, "自动续接与模型切换 · 可配置优先模型链、探测与冷却")
								: render())));
			}
		};
	}
});
