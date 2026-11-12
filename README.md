# dsh-auto-continue — 自动续接与模型切换

[English](#english) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：当任意会话的模型请求因**用量不足、限流、额度重置、凭证错误、上下文超限**等原因中断时，自动探测一个可用的备选模型、持久切换会话，并自动补发续接消息——无需人工干预。

## 它解决什么问题

免费模型经常在任务中途失效（用量耗尽、每分钟限流、整点重置）。没有这个插件时，你得手动换模型、再手动发一句「继续」；有了它，这套动作全自动完成。

## 工作原理

插件挂在 agent loop 的 `agent/request-error` 瀑布上，与内置的 `dsh-llm-retry` 分工协作：

1. **短退避重试**（瞬时抖动）由内置 `dsh-llm-retry` 处理；重试耗尽或错误不可重试时，才轮到本插件。
2. **枚举候选**：显式 `fallbackChain`（`provider/model` 列表）优先，其后按注册顺序枚举全部已注册 provider × model。
3. **探测可用性**：切换前对每个候选发一个极小的真实请求（默认 16 token、20 秒超时），只有探测通过的候选才会被选中；刚失败过的路由进入冷却表（配额 30 分钟 / 限流 5 分钟 / 凭证 6 小时），不会被立刻重复选中。
4. **持久切换**：`agent.model.select()` 写入 `model/selection` 会话事件——与 Web UI 手动切换完全同一机制，下一步自动出现 `[model changed: ...]` 通知。
5. **自动续接**：以 hook 原因中止死回合（保留已排队的输入），向 next-turn 收件箱补发一条「继续」；循环的唤醒闩锁自动开新回合，在新模型上原地续跑任务。
6. **防失控**：单回合最多切换 3 次（可配）；上下文超限（`CONTEXT_WINDOW_EXCEEDED`）会优先挑上下文窗口更大的模型；全死时不切，如实上报错误。
7. **兜底续接（v1.1.0）**：任何回合以错误收尾后——包括驱动级异常、重试耗尽仍无可用候选等「不明原因」中断——一旦会话空闲即自动重新探活并续接（受 `maxIdleResumes` 上限约束）；正常结束或用户手动停止则绝不打扰。

## 安装

- **dsh-market**：市场内搜索 `auto-continue` 或 `自动续接` → 安装 → 重启 DSH。
- **手动（GitHub 源）**：在插件管理中安装 `github:43aquarius/dsh-auto-continue`。

## 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `continuationText` | `继续` | 切换后自动补发的续接消息文本 |
| `fallbackChain` | `[]` | 优先尝试的备选模型（`provider/model`），按顺序优先；留空则自动枚举 |
| `ignoreCodes` | `["ABORTED", "IMAGE_OFFLOAD_REQUIRED"]` | 这些错误码不触发切换 |
| `maxSwitchesPerTurn` | `3` | 单回合最多切换次数 |
| `probe` | `true` | 切换前发极小真实请求验证候选可用 |
| `probeTimeoutMs` | `20000` | 单个探测超时（毫秒） |
| `probeMaxTokens` | `16` | 探测请求最大输出 token |
| `maxProbeCandidates` | `6` | 单次故障最多探测的候选数 |
| `switchAfterMs` | `120000` | 限流等待超过该毫秒数时不再等待、直接切换 |
| `cooldownQuotaMs` | `1800000` | 配额耗尽路由的冷却时间 |
| `cooldownRateLimitMs` | `300000` | 限流路由的冷却时间 |
| `cooldownAuthMs` | `21600000` | 凭证错误路由的冷却时间 |
| `cooldownTransientMs` | `120000` | 其他临时错误路由的冷却时间 |
| `healthyTtlMs` | `600000` | 探测成功结果的缓存时长 |
| `resumeOnErrorIdle` | `true` | 回合错误收尾且无排定续接时，空闲后自动兜底续接 |
| `maxIdleResumes` | `3` | 每个会话在每个宿主生命周期内兜底续接的最大次数 |
| `cooldownModelFaultMs` | `1800000` | 模型级持续故障（PI_AI_ERROR、切换压缩失败等）的冷却时间 |

## 验证

- 9 个对照会话（含 teammates 与子代理）在健康路由下零干扰。
- 真实 429 限流风暴压测：`dsh-llm-retry` 退避重试 5 次耗尽后，插件逐个探测候选；峰值全 429 时如实上报错误、不切死模型；风暴过后探测命中健康候选即完成切换。
- 确定性单元测试（`test/switch.test.mjs`，7 个场景）覆盖完整切换链路、空闲兜底续接、正常收尾取消挂起与驱动错误续接。

## English

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that automatically recovers interrupted sessions: when a model request fails (quota exhausted, rate limit, reset windows, credential errors, context overflow), it probes the registered model catalog for a healthy fallback, durably switches the session via the same `model/selection` mechanism as the UI, and queues a continuation message so the task resumes on the new model — no manual intervention.

Short same-model backoff retries remain the job of the bundled `dsh-llm-retry` plugin; this plugin takes over once retries are exhausted or the failure is terminal. Since v1.1.0 it also covers every other kind of interruption: driver-level failures and exhausted-fallback errors are resumed automatically once the agent goes idle (bounded by `maxIdleResumes`), and model-level persistent faults (e.g. `PI_AI_ERROR`, compaction failures during a switch) get a long 30-minute cooldown. Switch records are committed via `session.appendPluginRecord()` with the `plugin:` envelope grammar so they never poison the session log. See the configuration table above (defaults are sane; everything is tunable).

## License

MIT
