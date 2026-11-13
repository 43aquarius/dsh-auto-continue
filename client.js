/**
 * dsh-auto-continue — browser half: the bundle's settings panel.
 *
 * Option-based form (v1.3.0): every setting is a <select> with a few curated
 * choices; the one marked ★推荐 is pre-selected. This replaces the free-text
 * / number inputs of v1.2.x. Two array settings (fallbackChain, ignoreCodes)
 * additionally offer a 自定义 option that reveals a textarea.
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

		const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
		const opt = (label, value, recommended) => ({ label, value, ...(recommended ? { recommended: true } : {}) });
		const CUSTOM = () => ({ label: "自定义（从模型列表选）…", custom: true });

		/**
		 * Known model routes of this deployment (provider -> model ids).
		 * Used to populate the fallback-chain picker so a person chooses from
		 * the current catalog instead of typing `provider/model` by hand.
		 * A Host-provided `modelOptions` config field (if present) is merged on
		 * top and wins, so this snapshot only matters when no live list exists.
		 */
		const KNOWN_MODELS = {
			"workbuddy-vision": ["hy4free", "hy4std", "hy3", "hy3-x", "glm-5.3", "glm-5.3-flash", "glm-5.2", "deepseek-v4.1-flash", "deepseek-v4-pro", "minimax-m3.1-flash", "kimi-k3.1-pro", "kimi-k3-1", "kimi-k2.8-preview", "step-5-preview", "mimo-v2.6-pro", "space-bunny"],
			raccoon: ["sn-deepseek-v4-1-flash-1017"],
			"trae-vision": ["glm-5.3", "deepseek-v4.1-flash"],
			"our-free-model-vision": ["minimaxai/minimax-m3.1-flash"],
			"kilo-auto": ["free"],
			"deepseek-account": ["deepseek-v4-pro"]
		};
		const modelChoices = (extra) => {
			const all = [];
			const push = (route) => {
				const s = String(route ?? "").trim();
				if (s === "" || all.includes(s)) return;
				all.push(s);
			};
			for (const [provider, models] of Object.entries(KNOWN_MODELS)) {
				for (const model of models) push(`${provider}/${model}`);
			}
			for (const route of Array.isArray(extra) ? extra : []) push(route);
			return all;
		};

		// Text <-> array codecs for the two custom-capable fields.
		const toText = (key, v) => key === "ignoreCodes"
			? (Array.isArray(v) ? v.join(", ") : String(v ?? ""))
			: (Array.isArray(v) ? v.join("\n") : String(v ?? ""));
		const fromText = (key, s) => key === "ignoreCodes"
			? String(s ?? "").split(/[,，\n]/).map((x) => x.trim()).filter(Boolean)
			: String(s ?? "").split("\n").map((x) => x.trim()).filter(Boolean);

		/**
		 * Field schema: { key, label, hint, group, options[], custom? }
		 * options[].value is the REAL config value (any type); the <select>
		 * uses the option index as its DOM value so complex values stay intact.
		 * The option with recommended:true is the default selection.
		 */
		const FIELDS = [
			// ---- 基础 ----
			{
				key: "enabled", label: "总开关", hint: "关闭后插件不介入任何失败", group: "basic",
				options: [opt("开启自动续接（推荐）", true, true), opt("关闭（不介入任何失败）", false)]
			},
			{
				key: "continuationText", label: "续接消息文本", hint: "切换模型后自动补发的消息", group: "basic",
				options: [opt("继续（推荐）", "继续", true), opt("继续完成上面的任务", "继续完成上面的任务"), opt("请从中断处继续", "请从中断处继续")]
			},
			{
				key: "fallbackChain", label: "优先切换模型链", hint: "按顺序尝试；选「自定义」后可从当前模型列表下拉逐个加入（也可手填 provider/model）", group: "basic", custom: true,
				options: [
					opt("自动枚举全部可用模型（推荐）", [], true),
					opt("优先 DeepSeek 官方模型", ["deepseek-account/deepseek-v4-pro"]),
					opt("优先免费大窗口模型", ["workbuddy-vision/hy4free", "our-free-model-vision/minimaxai/minimax-m3.1-flash"]),
					CUSTOM()
				]
			},
			{
				key: "ignoreCodes", label: "忽略的错误码", hint: "这些错误码不触发切换、原样报错", group: "basic", custom: true,
				options: [
					opt("默认（推荐）", ["ABORTED", "IMAGE_OFFLOAD_REQUIRED"], true),
					opt("仅忽略用户中止", ["ABORTED"]),
					opt("不忽略（所有失败都尝试切换）", []),
					CUSTOM()
				]
			},
			// ---- 切换行为 ----
			{
				key: "probe", label: "切换前探测", hint: "先发极小真实请求验证候选模型可用，避免切到死模型", group: "behavior",
				options: [opt("开启（推荐）", true, true), opt("关闭（直接切第一个候选）", false)]
			},
			{
				key: "maxSwitchesPerTurn", label: "每回合最大切换数", hint: "防止同一回合内循环切换", group: "behavior",
				options: [opt("1 次", 1), opt("2 次", 2), opt("3 次（推荐）", 3, true), opt("5 次", 5), opt("8 次", 8)]
			},
			{
				key: "maxProbeCandidates", label: "最多探测候选数", hint: "单次故障最多探测多少个候选模型", group: "behavior",
				options: [opt("3 个", 3), opt("4 个", 4), opt("6 个（推荐）", 6, true), opt("8 个", 8), opt("12 个", 12)]
			},
			{
				key: "switchAfterMs", label: "限流等待上限", hint: "上游提示的重置等待超过该值时不再等、直接切换", group: "behavior",
				options: [opt("1 分钟", 60000), opt("2 分钟（推荐）", 120000, true), opt("5 分钟", 300000), opt("不等待，立即切换", 0)]
			},
			{
				key: "resumeOnErrorIdle", label: "空闲兜底续接", hint: "回合以错误收尾且无排定续接时，空闲后自动重新探活并续接", group: "behavior",
				options: [opt("开启（推荐）", true, true), opt("关闭（只在请求失败时介入）", false)]
			},
			{
				key: "maxIdleResumes", label: "兜底续接上限", hint: "每会话每宿主生命周期内的最大兜底次数", group: "behavior",
				options: [opt("1 次", 1), opt("2 次", 2), opt("3 次（推荐）", 3, true), opt("5 次", 5), opt("10 次", 10)]
			},
			// ---- 高级 ----
			{
				key: "preferLargeContext", label: "优先选大窗口模型", hint: "目标窗口不小于当前模型，避免切换触发历史压缩（压缩摘要用旧模型，旧模型限流会失败）", group: "advanced",
				options: [opt("开启（推荐）", true, true), opt("关闭（按注册顺序选）", false)]
			},
			{
				key: "minContextWindow", label: "最小上下文窗口", hint: "低于该值的模型不作为切换目标", group: "advanced",
				options: [opt("不限制（推荐）", 0, true), opt("≥ 128K", 128000), opt("≥ 200K", 200000), opt("≥ 500K", 500000)]
			},
			{
				key: "probeTimeoutMs", label: "探测超时", hint: "单个探测请求的超时时间", group: "advanced",
				options: [opt("10 秒", 10000), opt("20 秒（推荐）", 20000, true), opt("30 秒", 30000), opt("60 秒", 60000)]
			},
			{
				key: "probeMaxTokens", label: "探测最大 token", hint: "探测请求允许的最大输出 token", group: "advanced",
				options: [opt("8", 8), opt("16（推荐）", 16, true), opt("32", 32), opt("64", 64)]
			},
			{
				key: "cooldownQuotaMs", label: "配额冷却", hint: "配额耗尽路由多久内不再被选中", group: "advanced",
				options: [opt("10 分钟", 600000), opt("30 分钟（推荐）", 1800000, true), opt("1 小时", 3600000), opt("2 小时", 7200000)]
			},
			{
				key: "cooldownRateLimitMs", label: "限流冷却", hint: "限流路由的冷却时长", group: "advanced",
				options: [opt("1 分钟", 60000), opt("5 分钟（推荐）", 300000, true), opt("10 分钟", 600000), opt("30 分钟", 1800000)]
			},
			{
				key: "cooldownAuthMs", label: "鉴权冷却", hint: "凭证/鉴权错误路由的冷却时长", group: "advanced",
				options: [opt("1 小时", 3600000), opt("6 小时（推荐）", 21600000, true), opt("12 小时", 43200000), opt("24 小时", 86400000)]
			},
			{
				key: "cooldownTransientMs", label: "临时错误冷却", hint: "其他临时错误的冷却时长", group: "advanced",
				options: [opt("1 分钟", 60000), opt("2 分钟（推荐）", 120000, true), opt("5 分钟", 300000), opt("10 分钟", 600000)]
			},
			{
				key: "cooldownModelFaultMs", label: "模型故障冷却", hint: "模型级持续故障（PI_AI_ERROR 等）的冷却时长", group: "advanced",
				options: [opt("10 分钟", 600000), opt("30 分钟（推荐）", 1800000, true), opt("1 小时", 3600000), opt("2 小时", 7200000)]
			},
			{
				key: "healthyTtlMs", label: "健康缓存时长", hint: "探测成功结果保留多久（期间直接复用、不再探测）", group: "advanced",
				options: [opt("5 分钟", 300000), opt("10 分钟（推荐）", 600000, true), opt("30 分钟", 1800000), opt("1 小时", 3600000)]
			}
		];

		const GROUPS = [["basic", "基础"], ["behavior", "切换行为"], ["advanced", "高级（探测与冷却）"]];
		const recommendedOf = (f) => (f.options.find((o) => o.recommended) ?? f.options[0]).value;
		const indexOfValue = (f, v) => f.options.findIndex((o) => !o.custom && eq(o.value, v));
		const customIndex = (f) => f.options.findIndex((o) => o.custom);

		const selectStyle = { width: "100%", boxSizing: "border-box", fontSize: 13, padding: "4px 6px" };
		const areaStyle = { width: "100%", boxSizing: "border-box", fontSize: 12, fontFamily: "var(--dsh-font-mono, monospace)", marginTop: 6, resize: "vertical" };
		const rowStyle = { display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 10 };
		const labelStyle = { flex: "0 0 210px", fontSize: 13, lineHeight: "26px", opacity: 0.9 };

		function FieldRow({ field, value, isCustom, onSelect, onCustomText, onPickModel, onRemoveChain, modelChoices: choices, disabled }) {
			const idx = isCustom
				? customIndex(field)
				: (() => { const i = indexOfValue(field, value); return i >= 0 ? i : (field.custom ? customIndex(field) : 0); })();
			const selector = h("select", {
				value: String(idx), disabled, style: selectStyle,
				onChange: (e) => {
					const i = Number(e.target.value);
					const o = field.options[i];
					if (o && o.custom) onSelect(field, true, value);
					else onSelect(field, false, o.value);
				}
			}, field.options.map((o, i) => h("option", { key: i, value: String(i) }, o.label + (o.recommended ? " ★推荐" : ""))));
			const showCustom = field.custom && (isCustom || idx === customIndex(field));
			let extra = null;
			if (showCustom && field.key === "fallbackChain") {
				// Model picker: choose from the current catalog instead of typing.
				const chain = Array.isArray(value) ? value : [];
				const available = (choices || []).filter((route) => !chain.includes(route));
				extra = h("div", null,
					h("div", { style: { display: "flex", gap: 6, marginTop: 6 } },
						h("select", {
							value: "", disabled: disabled || available.length === 0, style: { ...selectStyle, flex: 1 },
							onChange: (e) => {
								const picked = e.target.value;
								if (picked) onPickModel(field, picked);
								e.target.value = "";
							}
						},
						[
							h("option", { key: "__placeholder", value: "" }, available.length ? "从当前模型列表选择…" : "（当前列表已全部加入）"),
							...available.map((route, i) => h("option", { key: route + i, value: route }, route))
						]),
						h("button", {
							type: "button", disabled: disabled || chain.length === 0,
							onClick: () => onCustomText(field, ""), title: "清空模型链"
						}, "清空")),
					chain.length > 0
						? h("ol", { style: { margin: "6px 0 0 18px", padding: 0, fontSize: 12 } },
							chain.map((route, i) => h("li", { key: route + i, style: { marginBottom: 2 } },
								h("span", { style: { fontFamily: "var(--dsh-font-mono, monospace)" } }, route),
								h("button", {
									type: "button", disabled, style: { marginLeft: 8, fontSize: 11 },
									onClick: () => onRemoveChain(field, i)
								}, "移除"))))
						: h("div", { style: { fontSize: 11, opacity: 0.55, marginTop: 6 } }, "还没有加入模型；可从上方下拉列表逐个添加。"),
					h("textarea", {
						value: toText(field.key, value), rows: 3, disabled,
						placeholder: "也可直接手填，一行一个：\nworkbuddy-vision/glm-5.3\nraccoon/sn-deepseek-v4-1-flash-1017",
						style: areaStyle,
						onChange: (e) => onCustomText(field, e.target.value)
					}));
			} else if (showCustom) {
				extra = h("textarea", {
					value: toText(field.key, value), rows: 2, disabled,
					placeholder: "ABORTED, IMAGE_OFFLOAD_REQUIRED",
					style: areaStyle,
					onChange: (e) => onCustomText(field, e.target.value)
				});
			}
			return h("div", { style: rowStyle },
				h("label", { style: labelStyle }, field.label),
				h("div", { style: { flex: 1, minWidth: 0 } }, selector, extra,
					field.hint ? h("div", { style: { fontSize: 11, opacity: 0.55, marginTop: 3 } }, field.hint) : null));
		}

		function initialState(accepted) {
			const d = {}, c = {};
			for (const f of FIELDS) {
				const v = accepted[f.key];
				if (v !== undefined && indexOfValue(f, v) >= 0) { d[f.key] = v; }
				else if (f.custom && v !== undefined) { d[f.key] = v; c[f.key] = true; }
				else d[f.key] = recommendedOf(f);
			}
			return { d, c };
		}

		function Panel({ scope, snap }) {
			const accepted = snap.value ?? {};
			const writable = snap.writable !== false;
			const revision = snap.revision ?? 0;
			const [state, setState] = React.useState(() => initialState(accepted));
			const [savedAt, setSavedAt] = React.useState(null);
			const [error, setError] = React.useState(null);
			const [saving, setSaving] = React.useState(false);
			const draft = state.d, custom = state.c;
			// Live model routes if the Host ever publishes them; the baked
			// catalog covers deployments that do not.
			const choices = React.useMemo(() => modelChoices(accepted.modelOptions), [accepted.modelOptions]);

			const setVal = (key, val, isCustom) => {
				setState((s) => ({ d: { ...s.d, [key]: val }, c: { ...s.c, [key]: !!isCustom } }));
				setError(null);
			};
			const dirty = FIELDS.some((f) => !eq(draft[f.key], accepted[f.key]));

			const save = async () => {
				if (!dirty || saving || typeof scope.mutate !== "function") return;
				setSaving(true); setError(null);
				try {
					const ops = FIELDS.map((f) => ({ op: "set", path: [f.key], value: draft[f.key] }));
					const result = await scope.mutate(ops, revision);
					if (result && result.ok === false) setError(`保存被拒绝：${result.error?.message ?? "配置已变更，请重试"}`);
					else setSavedAt(Date.now());
				} catch (e) { setError(`保存失败：${e?.message ?? String(e)}`); }
				finally { setSaving(false); }
			};
			const resetRecommended = () => { setState(initialState({})); setError(null); setSavedAt(null); };

			return h("div", { "data-plugin-config": true, style: { fontSize: 13 } },
				h("div", { style: { fontSize: 12, opacity: 0.7, marginBottom: 8 } }, "已默认选中推荐设置（★推荐）；改动后点「保存」生效。"),
				!writable && h("p", { style: { color: "#c33" } }, "当前配置不可写（可能被更高层覆盖）"),
				...GROUPS.map(([group, title]) =>
					h("section", { key: title, style: { margin: "16px 0" } },
						h("h3", { style: { fontSize: 13, margin: "0 0 8px", opacity: 0.85 } }, title),
						FIELDS.filter((f) => f.group === group).map((f) =>
							h(FieldRow, {
								key: f.key, field: f, value: draft[f.key], isCustom: !!custom[f.key], disabled: !writable,
								modelChoices: choices,
								onSelect: (field, isCustom, val) => setVal(field.key, val, isCustom),
								onCustomText: (field, text) => setVal(field.key, fromText(field.key, text), true),
								onPickModel: (field, route) => {
									const cur = Array.isArray(draft[field.key]) ? draft[field.key] : [];
									if (cur.includes(route)) return;
									setVal(field.key, [...cur, route], true);
								},
								onRemoveChain: (field, index) => {
									const cur = Array.isArray(draft[field.key]) ? draft[field.key] : [];
									setVal(field.key, cur.filter((_, i) => i !== index), true);
								}
							})))),
				h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 16, flexWrap: "wrap" } },
					h("button", { type: "button", disabled: !dirty || saving || !writable, onClick: save }, saving ? "保存中…" : "保存"),
					h("button", { type: "button", disabled: !dirty || saving, onClick: () => { setState(initialState(accepted)); setError(null); } }, "撤销改动"),
					h("button", { type: "button", disabled: saving || !writable, onClick: resetRecommended }, "恢复推荐设置"),
					dirty && h("span", { style: { fontSize: 12, opacity: 0.6 } }, "有未保存的修改"),
					savedAt && !dirty && !error && h("span", { style: { fontSize: 12, opacity: 0.6 } }, "已保存"),
					error && h("span", { style: { fontSize: 12, color: "#c33" } }, error)));
		}

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
			// Keying on revision remounts on external config changes, so all hooks
			// inside Panel run unconditionally before any early return.
			return h(Panel, { key: snap.revision ?? 0, scope, snap });
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
				// Bundle detail page.
				safe("plugins.bundle.config", () =>
					ctx.slots.inject("plugins.bundle.config", () =>
						ctx.slots.register({ name: "plugins.bundle.config", key: "dsh-auto-continue" }, render)));
				// Row Configure page (summary on the card, full form on the page).
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
