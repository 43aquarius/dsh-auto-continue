/**
 * @local/auto-continue — browser half: the bundle's settings panel.
 *
 * Design (v1.6.0):
 *   - EVERY setting is a choice. There is no free-text input anywhere: the
 *     model chain is a grouped checkbox list over the LIVE provider catalog,
 *     and the remaining fields are curated <select>s.
 *   - The catalog is NEVER baked into this file. Provider ids change between
 *     deployments (see `workbuddy`, `trae`, `raccoon`, `loomy`, `our-free-model`
 *     in this profile), so a hardcoded list is wrong the moment a plugin is
 *     renamed. The Host enumerates `llm.listProviders()/listModels()` per
 *     request; this half unions the answers over a short poll window, because
 *     providers register asynchronously and a single early fetch misses them.
 *   - Persistence goes through the plugin's OWN Host bridge
 *     (`/api/dsh-auto-continue-settings/save` -> `settings.mutate`). The Host
 *     Config fields are `.volatile()`, which `settings.mutate` requires.
 *   - Only baseline services are injected (`slots`, `locale`).
 */
window.__ModuleLoader__.load({
	id: "@local/auto-continue",
	factory: (require) => {
		const React = require("react");
		const h = React.createElement;

		const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
		const opt = (label, value, recommended) => ({ label, value, ...(recommended ? { recommended: true } : {}) });

		const BRIDGE = "/api/dsh-auto-continue-settings";
		/** Providers register lazily; sample a few times and union the answers. */
		const POLL_DELAYS_MS = [0, 700, 1600, 3200, 6000];

		/**
		 * Field schema. `options[].value` is the REAL config value; the <select>
		 * uses the option index as its DOM value so complex values stay intact.
		 * A field with `kind: "chain"` renders the live model picker instead.
		 */
		const FIELDS = [
			{
				key: "enabled", label: "总开关", hint: "关闭后插件不介入任何失败", group: "basic",
				options: [opt("开启自动续接（推荐）", true, true), opt("关闭（不介入任何失败）", false)]
			},
			{
				key: "continuationText", label: "续接消息文本", hint: "切换模型后自动补发的消息（仅预设）", group: "basic",
				options: [
					opt("继续（推荐）", "继续", true),
					opt("继续完成上面的任务", "继续完成上面的任务"),
					opt("请从中断处继续", "请从中断处继续"),
					opt("接着做，不用解释", "接着做，不用解释")
				]
			},
			{
				key: "fallbackChain", label: "优先切换模型链", hint: "勾选即按顺序优先尝试；不勾选＝自动枚举全部可用模型", group: "basic",
				kind: "chain"
			},
			{
				key: "ignoreCodes", label: "忽略的错误码", hint: "这些错误码不触发切换、原样报错（仅预设）", group: "basic",
				options: [
					opt("默认（推荐）", ["ABORTED", "IMAGE_OFFLOAD_REQUIRED"], true),
					opt("仅忽略用户中止", ["ABORTED"]),
					opt("不忽略（所有失败都尝试切换）", [])
				]
			},
			{
				key: "probe", label: "切换前探测", hint: "先发极小真实请求验证候选模型可用，避免切到死模型", group: "behavior",
				options: [opt("开启（推荐）", true, true), opt("关闭（直接切第一个候选）", false)]
			},
			{
				key: "maxSwitchesPerTurn", label: "每回合最大切换数", hint: "同一回合内最多自动切换几次；0=不限制（推荐，会尝试全部候选模型）", group: "behavior",
				options: [opt("不限制（推荐）", 0, true), opt("1 次", 1), opt("2 次", 2), opt("3 次", 3), opt("5 次", 5), opt("8 次", 8)]
			},
			{
				key: "maxProbeCandidates", label: "最多探测候选数", hint: "单次故障最多探测多少个候选模型；0=不限制（推荐，会探测所有候选）", group: "behavior",
				options: [opt("不限制（推荐）", 0, true), opt("3 个", 3), opt("4 个", 4), opt("6 个", 6), opt("8 个", 8), opt("12 个", 12)]
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
				key: "maxIdleResumes", label: "兜底续接上限", hint: "每会话每宿主生命周期内的最大兜底次数；0=不限制（推荐，有内置安全上限防死循环）", group: "behavior",
				options: [opt("不限制（推荐）", 0, true), opt("1 次", 1), opt("2 次", 2), opt("3 次", 3), opt("5 次", 5), opt("10 次", 10)]
			},
			{
				key: "preferLargeContext", label: "优先选大窗口模型", hint: "目标窗口不小于当前模型，避免切换触发历史压缩", group: "advanced",
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
				key: "cooldownModelFaultMs", label: "模型故障冷却", hint: "模型级持续故障的冷却时长", group: "advanced",
				options: [opt("10 分钟", 600000), opt("30 分钟（推荐）", 1800000, true), opt("1 小时", 3600000), opt("2 小时", 7200000)]
			},
			{
				key: "healthyTtlMs", label: "健康缓存时长", hint: "探测成功结果保留多久（期间直接复用、不再探测）", group: "advanced",
				options: [opt("5 分钟", 300000), opt("10 分钟（推荐）", 600000, true), opt("30 分钟", 1800000), opt("1 小时", 3600000)]
			}
		];

		const GROUPS = [["basic", "基础"], ["behavior", "切换行为"], ["advanced", "高级（探测与冷却）"]];

		const recommendedOf = (f) => (f.options.find((o) => o.recommended) ?? f.options[0]).value;
		const indexOfValue = (f, v) => f.options.findIndex((o) => eq(o.value, v));
		const providerOf = (route) => {
			const at = String(route).indexOf("/");
			return at < 0 ? "(unknown)" : String(route).slice(0, at);
		};

		const selectStyle = { width: "100%", boxSizing: "border-box", fontSize: 13, padding: "4px 6px" };
		const labelStyle = { flex: "0 0 210px", fontSize: 13, lineHeight: "26px", opacity: 0.9 };
		const rowStyle = { display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 10 };
		const boxStyle = {
			border: "1px solid var(--dsw-alias-border-secondary, #d0d0d0)",
			borderRadius: 6, padding: 8
		};

		function SelectField({ field, value, onChange, disabled }) {
			const found = indexOfValue(field, value);
			const idx = found >= 0 ? found : field.options.findIndex((o) => o.recommended);
			return h("select", {
				value: String(idx < 0 ? 0 : idx),
				disabled,
				style: selectStyle,
				onChange: (e) => {
					const chosen = field.options[Number(e.target.value)];
					if (chosen) onChange(field.key, chosen.value);
				}
			}, field.options.map((o, i) => h("option", { key: i, value: String(i) }, o.label + (o.recommended ? " ★推荐" : ""))));
		}

		/**
		 * Ordered checkbox list over the LIVE catalog, grouped by provider.
		 * A provider <select> narrows the list; "全部" shows everything. No text
		 * entry anywhere, so nothing needs typing to reach all 159+ routes.
		 */
		function ChainField({ value, models, onChange, disabled, onRefresh, refreshing }) {
			const chain = Array.isArray(value) ? value.filter((x) => typeof x === "string") : [];
			// Accept either plain route strings or `{route}` records; the Host sends
			// records, tests and older payloads may send strings.
			const catalogModels = React.useMemo(() => {
				const list = (Array.isArray(models) ? models : [])
					.map((m) => (typeof m === "string" ? m : m && typeof m.route === "string" ? m.route : undefined))
					.filter((m) => typeof m === "string" && m !== "");
				return Array.from(new Set(list)).sort();
			}, [models]);
			const [providerFilter, setProviderFilter] = React.useState("__all__");

			const providers = React.useMemo(() => {
				const set = new Set(catalogModels.map(providerOf));
				return Array.from(set).sort();
			}, [catalogModels]);

			const visible = providerFilter === "__all__"
				? catalogModels
				: catalogModels.filter((route) => providerOf(route) === providerFilter);

			// Group by provider for display, preserving catalog order within a group.
			const grouped = React.useMemo(() => {
				const map = new Map();
				for (const route of visible) {
					const provider = providerOf(route);
					if (!map.has(provider)) map.set(provider, []);
					map.get(provider).push(route);
				}
				return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
			}, [visible]);

			const toggle = (route) => {
				const next = chain.includes(route) ? chain.filter((x) => x !== route) : [...chain, route];
				onChange("fallbackChain", next);
			};
			const move = (route, delta) => {
				const at = chain.indexOf(route);
				if (at < 0) return;
				const to = at + delta;
				if (to < 0 || to >= chain.length) return;
				const next = chain.slice();
				const [item] = next.splice(at, 1);
				next.splice(to, 0, item);
				onChange("fallbackChain", next);
			};

			const filterIdx = providerFilter === "__all__" ? 0 : providers.indexOf(providerFilter) + 1;

			return h("div", null,
				h("div", { style: { fontSize: 12, opacity: 0.75, marginBottom: 6 } },
					chain.length === 0
						? `未勾选任何模型 → 自动枚举全部可用模型（当前目录 ${models.length} 个）`
						: `已选 ${chain.length} 个，按顺序优先尝试（当前目录 ${models.length} 个）：`),
				chain.length === 0 ? null : h("div", { style: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 } },
					chain.map((route, i) => h("span", {
						key: route,
						style: {
							display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12,
							border: "1px solid var(--dsw-alias-border-secondary, #d0d0d0)",
							borderRadius: 12, padding: "2px 6px 2px 10px"
						}
					},
						h("span", null, `${i + 1}. ${route}`),
						h("button", { type: "button", disabled: disabled || i === 0, title: "上移", onClick: () => move(route, -1), style: { cursor: "pointer", border: "none", background: "transparent", opacity: i === 0 ? 0.3 : 0.8 } }, "↑"),
						h("button", { type: "button", disabled: disabled || i === chain.length - 1, title: "下移", onClick: () => move(route, 1), style: { cursor: "pointer", border: "none", background: "transparent", opacity: i === chain.length - 1 ? 0.3 : 0.8 } }, "↓"),
						h("button", { type: "button", disabled, title: "移除", onClick: () => toggle(route), style: { cursor: "pointer", border: "none", background: "transparent" } }, "×")
					))
				),
				h("div", { style: { display: "flex", gap: 6, marginBottom: 6 } },
					h("select", {
						value: String(filterIdx), disabled, style: { ...selectStyle, flex: 1 },
						onChange: (e) => {
							const i = Number(e.target.value);
							setProviderFilter(i === 0 ? "__all__" : (providers[i - 1] ?? "__all__"));
						}
					},
						[
							h("option", { key: "__all__", value: "0" }, `全部厂商（${models.length} 个模型）`),
							...providers.map((p, i) => {
								const count = models.filter((r) => providerOf(r) === p).length;
								return h("option", { key: p, value: String(i + 1) }, `${p}（${count}）`);
							})
						]
					),
					h("button", {
						type: "button", disabled: disabled || refreshing, onClick: onRefresh,
						style: { fontSize: 12, padding: "3px 10px", cursor: disabled || refreshing ? "default" : "pointer", whiteSpace: "nowrap" }
					}, refreshing ? "读取中…" : "刷新模型列表")
				),
				h("div", { style: { ...boxStyle, maxHeight: 300, overflowY: "auto" } },
					models.length === 0
						? h("div", { style: { fontSize: 12, opacity: 0.7 } }, "Host 未返回任何模型；请点「刷新模型列表」或重启 DSH。")
						: grouped.map(([provider, routes]) => h("div", { key: provider, style: { marginBottom: 6 } },
							h("div", { style: { fontSize: 12, fontWeight: 600, opacity: 0.85, margin: "2px 0 2px" } }, `${provider}（${routes.length}）`),
							routes.map((route) => h("label", {
								key: route,
								style: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, lineHeight: "20px", cursor: "pointer", paddingLeft: 8 }
							},
								h("input", {
									type: "checkbox",
									checked: chain.includes(route),
									disabled,
									onChange: () => toggle(route)
								}),
								h("span", null, route.slice(provider.length + 1))
							))
						))
				)
			);
		}

		function Panel({ initial, models, writable, onRefresh, refreshing }) {
			const [draft, setDraft] = React.useState(() => {
				const seed = {};
				for (const field of FIELDS) {
					const key = field.key;
					const value = initial && Object.prototype.hasOwnProperty.call(initial, key) ? initial[key] : undefined;
					seed[key] = value !== undefined ? value : (field.kind === "chain" ? [] : recommendedOf(field));
				}
				return seed;
			});
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState("");
			const [notice, setNotice] = React.useState("");

			const setField = (key, value) => {
				setDraft((prev) => ({ ...prev, [key]: value }));
				setNotice("");
				setError("");
			};
			// Only compare keys the Host actually reported: a field absent from the
			// answer was never set by the user, so showing it as "dirty" on first
			// paint would leave the save control enabled before any edit.
			const dirtyKeys = FIELDS
				.map((f) => f.key)
				.filter((key) => initial && Object.prototype.hasOwnProperty.call(initial, key))
				.filter((key) => !eq(draft[key], initial[key]));
			const dirty = dirtyKeys.length > 0;

			const save = async () => {
				if (!writable || busy || !dirty) return;
				setBusy(true);
				setError("");
				setNotice("");
				try {
					const ops = dirtyKeys.map((key) => ({ op: "set", path: [key], value: draft[key] }));
					const res = await fetch(`${BRIDGE}/save`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ ops })
					});
					const body = await res.json().catch(() => ({}));
					if (!res.ok || body?.ok !== true) {
						setError(`保存失败：${body?.message ?? body?.code ?? `HTTP ${res.status}`}`);
						return;
					}
					setNotice("已保存并即时生效");
				} catch (e) {
					setError(`保存请求失败：${e && e.message ? e.message : String(e)}`);
				} finally {
					setBusy(false);
				}
			};

			const sections = GROUPS.map(([group, title]) => {
				const fields = FIELDS.filter((f) => f.group === group);
				if (fields.length === 0) return null;
				return h("div", { key: group, style: { marginBottom: 18 } },
					h("div", { style: { fontSize: 13, fontWeight: 600, margin: "0 0 8px" } }, title),
					fields.map((field) => h("div", { key: field.key, style: rowStyle },
						h("div", { style: labelStyle }, field.label),
						h("div", { style: { flex: 1, minWidth: 0 } },
							field.kind === "chain"
								? h(ChainField, {
									value: draft[field.key],
									models,
									disabled: busy || !writable,
									onChange: setField,
									onRefresh,
									refreshing
								})
								: h(SelectField, {
									field,
									value: draft[field.key],
									disabled: busy || !writable,
									onChange: setField
								}),
							h("div", { style: { fontSize: 11, opacity: 0.6, marginTop: 4 } }, field.hint)
						)
					))
				);
			});

			return h("div", { "data-plugin-config": true, style: { fontSize: 13 } },
				!writable ? h("p", { style: { color: "#c33", margin: "0 0 8px" } },
					"配置暂时只读：Host 配置服务不可用，重启 DSH 后再试。") : null,
				sections,
				h("div", { style: { display: "flex", alignItems: "center", gap: 12, marginTop: 6, flexWrap: "wrap" } },
					h("button", {
						type: "button",
						disabled: busy || !writable || !dirty,
						onClick: save,
						style: { fontSize: 13, padding: "5px 14px", cursor: busy || !writable || !dirty ? "default" : "pointer" }
					}, busy ? "保存中…" : "保存"),
					h("span", { style: { fontSize: 12, opacity: 0.7 } },
						dirty ? `有 ${dirtyKeys.length} 项未保存的修改` : "没有未保存的修改"),
					error ? h("span", { style: { fontSize: 12, color: "#c33" } }, error) : null,
					!error && notice ? h("span", { style: { fontSize: 12, color: "#2a7" } }, notice) : null
				)
			);
		}

		/**
		 * Loads Host state, keeps sampling the catalog until it stops growing,
		 * and exposes an explicit refresh. Providers mount asynchronously, so a
		 * single early fetch reports a partial list — the exact "list is
		 * incomplete" symptom this replaces.
		 */
		function AutoContinueSettings() {
			const [state, setState] = React.useState({ phase: "loading", models: [] });
			const [refreshing, setRefreshing] = React.useState(false);
			const modelsRef = React.useRef([]);
			const timersRef = React.useRef([]);

			const sample = React.useCallback(async ({ keepModels } = {}) => {
				const res = await fetch(`${BRIDGE}/state`, { method: "GET" });
				const body = await res.json().catch(() => ({}));
				if (!res.ok || body?.ok !== true) {
					throw new Error(body?.message ?? `HTTP ${res.status}`);
				}
				const live = Array.isArray(body.models)
					? body.models.map((m) => (typeof m === "string" ? m : m?.route)).filter((x) => typeof x === "string" && x !== "")
					: [];
				const union = keepModels
					? Array.from(new Set([...modelsRef.current, ...live])).sort()
					: live.slice().sort();
				modelsRef.current = union;
				return { config: body.config ?? {}, writable: body.writable !== false, models: union };
			}, []);

			const refresh = React.useCallback(async () => {
				setRefreshing(true);
				try {
					const next = await sample({ keepModels: false });
					setState({ phase: "ready", ...next });
				} catch (e) {
					setState((prev) => ({ ...prev, phase: prev.phase === "ready" ? "ready" : "failed", message: e && e.message ? e.message : String(e) }));
				} finally {
					setRefreshing(false);
				}
			}, [sample]);

			React.useEffect(() => {
				let cancelled = false;
				let settled = false;
				const tick = async () => {
					try {
						const next = await sample({ keepModels: true });
						if (cancelled) return;
						settled = true;
						setState({ phase: "ready", ...next });
					} catch (e) {
						if (cancelled) return;
						// Keep whatever we already showed; only fail on the first sample.
						setState((prev) => (prev.phase === "ready"
							? prev
							: { phase: "failed", message: e && e.message ? e.message : String(e), models: [] }));
					}
				};
				// First sample gates the panel; later ones only widen the catalog.
				void tick();
				for (const delay of POLL_DELAYS_MS.slice(1)) {
					timersRef.current.push(setTimeout(() => { if (!cancelled) void tick(); }, delay));
				}
				return () => {
					cancelled = true;
					for (const id of timersRef.current) clearTimeout(id);
					timersRef.current = [];
					void settled;
				};
			}, [sample]);

			if (state.phase === "loading") {
				return h("div", { "data-plugin-config": true, style: { fontSize: 13, opacity: 0.7 } }, "正在读取配置…");
			}
			if (state.phase === "failed") {
				return h("div", { "data-plugin-config": true, style: { fontSize: 13 } },
					h("p", { style: { color: "#c33", margin: "0 0 6px" } }, "无法读取配置"),
					h("p", { style: { opacity: 0.75, margin: "0 0 8px" } },
						`${state.message ?? "未知错误"}。若刚安装或升级，请重启 DSH 后重开此页。`),
					h("button", { type: "button", onClick: refresh, style: { fontSize: 13, padding: "5px 14px" } }, "重试"));
			}
			return h(Panel, {
				key: JSON.stringify(state.config),
				initial: state.config,
				models: state.models ?? [],
				writable: state.writable,
				onRefresh: refresh,
				refreshing
			});
		}

		return {
			// Baseline Client service keys only.
			inject: ["slots", "locale"],
			apply(ctx) {
				const render = () => h(AutoContinueSettings, null);
				const safe = (tag, fn) => {
					try { fn(); } catch (e) {
						if (ctx.logger && ctx.logger.warn) {
							ctx.logger.warn(`auto-continue: ${tag} failed: ${e && e.message ? e.message : String(e)}`);
						}
					}
				};
				// Bundle detail page.
				safe("plugins.bundle.config", () =>
					ctx.slots.inject("plugins.bundle.config", () =>
						ctx.slots.register({ name: "plugins.bundle.config", key: "@local/auto-continue" }, render)));
				// Row Configure page (summary on the card, full form on the page).
				safe("plugins.row.config", () =>
					ctx.slots.inject("plugins.row.config", () =>
						ctx.slots.register({ name: "plugins.row.config", key: "@local/auto-continue#auto-continue" },
							(slotProps) => slotProps && slotProps.view === "summary"
								? h("span", null, "自动续接与模型切换 · 优先模型链、探测与冷却")
								: render())));
			}
		};
	}
});