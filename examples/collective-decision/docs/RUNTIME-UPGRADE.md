# 可选运行时增强

这些能力属于完整群体场景，不是 `@rulora/core` 自动提供的能力。默认运行、离线示例和业务方向不变。

## 1. 有界模型存活检测

默认保留已有请求超时策略。需要处理长推理时，可以在场景 `config/execution.json` 中显式增加：

```json
{
  "model_request_policy": {
    "mode": "liveness",
    "stream": true,
    "probe_interval_ms": 60000,
    "probe_timeout_ms": 15000,
    "consecutive_failures": 3,
    "maximum_elapsed_ms": 1200000,
    "maximum_response_bytes": 8388608
  }
}
```

这是需要合入现有配置的一个字段，不是替换整个配置文件。也可在构造
`MultiModelProvider` 时传入 `requestPolicy`。所有数值必须为正整数；不接受无限等待。

没有响应进展时探测同一服务的 `/models`，不发送业务请求正文，禁止重定向。
2xx–4xx 表示端点可达，不表示当前推理在进展。达到等待预算，即使服务仍可达也停止。
连续探测失败进入既有有限网络重试；取消、等待预算耗尽、响应过大不自动重试。
这里的等待上限是每次 HTTP 请求的预算，整个任务仍受模型调用次数和宿主执行预算约束。
探测路径只支持已知的 `chat/completions`、`messages`、`evaluate` 端点；其他服务需独立适配。

支持 OpenAI-compatible `[DONE]` 与 Anthropic `message_stop` 完成标记。
断流不得接受半截答案；流错误按既有错误分类处理，鉴权失败不换模型掩盖问题。
终止标记后的内容不会加入结果；无效 SSE JSON 事件不静默忽略。
响应大小限制可在真实流式读取时逐块生效；自定义仅提供 `text()` 的传输实现只能在返回后检查大小。

## 2. 纯消息传输适配

在独立 Provider 配置中显式声明：

```json
{
  "message_adapter": { "type": "system-first-v1", "enabled": true }
}
```

只将纯文本 system 指令按原顺序合并到首条消息。其余消息、证据、多模态用户输入和工具消息保持不变。
不能无损合并的 system 元数据或非文本内容会被拒绝，而非丢弃。
适配器不增加业务提示、不修改候选、不推断答案；业务复核要求放在场景 Prompt 中。
原始与发送角色序列及消息哈希写入审计，不额外写入凭据。

消息顺序可能影响模型行为。适配不保证语义等价或模型准确性；启用后需重新做供应商连通与业务测试。
此配置只适用于 OpenAI-compatible 消息数组，Anthropic 保留既有独立请求构造。

## 3. 复核及格式退修

- `action_classification_error` 必须绑定本候选恰好一个实际行动；`action_conflict` 至少绑定两个。
- 缺失比较说明返回字段定位，不把选中关系或业务矛盾自动改成合法答案。
- 反馈定位原字段、合法枚举与原证据；程序不清空真实缺口、重标行动或代替原席修订。
- 格式修订保留既有有效裁决、非空理由、问题记录及阻断缺口原文；漂移拒绝交付。
- 业务重新复核与格式修订分别记录，并保持有限次数；更换业务裁决不能伪装成格式修订。
- 无法解析的原始 JSON 只提供语法定位及有限修订，不能机械证明其原业务语义未变；新输出仍必须重新通过全部门禁。
- 显式 `maintain` 且没有替代候选、未知字段或新增行动时，允许补齐空 `candidate:null` 槽位；绝不丢弃显式替代候选。
- 不适用的空 `no_action_basis` 注释可以确定性清理；非空依据仍保留并由原合同拒绝不适用内容。

业务协议仍为 `5.3.0-action-object-boundaries`。独立问题分类契约为 `1.1.0`；格式修订版本进入检查点身份。
重放会验证缓存，不保证崩溃期间外部调用恰好执行一次。
本次运行时身份为 `1.1.0`，旧版本检查点不会自动迁移或当作新版本结果复用；原记录保留。
升级后的首次运行可能需要重新调用模型；同一新版本的成功节点仍通过检查点复用。
启用或关闭消息适配会改变连通验证及模型配置指纹，需重新完成宿主连通检查。

## 4. 动态并发上限

`applySchedulerConcurrency(scheduler, {maximumConcurrent, maximumConcurrentPerProfile})`
可以修改有限上限，不取消已运行请求。降低上限只约束后续启动；校验失败不部分修改配置。
默认继续使用总并发 3、单配置档并发 1；不迁入无限并发默认设置。
并发上限不是 RPM、Token 或费用限额，部署方仍需配置自己的额度与认证。

## 验证

```bash
node --test tests/runtime-upgrade.test.js tests/stream-errors.test.js
npm test
npm run example:static
npm run privacy:check
```

本次使用合成输入、模拟 HTTP/SSE、临时本地服务与离线重放验证，不调用真实模型或生产系统。
控制测试证明失败处理和约束行为，不证明企业经营决策正确。

## October 13 follow-up

Generic scheduler fixes preserve omitted/undefined limits during partial updates,
support cancelling queued work via `schedule(..., { signal })`, and do not count
caller cancellation or response/time budget exhaustion as provider outages.
Once a task starts, its owner must pass cancellation to its transport; this scheduler
API alone is not end-to-end web-job cancellation.

The public example retains finite concurrency and request budgets. It does not
import the private application's unlimited-wait/unlimited-concurrency policy,
provider-specific adapters, review guards, reasoning-output fallbacks, model menus,
credentials or production data. The generic opt-in `system-first-v1` adapter is
provider-neutral and contains no provider-specific business instructions.
